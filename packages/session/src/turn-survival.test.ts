import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@verity/events';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { RunnerFrameIngest, RunnerFrameIngestResult, SequencedEvent } from '@verity/store';
import { InMemoryEventBus } from './bus.js';
import type { Backend } from './backend.js';
import type { RunResult } from './backend-contract.js';
import { FileTailRunnerClient, type RunnerFrameStore } from './file-tail-runner-client.js';
import {
  stampFrame,
  writeFrame,
  type RunnerFrame,
  type RunnerFrameBody,
} from './runner-transport.js';

/**
 * MECHANISM-LEVEL (seam) turn-survival matrix (ADR 0006 D4/D7). These prove
 * exactly-once event ingest + crash-safe reattach at the CODE SEAM using the REAL
 * EventStore over PGlite, the REAL runner transport (`writeFrame`/tail), and the
 * REAL {@link FileTailRunnerClient} reattach dispatch. They do NOT prove the
 * end-to-end production guarantee (that needs separate production wiring); they lock
 * the mechanism.
 *
 * Exactly-once vocabulary (used consistently below): after replay,
 * `store.getEvents(sessionId)` has exactly one row per distinct `(turnId, frameSeq)`
 * event, `runner_frames` has one claim per seq, and the UNION of bus-published events
 * + backlog replay (`getEventsAfter` cursor) delivers each event exactly once. The
 * live bus alone is at-most-once — the backlog/reattach replay fills the gaps.
 */

const SESSION = 'sess-survival';
const WORKTREE = '/wt/survival';
const RUNNER_INSTANCE = 'runner-survival';

const EV_A: AgentEvent = { t: 'text', delta: 'alpha' };
const EV_B: AgentEvent = { t: 'text', delta: 'bravo' };
const EV_C: AgentEvent = { t: 'text', delta: 'charlie' };
const RESULT: RunResult = { sessionId: SESSION, exitCode: 0, stderr: '', aborted: false };

let ctx: TestDb;
let dir: string;
let file: string;
let noSock: string;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  dir = await mkdtemp(join(tmpdir(), 'verity-turn-survival-'));
  file = join(dir, 'events.jsonl');
  // A control socket path that never exists: `attach` still runs its event tail; the
  // control connect fails and is swallowed (these tests exercise the EVENT seam).
  noSock = join(dir, 'absent.sock');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** One turn's whole append-only frame stream: session, three events, terminal result.
 * The Runner writes this to the mount as the durability point, independent of any
 * Server crash — a re-tail from byte zero re-reads exactly these bytes. */
function buildFrames(turnId: string): RunnerFrame[] {
  const bodies: RunnerFrameBody[] = [
    { kind: 'session', id: SESSION },
    { kind: 'event', event: EV_A },
    { kind: 'event', event: EV_B },
    { kind: 'event', event: EV_C },
    { kind: 'result', result: RESULT },
  ];
  return bodies.map((body, i) =>
    stampFrame(body, { turnId, runnerInstanceId: RUNNER_INSTANCE, frameSeq: i + 1 }),
  );
}

/** Append `count` frames (default: all) to the event file, one JSONL line each. */
async function writeFrames(frames: RunnerFrame[], count = frames.length): Promise<void> {
  for (const f of frames.slice(0, count)) await writeFrame({ path: file }, f);
}

/** Project a transport {@link RunnerFrame} to the store's ingest descriptor exactly as
 * {@link FileTailRunnerClient} does — same `payloadHash`, so a direct prefix-ingest and
 * a later re-tail of the same frame agree (no spurious corruption). */
function frameToIngest(frame: RunnerFrame): RunnerFrameIngest {
  return {
    protocolVersion: frame.protocolVersion,
    runnerInstanceId: frame.runnerInstanceId,
    turnId: frame.turnId,
    frameSeq: frame.frameSeq,
    payloadHash: frame.payloadHash,
    ...(frame.kind === 'event' ? { event: frame.event } : {}),
    ...(frame.kind === 'result' ? { terminal: true as const } : {}),
  };
}

/** A Backend the reattach path never invokes (`attach` starts no RunnerServer). */
const inertBackend: Backend = {
  run: () => new Promise<RunResult>(() => {}),
};

/** A Server-side {@link FileTailRunnerClient} wired to the REAL store + a given bus. */
function makeClient(store: RunnerFrameStore, bus: InMemoryEventBus): FileTailRunnerClient {
  return new FileTailRunnerClient(inertBackend, {
    store,
    bus,
    allocateEventFile: () => join(dir, `${randomUUID()}.jsonl`),
    pollMs: 2,
  });
}

/** The `(turnId, frameSeq)` claims persisted in `runner_frames`, ascending. One row
 * per seq is the store-level exactly-once invariant. */
async function frameClaims(turnId: string): Promise<number[]> {
  const rows = await ctx.db
    .selectFrom('runner_frames')
    .select('frame_seq')
    .where('turn_id', '=', turnId)
    .orderBy('frame_seq', 'asc')
    .execute();
  return rows.map((r) => Number(r.frame_seq));
}

describe('turn-survival: exactly-once ingest + crash-safe reattach (ADR 0006 D4/D7)', () => {
  it('S2 pre-commit crash: reattach accepts the uncommitted frame and closes the marker with the result', async () => {
    await ctx.store.createSession({ sessionId: SESSION, worktree: WORKTREE, model: 'm' });
    const turnId = 'turn-s2';
    const frames = buildFrames(turnId);
    await writeFrames(frames);
    await ctx.store.markTurnRunning({ sessionId: SESSION, promptSeq: 1 });
    await ctx.store.bindTurnIdentity(SESSION, { turnId, startCommandId: 'start-s2' });

    // Server-A commits only the prefix, then dies before calling the store for frame 4.
    // The durable Runner file still contains the complete stream.
    for (const frame of frames.slice(0, 3)) {
      await ctx.store.ingestRunnerFrame(SESSION, frameToIngest(frame));
    }
    expect((await ctx.store.listRunningTurns()).map((r) => r.turnId)).toEqual([turnId]);

    const published: AgentEvent[] = [];
    const bus = new InMemoryEventBus();
    bus.subscribeAll((_sid, event) => published.push(event.event));
    const recovered = makeClient(ctx.store, bus).attach(
      { turnId, sessionId: SESSION, eventFilePath: file, controlSocketPath: noSock },
      {},
    );
    await expect(recovered.result).resolves.toMatchObject({ sessionId: SESSION });

    expect(published).toEqual([EV_C]);
    expect(await frameClaims(turnId)).toEqual([1, 2, 3, 4, 5]);
    expect(await ctx.store.listRunningTurns()).toEqual([]);
  });

  it('S1 re-tail from byte zero is exactly-once: pass 1 all accepted+published, pass 2 all duplicate+0 published', async () => {
    await ctx.store.createSession({ sessionId: SESSION, worktree: WORKTREE, model: 'm' });
    const turnId = 'turn-s1';
    const frames = buildFrames(turnId);
    await writeFrames(frames); // the whole turn is durable on the mount

    // Pass 1: a fresh store re-tails the file end-to-end through the REAL client. Every
    // frame is newly claimed (`accepted`); every event is published.
    const busA = new InMemoryEventBus();
    const pubA: SequencedEvent[] = [];
    busA.subscribeAll((_sid, e) => pubA.push(e));
    const turnA = makeClient(ctx.store, busA).attach(
      { turnId, sessionId: SESSION, eventFilePath: file, controlSocketPath: noSock },
      {},
    );
    await expect(turnA.result).resolves.toMatchObject({ sessionId: SESSION });

    expect(await ctx.store.getEvents(SESSION)).toEqual([EV_A, EV_B, EV_C]);
    expect(pubA.map((e) => e.event)).toEqual([EV_A, EV_B, EV_C]); // N published on pass 1
    expect(await frameClaims(turnId)).toEqual([1, 2, 3, 4, 5]); // one claim per seq

    // Pass 2: the SAME store re-attaches from byte zero. Every frame is a `duplicate`
    // (a reconnecting client gets backlog via replay, not a second publish).
    const busB = new InMemoryEventBus();
    const pubB: SequencedEvent[] = [];
    busB.subscribeAll((_sid, e) => pubB.push(e));
    const turnB = makeClient(ctx.store, busB).attach(
      { turnId, sessionId: SESSION, eventFilePath: file, controlSocketPath: noSock },
      {},
    );
    await expect(turnB.result).resolves.toMatchObject({ sessionId: SESSION });

    expect(pubB).toEqual([]); // 0 published on pass 2 — the bus is at-most-once
    expect(await ctx.store.getEvents(SESSION)).toEqual([EV_A, EV_B, EV_C]); // length unchanged
    expect(await frameClaims(turnId)).toEqual([1, 2, 3, 4, 5]); // still one claim per seq
  });

  it('S3 server crash mid-turn: server-B reattaches, <=k re-ingest as duplicate (no republish), >k accepted, exactly-once', async () => {
    await ctx.store.createSession({ sessionId: SESSION, worktree: WORKTREE, model: 'm' });
    const turnId = 'turn-s3';
    const frames = buildFrames(turnId);
    // The Runner writes the WHOLE stream to the mount (the durability point), regardless
    // of any Server crash.
    await writeFrames(frames);

    // Server-A drives the turn and ingests+publishes frames 1..k, then is SIGKILLed
    // (modelled: it processed a prefix of the durable file and vanished). k = 3 covers
    // session(1) + events A(2), B(3); the result and event C are not yet ingested.
    const k = 3;
    const pubA: AgentEvent[] = [];
    for (const f of frames.slice(0, k)) {
      const r = await ctx.store.ingestRunnerFrame(SESSION, frameToIngest(f));
      if (r.outcome === 'accepted' && f.kind === 'event') pubA.push(f.event);
    }
    expect(pubA).toEqual([EV_A, EV_B]); // A, B reached the live bus before the crash

    // Server-B reattaches to the SAME file + store through the REAL client and settles
    // from the replayed terminal frame.
    const busB = new InMemoryEventBus();
    const pubB: AgentEvent[] = [];
    busB.subscribeAll((_sid, e) => pubB.push(e.event));
    const turnB = makeClient(ctx.store, busB).attach(
      { turnId, sessionId: SESSION, eventFilePath: file, controlSocketPath: noSock },
      {},
    );
    await expect(turnB.result).resolves.toMatchObject({ sessionId: SESSION });

    // <=k re-ingest as duplicate → not republished; >k (event C) is accepted → published.
    expect(pubB).toEqual([EV_C]);
    // Union of live-before-crash (busA) + reattach publishes (busB) = each event once.
    expect([...pubA, ...pubB]).toEqual([EV_A, EV_B, EV_C]);
    // Store holds each event exactly once; one frame claim per seq.
    expect(await ctx.store.getEvents(SESSION)).toEqual([EV_A, EV_B, EV_C]);
    expect(await frameClaims(turnId)).toEqual([1, 2, 3, 4, 5]);
  });

  it('S4 post-commit-pre-publish crash: the duplicate is not republished; backlog replay delivers the gap exactly once', async () => {
    await ctx.store.createSession({ sessionId: SESSION, worktree: WORKTREE, model: 'm' });
    const turnId = 'turn-s4';
    const frames = buildFrames(turnId);
    await writeFrames(frames);

    // Server-A publishes as it ingests, but crashes AFTER committing frame 4 (event C)
    // and BEFORE it can publish that event — the post-commit-pre-publish window. A thin
    // store decorator reproduces exactly that: commit, then throw before the caller
    // reaches `bus.publish`.
    const crashSeq = 4;
    const commitThenCrash: RunnerFrameStore = {
      async ingestRunnerFrame(
        sid: string,
        frame: RunnerFrameIngest,
      ): Promise<RunnerFrameIngestResult> {
        const r = await ctx.store.ingestRunnerFrame(sid, frame); // COMMIT
        if (frame.frameSeq === crashSeq) {
          throw new Error('server crash after commit, before publish');
        }
        return r;
      },
    };

    const pubA: SequencedEvent[] = [];
    let cursor = 0; // the reconnecting client's last-seen seq
    let crashed = false;
    try {
      for (const f of frames) {
        const r = await commitThenCrash.ingestRunnerFrame(SESSION, frameToIngest(f));
        if (
          r.outcome === 'accepted' &&
          r.seq !== undefined &&
          r.ts !== undefined &&
          f.kind === 'event'
        ) {
          pubA.push({ seq: r.seq, ts: r.ts, event: f.event });
          cursor = r.seq;
        }
      }
    } catch (err) {
      crashed = err instanceof Error && /after commit, before publish/.test(err.message);
      if (!crashed) throw err;
    }
    expect(crashed).toBe(true);
    // A, B reached the live bus; C committed but was NEVER published (crash in the window).
    expect(pubA.map((e) => e.event)).toEqual([EV_A, EV_B]);

    // Server-B reattaches on the REAL store. Frame 4 (event C) re-tails as a DUPLICATE
    // (already committed) → it must NOT be republished. The terminal frame settles it.
    const busB = new InMemoryEventBus();
    const pubB: SequencedEvent[] = [];
    busB.subscribeAll((_sid, e) => pubB.push(e));
    const turnB = makeClient(ctx.store, busB).attach(
      { turnId, sessionId: SESSION, eventFilePath: file, controlSocketPath: noSock },
      {},
    );
    await expect(turnB.result).resolves.toMatchObject({ sessionId: SESSION });
    expect(pubB).toEqual([]); // all committed already → all duplicate → nothing republished

    // Event C reached NEITHER bus. It is recovered ONLY via backlog replay from the
    // client's cursor (the seq of the last event it saw live before the crash).
    const replay = await ctx.store.getEventsAfter(SESSION, cursor);
    expect(replay.map((e) => e.event)).toEqual([EV_C]);

    // Union: live-before-crash (A, B) ∪ backlog replay (C) = each event exactly once.
    expect([...pubA.map((e) => e.event), ...replay.map((e) => e.event)]).toEqual([
      EV_A,
      EV_B,
      EV_C,
    ]);
    expect(await ctx.store.getEvents(SESSION)).toEqual([EV_A, EV_B, EV_C]);
    expect(await frameClaims(turnId)).toEqual([1, 2, 3, 4, 5]);
  });
});
