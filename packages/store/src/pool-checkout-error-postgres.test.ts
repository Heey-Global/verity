import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPostgresDb } from './db.js';
import type { Database } from './schema.js';

/**
 * Real-Postgres coverage for the half of a pooled connection's life that
 * `db-postgres.test.ts` cannot see.
 *
 * That file mocks `pg` to prove the mandatory `pool.on('error')` handler is
 * wired, and a mock is the wrong instrument for what is asserted here, because
 * the hazard lives in `pg`'s own listener bookkeeping rather than in ours: `pg`
 * attaches the listener behind `pool.on('error')` only while a client sits IDLE
 * IN THE POOL. It removes that listener at checkout and re-attaches it at
 * release, so for the whole checked-out window the client has no 'error'
 * listener — and node turns an 'error' event with no listener into an uncaught
 * exception that takes the process down.
 *
 * A checked-out connection sits idle between statements constantly: inside every
 * Kysely transaction, and inside the fenced serving pool's `verify` hook, which
 * spends two round trips taking the control-plane shared lock and reading the
 * generation row before the pool will hand the connection out. `FATAL 57P01`
 * ("terminating connection due to administrator command") is what a PostgreSQL
 * restart delivers into that window, which made the keeper's own restart-
 * survival suite kill its worker rather than fail an assertion — the crash this
 * control plane exists to prevent, arriving through the client library.
 *
 * The window is opened here deliberately rather than waited for: hold a
 * connection checked out, terminate its backend from a second connection, and
 * let it sit. Without the guard in `createPostgresDb` this is a hard crash on
 * every run; with it, the error is reported and the pool recovers.
 */
const connectionString = process.env.VERITY_TEST_POSTGRES_URL;
const describePostgres = connectionString === undefined ? describe.skip : describe;

describePostgres('pooled connection error handling (PostgreSQL)', () => {
  let db: Kysely<Database>;
  let executioner: Kysely<Database>;

  beforeAll(() => {
    db = createPostgresDb(connectionString!);
    executioner = createPostgresDb(connectionString!);
  });

  afterAll(async () => {
    await Promise.all([db.destroy(), executioner.destroy()]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Kill one backend by pid, so no other suite sharing this database is touched. */
  async function terminate(pid: number): Promise<void> {
    await sql`select pg_terminate_backend(${pid})`.execute(executioner);
  }

  /**
   * Wait for the guard to report, on a deadline rather than a fixed delay.
   *
   * The FATAL has to travel back from PostgreSQL, and this suite shares a
   * loaded CI host with five other runner lanes; a sleep long enough to be safe
   * there would be a sleep, and one short enough to be quick would be a race.
   */
  async function reportedWhileCheckedOut(calls: () => unknown[][]): Promise<boolean> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const seen = calls().some((call) =>
        String(call[0]).includes('postgres client error while checked out'),
      );
      if (seen) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it('survives its backend dying while the connection is checked out', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // `connection()` pins ONE pooled client for the callback's whole duration —
    // the same hold a transaction and the fenced `verify` hook take, and the
    // hold during which `pg` has no 'error' listener attached.
    let guarded = false;
    await db.connection().execute(async (held) => {
      const backend = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(held);
      const pid = backend.rows[0]?.pid;
      expect(pid).toBeGreaterThan(0);
      await terminate(pid!);
      // The kill lands here, between two statements, with the connection idle
      // and still checked out. Reaching the end of this callback at all is half
      // the assertion: an unguarded client takes the process down instead.
      guarded = await reportedWhileCheckedOut(() => reported.mock.calls);
    });

    expect(guarded).toBe(true);
  }, 30_000);

  it('serves the next query on a replacement connection', async () => {
    // The dead connection above must not be handed out again: recovering from
    // the crash is worth nothing if the pool keeps a corpse in rotation.
    const result = await sql<{ ok: number }>`select 1 as ok`.execute(db);
    expect(result.rows[0]?.ok).toBe(1);
  });
});
