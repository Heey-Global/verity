// Server self-update preflight (ADR 0008 D5) — "slice 1", read-only foundation.
//
// A candidate Server image exposes preflight as an entrypoint DISTINCT from
// normal startup. It validates that this build could take over — database
// connectivity + schema-generation compatibility, required mounts, and candidate
// listener ports — WITHOUT any externally visible side effect. Per D5 it must
// NOT run migrations, start a scheduler, recover queued work, take a Runner
// lease, mint a token, or begin listening for real traffic. It only opens a DB
// connection to read, touches the filesystem to check mounts, and binds candidate
// ports transiently (immediately closing them) to prove they are free.
//
// The report is a structured pass/fail document (modeled on the flat status
// shape of sandbox-updates.ts) so callers — the CLI exit code today, the Updater
// journal later — can act on it without parsing prose.

import { createServer } from 'node:net';
import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createPostgresDb, executedSchemaGeneration, type Database } from '@verity/store';
import type { Kysely } from 'kysely';
import { SERVER_COMPAT, compareSchemaGenerations } from './compat.js';

/** A filesystem mount the candidate requires. */
export interface MountRequirement {
  /** Absolute path expected to be present. */
  readonly path: string;
  /** When true, the candidate must also be able to write here (W_OK). */
  readonly writable?: boolean;
  /** When true, the path must be a directory (default: any type accepted). */
  readonly directory?: boolean;
}

/** A listener port the candidate must be able to bind. */
export interface CandidatePort {
  /** A short label for the report (e.g. `public`, `internal`). */
  readonly label: string;
  readonly port: number;
  /** Bind host; defaults to the report-level host. */
  readonly host?: string;
}

/** Inputs for a preflight run. All optional so tests can exercise slices. */
export interface PreflightConfig {
  /** A real Postgres connection string — the only store preflight itself opens.
   * Tests that want the hermetic pglite inject it via
   * {@link PreflightDeps.openDatabase} instead. */
  readonly databaseUrl?: string;
  /** Bind host for candidate ports and the default for each port's own host. */
  readonly host?: string;
  readonly requiredMounts?: readonly MountRequirement[];
  readonly candidatePorts?: readonly CandidatePort[];
}

/** Dependency seam so tests can inject an already-open (migrated) store. */
export interface PreflightDeps {
  /**
   * Open the database to inspect. Returns the handle plus a `close` the caller
   * owns. Default opens `config.databaseUrl` and closes it. When injected,
   * preflight uses the provided `close` (the test owns lifecycle), so it never
   * destroys a store it did not open.
   */
  readonly openDatabase?: (config: PreflightConfig) => {
    db: Kysely<Database>;
    close: () => Promise<void>;
  };
}

export type PreflightCheckStatus = 'pass' | 'fail';

export interface PreflightCheck {
  readonly name: string;
  readonly status: PreflightCheckStatus;
  readonly detail: string | null;
}

export interface PreflightSchemaReport {
  /** The schema generation this build targets (SERVER_COMPAT.schema.current). */
  readonly expected: string;
  /** The generation actually applied to the DB, or null when none/unreadable. */
  readonly executed: string | null;
  readonly compatible: boolean;
  /**
   * The declared schema read/write window this build supports (ADR 0008 D9),
   * mirrored from `SERVER_COMPAT.schema`. Surfaced so a passive preflight
   * instance publishes the whole compatibility RANGE — not just the target
   * `expected` point — and a peer can compare its own window against it.
   */
  readonly supported: { readonly min: string; readonly max: string };
}

export interface PreflightReport {
  /** True iff every check passed and the schema is compatible. */
  readonly ok: boolean;
  readonly serverVersion: string;
  readonly schema: PreflightSchemaReport;
  readonly checks: readonly PreflightCheck[];
}

function openPostgres(databaseUrl: string): {
  db: Kysely<Database>;
  close: () => Promise<void>;
} {
  const db = createPostgresDb(databaseUrl);
  return { db, close: () => db.destroy() };
}

async function checkMount(requirement: MountRequirement): Promise<PreflightCheck> {
  const name = `mount:${requirement.path}`;
  try {
    const info = await stat(requirement.path);
    if (requirement.directory === true && !info.isDirectory()) {
      return { name, status: 'fail', detail: 'path exists but is not a directory' };
    }
    if (requirement.writable === true) {
      await access(requirement.path, fsConstants.W_OK);
    } else {
      await access(requirement.path, fsConstants.R_OK);
    }
    return { name, status: 'pass', detail: null };
  } catch (error) {
    return { name, status: 'fail', detail: describeError(error) };
  }
}

function checkPort(port: CandidatePort, defaultHost: string): Promise<PreflightCheck> {
  const name = `port:${port.label}:${String(port.port)}`;
  const host = port.host ?? defaultHost;
  return new Promise((resolve) => {
    const server = createServer();
    const done = (check: PreflightCheck): void => {
      server.removeAllListeners();
      server.close(() => resolve(check));
    };
    server.once('error', (error) => {
      // The socket never bound, so nothing to close — resolve directly.
      server.removeAllListeners();
      resolve({ name, status: 'fail', detail: describeError(error) });
    });
    server.once('listening', () => {
      done({ name, status: 'pass', detail: null });
    });
    // exclusive so a shared-address kernel does not mask an already-bound port.
    server.listen({ port: port.port, host, exclusive: true });
  });
}

async function checkDatabaseAndSchema(db: Kysely<Database>): Promise<{
  database: PreflightCheck;
  schema: PreflightSchemaReport;
  schemaCheck: PreflightCheck;
}> {
  const expected = SERVER_COMPAT.schema.current;
  const supported = { min: SERVER_COMPAT.schema.min, max: SERVER_COMPAT.schema.max };
  let executed: string | null;
  try {
    executed = await executedSchemaGeneration(db);
  } catch (error) {
    return {
      database: { name: 'database', status: 'fail', detail: describeError(error) },
      schema: { expected, executed: null, compatible: false, supported },
      schemaCheck: {
        name: 'schema',
        status: 'fail',
        detail: 'schema generation could not be read (database unreadable)',
      },
    };
  }
  const database: PreflightCheck = { name: 'database', status: 'pass', detail: null };
  const compatible =
    executed !== null &&
    compareSchemaGenerations(executed, SERVER_COMPAT.schema.min) >= 0 &&
    compareSchemaGenerations(executed, SERVER_COMPAT.schema.max) <= 0;
  const schemaCheck: PreflightCheck = compatible
    ? { name: 'schema', status: 'pass', detail: null }
    : {
        name: 'schema',
        status: 'fail',
        detail:
          executed === null
            ? `database has no applied migrations; expected generation "${expected}"`
            : `database schema generation "${executed}" is outside this build's ` +
              `supported range ["${SERVER_COMPAT.schema.min}", "${SERVER_COMPAT.schema.max}"]`,
      };
  return { database, schema: { expected, executed, compatible, supported }, schemaCheck };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    // Node fs/net errors already embed the code in `message`; only prefix it
    // when it isn't there so we don't produce "ENOENT: ENOENT: …".
    return code && !error.message.includes(code) ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

/**
 * Run the read-only preflight and return a structured report. Opens a DB
 * connection (or uses the injected one), reads the applied schema generation,
 * verifies required mounts, and binds candidate ports transiently. Never runs a
 * migration, starts a scheduler, or begins serving traffic (ADR 0008 D5).
 */
export async function runPreflight(
  config: PreflightConfig,
  deps: PreflightDeps = {},
): Promise<PreflightReport> {
  const host = config.host ?? '127.0.0.1';

  let database: PreflightCheck;
  let schema: PreflightSchemaReport;
  let schemaCheck: PreflightCheck;
  // An unconfigured store must fail-closed with an honest reason rather than
  // silently opening an ephemeral database (which would make the `database`
  // check falsely pass). Tests inject a store, so they keep the hermetic pglite
  // path without preflight itself knowing pglite exists.
  let opened: { db: Kysely<Database>; close: () => Promise<void> } | undefined;
  if (deps.openDatabase !== undefined) {
    opened = deps.openDatabase(config);
  } else if (config.databaseUrl !== undefined) {
    opened = openPostgres(config.databaseUrl);
  }

  if (opened === undefined) {
    database = {
      name: 'database',
      status: 'fail',
      detail: 'no database configured: DATABASE_URL is required',
    };
    schema = {
      expected: SERVER_COMPAT.schema.current,
      executed: null,
      compatible: false,
      supported: { min: SERVER_COMPAT.schema.min, max: SERVER_COMPAT.schema.max },
    };
    schemaCheck = {
      name: 'schema',
      status: 'fail',
      detail: 'schema generation unknown: database is not configured',
    };
  } else {
    try {
      ({ database, schema, schemaCheck } = await checkDatabaseAndSchema(opened.db));
    } finally {
      await opened.close();
    }
  }

  const mountChecks = await Promise.all(
    (config.requiredMounts ?? []).map((mount) => checkMount(mount)),
  );
  const portChecks = await Promise.all(
    (config.candidatePorts ?? []).map((port) => checkPort(port, host)),
  );

  const checks: PreflightCheck[] = [database, schemaCheck, ...mountChecks, ...portChecks];
  const ok = checks.every((check) => check.status === 'pass');
  return { ok, serverVersion: SERVER_COMPAT.serverVersion, schema, checks };
}

/**
 * True when this process was invoked as the preflight entrypoint rather than a
 * normal Server start. Dispatched on an explicit `preflight` argv token or
 * `VERITY_SERVER_COMMAND=preflight`, so the default startup path is unaffected.
 */
export function isPreflightCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return argv.includes('preflight') || env.VERITY_SERVER_COMMAND === 'preflight';
}

function parsePortValue(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`invalid port "${value}": expected an integer in 0-65535`);
  }
  return parsed;
}

/**
 * Derive a {@link PreflightConfig} from the deployment environment, mirroring the
 * env knobs main.ts reads for a normal start (DATABASE_URL, HOST, PORT,
 * VERITY_INTERNAL_PORT, VERITY_ROOT). Pure: no I/O, so it is unit-testable.
 */
export function preflightConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PreflightConfig {
  const verityRoot = env.VERITY_ROOT ?? '/srv/verity';
  const host = env.HOST ?? '127.0.0.1';
  const publicPort = parsePortValue(env.PORT, 8787);
  const internalPort = parsePortValue(env.VERITY_INTERNAL_PORT, 8083);
  const config: PreflightConfig = {
    host,
    requiredMounts: [
      {
        path: verityRoot,
        writable: env.VERITY_PREFLIGHT_READ_ONLY !== '1',
        directory: true,
      },
    ],
    candidatePorts: [
      { label: 'public', port: publicPort },
      { label: 'internal', port: internalPort },
    ],
    ...(env.DATABASE_URL && env.DATABASE_URL.trim() !== ''
      ? { databaseUrl: env.DATABASE_URL }
      : {}),
  };
  return config;
}
