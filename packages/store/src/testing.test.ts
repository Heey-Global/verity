import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateToLatest } from './db.js';
import { EventStore, RUNNER_FRAME_PROTOCOL_VERSION } from './store.js';
import {
  createIsolatedTestDb,
  createRawDb,
  dropRunDatabases,
  ensureWorkerDatabase,
  truncateAll,
  workerDatabaseUrl,
} from './testing.js';

// Connecting to the shared PostgreSQL needs a live server and is exercised by
// CI. What is checkable everywhere is the part that decides WHICH database a
// worker talks to and how it gets created. Getting the name wrong is the one
// failure mode that would not look like a failure: two workers silently sharing
// a database, truncating each other mid-test, producing flakes that read as
// application bugs.
// Vitest hands this file to whichever worker is free, so `VITEST_POOL_ID` is
// not 1 in a run wide enough to need a second one. Nothing below may assert a
// worker id it did not set itself: pass the id explicitly, derive the
// expectation from the same helper, or stub the variable — never write out
// `w1` and let the ambient pool decide whether the assertion holds.
describe('workerDatabaseUrl', () => {
  const admin = 'postgres://verity:pw@10.0.0.1:5432/verity';

  // Same rule as the worker id above, for the same reason: a run that sets a
  // namespace would otherwise change every name asserted here. Cleared rather
  // than worked around, so the expectations below stay readable.
  beforeEach(() => {
    vi.stubEnv('VERITY_TEST_DB_NAMESPACE', undefined);
  });

  // The stub has to come back off: `createIsolatedTestDb` below reads the same
  // variable when the suite runs against the shared PostgreSQL.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not let two namespaces sanitize onto one database', () => {
    // Sanitizing is many-to-one: `run-1`, `run.1` and `run_1` all reduce to
    // `run1`, since the sanitizer keeps only [0-9A-Za-z].
    // Passing the cleaned form through unchanged would hand two concurrent runs
    // the same database and each other's teardown — so anything the sanitizer
    // had to touch is hashed instead, and only an already-safe namespace is
    // carried through verbatim.
    const nameFor = (namespace: string) =>
      new URL(workerDatabaseUrl(admin, '1', namespace)).pathname;
    expect(nameFor('run-1')).not.toBe(nameFor('run.1'));
    // The namespaces this repo actually mints are hex, so the readable name is
    // what a run gets; only a hand-written one with punctuation pays the hash.
    expect(nameFor('run1')).toBe('/verity_test_run1_w1');
  });

  it('gives each Vitest worker its own database on the same server', () => {
    expect(workerDatabaseUrl(admin, '1')).toBe('postgres://verity:pw@10.0.0.1:5432/verity_test_w1');
    expect(workerDatabaseUrl(admin, '2')).toBe('postgres://verity:pw@10.0.0.1:5432/verity_test_w2');
    // Credentials, host and port are the admin URL's; only the database changes.
    expect(new URL(workerDatabaseUrl(admin, '7')).host).toBe(new URL(admin).host);
  });

  it('replaces the admin database rather than appending to it', () => {
    // A trailing path would otherwise produce `/verity/verity_test_w1`, which is
    // not a database name at all — the connection would fail late and obscurely.
    expect(workerDatabaseUrl('postgres://h/postgres', '1')).toBe('postgres://h/verity_test_w1');
    expect(workerDatabaseUrl('postgres://h', '1')).toBe('postgres://h/verity_test_w1');
  });

  it('strips anything that is not a plain identifier character from the worker id', () => {
    // VITEST_POOL_ID is a number today. It is still interpolated into DDL, so it
    // is narrowed to [0-9A-Za-z] here rather than trusted.
    expect(workerDatabaseUrl(admin, '1"; drop database verity --')).toBe(
      'postgres://verity:pw@10.0.0.1:5432/verity_test_w1dropdatabaseverity',
    );
  });

  it('keeps two concurrent runs off one another’s databases', () => {
    // The blocker this exists for. `VITEST_POOL_ID` is the worker index WITHIN a
    // run, so worker 1 of every run claims `verity_test_w1`. One shared server is
    // fine while each run has its own (CI starts a throwaway container per job);
    // the moment two sessions in one sandbox — or two sandboxes — point at one
    // instance, both truncate the same database mid-test and the flakes read as
    // application bugs, not as a harness collision.
    expect(workerDatabaseUrl(admin, '1', 'runA')).not.toBe(workerDatabaseUrl(admin, '1', 'runB'));
    // Worker separation still holds inside a run...
    expect(workerDatabaseUrl(admin, '1', 'runA')).not.toBe(workerDatabaseUrl(admin, '2', 'runA'));
    // ...and the same run still lands on the same database, or nothing would be
    // reused between a run's files.
    expect(workerDatabaseUrl(admin, '2', 'runA')).toBe(workerDatabaseUrl(admin, '2', 'runA'));
    expect(workerDatabaseUrl(admin, '1', 'runA')).toBe(
      'postgres://verity:pw@10.0.0.1:5432/verity_test_runA_w1',
    );
  });

  it('leaves the un-namespaced names exactly as they were', () => {
    // The shape a run takes when nothing sets the variable. CI does set it now
    // — the harness mints one on the explicit-URL path too — so this is not
    // "what CI uses"; it is the guarantee that an unset variable still produces
    // the names the dedicated Postgres suites and older tooling expect.
    vi.stubEnv('VERITY_TEST_DB_NAMESPACE', undefined);
    expect(workerDatabaseUrl(admin, '3')).toBe('postgres://verity:pw@10.0.0.1:5432/verity_test_w3');
  });

  it('shortens an over-long namespace instead of letting PostgreSQL truncate it', () => {
    // Identifiers are cut at 63 bytes silently, so two namespaces sharing a long
    // prefix would land on ONE database — the collision this whole namespace
    // exists to prevent, reached in the one shape that reports nothing.
    const a = workerDatabaseUrl(admin, '1', `${'x'.repeat(80)}a`);
    const b = workerDatabaseUrl(admin, '1', `${'x'.repeat(80)}b`);
    expect(decodeURIComponent(new URL(a).pathname).length - 1).toBeLessThanOrEqual(63);
    expect(a).not.toBe(b);
  });

  it('lets nothing but plain identifier characters out of the namespace', () => {
    // Same reasoning as the worker id below: it is interpolated into DDL. A
    // namespace carrying anything else is hashed rather than stripped — see the
    // collision case above — so what matters here is that the DDL-shaped input
    // is gone from the name entirely, not which of the two rules removed it.
    const name = new URL(workerDatabaseUrl(admin, '1', 'a"; drop database verity --')).pathname;
    expect(name).toMatch(/^\/verity_test_[0-9a-f]{16}_w1$/u);
  });

  it('falls back to a single database when the worker id is absent', () => {
    // Unset rather than passed as `undefined`: the parameter DEFAULTS to
    // VITEST_POOL_ID, so an explicit undefined reads the ambient worker id and
    // asserts nothing about the fallback. Absent is the case being described —
    // a pool that sets no id, or the helper called outside Vitest entirely.
    vi.stubEnv('VITEST_POOL_ID', undefined);
    expect(workerDatabaseUrl(admin)).toBe('postgres://verity:pw@10.0.0.1:5432/verity_test_w1');
  });
});

describe('ensureWorkerDatabase', () => {
  const admin = 'postgres://verity:pw@10.0.0.1:5432/verity';

  beforeEach(() => {
    vi.stubEnv('VERITY_TEST_DB_NAMESPACE', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates the worker database on the admin connection and returns its URL', async () => {
    // Pinned, and to something other than the first worker: the statement below
    // is spelled out to pin the exact DDL, which only says anything if the id in
    // it is one this test chose. It also shows the name tracking the pool id
    // rather than a constant.
    vi.stubEnv('VITEST_POOL_ID', '7');
    const issued: Array<[string, string]> = [];
    const target = await ensureWorkerDatabase(admin, async (url, statement) => {
      issued.push([url, statement]);
    });

    // CREATE DATABASE has to run on a database that is not the one being
    // created, so the statement goes to the admin URL while the caller gets the
    // worker URL back.
    expect(issued).toEqual([[admin, 'create database "verity_test_w7"']]);
    expect(target).toBe(workerDatabaseUrl(admin));
  });

  it('treats an already-existing database as success (42P04)', async () => {
    // Every file in a worker runs this; all but the first lose the race. That is
    // the steady state, not an error — if it threw, one worker would pass and
    // the rest of its files would fail before their first assertion.
    const duplicate = Object.assign(new Error('database already exists'), { code: '42P04' });
    await expect(ensureWorkerDatabase(admin, () => Promise.reject(duplicate))).resolves.toBe(
      workerDatabaseUrl(admin),
    );
  });

  it('propagates any other failure instead of falling through to a bad connection', async () => {
    // A refused connection or a non-superuser role must surface here, not later
    // as an inscrutable failure inside migrateToLatest.
    const denied = Object.assign(new Error('permission denied to create database'), {
      code: '42501',
    });
    await expect(ensureWorkerDatabase(admin, () => Promise.reject(denied))).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('createIsolatedTestDb', () => {
  it('is a private migrated database, never the shared instance', async () => {
    const a = await createIsolatedTestDb();
    const b = await createIsolatedTestDb();
    try {
      await a.store.createSession({ sessionId: 's1', worktree: '/wt/a', model: 'm' });
      // Two live handles must not see each other — that is the whole point of the
      // isolated variant, and what lets schema-mutating tests keep using it.
      expect(await a.store.getSession('s1')).toBeDefined();
      expect(await b.store.getSession('s1')).toBeUndefined();
      // Schema changes must not leak either — that is what lets the
      // migration tests keep mutating their database without breaking the rest
      // of the file's worker.
      await sql`create table isolation_probe (id text primary key)`.execute(b.db);
      await expect(sql`select 1 from isolation_probe`.execute(b.db)).resolves.toBeDefined();
      await expect(sql`select 1 from isolation_probe`.execute(a.db)).rejects.toThrow();
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe('truncateAll', () => {
  it('drains projection backfills before it takes the truncate lock', async () => {
    // `ingestRunnerFrame` schedules the recovery/search backfill and deliberately
    // does not await it. On the shared PostgreSQL that backfill holds its own
    // pool connection, so a TRUNCATE issued while it is mid-read deadlocks
    // against it (40P01) — Postgres kills one side and the file fails on
    // whichever test was next, pointing at nothing. pglite serializes every
    // statement onto one connection and so cannot deadlock; what it can still
    // show is the ordering that causes it, which is the actual invariant:
    // once truncateAll resolves, nothing else may reach the database.
    const statements: string[] = [];
    const { db: base, close } = createRawDb();
    const db = base.withPlugin({
      transformQuery(args) {
        const node = args.node as { kind: string; sqlFragments?: readonly string[] };
        statements.push(node.kind === 'RawNode' ? (node.sqlFragments ?? []).join('?') : node.kind);
        return args.node;
      },
      transformResult: (args) => Promise.resolve(args.result),
    });
    try {
      await migrateToLatest(db);
      const store = new EventStore(db);
      await store.createSession({ sessionId: 's1', worktree: '/wt/a', model: 'm' });
      await store.ingestRunnerFrame('s1', {
        protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
        runnerInstanceId: 'runner-a',
        turnId: 'turn-a',
        frameSeq: 1,
        payloadHash: 'h1',
        event: { t: 'text', delta: 'hello' },
      });

      await truncateAll(db);
      const truncatedAt = statements.findIndex((statement) =>
        statement.startsWith('truncate table'),
      );
      expect(truncatedAt).toBeGreaterThanOrEqual(0);

      // Give anything still queued the turns it would need to reach the driver.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(statements.slice(truncatedAt + 1)).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);
});

describe('dropRunDatabases', () => {
  const admin = 'postgres://verity:pw@10.0.0.1:5432/verity';

  it('drops one database per worker the pool could have started', async () => {
    // A run does not record which workers it actually used, so cleanup covers
    // the whole pool. `if exists` is what makes that safe rather than noisy.
    const issued: string[] = [];
    await dropRunDatabases(admin, 'runA', 3, async (_url, statement) => {
      issued.push(statement);
    });
    expect(issued).toEqual([
      'drop database if exists "verity_test_runA_w1" with (force)',
      'drop database if exists "verity_test_runA_w2" with (force)',
      'drop database if exists "verity_test_runA_w3" with (force)',
    ]);
  });

  it('names the same databases the run connected to', async () => {
    // The two derivations must not drift: cleanup that computes a different name
    // than `workerDatabaseUrl` leaks every database while reporting success.
    const issued: string[] = [];
    await dropRunDatabases(admin, 'runA', 2, async (_url, statement) => {
      issued.push(statement);
    });
    for (const poolId of ['1', '2']) {
      const name = decodeURIComponent(
        new URL(workerDatabaseUrl(admin, poolId, 'runA')).pathname.slice(1),
      );
      expect(issued.some((statement) => statement.includes(`"${name}"`))).toBe(true);
    }
  });

  it('drops nothing when the run had no namespace of its own', async () => {
    // The un-namespaced shape. Those names are not this run's to drop — on a
    // shared server they are whatever legacy run is using them — so teardown
    // has to decline rather than sweep.
    const issued: string[] = [];
    await dropRunDatabases(admin, '', 2, async (_url, statement) => {
      issued.push(statement);
    });
    expect(issued).toEqual([]);
  });

  it('drops nothing when the pool started no workers', async () => {
    const issued: string[] = [];
    await dropRunDatabases(admin, 'runA', 0, async (_url, statement) => {
      issued.push(statement);
    });
    expect(issued).toEqual([]);
  });

  it('keeps a namespace that sanitizes to nothing away from the legacy names', async () => {
    // `::` cleans to the empty string. Falling through to verity_test_wN there
    // would both collide with a concurrent run and aim teardown at its
    // databases — the two failures this namespace exists to prevent, at once.
    const issued: string[] = [];
    await dropRunDatabases(admin, '::', 1, async (_url, statement) => {
      issued.push(statement);
    });
    expect(issued).toHaveLength(1);
    expect(issued[0]).not.toContain('"verity_test_w1"');
  });
});
