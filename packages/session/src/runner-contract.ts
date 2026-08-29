import { type PermissionDecision, type PermissionRequest } from '@verity/adapter-claude';
import type { AgentEvent } from '@verity/events';
import { type RunResult, type RunTurnOptions, type SteerMessage } from './backend-contract.js';
import type { EventBus } from './bus.js';
import type { Backend } from './backend.js';

/**
 * The Runner contract (ADR 0006, D5). It sits ONE layer BELOW the {@link Backend}
 * seam: the {@link Backend} still picks the agent binary + args + handoff context
 * (model-selection), while the {@link RunnerClient} owns a single turn's LIFECYCLE
 * across a (future) process boundary. Where {@link Backend.run} exposes control as
 * in-process CALLBACKS threaded through the run options (`onSteer`,
 * `onPermissionRequest`), the RunnerClient exposes control as METHODS on the
 * returned {@link RunnerTurn} handle. That shape is boundary-ready: the same handle
 * works when the {@link RunnerServer} later runs inside the Sandbox and the methods
 * become control-socket RPCs (D1) — the caller (the Conductor) never learns whether
 * the turn is in-process or remote.
 *
 * Stage 1 (this module) ships only the in-process {@link LoopbackRunnerClient}: the
 * Runner still runs in the Server process, but strictly behind this contract. No
 * process moves; the topology is unchanged; every existing test must stay green.
 * Persisted events keep flowing over the {@link EventBus} exactly as today — event
 * transport across the boundary is Stage 2 (deferred), so the `bus` still rides in
 * via {@link StartTurnHooks}.
 */

/**
 * A live handle to ONE running turn. `result` settles when the turn ends (a #79
 * cancel settles it normally — the underlying run reports `aborted`, it does not
 * reject); the control methods steer / answer-permission / cancel while it runs.
 */
export interface RunnerTurn {
  /**
   * The turn's terminal result. An operator-cancel (#79) settles this normally
   * (partial output already persisted, `RunResult.aborted` set) rather than
   * rejecting — the caller distinguishes a cancel from a crash via `aborted`.
   */
  readonly result: Promise<RunResult>;
  /**
   * Fold an operator message into the RUNNING turn (#101): the agent injects it at
   * its next step boundary. Resolves `false` once the turn's stdin is closed (the
   * turn ended, or it was never steerable) — the caller then falls back to queueing.
   * Async because the answer round-trips the control socket (ADR 0006 D1) once the
   * Runner runs across the boundary; the in-process implementations resolve
   * immediately with the same boolean the sync path returned.
   */
  steer(message: SteerMessage): Promise<boolean>;
  /**
   * Answer a parked permission prompt (#27): allow (optionally with edited input)
   * or deny the tool identified by `toolUseId`. Idempotent — a second answer for an
   * already-resolved id is a harmless no-op. The turn is PAUSED inside the agent
   * until this is called; the underlying runner still fail-safe-DENIES any prompt
   * left unanswered when the turn settles, so this only forwards a real answer.
   */
  answerPermission(toolUseId: string, decision: PermissionDecision): Promise<boolean>;
  /**
   * Stop the turn (#79): SIGTERM the agent via the underlying AbortController. The
   * `result` then settles normally with `aborted` set. A no-op after the turn has
   * already settled.
   */
  cancel(): Promise<boolean>;
  /**
   * Out-of-band fallback when the normal control channel does not acknowledge
   * {@link cancel}. Supervisor-backed turns use this to terminate the owning
   * worker directly; loopback turns may omit it. Resolves true only when worker
   * termination (including an already-terminal state) is confirmed. False means
   * no termination certificate was obtained and the session must remain fenced.
   */
  forceCancel?(): Promise<boolean>;
}

/**
 * The out-of-band hooks a caller wires into a turn at start. These are the pieces
 * that are NOT control-flow the caller drives (that's on the {@link RunnerTurn}
 * handle) but INBOUND notifications the Runner pushes up: the backend-minted
 * session id when it first binds, and a permission prompt when the agent raises
 * one. `bus` is the persisted-event fan-out seam, unchanged in Stage 1.
 */
export interface StartTurnHooks {
  /**
   * Called once with the backend-minted session id the moment it first binds (the
   * first `session` event) — lets a FRESH run's caller learn the id without awaiting
   * the whole turn. Mirrors {@link RunTurnOptions.onSession}.
   */
  onSession?: (id: string) => void | Promise<void>;
  /**
   * Called for each mid-turn permission prompt (#27). INBOUND notify ONLY — the
   * caller answers via {@link RunnerTurn.answerPermission}, not a callback here. The
   * request carries the `toolUseId` the answer is keyed to.
   */
  onPermissionRequest?: (request: PermissionRequest) => void;
  /** Fan-out seam: publish each persisted event to live subscribers (unchanged
   * transport in Stage 1; event transport moves across the boundary in Stage 2). */
  bus?: EventBus;
}

/**
 * Everything needed to reattach to an ALREADY-RUNNING turn (ADR 0006 Stage 4c / D7):
 * the turn identity + session the Server allocated (recovered from the `running_turns`
 * marker), and the durable artifacts the Runner is still writing/serving. A recovering
 * Server re-tails `eventFilePath` idempotently and reconnects `controlSocketPath` via
 * the D6 handshake instead of launching a new agent.
 */
export interface RunnerAttachTarget {
  turnId: string;
  sessionId: string;
  /** Protocol version already authenticated by supervisor discovery. Allows N+1 to
   * attach to an N control socket that predates read-only `inspect`. */
  protocolVersion?: number;
  eventFilePath: string;
  controlSocketPath: string;
}

/**
 * The result of discovering an abandoned turn's Runner during recovery (ADR 0006 D7):
 *  - `live`  → the agent is still running and reattachable; recovery reattaches
 *    ({@link RunnerClient.attach}) and continues tailing rather than settling it.
 *  - `uncertain` → the Runner's fate cannot yet be determined; recovery keeps the
 *    marker and does NOT interrupt or re-run — a later pass resolves it (bounded
 *    discovery). "A surviving turn is never inferred only from the event tail."
 *  - `dead`  → the Runner/Sandbox is confirmed gone; recovery settles the turn
 *    (`interrupted`) and drops the marker.
 */
export type RunnerRecoveryOutcome =
  { status: 'live'; target: RunnerAttachTarget } | { status: 'uncertain' } | { status: 'dead' };

/**
 * The seam recovery uses to decide reattach-vs-settle for an abandoned in-flight turn
 * (ADR 0006 D7). The real implementation queries the in-Sandbox supervisor by the
 * marker's `turnId`; it is left UNSET until turns route through the supervisor
 * (Stage 5), so recovery keeps its current "settle every abandoned turn" behavior by
 * default. `marker` is the durable `running_turns` row (carries `turnId`/`sessionId`).
 */
export interface RunnerRecovery {
  discover(marker: {
    sessionId: string;
    turnId: string;
    startCommandId: string | null;
  }): Promise<RunnerRecoveryOutcome>;
}

/**
 * The Server-side handle to the Runner. `startTurn` begins one turn behind the
 * contract and returns its {@link RunnerTurn}. The same interface backs both the
 * Stage 1 in-process {@link LoopbackRunnerClient} and the future remote client.
 */
export interface RunnerClient {
  startTurn(opts: RunTurnOptions, hooks: StartTurnHooks): RunnerTurn;
  /**
   * ADR 0006 Stage 4c (D7): reattach to an already-running turn's durable artifacts
   * instead of launching a new one — re-tail its event file idempotently (a replayed
   * frame is a no-op; a NEW post-crash frame publishes) and reconnect its control
   * socket, re-surfacing still-open permission prompts from the D6 attach snapshot.
   * OPTIONAL: only a client backed by a restart-durable transport implements it; the
   * in-process {@link LoopbackRunnerClient} cannot reattach and omits it. The returned
   * {@link RunnerTurn} settles from the replayed (or newly-produced) terminal frame.
   */
  attach?(target: RunnerAttachTarget, hooks: StartTurnHooks): RunnerTurn;
}

/**
 * The in-Sandbox side of the contract (owns the warm process + local ingest +
 * permission loop). For Stage 1 the loopback IS the server — the {@link
 * LoopbackRunnerClient} calls the in-process {@link Backend} directly, so there is
 * no separate server object yet. The interface is declared here so the Stage 2
 * remote implementation has a named seam to satisfy; it stays intentionally empty
 * until the transport lands. Intentionally empty until Stage 2 adds the event-file
 * writer + control-socket server methods.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RunnerServer {
  /* Stage 2: the in-Sandbox event-file writer + control-socket server. */
}

/**
 * Per-turn session/project identity handed to a {@link RunnerClientFactory}
 * alongside the backend. It carries ONLY per-turn identity — process-wide
 * dependencies (`dataVolumeRoot`, `store`, `bus`, socket allocators) stay in the
 * factory closure, not here. A future flag-gated supervisor wiring uses
 * {@link projectId} to locate the per-project runner-supervisor socket; the
 * loopback/file-tail factories ignore this context entirely, so threading it is a
 * pure signature addition with no behaviour change.
 */
export interface RunnerClientContext {
  /**
   * The bound Verity session id, or `null` on the fresh-spawn path before the
   * backend mints one. Pre-created sessions (project/Agent Loop turns, reattach,
   * and every steering turn) always carry it; only a fresh project-less
   * control-plane spawn (e.g. the concierge) reaches the factory before its id
   * binds, and such spawns have no per-project supervisor anyway (`projectId`
   * is `null`).
   */
  sessionId: string | null;
  /** Project the session runs in; `null` ⇒ control-plane session (no per-project supervisor). */
  projectId: string | null;
  /** The session's worktree (its `cwd`). */
  worktree: string;
  /**
   * A transient meta-query (auto-title/task refinement) collects the Runner's
   * normalized events here instead of persisting or broadcasting them. Runner
   * factories that honor this hook must also omit transcript persistence and
   * privileged tool wiring: the query is deliberately not a Verity session.
   */
  ephemeralEventSink?: ((event: AgentEvent) => void) | undefined;
}

/**
 * Build a {@link RunnerClient} from a selected {@link Backend} and the per-turn
 * {@link RunnerClientContext}. The Conductor picks the backend per turn (model
 * routing + per-session Docker wrapper — ADR 0006 D7) and hands it here, so the
 * loopback composes with `DockerExecBackend`/model selection unchanged: the
 * RunnerClient wraps whatever `backendForSession` returns. The context lets a
 * later supervisor-backed factory locate a per-project runner socket; the
 * built-in loopback/file-tail factories ignore it.
 *
 * May answer asynchronously: choosing between a project's Sandbox supervisor and the
 * in-process loopback means establishing whether that supervisor is actually
 * accepting connections, and no synchronous check can decide that (its socket file
 * outlives the generation that created it). The built-in factories stay synchronous
 * and a plain `RunnerClient` return remains valid — the Conductor awaits whatever
 * comes back.
 */
export type RunnerClientFactory = (
  backend: Backend,
  context: RunnerClientContext,
) => RunnerClient | Promise<RunnerClient>;

/**
 * The Stage 1 in-process Runner: wraps a {@link Backend} and drives one turn
 * through {@link Backend.run}, translating the run's in-process callbacks into the
 * boundary-ready {@link RunnerTurn} handle.
 *
 * The bridge is 1:1 with the old conductor wiring, so behavior is byte-for-byte
 * unchanged:
 *   - `cancel()` aborts an {@link AbortController} whose signal is threaded into the
 *     run as `signal` (#79) — same SIGTERM path as before.
 *   - `steer()` forwards to the inject fn the run surfaces via `onSteer` (#101);
 *     resolves `false` before the run has surfaced it, or once stdin is closed
 *     (async to match the boundary-ready contract; the answer is immediate here).
 *   - `answerPermission()` looks up the `respond` fn the run surfaced via
 *     `onPermissionRequest` and calls it (#27), then drops it so a repeat is a
 *     no-op. The run's own fail-safe still denies anything left unanswered at
 *     settle, so this only forwards real answers.
 *   - `onSession` / `bus` / `onPermissionRequest`(notify) pass straight through.
 */
export class LoopbackRunnerClient implements RunnerClient {
  constructor(
    private readonly backend: Backend,
    private readonly runtimeNotice?: string,
  ) {}

  startTurn(opts: RunTurnOptions, hooks: StartTurnHooks): RunnerTurn {
    // If the caller already threaded in a cancel signal (the Conductor registers a
    // handle synchronously at turn-accept, before this async start, so a cancel that
    // races the spawn still lands — #79), adopt its controller so `cancel()` aborts
    // the SAME signal the run observes. Otherwise own a fresh one.
    const externalSignal = opts.signal;
    const controller = new AbortController();
    if (externalSignal !== undefined) {
      // Mirror an external abort onto our controller so a single `cancel()` path
      // covers both (and a pre-existing abort is honoured immediately).
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    // Captured from the run's synchronous `onSteer` (fires at spawn). Undefined
    // until then, and stays whatever the run last handed us; the run's inject fn
    // itself returns false once stdin closes, so we don't have to track that here.
    let capturedInject: ((message: SteerMessage) => boolean) | undefined;
    // toolUseId → the run's `respond` fn for a parked permission prompt. Deleted on
    // first answer so a repeat is a no-op (idempotent, mirroring the old channel).
    const respondById = new Map<string, (decision: PermissionDecision) => void>();
    let settled = false;

    const appendSystemPrompt =
      this.runtimeNotice === undefined
        ? opts.appendSystemPrompt
        : `${opts.appendSystemPrompt ?? ''}\n\n${this.runtimeNotice}`.trim();
    const result = this.backend.run({
      ...opts,
      ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
      signal: controller.signal,
      ...(hooks.bus !== undefined ? { bus: hooks.bus } : {}),
      ...(hooks.onSession !== undefined ? { onSession: hooks.onSession } : {}),
      onSteer: (inject) => {
        capturedInject = inject;
      },
      onPermissionRequest: (request, respond) => {
        respondById.set(request.toolUseId, respond);
        hooks.onPermissionRequest?.(request);
      },
    });
    const markSettled = (): void => {
      settled = true;
      capturedInject = undefined;
      respondById.clear();
    };
    void result.then(markSettled, markSettled);

    return {
      result,
      // The inject decision is synchronous in-process; wrap it in a resolved promise
      // to satisfy the async contract without a spurious `async` (no await to make).
      steer: (message) =>
        Promise.resolve(!settled && capturedInject ? capturedInject(message) : false),
      answerPermission: (toolUseId, decision) => {
        if (settled) return Promise.resolve(false);
        const respond = respondById.get(toolUseId);
        if (respond === undefined) return Promise.resolve(false);
        respondById.delete(toolUseId);
        respond(decision);
        return Promise.resolve(true);
      },
      cancel: () => {
        if (settled || controller.signal.aborted) return Promise.resolve(false);
        controller.abort();
        return Promise.resolve(true);
      },
    };
  }
}
