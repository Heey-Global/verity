import { createHash } from 'node:crypto';

import { type Kysely, sql } from 'kysely';

import { createPostgresDb, migrateToLatest } from './db.js';
import { migratedTemplateDir, rawTemplateDir, tryOpenTemplate } from './pglite-template.js';
import { createEmbeddedDb } from './pglite.js';
import type { Database } from './schema.js';
import { EventStore, waitForMessageProjectionWork } from './store.js';

// The pglite Kysely dialect lives in ./pglite.ts and is re-exported here, not
// from the package index: pglite is a devDependency, so this test-support entry
// point is the only door to it. Anything that imports it is test-only by
// construction, which is what keeps 26 MB of WASM Postgres out of the runtime
// image (`npm ci --omit=dev`). The helpers below are the sugar on top:
// in-memory instances + truncation between tests.
export { createEmbeddedDb } from './pglite.js';

export interface RawTestDb {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

export interface TestDb extends RawTestDb {
  store: EventStore;
}

/**
 * Set to a superuser connection string to run the suite against one real
 * PostgreSQL instead of a private pglite per test file. Booting pglite is a WASM
 * Postgres start plus 77 migrations — seconds and hundreds of megabytes that a
 * test file pays before it asserts anything, and it is paid by 50+ files, which
 * is what keeps CI serialized to one worker to stay under the runner's memory.
 * Unset (the local default) nothing changes: every file gets its own pglite and
 * the suite stays hermetic with no service to install.
 *
 * Deliberately NOT `VERITY_TEST_POSTGRES_URL`: that variable un-skips the
 * dedicated real-Postgres suites (`runner-frames-postgres.test.ts`,
 * `two-server-cutover-postgres.test.ts`,
 * `control-plane-generation-postgres.test.ts`), which own the `verity` database
 * directly and have their own CI job. Sharing one name would drag those into
 * every shard as a side effect of switching this harness over.
 */
const SHARED_POSTGRES_URL = process.env.VERITY_TEST_SHARED_POSTGRES_URL;

/**
 * Distinguishes one run of the suite from every other run that reaches the same
 * PostgreSQL. `VITEST_POOL_ID` alone does not: it is the worker index within a
 * run, so worker 1 of every concurrent run claims the same name. That is fine
 * in CI, where each job starts its own throwaway container
 * (`.github/actions/postgres`), and wrong everywhere a server is shared — two
 * sessions in one sandbox, or two sandboxes pointed at one instance, would
 * truncate each other mid-test and produce flakes that read as application bugs.
 *
 * Unset is therefore the CI/legacy shape and keeps the old names verbatim. It is
 * set per run, not per sandbox or per session: the incident behind this was a
 * session running a second full `vitest` while the first was still going, so
 * anything coarser than a run still collides.
 */
const RUN_NAMESPACE_VAR = 'VERITY_TEST_DB_NAMESPACE';

/** Postgres truncates identifiers at 63 bytes, silently. */
const MAX_IDENTIFIER_BYTES = 63;

/** Everything outside this is dropped before the value reaches DDL. */
const sanitizeIdentifierPart = (raw: string): string => raw.replace(/[^0-9A-Za-z]/g, '');

/**
 * The namespace, shortened to `budget` characters if it does not fit.
 *
 * By hashing rather than slicing: Postgres would truncate an over-long name
 * itself, so two namespaces sharing a 63-byte prefix would silently land on one
 * database — reintroducing the collision this exists to prevent, in the one
 * shape nothing would report. A digest keeps distinct inputs distinct and equal
 * inputs equal, which is all the name has to do.
 */
function namespaceSegment(raw: string, budget: number): string {
  const clean = sanitizeIdentifierPart(raw);
  // `clean.length > 0` is not a formality. A namespace of `::` or `--`
  // sanitizes away entirely, and returning that empty string would drop the
  // caller back onto the un-namespaced `verity_test_wN` — the exact collision
  // this function exists to prevent, arriving with nothing to report it, and
  // then handing `dropRunDatabases` the legacy names a concurrent run may be
  // using. Hash it instead, the same way an over-long one is hashed.
  // `clean === raw` and not merely "clean is non-empty": the sanitizer drops
  // every character outside [0-9A-Za-z], underscores included, so `run-1`,
  // `run_1` and `run.1` all arrive here as `run1` and would share a database.
  // Anything it had to touch is hashed instead, which keeps distinct inputs
  // distinct; the hex namespaces this repo mints pass through untouched.
  if (clean === raw && clean.length > 0 && clean.length <= budget) return clean;
  return createHash('sha256')
    .update(raw)
    .digest('hex')
    .slice(0, Math.max(1, Math.min(budget, 16)));
}

/**
 * The database this Vitest worker owns, derived from the admin connection string.
 * A worker runs its files one at a time, so a database per worker isolates
 * exactly as well as a database per file — at 1/nth the setup. `VITEST_POOL_ID`
 * is the worker index; module state cannot be used to memoize anything here
 * because `isolate: true` gives each file a fresh module registry.
 *
 * Scoped by {@link RUN_NAMESPACE_VAR} when one is set, so that concurrent runs
 * against a shared server do not both claim worker 1.
 */
export function workerDatabaseUrl(
  adminUrl: string,
  poolId = process.env.VITEST_POOL_ID,
  namespace = process.env[RUN_NAMESPACE_VAR],
): string {
  const url = new URL(adminUrl);
  const worker = `w${sanitizeIdentifierPart(poolId ?? '1')}`;
  const budget = MAX_IDENTIFIER_BYTES - `verity_test__${worker}`.length;
  // An empty value is what an unset variable looks like once a shell has
  // exported it, so it means the same thing here as `undefined` — unlike a
  // value that merely sanitizes to nothing, which is a real namespace and is
  // hashed above.
  const scope =
    namespace === undefined || namespace === '' ? '' : namespaceSegment(namespace, budget);
  const name = scope === '' ? `verity_test_${worker}` : `verity_test_${scope}_${worker}`;
  // Only reachable through an absurd VITEST_POOL_ID, which is why it is a throw
  // and not a shortening: Postgres would truncate the name silently, and two
  // workers sharing a truncated name is the collision case again.
  if (Buffer.byteLength(name) > MAX_IDENTIFIER_BYTES) {
    throw new Error(`test database name exceeds ${String(MAX_IDENTIFIER_BYTES)} bytes: ${name}`);
  }
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Every database name this run may have created — one per worker the pool could
 * have started, since a run does not record which ones it actually used.
 *
 * Namespaced databases are per run and so accumulate; something has to drop them
 * or a long-lived shared server fills up with the debris of every suite that
 * ever ran against it. Dropping by enumeration rather than by a `LIKE` sweep is
 * deliberate: a pattern wide enough to catch this run's databases is also wide
 * enough to catch a concurrent run's, and a `DROP DATABASE` that lands on a
 * live worker is a worse failure than the leak it cleans up.
 */
export function runDatabaseNames(namespace: string, workers: number): string[] {
  // No namespace, no names of this run's own — `workerDatabaseUrl` would answer
  // the legacy un-namespaced `verity_test_wN`, which may well belong to a run
  // still using them. The guard lives with the derivation rather than only in
  // `dropRunDatabases`, so it travels with every caller this export gains.
  if (namespace === '') return [];
  return Array.from({ length: Math.max(0, workers) }, (_, index) =>
    decodeURIComponent(
      new URL(
        workerDatabaseUrl('postgres://h/postgres', String(index + 1), namespace),
      ).pathname.slice(1),
    ),
  );
}

/** Runs one statement on the admin connection and disposes of it again. */
async function executeOnAdmin(adminUrl: string, statement: string): Promise<void> {
  const admin = createPostgresDb(adminUrl);
  try {
    await sql.raw(statement).execute(admin);
  } finally {
    await admin.destroy();
  }
}

/**
 * Create this worker's database if it is not there yet and return its URL.
 *
 * `execute` is injectable so the branch below is testable without a live server
 * — the container that runs the suite has neither Postgres nor Docker, and
 * getting the duplicate-database case wrong would turn every worker after the
 * first into a hard failure.
 */
export async function ensureWorkerDatabase(
  adminUrl: string,
  execute: (adminUrl: string, statement: string) => Promise<void> = executeOnAdmin,
): Promise<string> {
  const target = workerDatabaseUrl(adminUrl);
  const name = decodeURIComponent(new URL(target).pathname.slice(1));
  try {
    // CREATE DATABASE cannot run inside a transaction, so this is deliberately a
    // bare statement. Every file in the worker tries it and all but the first lose
    // — that is the intended steady state, not an error worth surfacing.
    await execute(adminUrl, `create database "${name.replaceAll('"', '""')}"`);
  } catch (error) {
    if ((error as { code?: string }).code !== '42P04') throw error; // 42P04 = duplicate_database
  }
  return target;
}

/**
 * Drop the databases {@link runDatabaseNames} names, ignoring the ones that were
 * never created.
 *
 * `WITH (FORCE)` (PostgreSQL 13+) so a connection the pool has not finished
 * closing does not turn cleanup into a failed run: by the time this is called
 * the suite is over, and a lingering backend is a reason to disconnect it rather
 * than to keep its database forever.
 */
export async function dropRunDatabases(
  adminUrl: string,
  namespace: string,
  workers: number,
  execute: (adminUrl: string, statement: string) => Promise<void> = executeOnAdmin,
): Promise<void> {
  // Without a namespace the names below are the un-namespaced legacy ones, which
  // belong to whoever else is on this server rather than to this run. Dropping
  // nothing is the only safe reading of "clean up my databases" when the run
  // cannot say which ones are its own.
  if (namespace === '') return;
  for (const name of runDatabaseNames(namespace, workers)) {
    // Sequential, not `Promise.all`: each statement opens its own admin
    // connection, and a cleanup step is not worth a connection burst against a
    // server that may be serving other runs.
    await execute(adminUrl, `drop database if exists "${name.replaceAll('"', '""')}" with (force)`);
  }
}

/**
 * A fresh pglite-backed Kysely, NOT migrated (for migration tests). Always
 * pglite — an unmigrated database is precisely what the shared instance cannot
 * offer.
 *
 * Opened from a pre-built cluster on disk when there is one (see
 * `./pglite-template.ts`), which is most of a second and ~350 MB cheaper than
 * running `initdb` in this process, and in-memory otherwise. Both give the
 * caller the same thing: a private PostgreSQL with no migration table.
 */
export function createRawDb(): RawTestDb {
  const template = rawTemplateDir();
  if (template !== undefined) {
    const opened = tryOpenTemplate(template);
    if (opened !== undefined) return opened;
  }
  const db = createEmbeddedDb();
  return { db, close: () => db.destroy() };
}

/**
 * A migrated store for one test file, on the shared PostgreSQL when
 * {@link SHARED_POSTGRES_URL} is set and on a private pglite otherwise.
 *
 * The shared instance is reused across files, so it is truncated on handover: a
 * caller sees the same empty schema either way. What it does NOT offer is a
 * private *schema*, nor pglite's single serialized connection — use
 * {@link createIsolatedTestDb} for tests that migrate up or down, that need two
 * independent databases alive at once, or that leave writes in flight across a
 * `truncateAll`.
 */
export async function createTestDb(): Promise<TestDb> {
  if (SHARED_POSTGRES_URL === undefined) return await createIsolatedTestDb();
  const db = createPostgresDb(await ensureWorkerDatabase(SHARED_POSTGRES_URL));
  await migrateToLatest(db); // idempotent; a no-op once the worker's database exists
  await truncateAll(db);
  return wrap(db, () => db.destroy());
}

/**
 * A migrated store on a private pglite, never the shared instance. For tests that
 * mutate the schema (`Migrator.migrateTo`) or compare two live databases — both
 * of which would otherwise corrupt every later file in the same worker.
 *
 * Also for files that leave background writes in flight when `truncateAll` runs.
 * pglite is one connection and serializes: a write issued before the truncate
 * lands before it. The shared path is a `pg.Pool`, where the truncate runs on a
 * different connection and can overtake that write — it then reappears in the
 * next test, or deadlocks against it (TRUNCATE takes AccessExclusiveLock on
 * every table while the stray query holds AccessShareLock on some of them).
 * Prefer draining the background work; reach for this when there is no hook to
 * drain it with (see `packages/server/src/app.test.ts`).
 */
export async function createIsolatedTestDb(): Promise<TestDb> {
  // A template that is already migrated to head, when one could be built. The
  // `migrateToLatest` below still runs against it and is a no-op — the same
  // shape as the shared-PostgreSQL path above, and the reason a stale template
  // could only ever cost time: anything the cluster is missing, the migrator
  // applies.
  const template = await migratedTemplateDir(migrateToLatest);
  const opened = template === undefined ? undefined : tryOpenTemplate(template);
  const { db, close } = opened ?? createRawDb();
  await migrateToLatest(db);
  return wrap(db, close);
}

function wrap(db: Kysely<Database>, close: () => Promise<void>): TestDb {
  const store = new EventStore(db);
  return {
    db,
    store,
    close: async () => {
      await store.waitForMessageProjectionIdle();
      await close();
    },
  };
}

/**
 * Reset all data to empty (and restart identity sequences) without re-creating
 * the database. Lets a test file share ONE migrated pglite instance across tests
 * — far cheaper than a fresh PGlite per test — by truncating between them.
 */
export async function truncateAll(db: Kysely<Database>): Promise<void> {
  // Every queue, not just the ordered live one: a projection backfill runs on
  // its own pool connection, and TRUNCATE wants AccessExclusiveLock on tables it
  // is midway through reading — the two deadlock (40P01) instead of one waiting
  // for the other. pglite hid this behind its single serialized connection;
  // the shared PostgreSQL does not.
  await waitForMessageProjectionWork(db);
  // `projects` is truncated first (it's referenced by `sessions.project_id` via
  // a SET NULL FK — cascade bounces through `sessions` so include both).
  await sql`truncate table workflow_commands, workflow_dispatch_outbox, workflow_provider_inbox, workflow_events, workflow_policy_decisions, workflow_artifacts, workflow_results, workflow_handoffs, workflow_steps, workflows, workflow_services, control_plane_generation, uplink_pending_share_removals, transcript_lines, events, queued_turns, running_turns, runner_frames, session_pending_note, session_automation_marker, sessions, attachments, secret_audit_events, audit_mac_keys, secret_job_frames, secret_jobs, secret_revocations, secret_approvals, secret_run_grants, agent_loop_runs, agent_loops, public_preview_shares, dev_server_detection_state, dev_servers, claude_egress_client_certs, claude_egress_ca, project_settings, verity_settings, secret_key_meta, push_receipts, device_push_tokens, auth_tokens, session_backend_state, project_identity_claims, projects restart identity cascade`.execute(
    db,
  );
}
