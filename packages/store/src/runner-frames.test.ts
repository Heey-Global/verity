import type { AgentEvent } from '@verity/events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RUNNER_FRAME_PROTOCOL_VERSION, type RunnerFrameIngest } from './store.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

/**
 * Idempotent Runner-frame ingestion (ADR 0006 D4): the restart-safe seam that lets a
 * new Server re-tail a turn's append-only frame file from byte zero without
 * duplicating events. These exercise the store transaction directly.
 */

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

const SESSION = { sessionId: 's1', worktree: '/wt/agent-s1', model: 'claude-opus-4-8' };
const TURN = 'turn-a';
const INSTANCE = 'runner-a';
const TEXT: AgentEvent = { t: 'text', delta: 'hello' };
const MORE: AgentEvent = { t: 'text', delta: 'world' };
/** The single `payload_hash` the store reserves: a row carrying it is a recovery fence,
 * never a Runner's frame (ADR 0006 D7 step 5). Spelled out here rather than imported so
 * a change to the sentinel has to be made deliberately on both sides. */
const FENCE_HASH = 'verity:abandoned-turn-fence';

/** A non-event frame (session/permission/result) that only claims its sequence slot.
 * `payloadHash` is opaque to the store apart from {@link FENCE_HASH}, so a fixed
 * per-seq token is enough. */
function slot(frameSeq: number, over: Partial<RunnerFrameIngest> = {}): RunnerFrameIngest {
  return {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    runnerInstanceId: INSTANCE,
    turnId: TURN,
    frameSeq,
    payloadHash: `h${frameSeq}`,
    ...over,
  };
}

/** An event frame — same envelope plus the event to persist. */
function ev(
  frameSeq: number,
  event: AgentEvent,
  over: Partial<RunnerFrameIngest> = {},
): RunnerFrameIngest {
  return { ...slot(frameSeq, over), event };
}

describe('EventStore.ingestRunnerFrame (ADR 0006 D4)', () => {
  beforeEach(async () => {
    // Event frames insert into `events`, whose session_id FK requires the row — the
    // Conductor creates it at session start in production.
    await ctx.store.createSession(SESSION);
  });

  it('persists a new event frame and returns accepted with its seq', async () => {
    const r = await ctx.store.ingestRunnerFrame('s1', ev(1, TEXT));
    expect(r.outcome).toBe('accepted');
    expect(r.seq).toBeGreaterThan(0);
    expect(typeof r.ts).toBe('number');
    expect(await ctx.store.getEvents('s1')).toEqual([TEXT]);
  });

  it('claims a non-event frame without persisting an event', async () => {
    const r = await ctx.store.ingestRunnerFrame('s1', slot(1));
    expect(r).toEqual({ outcome: 'accepted' });
    expect(await ctx.store.getEvents('s1')).toEqual([]);
  });

  it('atomically claims a terminal frame and closes only its bound running turn', async () => {
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: 1 });
    await ctx.store.bindTurnIdentity('s1', { turnId: TURN, startCommandId: 'start-a' });

    await ctx.store.ingestRunnerFrame('s1', slot(1));
    await expect(ctx.store.ingestRunnerFrame('s1', slot(2, { terminal: true }))).resolves.toEqual({
      outcome: 'accepted',
    });

    expect(await ctx.store.listRunningTurns()).toEqual([]);
    await expect(ctx.store.ingestRunnerFrame('s1', slot(3))).rejects.toThrow(/already terminated/i);
  });

  it('replays the same terminal frame as a duplicate without touching a newer marker', async () => {
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: 1 });
    await ctx.store.bindTurnIdentity('s1', { turnId: TURN, startCommandId: 'start-a' });
    const terminal = slot(1, { terminal: true });
    await ctx.store.ingestRunnerFrame('s1', terminal);

    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: 2 });
    await ctx.store.bindTurnIdentity('s1', {
      turnId: 'turn-new',
      startCommandId: 'start-new',
    });
    await expect(ctx.store.ingestRunnerFrame('s1', terminal)).resolves.toEqual({
      outcome: 'duplicate',
    });
    expect(await ctx.store.listRunningTurns()).toEqual([
      expect.objectContaining({ sessionId: 's1', promptSeq: 2, turnId: 'turn-new' }),
    ]);
  });

  it('promotes a legacy result claim on replay and closes its matching marker', async () => {
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: 1 });
    await ctx.store.bindTurnIdentity('s1', { turnId: TURN, startCommandId: 'start-a' });
    // An older Server claimed the result before the terminal column existed.
    const legacyResult = slot(1);
    await ctx.store.ingestRunnerFrame('s1', legacyResult);
    expect((await ctx.store.listRunningTurns()).map((row) => row.turnId)).toEqual([TURN]);

    await expect(
      ctx.store.ingestRunnerFrame('s1', { ...legacyResult, terminal: true }),
    ).resolves.toEqual({ outcome: 'duplicate' });
    expect(await ctx.store.listRunningTurns()).toEqual([]);
    await expect(ctx.store.ingestRunnerFrame('s1', slot(2))).rejects.toThrow(/already terminated/i);
  });

  it('rejects a second terminal result at a later sequence', async () => {
    await ctx.store.ingestRunnerFrame('s1', slot(1, { terminal: true }));
    await expect(ctx.store.ingestRunnerFrame('s1', slot(2, { terminal: true }))).rejects.toThrow(
      /already terminated/i,
    );
  });

  it('rejects a frame that is both an event and terminal', async () => {
    await expect(
      ctx.store.ingestRunnerFrame('s1', ev(1, TEXT, { terminal: true })),
    ).rejects.toThrow(/cannot also carry an event/i);
    expect(await ctx.store.getEvents('s1')).toEqual([]);
  });

  it('rejects a later frame that tries to rebind the turn to another session', async () => {
    await ctx.store.createSession({
      sessionId: 's2',
      worktree: '/wt/agent-s2',
      model: 'claude-opus-4-8',
    });
    await ctx.store.ingestRunnerFrame('s1', slot(1));
    await expect(ctx.store.ingestRunnerFrame('s2', slot(2))).rejects.toThrow(
      /bound to session s1/i,
    );
    expect(await ctx.store.getEvents('s2')).toEqual([]);
  });

  it('serializes concurrent terminal claims so only one sequence commits', async () => {
    await ctx.store.ingestRunnerFrame('s1', slot(1));
    const outcomes = await Promise.allSettled([
      ctx.store.ingestRunnerFrame('s1', slot(2, { terminal: true })),
      ctx.store.ingestRunnerFrame('s1', slot(3, { terminal: true })),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

    // `frame_seq` is int8, and node-postgres returns int8 as a STRING (pglite as a
    // number) — so the raw row shape differs by driver even though the stored value
    // does not. Normalize before asserting, exactly as the dedicated real-Postgres
    // suite does (runner-frames-postgres.test.ts) and as the one production reader
    // does (runner-claude-live-server.ts). Asserting the bare row would pin this
    // test to pglite's coercion, i.e. to something production never sees.
    const claims = (
      await ctx.db
        .selectFrom('runner_frames')
        .select(['frame_seq', 'terminal'])
        .where('turn_id', '=', TURN)
        .orderBy('frame_seq', 'asc')
        .execute()
    ).map((row) => ({ ...row, frame_seq: Number(row.frame_seq) }));
    expect(claims).toEqual([
      { frame_seq: 1, terminal: false },
      { frame_seq: 2, terminal: true },
    ]);
  });

  it('deduplicates a replayed event frame: no second event, same seq returned', async () => {
    const first = await ctx.store.ingestRunnerFrame('s1', ev(1, TEXT));
    const replay = await ctx.store.ingestRunnerFrame('s1', ev(1, TEXT));
    expect(replay.outcome).toBe('duplicate');
    expect(replay.seq).toBe(first.seq);
    expect(replay.ts).toBe(first.ts);
    // The event was persisted exactly once.
    expect(await ctx.store.getEvents('s1')).toEqual([TEXT]);
  });

  it('re-tailing a whole turn from the start is idempotent (the crash-replay case)', async () => {
    const turn = [slot(1), ev(2, TEXT), ev(3, MORE), slot(4)];
    for (const f of turn) await ctx.store.ingestRunnerFrame('s1', f);
    // A new Server re-tails the same file from byte zero after a crash.
    const replayOutcomes = [];
    for (const f of turn) replayOutcomes.push(await ctx.store.ingestRunnerFrame('s1', f));
    expect(replayOutcomes.every((r) => r.outcome === 'duplicate')).toBe(true);
    // Only the two event frames ever produced events — the replay added nothing.
    expect(await ctx.store.getEvents('s1')).toEqual([TEXT, MORE]);
  });

  it('rejects a gap in the sequence (non-contiguous frame_seq)', async () => {
    await ctx.store.ingestRunnerFrame('s1', ev(1, TEXT));
    await expect(ctx.store.ingestRunnerFrame('s1', ev(3, MORE))).rejects.toThrow(/gap/i);
    // The rejected frame persisted nothing.
    expect(await ctx.store.getEvents('s1')).toEqual([TEXT]);
  });

  it('rejects a frame that rebinds the turn to a different runner instance', async () => {
    await ctx.store.ingestRunnerFrame('s1', ev(1, TEXT));
    await expect(
      ctx.store.ingestRunnerFrame('s1', ev(2, MORE, { runnerInstanceId: 'runner-b' })),
    ).rejects.toThrow(/corruption/i);
    expect(await ctx.store.getEvents('s1')).toEqual([TEXT]);
  });

  it('rejects a replay whose payload hash changed under the same sequence', async () => {
    await ctx.store.ingestRunnerFrame('s1', ev(1, TEXT));
    await expect(
      ctx.store.ingestRunnerFrame('s1', ev(1, TEXT, { payloadHash: 'tampered' })),
    ).rejects.toThrow(/corruption/i);
    expect(await ctx.store.getEvents('s1')).toEqual([TEXT]);
  });

  it('rejects an unsupported protocol version', async () => {
    await expect(
      ctx.store.ingestRunnerFrame('s1', ev(1, TEXT, { protocolVersion: 99 })),
    ).rejects.toThrow(/protocol version/i);
    expect(await ctx.store.getEvents('s1')).toEqual([]);
  });

  it('rejects a non-positive frame_seq', async () => {
    await expect(ctx.store.ingestRunnerFrame('s1', ev(0, TEXT))).rejects.toThrow(/positive/i);
  });

  it('keeps separate turns independent (each is its own sequence space)', async () => {
    await ctx.store.ingestRunnerFrame('s1', ev(1, TEXT));
    // A different turn starting at seq 1 is not a gap — it is a fresh sequence.
    const other = await ctx.store.ingestRunnerFrame('s1', ev(1, MORE, { turnId: 'turn-b' }));
    expect(other.outcome).toBe('accepted');
    expect(await ctx.store.getEvents('s1')).toEqual([TEXT, MORE]);
  });
});

/**
 * S9 — N / N-1 protocol compatibility (ADR 0006 D3). The Runner stamps every frame
 * with `protocolVersion`; a Server that predates a future bump must REFUSE an unknown
 * frame rather than misread it. That refusal is what makes a rollback safe: if traffic
 * from a newer (N) Runner reaches an older (N-1) Server, the older Server rejects the
 * frame and persists/claims nothing, so no half-understood event ever lands.
 */
describe('EventStore.ingestRunnerFrame protocol compatibility (S9, rollback safety)', () => {
  beforeEach(async () => {
    await ctx.store.createSession(SESSION);
  });

  it('an N-1 server refuses an N (protocolVersion 2) frame and persists/claims nothing', async () => {
    // This server ingests version 1. A frame stamped version 2 (the next protocol) is
    // the "newer Runner talking to an older Server after a rollback" case.
    await expect(
      ctx.store.ingestRunnerFrame('s1', ev(1, TEXT, { protocolVersion: 2 })),
    ).rejects.toThrow(/protocol version 2/i);
    // Rollback safety: the refused frame left no event row and claimed no sequence slot,
    // so a subsequent version-1 frame can still take seq 1 cleanly.
    expect(await ctx.store.getEvents('s1')).toEqual([]);
    const claims = await ctx.db
      .selectFrom('runner_frames')
      .select('frame_seq')
      .where('turn_id', '=', TURN)
      .execute();
    expect(claims).toEqual([]);
  });

  it('rejects a below-range protocol version too (never silently downgrades)', async () => {
    await expect(
      ctx.store.ingestRunnerFrame('s1', ev(1, TEXT, { protocolVersion: 0 })),
    ).rejects.toThrow(/protocol version 0/i);
    expect(await ctx.store.getEvents('s1')).toEqual([]);
  });
});

/**
 * ADR 0006 D7 step 5 settles a turn whose Runner was never CONFIRMED gone, so unlike a
 * dead one it can come back and stream. {@link EventStore.fenceAbandonedTurn} closes the
 * frame stream that turn would come back through.
 */
describe('EventStore.fenceAbandonedTurn (ADR 0006 D7 step 5)', () => {
  beforeEach(async () => {
    await ctx.store.createSession(SESSION);
  });

  it('refuses every later frame from a Runner recovery gave up on', async () => {
    await ctx.store.ingestRunnerFrame('s1', ev(1, TEXT));
    await ctx.store.fenceAbandonedTurn('s1', TURN);

    await expect(ctx.store.ingestRunnerFrame('s1', ev(2, MORE))).rejects.toThrow(
      /abandoned by recovery/i,
    );
    // The abandoned turn's late words reached nothing: the transcript is what it was
    // when the session was handed on.
    expect(await ctx.store.getEvents('s1')).toEqual([TEXT]);
  });

  it('fences a turn that never streamed a frame at all', async () => {
    // The give-up path most often runs for a turn whose Runner was unreachable from the
    // start, so `runner_frames` is empty and there is no instance id to inherit.
    await ctx.store.fenceAbandonedTurn('s1', TURN);
    await expect(ctx.store.ingestRunnerFrame('s1', ev(1, TEXT))).rejects.toThrow(
      /abandoned by recovery/i,
    );
    expect(await ctx.store.getEvents('s1')).toEqual([]);
  });

  it('still answers a replay of what the turn said before it was abandoned', async () => {
    // The fence closes the FUTURE of the stream. A frame the turn claimed while it still
    // held the session is below the fence and stays an idempotent duplicate, so a tail
    // re-reading its file from byte zero is not turned into an error.
    const first = await ctx.store.ingestRunnerFrame('s1', ev(1, TEXT));
    await ctx.store.fenceAbandonedTurn('s1', TURN);

    const replay = await ctx.store.ingestRunnerFrame('s1', ev(1, TEXT));
    expect(replay.outcome).toBe('duplicate');
    expect(replay.seq).toBe(first.seq);
    expect(await ctx.store.getEvents('s1')).toEqual([TEXT]);
  });

  it('is idempotent, so a retried settle does not stack fences', async () => {
    // Everything after the fence in the give-up path can fail and be retried from the
    // top, and each retry fences again before settling.
    await ctx.store.ingestRunnerFrame('s1', ev(1, TEXT));
    await ctx.store.fenceAbandonedTurn('s1', TURN);
    await ctx.store.fenceAbandonedTurn('s1', TURN);

    const claims = await ctx.db
      .selectFrom('runner_frames')
      .select('frame_seq')
      .where('turn_id', '=', TURN)
      .execute();
    expect(claims).toHaveLength(2); // the turn's one real frame, and one fence
  });

  it('refuses a frame that claims the fence hash instead of fencing that turn', async () => {
    // The fence is recognized by a reserved `payload_hash`, and a Runner chooses its own
    // hashes — so a frame carrying the sentinel, whether by malfunction or by design,
    // must be rejected rather than stored. Otherwise a turn could fence itself and
    // silence its own successor frames.
    await expect(
      ctx.store.ingestRunnerFrame('s1', ev(1, TEXT, { payloadHash: FENCE_HASH })),
    ).rejects.toThrow(/reserved/i);

    // Nothing was stored, so the turn's stream is untouched and still ingests.
    expect(await ctx.store.ingestRunnerFrame('s1', ev(1, TEXT))).toMatchObject({
      outcome: 'accepted',
    });
    expect(await ctx.store.getEvents('s1')).toEqual([TEXT]);
  });

  it('leaves the stream of another turn open', async () => {
    // The fence is per TURN. A successor running in the same session must keep ingesting.
    await ctx.store.fenceAbandonedTurn('s1', TURN);
    const successor = await ctx.store.ingestRunnerFrame(
      's1',
      ev(1, MORE, { turnId: 'turn-successor' }),
    );
    expect(successor.outcome).toBe('accepted');
    expect(await ctx.store.getEvents('s1')).toEqual([MORE]);
  });
});

describe('EventStore.fenceRunningTurnIfSilent', () => {
  beforeEach(async () => {
    await ctx.store.createSession(SESSION);
  });

  async function runningAnchor() {
    const prompt = await ctx.store.appendEvent('s1', { t: 'prompt', text: 'work' });
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: prompt.seq });
    await ctx.store.bindTurnIdentity('s1', {
      turnId: TURN,
      startCommandId: 'start-a',
    });
    return {
      sessionId: 's1',
      promptSeq: prompt.seq,
      startedAt: new Date(),
      turnId: TURN,
      startCommandId: 'start-a',
    };
  }

  it('atomically fences a matching turn that stayed silent', async () => {
    const anchor = await runningAnchor();
    const latestSeq = await ctx.store.latestEventSeq('s1');
    const notice: AgentEvent = { t: 'notice', role: 'agent', text: 'stalled' };

    await expect(
      ctx.store.fenceRunningTurnIfSilent(anchor, latestSeq, notice),
    ).resolves.not.toBeNull();
    await expect(ctx.store.ingestRunnerFrame('s1', ev(1, TEXT))).rejects.toThrow(/abandoned/i);
    expect((await ctx.store.getEvents('s1')).at(-1)).toEqual(notice);
  });

  it('refuses to fence after the turn speaks', async () => {
    const anchor = await runningAnchor();
    const latestSeq = await ctx.store.latestEventSeq('s1');
    await ctx.store.ingestRunnerFrame('s1', ev(1, TEXT));

    await expect(
      ctx.store.fenceRunningTurnIfSilent(anchor, latestSeq, {
        t: 'notice',
        role: 'agent',
        text: 'stalled',
      }),
    ).resolves.toBeNull();
    await expect(ctx.store.ingestRunnerFrame('s1', ev(2, MORE))).resolves.toMatchObject({
      outcome: 'accepted',
    });
    expect(await ctx.store.getEvents('s1')).not.toContainEqual(
      expect.objectContaining({ t: 'notice' }),
    );
  });

  it('refuses to fence a replacement running-turn marker', async () => {
    const anchor = await runningAnchor();
    const latestSeq = await ctx.store.latestEventSeq('s1');
    await ctx.store.clearRunningTurn('s1', anchor.promptSeq);
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: anchor.promptSeq + 1 });

    await expect(ctx.store.fenceRunningTurnIfSilent(anchor, latestSeq)).resolves.toBeNull();
    await expect(ctx.store.ingestRunnerFrame('s1', ev(1, TEXT))).resolves.toMatchObject({
      outcome: 'accepted',
    });
  });

  it('does not add a notice for or reopen an existing abandoned fence', async () => {
    const anchor = await runningAnchor();
    const latestSeq = await ctx.store.latestEventSeq('s1');
    await ctx.store.fenceAbandonedTurn('s1', TURN);

    await expect(
      ctx.store.fenceRunningTurnIfSilent(anchor, latestSeq, {
        t: 'notice',
        role: 'agent',
        text: 'stalled',
      }),
    ).resolves.toBeNull();
    expect(await ctx.store.getEvents('s1')).not.toContainEqual(
      expect.objectContaining({ t: 'notice' }),
    );
    await expect(ctx.store.ingestRunnerFrame('s1', ev(1, TEXT))).rejects.toThrow(/abandoned/i);
  });

  it('serializes an eventless frame against the fence under PGlite', async () => {
    const anchor = await runningAnchor();
    const latestSeq = await ctx.store.latestEventSeq('s1');
    const outcomes = await Promise.allSettled([
      ctx.store.ingestRunnerFrame('s1', slot(1)),
      ctx.store.fenceRunningTurnIfSilent(anchor, latestSeq),
    ]);

    expect(outcomes[1]?.status).toBe('fulfilled');
    await expect(ctx.store.ingestRunnerFrame('s1', slot(2))).rejects.toThrow(/abandoned/i);
  });

  it('serializes shutdown fence release before a resumed eventless frame', async () => {
    const anchor = await runningAnchor();
    const latestSeq = await ctx.store.latestEventSeq('s1');
    const fenced = await ctx.store.fenceRunningTurnIfSilent(anchor, latestSeq, {
      t: 'notice',
      role: 'agent',
      text: 'stalled',
    });
    expect(fenced).not.toBeNull();

    const [, resumed] = await Promise.all([
      ctx.store.releaseRunningTurnFence(anchor, fenced!.noticeSeq, fenced!.fenceSeq),
      ctx.store.ingestRunnerFrame('s1', slot(1)),
    ]);
    expect(resumed).toMatchObject({ outcome: 'accepted' });
  });

  it('releases the exact shutdown fence when an unrelated event followed its notice', async () => {
    const anchor = await runningAnchor();
    const latestSeq = await ctx.store.latestEventSeq('s1');
    const fenced = await ctx.store.fenceRunningTurnIfSilent(anchor, latestSeq, {
      t: 'notice',
      role: 'agent',
      text: 'stalled',
    });
    expect(fenced).not.toBeNull();
    await ctx.store.appendEvent('s1', { t: 'text', delta: 'unrelated server event' });

    await ctx.store.releaseRunningTurnFence(anchor, fenced!.noticeSeq, fenced!.fenceSeq);
    await expect(ctx.store.ingestRunnerFrame('s1', slot(1))).resolves.toMatchObject({
      outcome: 'accepted',
    });
    expect(await ctx.store.getEvents('s1')).toContainEqual({
      t: 'text',
      delta: 'unrelated server event',
    });
  });

  it('never removes a fence not identified by the rollback token', async () => {
    const anchor = await runningAnchor();
    const latestSeq = await ctx.store.latestEventSeq('s1');
    const fenced = await ctx.store.fenceRunningTurnIfSilent(anchor, latestSeq);
    expect(fenced).not.toBeNull();

    await ctx.store.releaseRunningTurnFence(anchor, fenced!.noticeSeq, fenced!.fenceSeq + 1);
    await expect(ctx.store.ingestRunnerFrame('s1', slot(1))).rejects.toThrow(/abandoned/i);
    expect(await ctx.store.getEvents('s1')).toContainEqual({ t: 'prompt', text: 'work' });
  });
});
