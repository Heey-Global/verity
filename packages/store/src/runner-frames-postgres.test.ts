import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresDb, migrateToLatest } from './db.js';
import type { Database } from './schema.js';
import { EventStore, RUNNER_FRAME_PROTOCOL_VERSION, type RunnerFrameIngest } from './store.js';

/**
 * Real-Postgres race coverage for ADR 0006 D4 (frame ingest) and D7 (the event
 * append two overlapping Servers contend for). Unlike the PGlite seam tests, the
 * stores below own independent pg pools and therefore cannot share the
 * EventStore's in-process queues — the advisory locks are all that orders them,
 * which is exactly what these tests exist to exercise.
 */

const connectionString = process.env.VERITY_TEST_POSTGRES_URL;
const describePostgres = connectionString === undefined ? describe.skip : describe;
const INSTANCE = 'runner-postgres-race';
// These suites own four independent pools so they genuinely model overlapping
// Servers. On a loaded self-hosted runner, draining all four after the shared
// outage/race shard can exceed Vitest's generic 20-second hook budget even though
// every query and assertion has already completed. Keep the larger budget local
// to this cleanup; production deadlines and test execution timeouts stay strict.
const POSTGRES_POOL_CLEANUP_TIMEOUT_MS = 60_000;

function frame(
  turnId: string,
  frameSeq: number,
  over: Partial<RunnerFrameIngest> = {},
): RunnerFrameIngest {
  return {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    runnerInstanceId: INSTANCE,
    turnId,
    frameSeq,
    payloadHash: `${turnId}-h${frameSeq}`,
    ...over,
  };
}

async function waitForAdvisoryWaiters(db: Kysely<Database>, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await sql<{ count: number }>`
      select count(*)::int as count
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and wait_event = 'advisory'
    `.execute(db);
    if ((result.rows[0]?.count ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${count} PostgreSQL advisory-lock waiters`);
}

/**
 * Run both operations from a standstill: a third connection holds the advisory
 * lock they need, so neither can commit until both are provably queued on it.
 * `lockKey` is the string the contended lock hashes — a turn id for the frame
 * ingest lock, `events:<sessionId>` for the event append lock.
 */
async function raceBehindAdvisoryBarrier<T>(
  lockKey: string,
  gateDb: Kysely<Database>,
  observerDb: Kysely<Database>,
  operations: readonly [() => Promise<T>, () => Promise<T>],
): Promise<PromiseSettledResult<T>[]> {
  let releaseBarrier!: () => void;
  let barrierAcquired!: () => void;
  let barrierFailed!: (error: unknown) => void;
  const release = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const acquired = new Promise<void>((resolve, reject) => {
    barrierAcquired = resolve;
    barrierFailed = reject;
  });
  const barrier = gateDb.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`.execute(tx);
    barrierAcquired();
    await release;
  });
  const barrierOutcome = barrier.then(
    () => ({ ok: true as const }),
    (error: unknown) => {
      barrierFailed(error);
      return { ok: false as const, error };
    },
  );

  let settled: Promise<PromiseSettledResult<T>[]> | undefined;
  let barrierError: unknown;
  try {
    await acquired;
    settled = Promise.allSettled(operations.map((operation) => operation()));
    await waitForAdvisoryWaiters(observerDb, 2);
  } finally {
    releaseBarrier();
    const outcome = await barrierOutcome;
    if (!outcome.ok) barrierError = outcome.error;
  }
  if (barrierError !== undefined) {
    throw barrierError instanceof Error
      ? barrierError
      : new Error('PostgreSQL advisory barrier failed', { cause: barrierError });
  }
  if (settled === undefined) throw new Error('advisory barrier released before operations started');
  return await settled;
}

describePostgres('EventStore.ingestRunnerFrame two-server races (PostgreSQL)', () => {
  let dbA: Kysely<Database>;
  let dbB: Kysely<Database>;
  let gateDb: Kysely<Database>;
  let observerDb: Kysely<Database>;
  let storeA: EventStore;
  let storeB: EventStore;

  beforeAll(async () => {
    dbA = createPostgresDb(connectionString!);
    dbB = createPostgresDb(connectionString!);
    gateDb = createPostgresDb(connectionString!);
    observerDb = createPostgresDb(connectionString!);
    await migrateToLatest(observerDb);
    storeA = new EventStore(dbA);
    storeB = new EventStore(dbB);
  });

  afterAll(async () => {
    await Promise.all([dbA.destroy(), dbB.destroy(), gateDb.destroy(), observerDb.destroy()]);
  }, POSTGRES_POOL_CLEANUP_TIMEOUT_MS);

  it('deduplicates the same terminal frame across overlapping Servers', async () => {
    const sessionId = 'postgres-race-replay-session';
    const turnId = 'postgres-race-replay-turn';
    await storeA.createSession({
      sessionId,
      worktree: '/wt/postgres-race/replay',
      model: 'claude',
    });
    await storeA.markTurnRunning({ sessionId, promptSeq: 1 });
    await storeA.bindTurnIdentity(sessionId, { turnId, startCommandId: 'start-race-replay' });
    const terminal = frame(turnId, 1, { terminal: true });

    const outcomes = await raceBehindAdvisoryBarrier(turnId, gateDb, observerDb, [
      () => storeA.ingestRunnerFrame(sessionId, terminal),
      () => storeB.ingestRunnerFrame(sessionId, terminal),
    ]);

    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    expect(
      outcomes.map((outcome) =>
        outcome.status === 'fulfilled' ? outcome.value.outcome : 'rejected',
      ),
    ).toEqual(expect.arrayContaining(['accepted', 'duplicate']));
    expect(
      (
        await observerDb
          .selectFrom('runner_frames')
          .select(['frame_seq', 'terminal'])
          .where('turn_id', '=', turnId)
          .execute()
      ).map((row) => ({ ...row, frame_seq: Number(row.frame_seq) })),
    ).toEqual([{ frame_seq: 1, terminal: true }]);
    expect((await storeA.listRunningTurns()).filter((row) => row.turnId === turnId)).toEqual([]);
  });

  it('serializes conflicting terminal sequences across overlapping Servers', async () => {
    const sessionId = 'postgres-race-conflict-session';
    const turnId = 'postgres-race-conflict-turn';
    await storeA.createSession({
      sessionId,
      worktree: '/wt/postgres-race/conflict',
      model: 'codex',
    });
    await storeA.markTurnRunning({ sessionId, promptSeq: 1 });
    await storeA.bindTurnIdentity(sessionId, { turnId, startCommandId: 'start-race-conflict' });
    await storeA.ingestRunnerFrame(sessionId, frame(turnId, 1));

    const outcomes = await raceBehindAdvisoryBarrier(turnId, gateDb, observerDb, [
      () => storeA.ingestRunnerFrame(sessionId, frame(turnId, 2, { terminal: true })),
      () => storeB.ingestRunnerFrame(sessionId, frame(turnId, 3, { terminal: true })),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(
      (
        await observerDb
          .selectFrom('runner_frames')
          .select(['frame_seq', 'terminal'])
          .where('turn_id', '=', turnId)
          .orderBy('frame_seq', 'asc')
          .execute()
      ).map((row) => ({ ...row, frame_seq: Number(row.frame_seq) })),
    ).toEqual([
      { frame_seq: 1, terminal: false },
      { frame_seq: 2, terminal: true },
    ]);
    expect((await storeB.listRunningTurns()).filter((row) => row.turnId === turnId)).toEqual([]);
  });
});

describePostgres('EventStore event-append ordering across overlapping Servers (PostgreSQL)', () => {
  let dbA: Kysely<Database>;
  let dbB: Kysely<Database>;
  let gateDb: Kysely<Database>;
  let observerDb: Kysely<Database>;
  let storeA: EventStore;
  let storeB: EventStore;

  beforeAll(async () => {
    dbA = createPostgresDb(connectionString!);
    dbB = createPostgresDb(connectionString!);
    gateDb = createPostgresDb(connectionString!);
    observerDb = createPostgresDb(connectionString!);
    await migrateToLatest(observerDb);
    storeA = new EventStore(dbA);
    storeB = new EventStore(dbB);
  });

  afterAll(async () => {
    await Promise.all([dbA.destroy(), dbB.destroy(), gateDb.destroy(), observerDb.destroy()]);
  }, POSTGRES_POOL_CLEANUP_TIMEOUT_MS);

  it('never lands a dead-turn verdict behind an append it could not see', async () => {
    // The hole this closes: `appendEventForRunningTurn` tests "has this session
    // spoken since I formed my verdict?" under READ COMMITTED, where a concurrent
    // UNCOMMITTED append is invisible to the predicate yet takes the lower id. In
    // one process the per-session append tail hides that; two Server generations
    // overlap across processes during reattach, so only the advisory lock both
    // appends take can order them — and PGlite, being single-connection, cannot
    // exercise it at all.
    const sessionId = 'postgres-race-append-session';
    const turnId = 'postgres-race-append-turn';
    await storeA.createSession({
      sessionId,
      worktree: '/wt/postgres-race/append',
      model: 'claude',
    });
    const { seq: promptSeq } = await storeA.appendEvent(sessionId, { t: 'prompt', text: 'go' });
    await storeA.markTurnRunning({ sessionId, promptSeq });
    await storeA.bindTurnIdentity(sessionId, { turnId, startCommandId: 'start-race-append' });
    const anchor = {
      promptSeq,
      turnId,
      silentSinceSeq: await storeA.latestEventSeq(sessionId),
    };

    // Generation A's Runner speaks; generation B, holding a verdict formed while
    // the session was still silent, declares the same turn dead. Both start from a
    // standstill on `events:<sessionId>`, so each is genuinely in flight when the
    // other commits.
    const outcomes = await raceBehindAdvisoryBarrier<{ seq: number; ts: number } | null>(
      `events:${sessionId}`,
      gateDb,
      observerDb,
      [
        () => storeA.appendEvent(sessionId, { t: 'text', delta: 'still working' }),
        () =>
          storeB.appendEventForRunningTurn(sessionId, anchor, {
            t: 'notice',
            role: 'agent',
            text: 'runner is gone',
          }),
      ],
    );

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    const verdict = outcomes[1]?.status === 'fulfilled' ? outcomes[1].value : undefined;
    const written = (
      await observerDb
        .selectFrom('events')
        .select('type')
        .where('session_id', '=', sessionId)
        .orderBy('id', 'asc')
        .execute()
    ).map((row) => row.type);

    // Whichever won the lock, the verdict never ends up BEHIND the speech that
    // refutes it: it either goes first, or it sees the delta and writes nothing.
    if (verdict === null) {
      expect(written).toEqual(['prompt', 'text']);
    } else {
      expect(written).toEqual(['prompt', 'notice', 'text']);
    }
  });

  it('atomically chooses between a late Runner frame and a stalled-turn fence', async () => {
    const sessionId = 'postgres-race-stalled-fence-session';
    const turnId = 'postgres-race-stalled-fence-turn';
    await storeA.createSession({
      sessionId,
      worktree: '/wt/postgres-race/stalled-fence',
      model: 'codex',
    });
    const { seq: promptSeq } = await storeA.appendEvent(sessionId, { t: 'prompt', text: 'go' });
    await storeA.markTurnRunning({ sessionId, promptSeq });
    await storeA.bindTurnIdentity(sessionId, {
      turnId,
      startCommandId: 'start-race-stalled-fence',
    });
    const anchor = {
      sessionId,
      promptSeq,
      startedAt: new Date(),
      turnId,
      startCommandId: 'start-race-stalled-fence',
    };
    const latestSeq = await storeA.latestEventSeq(sessionId);

    const outcomes = await raceBehindAdvisoryBarrier<unknown>(
      `events:${sessionId}`,
      gateDb,
      observerDb,
      [
        () =>
          storeA.ingestRunnerFrame(
            sessionId,
            frame(turnId, 1, { event: { t: 'text', delta: 'still working' } }),
          ),
        () => storeB.fenceRunningTurnIfSilent(anchor, latestSeq),
      ],
    );

    const frameOutcome = outcomes[0];
    const fenceOutcome = outcomes[1];
    expect(fenceOutcome?.status).toBe('fulfilled');
    if (frameOutcome?.status === 'fulfilled') {
      expect(fenceOutcome).toMatchObject({ value: null });
      expect((await storeA.getEvents(sessionId)).at(-1)).toMatchObject({
        t: 'text',
        delta: 'still working',
      });
    } else {
      expect(fenceOutcome).not.toMatchObject({ value: null });
      expect(frameOutcome?.reason).toBeInstanceOf(Error);
      expect(String(frameOutcome?.reason)).toMatch(/abandoned/i);
    }
  });
});
