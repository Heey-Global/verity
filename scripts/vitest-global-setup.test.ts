import { afterEach, describe, expect, it, vi } from 'vitest';

import setup from './vitest-global-setup.js';
import { MAX_TEST_WORKERS, TEARDOWN_WORKERS } from './test-postgres.js';

// Mocked rather than injected: the file under test imports this module for one
// call in its teardown, and the real one reaches kysely and pglite — which is
// precisely what that import is deferred to avoid loading here.
const dropRunDatabases = vi.hoisted(() => vi.fn());
vi.mock('../packages/store/src/testing.js', () => ({ dropRunDatabases }));

/**
 * Whether teardown drops anything is the highest-consequence decision in that
 * file: `drop database ... with (force)` disconnects live backends, so getting
 * it wrong against a namespace someone else pinned takes down a running process
 * rather than leaking disk. `setUpSharedPostgres` deciding `minted` correctly is
 * covered next door; what is covered here is that the teardown honours it.
 *
 * Driven through the explicit-URL path, so no cluster is involved and the URL is
 * never connected to — `dropRunDatabases` is the seam, and it is mocked.
 */
describe('the vitest global setup', () => {
  const admin = 'postgres://verity@gateway:5432/postgres';

  // Through `vi.unstubAllEnvs` rather than by replacing `process.env` wholesale:
  // the function under test writes into that object, and swapping it for a plain
  // copy would leave the worker without Node's real env for the rest of its life.
  afterEach(() => {
    vi.unstubAllEnvs();
    dropRunDatabases.mockClear();
  });

  // Cleared, not merely overwritten. This very file's production counterpart
  // publishes VERITY_TEST_DB_NAMESPACE into `process.env` before the workers
  // fork, so in any run that found a shared PostgreSQL — the devcontainer this
  // branch exists for, and every CI job using `.github/actions/postgres` — a
  // namespace is already there and `minted` comes back false for a reason that
  // has nothing to do with the case under test.
  const run = async (env: Record<string, string>): Promise<void> => {
    for (const name of [
      'VERITY_TEST_SHARED_POSTGRES_URL',
      'VERITY_TEST_DB_NAMESPACE',
      'VERITY_TEST_LOCAL_POSTGRES',
      'VERITY_TEST_POSTGRES_ROOT',
    ]) {
      vi.stubEnv(name, undefined);
    }
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value);
    }
    await (
      await setup()
    )();
  };

  it('drops the databases of a namespace it minted itself', async () => {
    await run({ VERITY_TEST_SHARED_POSTGRES_URL: admin });
    expect(dropRunDatabases).toHaveBeenCalledTimes(1);
    expect(dropRunDatabases).toHaveBeenCalledWith(
      admin,
      // Whatever was minted — and published, since the workers read it from here.
      process.env.VERITY_TEST_DB_NAMESPACE,
      TEARDOWN_WORKERS,
    );
  });

  it('leaves a namespace it was handed alone', async () => {
    // Pinning one is documented as a way to reuse a database across runs, or to
    // aim two processes at the same set. Both are destroyed by a teardown that
    // sweeps it — the second one mid-test.
    await run({ VERITY_TEST_SHARED_POSTGRES_URL: admin, VERITY_TEST_DB_NAMESPACE: 'pinned' });
    expect(dropRunDatabases).not.toHaveBeenCalled();
  });

  it('looks past the worker count the config asks for', async () => {
    // `--maxWorkers=8` widens the pool without touching vitest.config.ts, and a
    // database created by worker 3 that teardown never names is one nothing ever
    // drops on a server built to outlive the run. Asserted through the call
    // rather than on the constant alone: what matters is that teardown is the
    // thing that received the wider bound.
    await run({ VERITY_TEST_SHARED_POSTGRES_URL: admin });
    const workers = dropRunDatabases.mock.calls[0]?.[2] as number;
    expect(workers).toBe(TEARDOWN_WORKERS);
    expect(workers).toBeGreaterThan(MAX_TEST_WORKERS);
    expect(workers).toBeGreaterThan(8);
  });
});
