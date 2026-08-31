import { setUpSharedPostgres, type SharedPostgres, TEARDOWN_WORKERS } from './test-postgres.js';

/**
 * Points the suite at one shared PostgreSQL when there is one, and drops the
 * databases it created when the run ends.
 *
 * This runs in the Vitest main process, before any worker is forked, so setting
 * `process.env` here is what the forked workers inherit — `packages/store/src/
 * testing.ts` reads both variables at module scope in each of them. That
 * inheritance is the whole mechanism; there is no other channel, which is why
 * this file assigns rather than using `provide`/`inject` (those would require
 * every one of the 52 database-using files to opt in).
 */
export default async function setup(): Promise<() => Promise<void>> {
  // Belt and braces around a function that already promises not to throw: an
  // exception out of globalSetup fails the whole run before a single test file
  // is loaded, and the fallback it would be denying — every file boots its own
  // pglite — is exactly what this repo did before the shared server existed.
  // Nothing about a speed optimisation is worth a red suite.
  let shared: SharedPostgres | undefined;
  try {
    shared = await setUpSharedPostgres();
  } catch (error) {
    console.warn(
      `[test-postgres] falling back to pglite: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (shared === undefined) {
    // Deleted rather than left as they were. `setUpSharedPostgres` treats an
    // empty string as unset — that is what an exported-but-unset variable looks
    // like — but `packages/store/src/testing.ts` reads the raw variable at
    // module scope in each forked worker and does not, so an empty URL surviving
    // this far makes every worker try to connect to it instead of booting
    // pglite. Whatever the environment held, the workers are told the truth: no
    // shared server.
    delete process.env.VERITY_TEST_SHARED_POSTGRES_URL;
    delete process.env.VERITY_TEST_DB_NAMESPACE;
    return async () => {};
  }

  process.env.VERITY_TEST_SHARED_POSTGRES_URL = shared.adminUrl;
  process.env.VERITY_TEST_DB_NAMESPACE = shared.namespace;

  // A namespace this run did not invent belongs to whoever pinned it — a run
  // being repeated against the same databases, or a second process deliberately
  // aimed at the same set. Dropping those would defeat both uses, and the second
  // one violently: `with (force)` disconnects backends the other process is
  // still using. Only a minted namespace is this run's to clean up.
  if (!shared.minted) return async () => {};

  return async () => {
    // Imported here, not at the top of the file: that module reaches kysely and
    // pglite, and this file is evaluated in Vitest's MAIN process on every run —
    // including every run that finds no server and never arrives here at all.
    const { dropRunDatabases } = await import('../packages/store/src/testing.js');

    // The server outlives the run on purpose — the next run reuses it, which is
    // where the saving comes from — so the databases have to go, or a long-lived
    // container accumulates one set per suite that ever ran in it. Cleanup
    // failure is reported and swallowed: the run's results are already decided by
    // the time this executes, and leaked test databases are a disk-space problem,
    // not a reason to turn a green run red.
    try {
      await dropRunDatabases(shared.adminUrl, shared.namespace, TEARDOWN_WORKERS);
    } catch (error) {
      console.warn(
        `[test-postgres] leaked databases for namespace ${shared.namespace}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}
