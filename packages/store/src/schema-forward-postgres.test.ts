import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresDb, migrateToLatest, SchemaGenerationAheadError } from './db.js';
import { latestMigrationKey, migrationProvider } from './migrations.js';
import type { Database } from './schema.js';

/**
 * Real-Postgres coverage for the ONE property the PGlite tests in `db.test.ts`
 * cannot reach: that the forward-compatibility decision is serialised against a
 * newer Server that is mid-migration.
 *
 * PGlite multiplexes every Kysely "connection" onto a single PGlite client (see
 * `./pglite.ts`), and a session-level advisory lock is re-entrant within one
 * session — so on PGlite `pg_advisory_lock` cannot block anybody, and the
 * concurrent shape below is not expressible. `db.test.ts` therefore pins that the
 * decision happens WHILE the lock is held (observable in `pg_locks` even in one
 * session); this file pins what that buys: an older build cannot observe a batch
 * the newer build has half committed.
 *
 * The batch runs with `disableTransactions` so each migration commits its own
 * ledger row. That is what makes a partial batch OBSERVABLE at all — with
 * Postgres's transactional DDL, Kysely's default wraps a whole batch in one
 * transaction and an interrupted run leaves no rows behind. Two states must be
 * kept apart and only the lock can tell them apart, because the ledger looks
 * identical in both: "the database is at 9998 because that run finished" and "the
 * database is at 9998 because a run is still going". The first is safe to start
 * on with a promise that covers 9998; the second is not.
 */
const connectionString = process.env.VERITY_TEST_POSTGRES_URL;
const describePostgres = connectionString === undefined ? describe.skip : describe;

/** Two synthetic generations, sorting after every real migration. */
const HEAD = '9998_bridge_head';
const TAIL = '9999_bridge_tail';

/** A release-controlled promise, as `SERVER_COMPAT.schema.max` supplies it. */
const promising = (forwardMax: string): { readonly forwardMax: string } => ({ forwardMax });

function blocking(gate: Promise<void>): Migration {
  return { up: () => gate, down: () => Promise.resolve() };
}

const noop: Migration = { up: () => Promise.resolve(), down: () => Promise.resolve() };

/** A migration that fails, to interrupt a batch part-way through. */
const dying: Migration = {
  up: () => Promise.reject(new Error('batch dies here')),
  down: () => Promise.resolve(),
};

/** Wait until `name` is committed in the ledger, as any third session sees it. */
async function waitForLedgerRow(db: Kysely<Database>, name: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await sql<{ present: boolean }>`
      select exists (select 1 from kysely_migration where name = ${name}) as present
    `.execute(db);
    if (result.rows[0]?.present === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for the ledger row ${name}`);
}

/**
 * Wait until at least one backend is queued on an advisory lock — the same
 * `pg_stat_activity` probe `runner-frames-postgres.test.ts` uses to prove two
 * operations are provably contending rather than merely slow.
 */
async function waitForAdvisoryWaiter(db: Kysely<Database>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await sql<{ count: number }>`
      select count(*)::int as count
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock' and wait_event = 'advisory'
    `.execute(db);
    if ((result.rows[0]?.count ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for a PostgreSQL advisory-lock waiter');
}

describePostgres('a newer generation migrating while an older build starts', () => {
  let observer: Kysely<Database>;

  beforeAll(async () => {
    observer = createPostgresDb(connectionString as string);
    await migrateToLatest(observer);
  });

  /**
   * Clear the synthetic rows between cases. Without this the SECOND case finds
   * them already in the ledger from the first, so its batch has nothing pending,
   * never blocks, never takes the lock — and the test would assert contention
   * against a batch that already finished.
   */
  afterEach(async () => {
    await sql`delete from kysely_migration where name in (${HEAD}, ${TAIL})`.execute(observer);
  });

  afterAll(async () => {
    await observer.destroy();
  });

  /**
   * Drive the newer generation's batch up to the point where `HEAD` is committed
   * and `TAIL` is still running, then run `body` while it is parked there. The
   * newer session holds Kysely's migration lock throughout.
   */
  const withHalfAppliedBatch = async (
    body: (releaseBatch: () => void) => Promise<void>,
  ): Promise<void> => {
    const newer = createPostgresDb(connectionString as string);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: MigrationProvider = {
      getMigrations: async () => ({
        ...(await migrationProvider.getMigrations()),
        [HEAD]: noop,
        [TAIL]: blocking(gate),
      }),
    };
    const batch = new Migrator({
      db: newer,
      provider,
      disableTransactions: true,
    }).migrateToLatest();
    try {
      await waitForLedgerRow(observer, HEAD);
      await body(release);
    } finally {
      release();
      const { error } = await batch;
      expect(error).toBeUndefined();
      await newer.destroy();
    }
  };

  it('makes the older build wait for the batch instead of accepting its committed prefix', async () => {
    await withHalfAppliedBatch(async (releaseBatch) => {
      const older = createPostgresDb(connectionString as string);
      try {
        // The promise covers exactly the committed prefix, so a decision taken on
        // an unlocked read would accept here and the Server would start serving
        // on a schema the newer generation is still writing.
        let settled = false;
        const start = migrateToLatest(older, migrationProvider, promising(HEAD)).then(
          () => {
            settled = true;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
        await waitForAdvisoryWaiter(observer);
        expect(settled).toBe(false);
        // Once the batch completes, the same call sees the WHOLE batch — and TAIL
        // is past the promise, so the only correct answer is a refusal.
        releaseBatch();
        await expect(start).resolves.toBeInstanceOf(SchemaGenerationAheadError);
        expect(settled).toBe(true);
      } finally {
        await older.destroy();
      }
    });
  });

  it('accepts the completed batch when the promise covers all of it', async () => {
    await withHalfAppliedBatch(async (releaseBatch) => {
      const older = createPostgresDb(connectionString as string);
      try {
        let settled = false;
        const start = migrateToLatest(older, migrationProvider, promising(TAIL)).then(() => {
          settled = true;
        });
        await waitForAdvisoryWaiter(observer);
        expect(settled).toBe(false);
        releaseBatch();
        await expect(start).resolves.toBeUndefined();
      } finally {
        await older.destroy();
      }
    });
  });

  it('leaves an interrupted default batch with no ledger rows to misread', async () => {
    // The control for `disableTransactions` above, and the reason a partial batch
    // is not reachable in production: Kysely's default wraps the batch in one
    // transaction, so a run that dies mid-batch commits nothing. This is a
    // characterisation of Kysely, not of the code under test — it passes with the
    // forward-compatibility fix removed, and exists so a future Kysely bump that
    // changed it would not quietly widen what an unlocked read could observe.
    const newer = createPostgresDb(connectionString as string);
    try {
      const provider: MigrationProvider = {
        getMigrations: async () => ({
          ...(await migrationProvider.getMigrations()),
          [HEAD]: noop,
          [TAIL]: dying,
        }),
      };
      const { error } = await new Migrator({ db: newer, provider }).migrateToLatest();
      expect((error as Error).message).toBe('batch dies here');
      const rows = await sql<{ name: string }>`
        select name from kysely_migration where name in (${HEAD}, ${TAIL})
      `.execute(newer);
      expect(rows.rows).toEqual([]);
      // And the real ledger is untouched, so the suites after this one are unaffected.
      const executed = await sql<{ name: string }>`
        select name from kysely_migration where name = ${latestMigrationKey()}
      `.execute(newer);
      expect(executed.rows).toHaveLength(1);
    } finally {
      await newer.destroy();
    }
  });
});
