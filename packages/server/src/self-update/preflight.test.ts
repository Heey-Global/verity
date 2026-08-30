import { createServer, type Server } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  earliestMigrationKey,
  executedSchemaGeneration,
  latestMigrationKey,
  migrateToLatest,
  migrationProvider,
  type Database,
} from '@verity/store';
import { createEmbeddedDb } from '@verity/store/testing';
import type { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import {
  isPreflightCommand,
  preflightConfigFromEnv,
  runPreflight,
  type PreflightConfig,
} from './preflight.js';

// Inject an already-open store (the hermetic pglite path embedded.ts uses) so
// preflight inspects it WITHOUT us migrating inside preflight. The test owns the
// db lifecycle, so the injected `close` is a no-op.
function inject(db: Kysely<Database>): {
  openDatabase: (config: PreflightConfig) => { db: Kysely<Database>; close: () => Promise<void> };
} {
  return { openDatabase: () => ({ db, close: () => Promise.resolve() }) };
}

async function listenOn(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
  });
  return server;
}

function assignedPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('runPreflight (hermetic pglite)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('passes database + schema checks against a migrated store', async () => {
    const db = createEmbeddedDb();
    cleanups.push(() => db.destroy());
    await migrateToLatest(db);

    const report = await runPreflight({}, inject(db));

    expect(report.ok).toBe(true);
    expect(report.schema.executed).toBe(latestMigrationKey());
    expect(report.schema.expected).toBe(latestMigrationKey());
    expect(report.schema.compatible).toBe(true);
    expect(report.checks.find((c) => c.name === 'database')?.status).toBe('pass');
    expect(report.checks.find((c) => c.name === 'schema')?.status).toBe('pass');
    // The declared schema window is surfaced so a passive preflight publishes the
    // whole compatibility RANGE, not just the target generation.
    expect(report.schema.supported).toEqual({
      min: earliestMigrationKey(),
      max: latestMigrationKey(),
    });
  });

  it('accepts an older executed generation that is within the declared window', async () => {
    // This is the behaviour the widened window unlocks (ADR 0008 D9): a target
    // build preflighting a DB still at an OLDER, in-window generation (e.g. the
    // N-1 DB it is about to take over) must report the schema as compatible even
    // though it is behind `current`. Before the window widened, preflight passed
    // only when executed === current, so this case would have failed.
    const db = createEmbeddedDb();
    cleanups.push(() => db.destroy());
    const intermediate = '0026_auth_tokens';
    const migrator = new Migrator({ db, provider: migrationProvider });
    expect((await migrator.migrateTo(intermediate)).error).toBeUndefined();

    const report = await runPreflight({}, inject(db));

    expect(report.schema.executed).toBe(intermediate);
    // Older than `current`, but inside [min, max], so the schema check accepts it.
    expect(report.schema.executed).not.toBe(latestMigrationKey());
    expect(report.schema.compatible).toBe(true);
    expect(report.checks.find((c) => c.name === 'schema')?.status).toBe('pass');
  });

  it('fails the schema check against an unmigrated store and does NOT migrate it', async () => {
    const db = createEmbeddedDb();
    cleanups.push(() => db.destroy());

    const report = await runPreflight({}, inject(db));

    expect(report.ok).toBe(false);
    expect(report.schema.executed).toBeNull();
    expect(report.schema.compatible).toBe(false);
    expect(report.checks.find((c) => c.name === 'schema')?.status).toBe('fail');
    // The store ANSWERED — it is only at the wrong generation. Keeping this
    // distinct from the connectivity failure below is what lets the live smoke's
    // two preflight stages assert different reports instead of the same one
    // twice (ADR 0008, "database unavailable and schema incompatible").
    expect(report.checks.find((c) => c.name === 'database')?.status).toBe('pass');
    // Preflight must never run migrations: the store is still empty afterwards.
    expect(await executedSchemaGeneration(db)).toBeNull();
  });

  it('passes a present, writable mount and fails a missing one', async () => {
    const db = createEmbeddedDb();
    cleanups.push(() => db.destroy());
    await migrateToLatest(db);
    const dir = await mkdtemp(join(tmpdir(), 'verity-preflight-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const ok = await runPreflight(
      { requiredMounts: [{ path: dir, writable: true, directory: true }] },
      inject(db),
    );
    expect(ok.checks.find((c) => c.name === `mount:${dir}`)?.status).toBe('pass');
    expect(ok.ok).toBe(true);

    const missing = join(dir, 'does-not-exist');
    const bad = await runPreflight({ requiredMounts: [{ path: missing }] }, inject(db));
    expect(bad.checks.find((c) => c.name === `mount:${missing}`)?.status).toBe('fail');
    expect(bad.ok).toBe(false);
  });

  it('passes a free candidate port and fails an occupied one', async () => {
    const db = createEmbeddedDb();
    cleanups.push(() => db.destroy());
    await migrateToLatest(db);

    const occupied = await listenOn(0);
    const busyPort = assignedPort(occupied);
    cleanups.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));

    const report = await runPreflight(
      {
        candidatePorts: [
          { label: 'public', port: 0 },
          { label: 'internal', port: busyPort },
        ],
      },
      inject(db),
    );
    expect(report.checks.find((c) => c.name === 'port:public:0')?.status).toBe('pass');
    expect(report.checks.find((c) => c.name === `port:internal:${String(busyPort)}`)?.status).toBe(
      'fail',
    );
    expect(report.ok).toBe(false);
  });

  it('fails the database check (fail-closed) when no database is configured', async () => {
    // Default path, no injection and no databaseUrl: must NOT silently open an
    // ephemeral in-memory store and report a misleading `database: pass`.
    const report = await runPreflight({});
    expect(report.ok).toBe(false);
    expect(report.schema.executed).toBeNull();
    expect(report.schema.compatible).toBe(false);
    const dbCheck = report.checks.find((c) => c.name === 'database');
    expect(dbCheck?.status).toBe('fail');
    expect(dbCheck?.detail).toMatch(/DATABASE_URL/);
    // The declared window is still reported even when the DB is unconfigured, so
    // a peer can read this build's range from a fail-closed preflight.
    expect(report.schema.supported).toEqual({
      min: earliestMigrationKey(),
      max: latestMigrationKey(),
    });
  });

  it('reports a database-connectivity failure without throwing', async () => {
    // A store whose every access throws (e.g. an unreachable Postgres): the
    // schema read must be caught and surfaced as a failed check, not propagated.
    const throwingDb = new Proxy(
      {},
      {
        get() {
          throw new Error('ECONNREFUSED: connection refused');
        },
      },
    ) as unknown as Kysely<Database>;

    const report = await runPreflight({}, inject(throwingDb));
    expect(report.ok).toBe(false);
    expect(report.schema.executed).toBeNull();
    expect(report.schema.compatible).toBe(false);
    expect(report.checks.find((c) => c.name === 'database')?.status).toBe('fail');
  });
});

describe('isPreflightCommand', () => {
  it('is true for a `preflight` argv token', () => {
    expect(isPreflightCommand(['node', 'main.js', 'preflight'], {})).toBe(true);
  });
  it('is true for VERITY_SERVER_COMMAND=preflight', () => {
    expect(isPreflightCommand(['node', 'main.js'], { VERITY_SERVER_COMMAND: 'preflight' })).toBe(
      true,
    );
  });
  it('is false for a normal start', () => {
    expect(isPreflightCommand(['node', 'main.js'], {})).toBe(false);
  });
});

describe('preflightConfigFromEnv', () => {
  it('derives databaseUrl, host, mounts, and candidate ports from the environment', () => {
    const config = preflightConfigFromEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/verity',
      HOST: '0.0.0.0',
      PORT: '9000',
      VERITY_INTERNAL_PORT: '9083',
      VERITY_ROOT: '/srv/custom',
    });
    expect(config.databaseUrl).toBe('postgresql://u:p@localhost:5432/verity');
    expect(config.host).toBe('0.0.0.0');
    expect(config.requiredMounts).toEqual([
      { path: '/srv/custom', writable: true, directory: true },
    ]);
    expect(config.candidatePorts).toEqual([
      { label: 'public', port: 9000 },
      { label: 'internal', port: 9083 },
    ]);
  });

  it('omits databaseUrl when unset and applies default ports/root', () => {
    const config = preflightConfigFromEnv({});
    expect(config.databaseUrl).toBeUndefined();
    expect(config.requiredMounts?.[0]?.path).toBe('/srv/verity');
    expect(config.candidatePorts).toEqual([
      { label: 'public', port: 8787 },
      { label: 'internal', port: 8083 },
    ]);
  });
});
