import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionDecision, PermissionRequest } from '@verity/adapter-claude';
import type { AgentEvent } from '@verity/events';
import {
  RUNNER_FRAME_PROTOCOL_VERSION,
  type RunnerFrameIngest,
  type RunnerFrameIngestResult,
  type SequencedEvent,
} from '@verity/store';
import { InMemoryEventBus } from './bus.js';
import type { Backend } from './backend.js';
import type { RunResult, RunTurnOptions, SteerMessage } from './backend-contract.js';
import { FileTailRunnerClient, type RunnerFrameStore } from './file-tail-runner-client.js';
import { RunnerServer } from './runner-server.js';
import { stampFrame } from './runner-transport.js';
import {
  connectControl,
  ControlCommandRejectedError,
  ControlDeliveryUnknownError,
  type ControlAck,
  type ControlSocketClient,
} from './runner-control.js';

/**
 * A seam for the reconnect tests below, which have to script control-socket
 * OUTCOMES (`unreachable`, `handler-error`, an ambiguous delivery) that a healthy
 * in-process RunnerServer never produces. Left `undefined`, every test above keeps
 * using the real `connectControl` against a real unix socket.
 */
const controlSeam = vi.hoisted(() => ({
  connect: undefined as
    ((path: string, opts: Record<string, unknown>) => Promise<ControlSocketClient>) | undefined,
}));

vi.mock('./runner-control.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runner-control.js')>();
  return {
    ...actual,
    connectControl: (path: string, opts: Record<string, unknown> = {}) =>
      controlSeam.connect === undefined
        ? actual.connectControl(path, opts)
        : controlSeam.connect(path, opts),
  };
});

const SESSION_ID = 'sess-roundtrip';
const WORKTREE = '/wt/roundtrip';
const EVENT_ONE: AgentEvent = { t: 'text', delta: 'first' };
const EVENT_TWO: AgentEvent = { t: 'text', delta: 'second' };
const PERMISSION_REQUEST: PermissionRequest = {
  requestId: 'req-1',
  toolName: 'Bash',
  input: { command: 'rm -rf /' },
  toolUseId: 'tool-1',
};
const PERMISSION_EVENT: AgentEvent = {
  t: 'permission',
  id: 'tool-1',
  tool: 'Bash',
  input: { command: 'rm -rf /' },
  riskClass: 'ask',
  // These fixtures drive a native-transport client, so the card sees the native
  // channel and may offer every standing grant scope (ADR 0014 D3).
  grantChannel: 'acp',
};
const RESULT: RunResult = { sessionId: SESSION_ID, exitCode: 0, stderr: '', aborted: false };

/**
 * A fake {@link Backend} that scripts one turn's stream against the run's `store`
 * (the RunnerServer's file-sink) + callbacks: bind the session, emit two events,
 * raise a permission prompt, then settle. It surfaces `inject` (from `onSteer`),
 * records the operator's permission answer + steer messages, and whether it was
 * cancelled — so the roundtrip test can assert control reaches the backend.
 */
function scriptedBackend() {
  const steerSeen: SteerMessage[] = [];
  const permissionAnswers: PermissionDecision[] = [];
  let cancelled = false;
  let settle: (r: RunResult) => void = () => {};
  let resolveStarted: () => void = () => {};
  const started = new Promise<void>((res) => {
    resolveStarted = res;
  });
  const backend: Backend = {
    // An attested native runner protocol, which is what puts the prompts this
    // fixture asserts on the native channel (ADR 0014 D3). Omitting it would fail
    // closed to `acp`, so it has to be declared rather than assumed.
    runnerSupervisorBackend: 'codex-acp',
    run(opts: RunTurnOptions): Promise<RunResult> {
      opts.signal?.addEventListener('abort', () => {
        cancelled = true;
      });
      opts.onSteer?.((m) => {
        steerSeen.push(m);
        return true;
      });
      void (async () => {
        // Bind the session (createSession + onSession), like the real ingest.
        await opts.store.createSession({
          sessionId: SESSION_ID,
          worktree: WORKTREE,
          model: 'm',
        });
        await opts.onSession?.(SESSION_ID);
        // Two persisted events (each becomes an event frame on the file).
        await opts.store.appendEvent(SESSION_ID, EVENT_ONE);
        await opts.store.appendEvent(SESSION_ID, EVENT_TWO);
        // A mid-turn permission prompt; the answer arrives via `respond`.
        opts.onPermissionRequest?.(PERMISSION_REQUEST, (decision) => {
          permissionAnswers.push(decision);
        });
        resolveStarted();
      })();
      return new Promise<RunResult>((res) => {
        settle = res;
      });
    },
  };
  return {
    backend,
    steerSeen,
    permissionAnswers,
    started,
    get cancelled() {
      return cancelled;
    },
    settle: () => settle(RESULT),
  };
}

/** A real-shaped in-memory {@link RunnerFrameStore} standing in for the Server-side
 * store: it ingests each frame idempotently, assigns a monotonic `seq` to event
 * frames, records the append order, and deduplicates a replayed `(turnId, frameSeq)`.
 * This is the SERVER side (the Runner's own store held no DB — D2/D4). */
class RecordingStore implements RunnerFrameStore {
  seq = 0;
  readonly appended: { sessionId: string; event: AgentEvent; seq: number }[] = [];
  readonly turnIds = new Set<string>();
  private readonly claimed = new Map<string, { seq: number; ts: number } | null>();

  /** How many distinct `(turnId, frameSeq)` frames have been claimed — lets a
   * reattach test wait until the ORIGINAL tail has ingested everything before the
   * second tail starts, so every re-tailed frame is deterministically a duplicate. */
  get claimedCount(): number {
    return this.claimed.size;
  }

  ingestRunnerFrame(sessionId: string, frame: RunnerFrameIngest): Promise<RunnerFrameIngestResult> {
    this.turnIds.add(frame.turnId);
    const key = `${frame.turnId}#${frame.frameSeq}`;
    const prior = this.claimed.get(key);
    if (prior !== undefined) {
      return Promise.resolve(
        prior !== null
          ? { outcome: 'duplicate', seq: prior.seq, ts: prior.ts }
          : { outcome: 'duplicate' },
      );
    }
    if (frame.event !== undefined) {
      this.seq += 1;
      const rec = { seq: this.seq, ts: 1000 + this.seq };
      this.appended.push({ sessionId, event: frame.event, seq: this.seq });
      this.claimed.set(key, rec);
      return Promise.resolve({ outcome: 'accepted', seq: rec.seq, ts: rec.ts });
    }
    this.claimed.set(key, null);
    return Promise.resolve({ outcome: 'accepted' });
  }
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verity-file-tail-client-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('FileTailRunnerClient (ADR 0006 Stage 2.1 roundtrip)', () => {
  it('drives a turn over a real event file: persist-then-publish, hooks, control, result', async () => {
    const fb = scriptedBackend();
    const store = new RecordingStore();
    const bus = new InMemoryEventBus();
    const published: SequencedEvent[] = [];

    const sessionSeen: string[] = [];
    const permSeen: PermissionRequest[] = [];

    const client = new FileTailRunnerClient(fb.backend, {
      store,
      bus,
      allocateEventFile: () => join(dir, randomUUID(), 'events.jsonl'),
      allocateControlSocket: () => join(dir, `${randomUUID()}.sock`),
      pollMs: 2,
    });

    const opts = { store, worktree: WORKTREE, cwd: WORKTREE } as unknown as RunTurnOptions;
    const turn = client.startTurn(opts, {
      onSession: (id) => {
        sessionSeen.push(id);
        // Subscribe on session bind so we catch every published event.
        bus.subscribe(id, (e) => published.push(e));
      },
      onPermissionRequest: (r) => {
        permSeen.push(r);
      },
    });

    // Wait for the backend to have emitted its scripted stream, then answer the
    // permission, steer, and let the turn settle.
    await fb.started;
    // Give the tail a moment to drain the session + event + permission frames.
    await waitFor(() => permSeen.length === 1 && store.appended.length === 3);

    // hooks fired
    expect(sessionSeen).toEqual([SESSION_ID]);
    expect(permSeen).toEqual([PERMISSION_REQUEST]);

    // persist-then-publish, Server-side seq authority, in order (D2)
    expect(store.appended).toEqual([
      { sessionId: SESSION_ID, event: EVENT_ONE, seq: 1 },
      { sessionId: SESSION_ID, event: EVENT_TWO, seq: 2 },
      { sessionId: SESSION_ID, event: PERMISSION_EVENT, seq: 3 },
    ]);
    expect(published).toEqual([
      { seq: 1, ts: 1001, event: EVENT_ONE },
      { seq: 2, ts: 1002, event: EVENT_TWO },
      { seq: 3, ts: 1003, event: PERMISSION_EVENT },
    ]);

    // control reaches the backend: answerPermission + steer forwarded in-process
    const decision: PermissionDecision = { behavior: 'allow' };
    await expect(turn.answerPermission('tool-1', decision)).resolves.toBe(true);
    const steerMsg: SteerMessage = { text: 'keep going' };
    await expect(turn.steer(steerMsg)).resolves.toBe(true);
    await waitFor(() => fb.permissionAnswers.length === 1 && fb.steerSeen.length === 1);
    expect(fb.permissionAnswers).toEqual([decision]);
    expect(fb.steerSeen).toEqual([steerMsg]);

    // settle -> result frame -> turn resolves with the RunResult
    fb.settle();
    await expect(turn.result).resolves.toEqual(RESULT);

    // A retained handle never reconnects to a settled Runner or reports a late
    // command as applied after the terminal frame closed the control socket.
    await expect(turn.steer({ text: 'too late' })).resolves.toBe(false);
    await expect(
      turn.answerPermission('tool-late', { behavior: 'deny', message: 'too late' }),
    ).resolves.toBe(false);
    await expect(turn.cancel()).resolves.toBe(false);
  });

  it('keeps external-launch frame claims on the Verity store session id', async () => {
    const veritySessionId = 'verity-store-session';
    const backendSessionId = SESSION_ID;
    const fb = scriptedBackend();
    const store = new RecordingStore();
    const bus = new InMemoryEventBus();
    const server = new RunnerServer(fb.backend);
    const sessionSeen: string[] = [];

    const client = new FileTailRunnerClient(fb.backend, {
      store,
      bus,
      allocateEventFile: () => join(dir, randomUUID(), 'events.jsonl'),
      allocateControlSocket: () => join(dir, `${randomUUID()}.sock`),
      launchTurn: async (opts, artifacts) => {
        await server.run(artifacts.eventFilePath, {
          ...opts,
          controlSocketPath: artifacts.controlSocketPath,
        });
      },
      pollMs: 2,
    });

    const turn = client.startTurn(
      {
        store,
        storeSessionId: veritySessionId,
        worktree: WORKTREE,
        cwd: WORKTREE,
      } as unknown as RunTurnOptions,
      {
        onSession: (id) => {
          sessionSeen.push(id);
        },
      },
    );

    await fb.started;
    await waitFor(() => store.appended.length === 3 && sessionSeen.length === 1);

    expect(store.appended.every((entry) => entry.sessionId === veritySessionId)).toBe(true);
    expect(sessionSeen).toEqual([backendSessionId]);

    fb.settle();
    await expect(turn.result).resolves.toEqual(RESULT);
  });

  it('cancel() reaches the backend and the turn still resolves with the result', async () => {
    const fb = scriptedBackend();
    const store = new RecordingStore();
    const bus = new InMemoryEventBus();

    const client = new FileTailRunnerClient(fb.backend, {
      store,
      bus,
      allocateEventFile: () => join(dir, randomUUID(), 'events.jsonl'),
      pollMs: 2,
    });

    const opts = { store, worktree: WORKTREE, cwd: WORKTREE } as unknown as RunTurnOptions;
    const turn = client.startTurn(opts, {});

    await fb.started;
    await expect(turn.cancel()).resolves.toBe(true);
    await waitFor(() => fb.cancelled);
    expect(fb.cancelled).toBe(true);

    // The backend settles after the cancel (partial output already persisted); the
    // turn resolves with the result frame the RunnerServer wrote on settle.
    fb.settle();
    await expect(turn.result).resolves.toEqual(RESULT);
  });

  it('stamps the Conductor-allocated opts.turnId onto frames instead of self-minting (Stage 4)', async () => {
    const fb = scriptedBackend();
    const store = new RecordingStore();

    const client = new FileTailRunnerClient(fb.backend, {
      store,
      bus: new InMemoryEventBus(),
      allocateEventFile: () => join(dir, randomUUID(), 'events.jsonl'),
      pollMs: 2,
    });

    // The Conductor mints the turn id, persists it on the marker (D2), then passes
    // it in via opts.turnId. Every ingested frame must carry exactly that id.
    const opts = {
      store,
      worktree: WORKTREE,
      cwd: WORKTREE,
      turnId: 'conductor-turn-1',
    } as unknown as RunTurnOptions;
    const turn = client.startTurn(opts, {});

    await fb.started;
    await waitFor(() => store.appended.length === 3);
    fb.settle();
    await turn.result;

    expect([...store.turnIds]).toEqual(['conductor-turn-1']);
  });

  it('RunnerServer reports a live D6 attach snapshot: frame count, status, outstanding permission (Stage 4b)', async () => {
    const fb = scriptedBackend();
    const server = new RunnerServer(fb.backend);
    const eventFile = join(dir, randomUUID(), 'events.jsonl');
    const controlSocket = join(dir, `${randomUUID()}.sock`);

    const turn = await server.run(eventFile, {
      worktree: WORKTREE,
      cwd: WORKTREE,
      turnId: 'turn-snap',
      controlSocketPath: controlSocket,
    });

    // By `started` the backend has bound the session, written both events, and raised
    // the permission — so the live snapshot must show advanced frames + the open prompt.
    await fb.started;
    const client = await connectControl(controlSocket, { turnId: 'turn-snap' });
    try {
      expect(client.snapshot.turnStatus).toBe('running');
      expect(client.snapshot.lastFrameSeq).toBeGreaterThanOrEqual(3);
      expect(typeof client.snapshot.runnerInstanceId).toBe('string');
      expect(client.snapshot.outstandingPermissions.map((p) => p.toolUseId)).toContain('tool-1');
    } finally {
      client.close();
      fb.settle();
      await turn.result;
    }
  });

  it('clears the outstanding permission from a later snapshot once answered in-process (Stage 4b)', async () => {
    const fb = scriptedBackend();
    const server = new RunnerServer(fb.backend);
    const eventFile = join(dir, randomUUID(), 'events.jsonl');
    const controlSocket = join(dir, `${randomUUID()}.sock`);
    const turn = await server.run(eventFile, {
      worktree: WORKTREE,
      cwd: WORKTREE,
      turnId: 'turn-ip',
      controlSocketPath: controlSocket,
    });

    await fb.started;
    // Answer through the in-process handle; the wrapper clears the prompt on apply.
    await expect(turn.answerPermission('tool-1', { behavior: 'allow' })).resolves.toBe(true);
    const client = await connectControl(controlSocket, { turnId: 'turn-ip' });
    try {
      expect(client.snapshot.outstandingPermissions).toEqual([]);
    } finally {
      client.close();
      fb.settle();
      await turn.result;
    }
  });

  it('clears the outstanding permission from a later snapshot once answered over the socket (Stage 4b)', async () => {
    const fb = scriptedBackend();
    const server = new RunnerServer(fb.backend);
    const eventFile = join(dir, randomUUID(), 'events.jsonl');
    const controlSocket = join(dir, `${randomUUID()}.sock`);
    const turn = await server.run(eventFile, {
      worktree: WORKTREE,
      cwd: WORKTREE,
      turnId: 'turn-sock',
      controlSocketPath: controlSocket,
    });

    await fb.started;
    const c1 = await connectControl(controlSocket, { turnId: 'turn-sock' });
    expect(c1.snapshot.outstandingPermissions.map((p) => p.toolUseId)).toContain('tool-1');
    await c1.answerPermission('tool-1', { behavior: 'allow' });
    // Re-read a fresh snapshot by RESUMING the same controller (acquire would be
    // fenced): the answered prompt must be gone from the new attach ACK.
    const c2 = await connectControl(controlSocket, {
      turnId: 'turn-sock',
      controllerId: c1.controllerId,
      resumeLeaseEpoch: c1.leaseEpoch,
    });
    try {
      expect(c2.snapshot.outstandingPermissions).toEqual([]);
    } finally {
      c1.close();
      c2.close();
      fb.settle();
      await turn.result;
    }
  });

  it('attach reattaches to a live turn: idempotent re-tail + re-surfaced prompt, settles both handles (Stage 4c)', async () => {
    const fb = scriptedBackend();
    const store = new RecordingStore();
    const eventFile = join(dir, randomUUID(), 'events.jsonl');
    const controlSocket = join(dir, `${randomUUID()}.sock`);

    // The ORIGINAL Server: starts the turn, tails it into `store`, holds control.
    const client1 = new FileTailRunnerClient(fb.backend, {
      store,
      bus: new InMemoryEventBus(),
      allocateEventFile: () => eventFile,
      allocateControlSocket: () => controlSocket,
      pollMs: 2,
    });
    const opts = {
      store,
      worktree: WORKTREE,
      cwd: WORKTREE,
      turnId: 'turn-reattach',
    } as unknown as RunTurnOptions;
    const turn1 = client1.startTurn(opts, {});
    await fb.started;
    // Wait until the original tail has claimed ALL pre-settle frames (session + 2
    // events + permission = 4), so every frame the reattach re-tails is a duplicate.
    await waitFor(() => store.claimedCount === 4);

    // A SECOND Server process reattaches to the SAME artifacts and the SAME store.
    const bus2 = new InMemoryEventBus();
    const published2: SequencedEvent[] = [];
    bus2.subscribe(SESSION_ID, (e) => published2.push(e));
    const resurfaced: PermissionRequest[] = [];
    const client2 = new FileTailRunnerClient(fb.backend, {
      store,
      bus: bus2,
      allocateEventFile: () => join(dir, 'unused', 'events.jsonl'),
      pollMs: 2,
    });
    const turn2 = client2.attach(
      {
        turnId: 'turn-reattach',
        sessionId: SESSION_ID,
        eventFilePath: eventFile,
        controlSocketPath: controlSocket,
      },
      { onPermissionRequest: (r) => resurfaced.push(r), bus: bus2 },
    );

    // The still-open prompt is re-surfaced from the D6 attach snapshot (not the
    // duplicate frame), exactly once.
    await waitFor(() => resurfaced.length === 1);
    expect(resurfaced[0]?.toolUseId).toBe('tool-1');

    // Settling the live turn resolves BOTH the original and the reattached handle.
    fb.settle();
    await expect(turn2.result).resolves.toEqual(RESULT);
    await turn1.result;

    // The reattach re-tailed every frame as a duplicate and re-published NOTHING
    // (a reconnecting client gets backlog via replay, not a second publish).
    expect(published2).toEqual([]);
    expect(resurfaced).toHaveLength(1);
  });

  it('attach surfaces a still-open prompt EXACTLY once even when its frame re-ingests as accepted (Stage 4c)', async () => {
    const fb = scriptedBackend();
    const store1 = new RecordingStore();
    const eventFile = join(dir, randomUUID(), 'events.jsonl');
    const controlSocket = join(dir, `${randomUUID()}.sock`);
    const client1 = new FileTailRunnerClient(fb.backend, {
      store: store1,
      bus: new InMemoryEventBus(),
      allocateEventFile: () => eventFile,
      allocateControlSocket: () => controlSocket,
      pollMs: 2,
    });
    const turn1 = client1.startTurn(
      {
        store: store1,
        worktree: WORKTREE,
        cwd: WORKTREE,
        turnId: 'turn-x',
      } as unknown as RunTurnOptions,
      {},
    );
    await fb.started;
    await waitFor(() => store1.claimedCount === 4);

    // Reattach with a FRESH store — the crash-window case: the permission frame was
    // never ingested before the "crash", so the re-tail ingests it as `accepted` AND
    // it is still in the live D6 snapshot. Both sources must dedupe to one surface.
    const store2 = new RecordingStore();
    const resurfaced: PermissionRequest[] = [];
    const client2 = new FileTailRunnerClient(fb.backend, {
      store: store2,
      bus: new InMemoryEventBus(),
      allocateEventFile: () => join(dir, 'unused', 'events.jsonl'),
      pollMs: 2,
    });
    const turn2 = client2.attach(
      {
        turnId: 'turn-x',
        sessionId: SESSION_ID,
        eventFilePath: eventFile,
        controlSocketPath: controlSocket,
      },
      { onPermissionRequest: (r) => resurfaced.push(r) },
    );

    await waitFor(() => store2.claimedCount >= 4);
    await waitFor(() => resurfaced.length >= 1);
    fb.settle();
    await turn2.result;
    await turn1.result;

    expect(resurfaced.map((r) => r.toolUseId)).toEqual(['tool-1']);
  });

  // ADR 0011 D2: a standing grant must be consulted BEFORE the prompt becomes an
  // event. Answering afterwards still flashes an approval card and fires a push for
  // a decision the operator already made.
  it('auto-approves a granted prompt without persisting, publishing, or surfacing it', async () => {
    const fb = scriptedBackend();
    const store = new RecordingStore();
    const bus = new InMemoryEventBus();
    const published: { seq: number; ts: number; event: AgentEvent }[] = [];
    const permSeen: PermissionRequest[] = [];
    const gateSaw: PermissionRequest[] = [];

    const client = new FileTailRunnerClient(fb.backend, {
      store,
      bus,
      allocateEventFile: () => join(dir, randomUUID(), 'events.jsonl'),
      allocateControlSocket: () => join(dir, `${randomUUID()}.sock`),
      pollMs: 2,
      autoApprovePermission: async (_sessionId, request) => {
        gateSaw.push(request);
        return true;
      },
    });

    const opts = { store, worktree: WORKTREE, cwd: WORKTREE } as unknown as RunTurnOptions;
    const turn = client.startTurn(opts, {
      onSession: (id) => {
        bus.subscribe(id, (e) => published.push(e));
      },
      onPermissionRequest: (r) => permSeen.push(r),
    });

    await fb.started;
    // The grant answers it: the backend sees an allow without any operator action.
    await waitFor(() => fb.permissionAnswers.length === 1);

    expect(gateSaw).toEqual([PERMISSION_REQUEST]);
    expect(fb.permissionAnswers).toEqual([{ behavior: 'allow' }]);
    // No card: neither persisted nor published nor surfaced to the Conductor.
    expect(permSeen).toEqual([]);
    expect(store.appended.map((a) => a.event)).toEqual([EVENT_ONE, EVENT_TWO]);
    expect(published.map((p) => p.event)).toEqual([EVENT_ONE, EVENT_TWO]);
    // The frame is still claimed, so the sequence stays contiguous (D4).
    expect(store.claimedCount).toBeGreaterThanOrEqual(4);

    fb.settle();
    await expect(turn.result).resolves.toEqual(RESULT);
  });

  it('falls back to the normal card when the grant lookup says no or throws', async () => {
    for (const gate of [
      async () => false,
      async () => {
        throw new Error('grant store unavailable');
      },
    ]) {
      const fb = scriptedBackend();
      const store = new RecordingStore();
      const bus = new InMemoryEventBus();
      const permSeen: PermissionRequest[] = [];
      const client = new FileTailRunnerClient(fb.backend, {
        store,
        bus,
        allocateEventFile: () => join(dir, randomUUID(), 'events.jsonl'),
        allocateControlSocket: () => join(dir, `${randomUUID()}.sock`),
        pollMs: 2,
        autoApprovePermission: gate,
      });
      const opts = { store, worktree: WORKTREE, cwd: WORKTREE } as unknown as RunTurnOptions;
      const turn = client.startTurn(opts, { onPermissionRequest: (r) => permSeen.push(r) });

      await fb.started;
      await waitFor(() => permSeen.length === 1);
      expect(store.appended.map((a) => a.event)).toContainEqual(PERMISSION_EVENT);
      expect(fb.permissionAnswers).toEqual([]);

      fb.settle();
      await turn.result;
    }
  });
});

/**
 * The in-process control fallback: no `allocateControlSocket`, so the returned
 * handle forwards straight to the {@link RunnerServer} it started. Only `cancel`
 * had coverage here, and steer/answerPermission are the two commands whose loss is
 * invisible — a dropped steer just looks like an agent that ignored the operator.
 */
describe('FileTailRunnerClient in-process control', () => {
  it('forwards steer and answerPermission to the runner, then refuses both once settled', async () => {
    const fb = scriptedBackend();
    const store = new RecordingStore();
    const client = new FileTailRunnerClient(fb.backend, {
      store,
      bus: new InMemoryEventBus(),
      allocateEventFile: () => join(dir, randomUUID(), 'events.jsonl'),
      pollMs: 2,
    });
    const turn = client.startTurn(
      { store, worktree: WORKTREE, cwd: WORKTREE } as unknown as RunTurnOptions,
      {},
    );

    await fb.started;
    const steerMessage: SteerMessage = { text: 'in-process steer' };
    await expect(turn.answerPermission('tool-1', { behavior: 'allow' })).resolves.toBe(true);
    await expect(turn.steer(steerMessage)).resolves.toBe(true);
    await waitFor(() => fb.permissionAnswers.length === 1 && fb.steerSeen.length === 1);
    expect(fb.permissionAnswers).toEqual([{ behavior: 'allow' }]);
    expect(fb.steerSeen).toEqual([steerMessage]);

    fb.settle();
    await expect(turn.result).resolves.toEqual(RESULT);
    // A retained handle must not report a post-terminal command as applied.
    await expect(turn.steer({ text: 'too late' })).resolves.toBe(false);
    await expect(turn.answerPermission('tool-late', { behavior: 'allow' })).resolves.toBe(false);
    await expect(turn.cancel()).resolves.toBe(false);
  });

  // The hard-teardown handle for an abandoned turn: it settles the turn LOCALLY
  // (the tail is aborted) rather than waiting for a runner that may never answer.
  it('forceCancel settles the turn as aborted and re-certifies a second one', async () => {
    const fb = scriptedBackend();
    const store = new RecordingStore();
    const client = new FileTailRunnerClient(fb.backend, {
      store,
      bus: new InMemoryEventBus(),
      allocateEventFile: () => join(dir, randomUUID(), 'events.jsonl'),
      pollMs: 2,
    });
    const turn = client.startTurn(
      {
        store,
        worktree: WORKTREE,
        cwd: WORKTREE,
        storeSessionId: 'sess-force',
      } as unknown as RunTurnOptions,
      {},
    );

    await fb.started;
    await expect(turn.forceCancel?.()).resolves.toBe(true);
    await expect(turn.result).resolves.toEqual({
      sessionId: 'sess-force',
      exitCode: 143,
      stderr: '',
      aborted: true,
    });
    // A repeat force-cancel answers true, not false: the boolean certifies that the
    // turn no longer owns the worktree, and an already-settled turn satisfies that.
    await expect(turn.forceCancel?.()).resolves.toBe(true);
    fb.settle();
  });

  // A runner that never started has no handle to forward to. Reporting the start
  // failure is the difference between a visibly failed turn and a steer that hangs
  // on a promise nothing will ever settle.
  it('surfaces a runner start failure through a pending steer', async () => {
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    const fb = scriptedBackend();
    const client = new FileTailRunnerClient(fb.backend, {
      store: new RecordingStore(),
      bus: new InMemoryEventBus(),
      allocateEventFile: () => join(blocker, 'events.jsonl'),
      pollMs: 2,
    });
    const turn = client.startTurn({ store: {} as never, worktree: WORKTREE, cwd: WORKTREE }, {});

    const steering = turn.steer({ text: 'never delivered' });
    const startFailure: unknown = await turn.result.catch((error: unknown) => error);
    await expect(steering).rejects.toBe(startFailure);
    expect(String(startFailure)).toContain('blocker');
  });
});

describe('FileTailRunnerClient frame dispatch', () => {
  // Every frame claim is keyed by a session id. Without one there is no row to bind
  // to, and claiming under a guessed id would attach the turn's whole stream to the
  // wrong session — so the tail fails the turn instead.
  it('rejects the turn when a frame arrives before any session id is known', async () => {
    const client = new FileTailRunnerClient(scriptedBackend().backend, {
      store: new RecordingStore(),
      bus: new InMemoryEventBus(),
      allocateEventFile: () => join(dir, 'headless', 'events.jsonl'),
      allocateControlSocket: () => join(dir, `${randomUUID()}.sock`),
      launchTurn: async (_opts, artifacts) => {
        await mkdir(dirname(artifacts.eventFilePath), { recursive: true });
        await writeFile(
          artifacts.eventFilePath,
          `${JSON.stringify(
            stampFrame(
              { kind: 'event', event: EVENT_ONE },
              { turnId: 'turn-headless', runnerInstanceId: 'runner-1', frameSeq: 1 },
            ),
          )}\n`,
        );
      },
      pollMs: 2,
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: WORKTREE,
        cwd: WORKTREE,
        turnId: 'turn-headless',
      },
      {},
    );

    await expect(turn.result).rejects.toThrow('received a event frame before a session frame');
  });

  // An externally launched turn has no in-process handle to fall back to, so a
  // missing control socket would silently strip steer/cancel/permission from the
  // whole turn. Fail at launch instead.
  it('refuses an external launch that was allocated no control socket', () => {
    const client = new FileTailRunnerClient(scriptedBackend().backend, {
      store: new RecordingStore(),
      bus: new InMemoryEventBus(),
      allocateEventFile: () => join(dir, randomUUID(), 'events.jsonl'),
      launchTurn: async () => undefined,
      pollMs: 2,
    });

    expect(() =>
      client.startTurn({ store: {} as never, worktree: WORKTREE, cwd: WORKTREE }, {}),
    ).toThrow('external runner launch requires a control socket path');
  });
});

describe('FileTailRunnerClient.attach control (ADR 0006 D7)', () => {
  it('drives steer, permission answers and cancel over the reattached socket', async () => {
    const fb = scriptedBackend();
    const store = new RecordingStore();
    const eventFile = join(dir, randomUUID(), 'events.jsonl');
    const controlSocket = join(dir, `${randomUUID()}.sock`);
    const original = new FileTailRunnerClient(fb.backend, {
      store,
      bus: new InMemoryEventBus(),
      allocateEventFile: () => eventFile,
      allocateControlSocket: () => controlSocket,
      pollMs: 2,
    });
    const turn1 = original.startTurn(
      {
        store,
        worktree: WORKTREE,
        cwd: WORKTREE,
        turnId: 'turn-attach-control',
      } as unknown as RunTurnOptions,
      {},
    );
    await fb.started;
    await waitFor(() => store.claimedCount === 4);

    const recovered = new FileTailRunnerClient(fb.backend, {
      store: new RecordingStore(),
      bus: new InMemoryEventBus(),
      allocateEventFile: () => join(dir, 'unused', 'events.jsonl'),
      pollMs: 2,
    });
    const turn2 = recovered.attach(
      {
        turnId: 'turn-attach-control',
        sessionId: SESSION_ID,
        eventFilePath: eventFile,
        controlSocketPath: controlSocket,
      },
      {},
    );

    const steerMessage: SteerMessage = { text: 'steered by the recovered server' };
    await expect(turn2.answerPermission('tool-1', { behavior: 'allow' })).resolves.toBe(true);
    await expect(turn2.steer(steerMessage)).resolves.toBe(true);
    await waitFor(() => fb.permissionAnswers.length === 1 && fb.steerSeen.length === 1);
    expect(fb.permissionAnswers).toEqual([{ behavior: 'allow' }]);
    expect(fb.steerSeen).toEqual([steerMessage]);

    await expect(turn2.cancel()).resolves.toBe(true);
    await waitFor(() => fb.cancelled);

    fb.settle();
    await expect(turn2.result).resolves.toEqual(RESULT);
    await turn1.result;
    await expect(turn2.steer({ text: 'too late' })).resolves.toBe(false);
    await expect(turn2.answerPermission('tool-late', { behavior: 'allow' })).resolves.toBe(false);
    await expect(turn2.cancel()).resolves.toBe(false);
  });

  it('forceCancel settles a reattached turn as aborted and refuses every later steer', async () => {
    const client = new FileTailRunnerClient(scriptedBackend().backend, {
      store: new RecordingStore(),
      bus: new InMemoryEventBus(),
      allocateEventFile: () => join(dir, 'unused', 'events.jsonl'),
      pollMs: 2,
    });
    const turn = client.attach(
      {
        turnId: 'turn-gone',
        sessionId: 'sess-gone',
        eventFilePath: join(dir, 'gone', 'events.jsonl'),
        controlSocketPath: join(dir, 'gone.sock'),
      },
      {},
    );

    await expect(turn.forceCancel?.()).resolves.toBe(true);
    await expect(turn.result).resolves.toEqual({
      sessionId: 'sess-gone',
      exitCode: 143,
      stderr: '',
      aborted: true,
    });
    // …except forceCancel, which certifies termination rather than reporting delivery.
    await expect(turn.forceCancel?.()).resolves.toBe(true);
    await expect(turn.steer({ text: 'too late' })).resolves.toBe(false);
    await expect(turn.answerPermission('tool-1', { behavior: 'allow' })).resolves.toBe(false);
    await expect(turn.cancel()).resolves.toBe(false);
  });

  // The re-tail is the recovered Server's only view of the turn. A stream it cannot
  // parse must fail the reattached handle, not leave it polling a broken file.
  it('rejects a reattached turn whose event stream cannot be parsed', async () => {
    const eventFile = join(dir, randomUUID(), 'events.jsonl');
    await mkdir(dirname(eventFile), { recursive: true });
    await writeFile(eventFile, '{"kind":"event","event":{"t":"text","delta":"x"}}\n');
    const client = new FileTailRunnerClient(scriptedBackend().backend, {
      store: new RecordingStore(),
      bus: new InMemoryEventBus(),
      allocateEventFile: () => join(dir, 'unused', 'events.jsonl'),
      pollMs: 2,
    });

    const turn = client.attach(
      {
        turnId: 'turn-corrupt',
        sessionId: SESSION_ID,
        eventFilePath: eventFile,
        controlSocketPath: join(dir, 'absent.sock'),
      },
      {},
    );

    await expect(turn.result).rejects.toThrow('invalid runner frame envelope');
  });
});

/**
 * ADR 0006 D5: a command whose ACK was lost is retried with the SAME command id
 * over a NEWER lease, so the Runner resolves it from its journal and applies it at
 * most once. Everything here is about which failures earn that retry and which are
 * reported as-is — get the classification wrong and a steer is either executed
 * twice or silently dropped.
 */
describe('FileTailRunnerClient control reconnect (ADR 0006 D5)', () => {
  const ACK: ControlAck = { commandId: 'ack', applied: true };

  function fakeControlClient(overrides: Partial<ControlSocketClient>): ControlSocketClient {
    return {
      turnId: 'turn-ctl',
      controllerId: 'controller-1',
      leaseEpoch: 1,
      snapshot: {
        protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
        lastFrameSeq: 0,
        turnStatus: 'running',
        outstandingPermissions: [],
      },
      steer: () => Promise.resolve(true),
      cancel: () => Promise.resolve(ACK),
      answerPermission: () => Promise.resolve(ACK),
      close: () => undefined,
      ...overrides,
    };
  }

  /** Start an externally launched turn (so control routes over the socket) whose
   * connect attempts are answered, in order, from `leases`. An `Error` entry stands
   * for a connect that fails. The launch writes no frames, so the turn stays live
   * until the test force-cancels it. */
  function turnWithLeases(
    leases: (ControlSocketClient | Error)[],
    opts: { signal?: AbortSignal } = {},
  ): { turn: ReturnType<FileTailRunnerClient['startTurn']>; connects: Record<string, unknown>[] } {
    const connects: Record<string, unknown>[] = [];
    let next = 0;
    controlSeam.connect = (_path, connectOpts) => {
      connects.push(connectOpts);
      const lease = leases[next];
      next += 1;
      if (lease === undefined) return Promise.reject(new Error('no further lease scripted'));
      return lease instanceof Error ? Promise.reject(lease) : Promise.resolve(lease);
    };
    const client = new FileTailRunnerClient(scriptedBackend().backend, {
      store: new RecordingStore(),
      bus: new InMemoryEventBus(),
      allocateEventFile: () => join(dir, randomUUID(), 'events.jsonl'),
      allocateControlSocket: () => join(dir, `${randomUUID()}.sock`),
      launchTurn: async () => undefined,
      pollMs: 5,
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: WORKTREE,
        cwd: WORKTREE,
        storeSessionId: SESSION_ID,
        turnId: 'turn-ctl',
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      },
      {},
    );
    return { turn, connects };
  }

  /** Stop the turn's tail so the temp dir can be removed. */
  async function stop(turn: ReturnType<FileTailRunnerClient['startTurn']>): Promise<void> {
    await turn.forceCancel?.();
    await turn.result;
  }

  afterEach(() => {
    controlSeam.connect = undefined;
  });

  it('resumes the same controller and replays the same command id after an ambiguous steer', async () => {
    const attempts: { commandId: string | undefined; lease: number }[] = [];
    const closed: number[] = [];
    const stale = fakeControlClient({
      leaseEpoch: 4,
      steer: (_message, options) => {
        attempts.push({ commandId: options?.commandId, lease: 4 });
        return Promise.reject(new ControlDeliveryUnknownError(options?.commandId ?? ''));
      },
      close: () => closed.push(4),
    });
    const fresh = fakeControlClient({
      leaseEpoch: 5,
      steer: (_message, options) => {
        attempts.push({ commandId: options?.commandId, lease: 5 });
        return Promise.resolve(true);
      },
    });
    const { turn, connects } = turnWithLeases([stale, fresh]);

    await expect(turn.steer({ text: 'keep going' })).resolves.toBe(true);

    expect(attempts.map((attempt) => attempt.lease)).toEqual([4, 5]);
    // Same id on the newer lease: the Runner resolves it from its journal and
    // applies the steer at most once.
    expect(attempts[1]?.commandId).toBe(attempts[0]?.commandId);
    expect(connects[1]).toEqual({
      turnId: 'turn-ctl',
      controllerId: connects[0]?.controllerId,
      resumeLeaseEpoch: 4,
      verifiedProtocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    });
    // The ambiguous lease is dropped rather than left open beside its successor.
    expect(closed).toEqual([4]);
    await stop(turn);
  });

  it('reports the ambiguity when the reconnect itself fails', async () => {
    const stale = fakeControlClient({
      steer: (_message, options) =>
        Promise.reject(new ControlDeliveryUnknownError(options?.commandId ?? '')),
    });
    const { turn } = turnWithLeases([stale, new Error('control socket is gone')]);

    const failure: unknown = await turn.steer({ text: 'keep going' }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ControlDeliveryUnknownError);
    expect((failure as Error).message).toMatch(
      /may have been delivered; retry it with the same id/u,
    );
    await stop(turn);
  });

  // A rejection is a decided outcome — the Runner answered. Retrying it on a new
  // lease would be a second delivery of a command that was never ambiguous.
  it('does not reconnect for a steer the runner explicitly rejected', async () => {
    const lease = fakeControlClient({
      steer: () => Promise.reject(new ControlCommandRejectedError('cmd-1', 'stale-lease')),
    });
    const { turn, connects } = turnWithLeases([lease]);

    await expect(turn.steer({ text: 'keep going' })).rejects.toThrow(
      "control command 'cmd-1' was rejected: stale-lease",
    );
    expect(connects).toHaveLength(1);
    await stop(turn);
  });

  // A permission answer is keyed deterministically by turn + prompt, so a retry
  // after any kind of ambiguity is recognised as the same decision.
  it('reports a handler-error permission answer as ambiguous under its per-prompt id', async () => {
    const lease = fakeControlClient({
      answerPermission: (_toolUseId, _decision, options) =>
        Promise.resolve({
          commandId: options?.commandId ?? '',
          applied: false,
          reason: 'handler-error',
        }),
    });
    const { turn, connects } = turnWithLeases([lease]);

    const failure: unknown = await turn
      .answerPermission('tool-1', { behavior: 'allow' })
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ControlDeliveryUnknownError);
    expect((failure as ControlDeliveryUnknownError).commandId).toBe('permission:turn-ctl:tool-1');
    // A handler error is ambiguous, not unreachable: the lease is still good.
    expect(connects).toHaveLength(1);
    await stop(turn);
  });

  it('retries an unreachable permission answer on a fresh lease and reports the applied outcome', async () => {
    const retried: (string | undefined)[] = [];
    const stale = fakeControlClient({
      answerPermission: () =>
        Promise.resolve({
          commandId: 'permission:turn-ctl:tool-1',
          applied: false,
          reason: 'unreachable',
        }),
    });
    const fresh = fakeControlClient({
      answerPermission: (_toolUseId, _decision, options) => {
        retried.push(options?.commandId);
        return Promise.resolve({ commandId: options?.commandId ?? '', applied: true });
      },
    });
    const { turn } = turnWithLeases([stale, fresh]);

    await expect(turn.answerPermission('tool-1', { behavior: 'allow' })).resolves.toBe(true);
    expect(retried).toEqual(['permission:turn-ctl:tool-1']);
    await stop(turn);
  });

  it('reports an unreachable permission answer as ambiguous when it cannot be retried', async () => {
    const unreachable = (): Promise<ControlAck> =>
      Promise.resolve({
        commandId: 'permission:turn-ctl:tool-1',
        applied: false,
        reason: 'unreachable',
      });
    const noReconnect = turnWithLeases([
      fakeControlClient({ answerPermission: unreachable }),
      new Error('control socket is gone'),
    ]);
    const failed: unknown = await noReconnect.turn
      .answerPermission('tool-1', { behavior: 'allow' })
      .catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ControlDeliveryUnknownError);
    expect((failed as ControlDeliveryUnknownError).commandId).toBe('permission:turn-ctl:tool-1');
    await stop(noReconnect.turn);

    // The retry landing on a lease that is ALSO unreachable stays ambiguous, under
    // the id the retry reported.
    const stillGone = turnWithLeases([
      fakeControlClient({ answerPermission: unreachable }),
      fakeControlClient({
        answerPermission: () =>
          Promise.resolve({ commandId: 'retry-1', applied: false, reason: 'unreachable' }),
      }),
    ]);
    const retryFailed: unknown = await stillGone.turn
      .answerPermission('tool-1', { behavior: 'allow' })
      .catch((e: unknown) => e);
    expect(retryFailed).toBeInstanceOf(ControlDeliveryUnknownError);
    expect((retryFailed as ControlDeliveryUnknownError).commandId).toBe('retry-1');
    await stop(stillGone.turn);
  });

  // A decided refusal is an answer. Reporting it as `false` is what lets the caller
  // stop waiting; turning it into a retry would re-ask a Runner that already said no.
  it('returns the applied flag for a permission answer the runner decided against', async () => {
    const lease = fakeControlClient({
      answerPermission: () =>
        Promise.resolve({
          commandId: 'permission:turn-ctl:tool-1',
          applied: false,
          reason: 'command-conflict',
        }),
    });
    const { turn, connects } = turnWithLeases([lease]);

    await expect(turn.answerPermission('tool-1', { behavior: 'allow' })).resolves.toBe(false);
    expect(connects).toHaveLength(1);
    await stop(turn);
  });

  it('classifies cancel failures the same way, under the per-turn cancel id', async () => {
    const handlerError = turnWithLeases([
      fakeControlClient({
        cancel: (options) =>
          Promise.resolve({
            commandId: options?.commandId ?? '',
            applied: false,
            reason: 'handler-error',
          }),
      }),
    ]);
    const handlerFailure: unknown = await handlerError.turn.cancel().catch((e: unknown) => e);
    expect(handlerFailure).toBeInstanceOf(ControlDeliveryUnknownError);
    expect((handlerFailure as ControlDeliveryUnknownError).commandId).toBe('cancel:turn-ctl');
    expect(handlerError.connects).toHaveLength(1);
    await stop(handlerError.turn);

    const unreachable = (): Promise<ControlAck> =>
      Promise.resolve({ commandId: 'cancel:turn-ctl', applied: false, reason: 'unreachable' });
    const retriedIds: (string | undefined)[] = [];
    const retried = turnWithLeases([
      fakeControlClient({ cancel: unreachable }),
      fakeControlClient({
        cancel: (options) => {
          retriedIds.push(options?.commandId);
          return Promise.resolve({ commandId: options?.commandId ?? '', applied: true });
        },
      }),
    ]);
    await expect(retried.turn.cancel()).resolves.toBe(true);
    expect(retriedIds).toEqual(['cancel:turn-ctl']);
    await stop(retried.turn);

    const noReconnect = turnWithLeases([
      fakeControlClient({ cancel: unreachable }),
      new Error('control socket is gone'),
    ]);
    const noReconnectFailure: unknown = await noReconnect.turn.cancel().catch((e: unknown) => e);
    expect(noReconnectFailure).toBeInstanceOf(ControlDeliveryUnknownError);
    expect((noReconnectFailure as ControlDeliveryUnknownError).commandId).toBe('cancel:turn-ctl');
    await stop(noReconnect.turn);

    const retryBroke = turnWithLeases([
      fakeControlClient({ cancel: unreachable }),
      fakeControlClient({
        cancel: () =>
          Promise.resolve({ commandId: 'retry-2', applied: false, reason: 'handler-error' }),
      }),
    ]);
    const retryFailure: unknown = await retryBroke.turn.cancel().catch((e: unknown) => e);
    expect(retryFailure).toBeInstanceOf(ControlDeliveryUnknownError);
    expect((retryFailure as ControlDeliveryUnknownError).commandId).toBe('retry-2');
    await stop(retryBroke.turn);
  });

  // No lease at all is not an error to throw at the caller: the turn is still
  // tailing, and the command simply was not applied.
  it('refuses every command when the control socket never connected', async () => {
    const { turn } = turnWithLeases([new Error('connect ENOENT')]);

    await expect(turn.steer({ text: 'keep going' })).resolves.toBe(false);
    await expect(turn.answerPermission('tool-1', { behavior: 'allow' })).resolves.toBe(false);
    await expect(turn.cancel()).resolves.toBe(false);
    await stop(turn);
  });

  // An externally launched runner outlives this process's abort signal, so the
  // abort has to travel over the control socket or the Sandbox keeps working on a
  // turn the Server has abandoned.
  it('cancels an externally launched runner over the socket when the turn signal aborts', async () => {
    const cancels: string[] = [];
    const lease = fakeControlClient({
      cancel: (options) => {
        cancels.push(options?.commandId ?? '');
        return Promise.resolve({ commandId: options?.commandId ?? '', applied: true });
      },
    });
    const controller = new AbortController();
    const { turn } = turnWithLeases([lease], { signal: controller.signal });

    controller.abort();
    await vi.waitFor(() => expect(cancels).toEqual(['cancel:turn-ctl']));
    await stop(turn);
  });

  // ADR 0011 D2 on the reattach path: a standing grant answers the prompt from
  // inside the tail, over the reattached control channel, so no card and no push
  // ever exist for a decision the operator already made.
  it('auto-approves a re-tailed prompt over the reattached control channel', async () => {
    const answered: { toolUseId: string; decision: PermissionDecision }[] = [];
    const connects: Record<string, unknown>[] = [];
    controlSeam.connect = (_path, opts) => {
      connects.push(opts);
      return Promise.resolve(
        fakeControlClient({
          answerPermission: (toolUseId, decision) => {
            answered.push({ toolUseId, decision });
            return Promise.resolve({ commandId: 'permission', applied: true });
          },
        }),
      );
    };
    const eventFile = join(dir, randomUUID(), 'events.jsonl');
    await mkdir(dirname(eventFile), { recursive: true });
    const meta = { turnId: 'turn-grant', runnerInstanceId: 'runner-1' };
    await writeFile(
      eventFile,
      [
        stampFrame({ kind: 'session', id: SESSION_ID }, { ...meta, frameSeq: 1 }),
        stampFrame(
          { kind: 'permission-request', request: PERMISSION_REQUEST },
          { ...meta, frameSeq: 2 },
        ),
        stampFrame({ kind: 'result', result: RESULT }, { ...meta, frameSeq: 3 }),
      ]
        .map((frame) => `${JSON.stringify(frame)}\n`)
        .join(''),
    );
    const store = new RecordingStore();
    const surfaced: PermissionRequest[] = [];
    const client = new FileTailRunnerClient(scriptedBackend().backend, {
      store,
      bus: new InMemoryEventBus(),
      allocateEventFile: () => join(dir, 'unused', 'events.jsonl'),
      autoApprovePermission: async () => true,
      pollMs: 2,
    });

    const turn = client.attach(
      {
        turnId: 'turn-grant',
        sessionId: SESSION_ID,
        protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
        eventFilePath: eventFile,
        controlSocketPath: join(dir, `${randomUUID()}.sock`),
      },
      { onPermissionRequest: (request) => surfaced.push(request) },
    );

    await expect(turn.result).resolves.toEqual(RESULT);
    expect(answered).toEqual([{ toolUseId: 'tool-1', decision: { behavior: 'allow' } }]);
    // No card: nothing surfaced to the Conductor and no `permission` event persisted.
    expect(surfaced).toEqual([]);
    expect(store.appended).toEqual([]);
    // The version discovery already authenticated rides the attach handshake.
    expect(connects[0]).toMatchObject({
      turnId: 'turn-grant',
      verifiedProtocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    });
  });
});

/** Poll `predicate` until true or a timeout. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
