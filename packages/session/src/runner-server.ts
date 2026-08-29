import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PermissionDecision, PermissionRequest } from '@verity/adapter-claude';
import type { AgentEvent } from '@verity/events';
import {
  RUNNER_FRAME_PROTOCOL_VERSION,
  type EventSink,
  type SessionInput,
  type SessionRecord,
} from '@verity/store';
import type { RunResult, RunTurnOptions, SteerMessage } from './backend-contract.js';
import type { Backend } from './backend.js';
import { LoopbackRunnerClient, type RunnerClient } from './runner-contract.js';
import { stampFrame, writeFrame, type RunnerFrameBody } from './runner-transport.js';
import { serveControl, type ControlSocketServer } from './runner-control.js';
import { initialRunnerTurnState, writeRunnerState, type RunnerTurnState } from './runner-state.js';

/**
 * The in-Sandbox side of the Runner boundary (ADR 0006 D5), for the Stage 2.1
 * event-file slice. A {@link RunnerServer} runs ONE turn against a file-sink
 * {@link EventSink} — every persisted event, the session bind, each permission
 * prompt, and the terminal result are serialized as {@link RunnerFrame}s to an
 * append-only JSONL event file (D1). The Runner touches NO DB (D2): its `store`
 * is the file-sink below, `createSession`/`getSession` do only the minimal
 * in-memory bookkeeping the ingest bind path needs, and there is no server-side
 * bus (events go to the file, not a bus — the Server tails the file and fans out).
 *
 * Control (steer / cancel / answerPermission) stays IN-PROCESS for this slice —
 * the {@link RunnerServer} delegates to the underlying Stage-1 loopback turn
 * handle. The control socket is a later slice; the event-file transport is what
 * this slice proves.
 *
 * Composes with the real run path by wrapping a {@link RunnerClient} (default: the
 * Stage-1 {@link LoopbackRunnerClient} over the given {@link Backend}), so the same
 * `Backend.run` drives the turn — only its outputs are teed to the file instead of
 * the DB/bus.
 */

/**
 * Serializes frame appends onto one held-open {@link FileHandle} through a promise
 * chain, so writes from different sources (the file-sink's `appendEvent`, the
 * `onSession`/`onPermissionRequest` hooks, the terminal `result`) are strictly
 * ordered and never interleave a partial line — concurrent `appendFile` calls on a
 * single handle are otherwise not order-guaranteed.
 */
class SerialFrameWriter {
  private tail: Promise<void> = Promise.resolve();
  private frameSeq = 0;

  constructor(
    private readonly handle: FileHandle,
    private readonly turnId: string,
    private readonly runnerInstanceId: string,
  ) {}

  /** The highest `frameSeq` stamped so far — the turn's frame count. Used to record
   * a discovery hint (`lastFrameSeq`) in the state file. */
  get frameCount(): number {
    return this.frameSeq;
  }

  /**
   * Stamp a body with the next contiguous `frameSeq` (ADR 0006 D3) and append it.
   * The seq is assigned SYNCHRONOUSLY at call time — JS runs each `write` call's
   * synchronous prefix to completion before the next, so seq order equals call order
   * equals the on-disk append order (the chain preserves it), keeping the sequence
   * gap-free even when `appendEvent` / `onSession` / `onPermissionRequest` interleave.
   */
  write(body: RunnerFrameBody): Promise<void> {
    const frame = stampFrame(body, {
      turnId: this.turnId,
      runnerInstanceId: this.runnerInstanceId,
      frameSeq: (this.frameSeq += 1),
    });
    const next = this.tail.then(() => writeFrame(this.handle, frame));
    // Keep the chain alive even if one write rejects (so later writes still run in
    // order); the returned promise still surfaces this write's own rejection.
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** A minimal in-memory {@link EventSink} that writes each `appendEvent` to the
 * event file as an `{kind:'event'}` frame and keeps NO DB. `createSession` /
 * `getSession` do just the bookkeeping the ingest bind path needs: remember the
 * session row so a resume within the same turn sees it, and hand back a synthetic,
 * monotonically increasing `seq`/`ts` (the Server is the real seq authority when
 * it re-persists on tail — D2; this local seq is only the file-write ordering). */
class FileEventSink implements EventSink {
  private seq = 0;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly writer: SerialFrameWriter) {}

  async appendEvent(_sessionId: string, event: AgentEvent): Promise<{ seq: number; ts: number }> {
    await this.writer.write({ kind: 'event', event });
    this.seq += 1;
    return { seq: this.seq, ts: Date.now() };
  }

  createSession(session: SessionInput): Promise<void> {
    this.sessions.set(session.sessionId, {
      sessionId: session.sessionId,
      worktree: session.worktree,
      model: session.model,
      name: session.name ?? null,
      projectId: session.projectId ?? null,
      kind: session.kind ?? 'normal',
      lastSeenEventCount: null,
    });
    return Promise.resolve();
  }

  getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return Promise.resolve(this.sessions.get(sessionId));
  }
}

/** Options a {@link RunnerServer} runs a turn under. `store`/`bus` are supplied
 * INTERNALLY by the server (the file-sink + no bus), so the caller passes the rest
 * of a {@link RunTurnOptions} minus those two. */
export type RunnerServerRunOptions = Omit<RunTurnOptions, 'store' | 'bus'> & {
  /**
   * The Server-allocated turn id (ADR 0006 D2). Stamped onto every frame's envelope
   * (D3) so the Server can bind the turn's stream to one runner instance and ingest a
   * re-tailed file idempotently (D4). Allocated once per turn by the caller.
   */
  turnId: string;
  /**
   * When set, the Runner ALSO serves a control socket at this path (ADR 0006 D1),
   * mapping `steer` / `cancel` / `answer-permission` messages to the in-process
   * turn's control methods. This is an ADDITIONAL control surface — the in-process
   * {@link RunnerServerTurn} handle keeps working unchanged. The socket is unlinked
   * when the turn settles. Omit it to run event-file-only (Stage 2.1a behaviour).
   */
  controlSocketPath?: string;
  /** Remote supervisor mode: fail if the immutable event log already exists. */
  exclusiveEventFile?: boolean;
  /** Remote worker mode: convert a rejected backend promise into durable terminal
   * frames so a detached Server tail never waits forever. */
  terminalizeErrors?: boolean;
};

/** A live handle to a turn driven through the {@link RunnerServer}: its terminal
 * result plus the in-process control methods (delegating to the Stage-1 loopback
 * turn). Mirrors the shape the Server-side {@link RunnerClient} exposes so the
 * {@link FileTailRunnerClient} can forward control straight through. */
export interface RunnerServerTurn {
  /** Settles when the turn ends and the terminal `result` frame has been written
   * and the event file flushed+closed. */
  readonly result: Promise<RunResult>;
  steer(message: SteerMessage): Promise<boolean>;
  answerPermission(toolUseId: string, decision: PermissionDecision): Promise<boolean>;
  cancel(): Promise<boolean>;
}

/**
 * The in-Sandbox Runner (Stage 2.1, in-process). Wraps a {@link RunnerClient}
 * (default: a {@link LoopbackRunnerClient} over the {@link Backend}) and tees the
 * turn's lifecycle into an event file.
 */
export class RunnerServer {
  private readonly client: RunnerClient;

  constructor(backend: Backend, client?: RunnerClient) {
    this.client = client ?? new LoopbackRunnerClient(backend);
  }

  /**
   * Run ONE turn, writing its stream to `eventFilePath`:
   *   - a `session` frame when the backend-minted id first binds (onSession),
   *   - an `event` frame per persisted event (via the file-sink `appendEvent`),
   *   - a `permission-request` frame per mid-turn prompt (onPermissionRequest),
   *   - a terminal `result` frame on settle, after which the file is flushed+closed.
   *
   * Returns a {@link RunnerServerTurn} whose in-process control methods stay live
   * (delegated to the underlying loopback turn). When `controlSocketPath` is set, an
   * ADDITIONAL control socket (ADR 0006 D1) is served that maps the same three
   * operations onto that same turn; the socket is unlinked on settle.
   */
  async run(eventFilePath: string, opts: RunnerServerRunOptions): Promise<RunnerServerTurn> {
    await mkdir(dirname(eventFilePath), { recursive: true });
    // 'w': fresh file per turn (truncate a stale one) so the tail's offset 0 is the
    // start of THIS turn's stream. The handle is held open for the whole turn and
    // closed after the terminal `result` frame.
    // Explicit mode, and a chmod after it, for the same reason the request/state
    // artefacts beside it carry one: the worker runs under `umask 0077`, so a file
    // created without a mode lands at 0600 and the Server — a DIFFERENT uid that
    // reaches this directory through the shared runner group — cannot tail it.
    // That surfaced as `EACCES: permission denied, open '.../turns/<id>/events.jsonl'`
    // on every control-plane turn, for both backends. The chmod also repairs a file
    // left at 0600 by an earlier run, which `'w'` would reuse without re-applying a
    // creation mode. Group READ only: the Server tails this stream, the worker owns
    // writing it.
    const handle = await open(eventFilePath, opts.exclusiveEventFile === true ? 'wx' : 'w', 0o640);
    try {
      await handle.chmod(0o640);
    } catch (error) {
      // The handle is already open; failing to normalise its mode must not leak it.
      await handle.close().catch(() => undefined);
      throw error;
    }
    // One runner-instance id per turn run (ADR 0006 D3): binds this turn's frame
    // stream immutably to this process instance, so the Server rejects a frame that
    // reuses the turn id under a different instance as corruption, not a duplicate.
    const runnerInstanceId = randomUUID();

    // `controlSocketPath`/`turnId` are RunnerServer-only knobs, not RunTurnOptions
    // fields — strip them before the rest reaches the backend run. `turnId` is stamped
    // onto every frame envelope by the writer.
    const { controlSocketPath, exclusiveEventFile, terminalizeErrors, turnId, ...runOpts } = opts;
    void exclusiveEventFile;
    const writer = new SerialFrameWriter(handle, turnId, runnerInstanceId);
    const sink = new FileEventSink(writer);
    const runnerOptions: RunTurnOptions = { ...(runOpts as RunTurnOptions), store: sink };

    // Per-turn status file (ADR 0006 D3): a small, atomically-replaced pointer beside
    // the event file that assists discovery. `persistState` serializes atomic replaces
    // through a promise chain and always writes the latest merged snapshot, so a
    // `sessionId`-bind racing the settle never writes a stale record. Written at the
    // key transitions (start / session-bind / settle) — it is a discovery hint, not the
    // event authority, so it need not mirror every frame.
    const stateFilePath = `${eventFilePath}.state.json`;
    const state: RunnerTurnState = initialRunnerTurnState(turnId, runnerInstanceId, Date.now());
    let stateTail: Promise<void> = Promise.resolve();
    // Best-effort: the status file is a discovery hint, not the event authority, so a
    // write failure must never fail the turn or surface as an unhandled rejection. Each
    // call chains an atomic replace of the latest snapshot and swallows its own error;
    // the returned promise is always safe to `await` or `void`.
    const persistState = (): Promise<void> => {
      state.updatedAt = Date.now();
      state.lastFrameSeq = writer.frameCount;
      const snapshot: RunnerTurnState = { ...state };
      stateTail = stateTail
        .then(() => writeRunnerState(stateFilePath, snapshot))
        .catch(() => undefined);
      return stateTail;
    };
    await persistState(); // publish the initial `running` record before the turn drives

    // Still-open permission prompts (ADR 0006 D6/D8): tracked so a (re)attaching Server
    // gets an accurate outstanding-permission snapshot in the attach handshake, even
    // when the original request frame was already deduplicated. Added on request,
    // removed when answered through EITHER control surface (socket or in-process).
    const outstandingPermissions = new Map<string, PermissionRequest>();

    const turn = this.client.startTurn(runnerOptions, {
      onSession: async (id) => {
        await writer.write({ kind: 'session', id });
        state.sessionId = id;
        void persistState();
      },
      onPermissionRequest: (request) => {
        outstandingPermissions.set(request.toolUseId, request);
        void writer.write({ kind: 'permission-request', request });
      },
      // No bus: events go to the file, not a server-side bus (D2).
    });

    // Clearing a prompt from the outstanding set is done here (not inside the backend)
    // so BOTH control surfaces — the socket handlers below and the in-process handle
    // returned at the end — keep the D6 snapshot accurate. Clear only AFTER the answer
    // APPLIES (the turn returns true): a false result means the prompt was already
    // resolved or the turn has settled, so a still-open prompt is never dropped from a
    // reattach snapshot on a non-applying answer (D8 — disconnect never implies allow).
    const answerPermission = async (
      toolUseId: string,
      decision: PermissionDecision,
    ): Promise<boolean> => {
      const applied = await turn.answerPermission(toolUseId, decision);
      if (applied) outstandingPermissions.delete(toolUseId);
      return applied;
    };

    // Serve the control socket, if requested, as an ADDITIONAL surface mapping the
    // wire ops onto the SAME in-process turn (the in-process handle below still works
    // unchanged — back-compat). Awaited so the returned turn's socket is already
    // listening when the caller connects to it.
    let controlServer: ControlSocketServer | undefined;
    if (controlSocketPath !== undefined) {
      controlServer = await serveControl(
        controlSocketPath,
        {
          steer: (message) => turn.steer(message),
          cancel: () => turn.cancel(),
          answerPermission,
        },
        {
          turnId,
          journalPath: `${controlSocketPath}.journal`,
          // D6 controller-lease takeover: a Server that reattaches after a restart
          // (ADR 0006 Stage 4c) has lost the prior controller id/epoch, so it must
          // ACQUIRE with a fresh id. Allow it — acquire bumps the monotonic lease
          // epoch, which fences the previous controller's stale-epoch commands, so
          // "highest epoch wins" still holds at most one live controller.
          authorizeAcquire: () => true,
          // D6 handshake: report this turn's live disposition at attach time.
          attachSnapshot: () => ({
            protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
            runnerInstanceId,
            lastFrameSeq: writer.frameCount,
            turnStatus: state.status,
            outstandingPermissions: [...outstandingPermissions.values()],
          }),
        },
      );
    }

    const markSettled = (aborted: boolean): Promise<void> => {
      state.status = 'settled';
      state.aborted = aborted;
      state.settledAt = Date.now();
      return persistState();
    };

    const result = (async (): Promise<RunResult> => {
      let settled: RunResult;
      try {
        settled = await turn.result;
      } catch (err) {
        if (terminalizeErrors === true) {
          const message = err instanceof Error ? err.message : String(err);
          await writer.write({
            kind: 'event',
            event: { t: 'error', kind: 'run_failed', message },
          });
          settled = {
            sessionId: state.sessionId ?? undefined,
            exitCode: 1,
            stderr: message.slice(-4_096),
            aborted: runOpts.signal?.aborted === true,
          };
          await writer.write({ kind: 'result', result: settled });
          await handle.sync().catch(() => undefined);
          await handle.close();
          await markSettled(settled.aborted);
          await controlServer?.close().catch(() => undefined);
          return settled;
        }
        // Don't leak the fd or the socket on a rejected run; the reject still propagates.
        // Record the abnormal settle so discovery doesn't see the turn as forever live.
        // NOTE: no terminal `result` frame is written here — the run rejected before
        // producing one — so this `settled` record has NO terminal frame in the log. The
        // frame log stays authoritative (D3): a reattach consumer must confirm the turn's
        // real disposition from the log, never infer "terminal frame exists" from `settled`.
        await markSettled(true).catch(() => undefined);
        await handle.close().catch(() => undefined);
        await controlServer?.close().catch(() => undefined);
        throw err;
      }
      await writer.write({ kind: 'result', result: settled });
      await handle.sync().catch(() => undefined);
      await handle.close();
      // Normal settle: mark settled AFTER the terminal frame is durable, so a `settled`
      // record from a NORMAL end always has its terminal frame on disk. (The abnormal path
      // above is the exception — hence the frame log, not `status`, is the authority; D3.)
      await markSettled(settled.aborted);
      // Tear down the control socket on settle (unlinks the socket file).
      await controlServer?.close().catch(() => undefined);
      return settled;
    })();

    return {
      result,
      steer: (message) => turn.steer(message),
      answerPermission,
      cancel: () => turn.cancel(),
    };
  }
}
