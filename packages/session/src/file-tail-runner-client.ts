import { randomUUID } from 'node:crypto';
import type { PermissionDecision, PermissionRequest } from '@verity/adapter-claude';
import { RUNNER_FRAME_PROTOCOL_VERSION } from '@verity/store';
import type { EventBus } from './bus.js';
import type { RunnerFrameIngest, RunnerFrameIngestResult } from '@verity/store';
import type { RunResult, RunTurnOptions, SteerMessage } from './backend-contract.js';
import { brokeredGrantChannel, type Backend, type BrokeredGrantChannel } from './backend.js';
import { RunnerServer, type RunnerServerTurn } from './runner-server.js';
import type {
  RunnerAttachTarget,
  RunnerClient,
  RunnerTurn,
  StartTurnHooks,
} from './runner-contract.js';
import { tailFrames, type RunnerFrame } from './runner-transport.js';
import {
  connectControl,
  ControlDeliveryUnknownError,
  type ControlSocketClient,
} from './runner-control.js';

/** The narrow Server-side persistence seam this client drives (ADR 0006 D4): one
 * idempotent, transactional frame-ingest entry point. {@link EventStore} implements
 * it. Typed here (rather than as the full `EventStore`) so the client depends only on
 * what it uses. */
export interface RunnerFrameStore {
  ingestRunnerFrame(sessionId: string, frame: RunnerFrameIngest): Promise<RunnerFrameIngestResult>;
}

/**
 * The store envelope for one tailed frame: everything an ingest carries except the
 * event itself, which only some kinds have and which the client derives (an `event`
 * frame's own payload, or the synthetic `permission` it mints for a request it did
 * not auto-approve).
 *
 * Exported so a test can put a REAL frame — one a supervisor actually wrote — through
 * the real mapping and into the real store, rather than through a second hand-written
 * copy of these five fields. A frame the Store refuses is a turn that never settles,
 * which is the failure this whole path exists to end; a mapping asserted only against
 * a duplicate of itself cannot catch that.
 */
export function runnerFrameIngestEnvelope(frame: RunnerFrame): RunnerFrameIngest {
  return {
    protocolVersion: frame.protocolVersion,
    runnerInstanceId: frame.runnerInstanceId,
    turnId: frame.turnId,
    frameSeq: frame.frameSeq,
    payloadHash: frame.payloadHash,
    // A `result` is the turn's last word — the bit that closes the running marker.
    ...(frame.kind === 'result' ? { terminal: true as const } : {}),
  };
}

/**
 * The Server-side {@link RunnerClient} for the Stage 2.1 event-file transport (ADR
 * 0006 D1/D2). It runs each turn's {@link RunnerServer} against an allocated event
 * file, then TAILS that file and, for every frame:
 *   - every frame → `store.ingestRunnerFrame(sessionId, …)` — one idempotent,
 *     transactional claim of `(turnId, frameSeq)` that also persists the event when
 *     the frame carries one (SERVER as the seq authority — D2/D4);
 *   - `session` → `hooks.onSession(id)`;
 *   - `event` → on a NEWLY claimed frame, `bus.publish(sessionId, {seq, ts, event})`
 *     (a replayed duplicate is suppressed — it reaches clients via backlog replay);
 *   - `permission-request` → atomically persists + publishes a synthetic `permission`
 *     event, then calls `hooks.onPermissionRequest(request)`;
 *   - `result` → resolves the turn's `result`.
 *
 * Control (steer/cancel/answerPermission) is IN-PROCESS by default (the returned
 * {@link RunnerTurn} forwards straight to the in-process {@link RunnerServer} handle).
 * When `deps.allocateControlSocket` is set (ADR 0006 Stage 2.1b), control instead
 * routes over the REAL unix socket the RunnerServer serves (D1) — steer awaits the
 * socket reply — proving the control wire end-to-end even though the RunnerServer is
 * still in-process this slice. Event transport rides the file either way.
 *
 * NOTE: unlike {@link StartTurnHooks}, this client does NOT thread `hooks.bus`
 * through to the Runner — events reach the bus ONLY after the Server re-persists
 * them off the file (persist-then-publish). The Runner's bus is a no-op by design.
 */

/** What the Server-side {@link FileTailRunnerClient} needs: the real persistence
 * store + live bus (the Server owns both — the Runner owns neither), and an event-
 * file path allocator (unique per turn). */
export interface FileTailRunnerClientDeps {
  /** The real Server-side event store (Postgres-backed in production). Frames are
   * ingested idempotently (D4) so a re-tail after a crash never double-persists. */
  store: RunnerFrameStore;
  /** The live fan-out bus. Each event is published AFTER it persists, and ONLY when
   * newly claimed (a replayed duplicate reaches clients via backlog replay). */
  bus: EventBus;
  /** Allocate a fresh event-file path for a turn (e.g. `<dir>/<uuid>/events.jsonl`).
   * Called once per {@link startTurn}. */
  allocateEventFile: (turnId?: string) => string;
  /**
   * Opt-in (ADR 0006 Stage 2.1b): allocate a fresh control-socket path per turn
   * (e.g. `<dir>/<uuid>/control.sock`). When set, control (steer / cancel /
   * answerPermission) routes over the REAL unix socket the {@link RunnerServer}
   * serves (D1) instead of the in-process delegation — proving the control wire even
   * though the RunnerServer is still in-process this slice. Event transport still
   * rides the file (S2.1a) regardless. Omit it to keep control in-process.
   */
  allocateControlSocket?: (turnId?: string) => string;
  /** Stage 5c: launch the turn through an external supervisor. When present, this
   * replaces the in-process RunnerServer start; event tailing and control remain
   * exactly the same transport paths. */
  launchTurn?: (
    opts: RunTurnOptions & { turnId: string },
    artifacts: { eventFilePath: string; controlSocketPath: string },
  ) => Promise<void>;
  /**
   * Decide a permission prompt BEFORE it is persisted, published, or pushed —
   * the seam for a standing operator grant (ADR 0011 D2). Answering after the
   * event exists is too late: the app has already flashed an approval card and
   * the operator has already received a push for a prompt nobody needs to see.
   *
   * Resolves `true` to auto-allow. Fail-open by contract: a rejection or a
   * `false` leaves the prompt on its normal path, so a broken grant lookup can
   * never silently swallow an approval.
   *
   * `channel` is this client's own transport (ADR 0014 D3), not anything the frame
   * carries: the prompt is authored by the agent process, so a channel read out of
   * it would be the attacker-controlled value the ceiling exists to distrust.
   */
  autoApprovePermission?: (
    sessionId: string,
    request: PermissionRequest,
    channel: BrokeredGrantChannel,
  ) => Promise<boolean>;
  /** Poll interval for the file tail (ms); defaults to the transport's own default. */
  pollMs?: number;
}

/** The mutable state a run's frame tail threads through {@link FileTailRunnerClient.dispatchFrame}:
 * the session id (learned from the first `session` frame, or seeded from a reattach
 * marker), the out-of-band hooks, and the resolver that settles the turn's result. */
interface FrameDispatchContext {
  sessionId: string | undefined;
  hooks: StartTurnHooks;
  resolveResult: (result: RunResult) => void;
  /** Answer a prompt from inside the tail (auto-approval). Absent on the
   * in-process path, where the Conductor still answers after the fact. */
  answerPermission?: (toolUseId: string, decision: PermissionDecision) => Promise<boolean>;
}

/**
 * One controller lease to a live turn's control socket, with reconnect-on-ambiguous
 * (ADR 0006 D5). It owns the {@link ControlSocketClient} lifecycle so BOTH a fresh
 * {@link FileTailRunnerClient.startTurn} and a reattach ({@link FileTailRunnerClient.attach})
 * drive control through the SAME reconnect semantics — one source of truth for the
 * crash-safe retry (a steer/permission/cancel whose ACK is lost is retried with the
 * same `commandId` over a newer lease, so the Runner applies it at most once).
 */
class ReconnectingControlChannel {
  private client: ControlSocketClient | undefined;
  private reconnecting: Promise<ControlSocketClient | undefined> | undefined;
  private readonly initial: Promise<ControlSocketClient | undefined>;

  constructor(
    private readonly controlSocketPath: string,
    private readonly turnId: string,
    private readonly controllerId: string,
    private readonly capability: string | undefined,
    private readonly isSettled: () => boolean,
    private readonly verifiedProtocolVersion: number | undefined,
    connectInitial: () => Promise<ControlSocketClient | undefined>,
  ) {
    this.initial = connectInitial()
      .then((client) => {
        this.client = client;
        return client;
      })
      .catch(() => undefined);
  }

  private async current(): Promise<ControlSocketClient | undefined> {
    await this.initial;
    return this.client;
  }

  /** Reconnect after an ambiguous disconnect: resume the SAME controller id with a
   * newer lease so the retried command id resolves from the Runner's journal. */
  private reconnect(failed: ControlSocketClient): Promise<ControlSocketClient | undefined> {
    // Another overlapping command may already have installed a healthy client.
    if (this.client !== failed) return Promise.resolve(this.client);
    if (this.reconnecting !== undefined) return this.reconnecting;
    failed.close();
    this.reconnecting = connectControl(this.controlSocketPath, {
      turnId: this.turnId,
      controllerId: this.controllerId,
      ...(this.capability !== undefined ? { capability: this.capability } : {}),
      resumeLeaseEpoch: failed.leaseEpoch,
      ...(this.verifiedProtocolVersion !== undefined
        ? { verifiedProtocolVersion: this.verifiedProtocolVersion }
        : {}),
    })
      .then((client) => {
        this.client = client;
        return client;
      })
      .catch(() => undefined)
      .finally(() => {
        this.reconnecting = undefined;
      });
    return this.reconnecting;
  }

  async steer(message: SteerMessage): Promise<boolean> {
    if (this.isSettled()) return false;
    const client = await this.current();
    if (this.isSettled() || client === undefined) return false;
    const commandId = randomUUID();
    try {
      return await client.steer(message, { commandId });
    } catch (error) {
      if (!(error instanceof ControlDeliveryUnknownError)) throw error;
      const reconnected = await this.reconnect(client);
      if (this.isSettled()) return false;
      if (reconnected === undefined) throw error;
      return await reconnected.steer(message, { commandId });
    }
  }

  async answerPermission(toolUseId: string, decision: PermissionDecision): Promise<boolean> {
    if (this.isSettled()) return false;
    const client = await this.current();
    if (this.isSettled() || client === undefined) return false;
    const commandId = `permission:${this.turnId}:${toolUseId}`;
    const outcome = await client.answerPermission(toolUseId, decision, { commandId });
    if (outcome.reason === 'handler-error') {
      throw new ControlDeliveryUnknownError(outcome.commandId);
    }
    if (outcome.reason !== 'unreachable') return outcome.applied;
    const reconnected = await this.reconnect(client);
    if (this.isSettled()) return false;
    if (reconnected === undefined) {
      throw new ControlDeliveryUnknownError(outcome.commandId);
    }
    const retried = await reconnected.answerPermission(toolUseId, decision, {
      commandId: outcome.commandId,
    });
    if (retried.reason === 'handler-error' || retried.reason === 'unreachable') {
      throw new ControlDeliveryUnknownError(retried.commandId);
    }
    return retried.applied;
  }

  async cancel(): Promise<boolean> {
    if (this.isSettled()) return false;
    const client = await this.current();
    if (this.isSettled() || client === undefined) return false;
    const commandId = `cancel:${this.turnId}`;
    const outcome = await client.cancel({ commandId });
    if (outcome.reason === 'handler-error') {
      throw new ControlDeliveryUnknownError(outcome.commandId);
    }
    if (outcome.reason !== 'unreachable') return outcome.applied;
    const reconnected = await this.reconnect(client);
    if (this.isSettled()) return false;
    if (reconnected === undefined) {
      throw new ControlDeliveryUnknownError(outcome.commandId);
    }
    const retried = await reconnected.cancel({ commandId: outcome.commandId });
    if (retried.reason === 'handler-error' || retried.reason === 'unreachable') {
      throw new ControlDeliveryUnknownError(retried.commandId);
    }
    return retried.applied;
  }

  close(): void {
    if (this.client !== undefined) this.client.close();
  }
}

/**
 * A {@link RunnerClient} that carries the turn's event stream over a file on the
 * bind-mount (Runner writes, Server tails), proving the ADR 0006 D1/D2 transport
 * end-to-end as an additive, roundtrip-tested module. NOT wired into the live
 * dispatch path in this slice.
 */
export class FileTailRunnerClient implements RunnerClient {
  private readonly runnerServer: RunnerServer;
  /** The transport standing grants are redeemed against for turns this client runs
   * (ADR 0014 D3). Fixed at construction from the backend, which is server-side state. */
  private readonly grantChannel: BrokeredGrantChannel;

  constructor(
    backend: Backend,
    private readonly deps: FileTailRunnerClientDeps,
  ) {
    this.runnerServer = new RunnerServer(backend);
    this.grantChannel = brokeredGrantChannel(backend);
  }

  /**
   * Ingest ONE frame (idempotent claim of `(turnId, frameSeq)` — D4) and fire its
   * side effect ONLY when the frame is NEWLY claimed:
   *   - `session` → `onSession` (a duplicate re-tail does not re-bind);
   *   - `event`  → `bus.publish` with the Server-authoritative seq/ts (a duplicate is
   *     suppressed and reaches clients via backlog replay);
   *   - `permission-request` → `onPermissionRequest` (a duplicate is NOT re-fired; a
   *     reattach re-surfaces still-open prompts from the D6 attach snapshot instead);
   *   - `result` → resolve the turn (NOT gated on `accepted`: a reattach settles the
   *     fresh handle from the replayed terminal frame even though it ingests as a
   *     duplicate).
   * Shared verbatim by {@link startTurn} and {@link attach} so replay semantics are
   * identical on the fresh and reattach paths.
   */
  private async dispatchFrame(frame: RunnerFrame, ctx: FrameDispatchContext): Promise<void> {
    // Only the legacy in-process path leaves `sessionId` undefined and lets the
    // backend's session frame define it. External launch and reattach pre-seed the
    // Verity store-session id — every frame claim must remain attached to that DB
    // row. The backend id still reaches `onSession`, but must never replace the
    // persistence key (it has no matching `sessions` row).
    if (frame.kind === 'session' && ctx.sessionId === undefined) ctx.sessionId = frame.id;
    if (ctx.sessionId === undefined) {
      throw new Error(`received a ${frame.kind} frame before a session frame`);
    }
    // A standing grant decides the prompt BEFORE it becomes an event (ADR 0011 D2):
    // no `permission` event means no approval card, no push, and no pending entry
    // for a decision the operator already made. The frame is still claimed below so
    // the sequence stays contiguous; the `tool_call` that follows keeps the request
    // itself visible in the transcript.
    const grantCovered =
      frame.kind === 'permission-request' &&
      ctx.answerPermission !== undefined &&
      (await this.deps
        .autoApprovePermission?.(ctx.sessionId, frame.request, this.grantChannel)
        .catch(() => false)) === true;
    // A grant lookup is not an approval until the Runner ACKs the decision. If
    // delivery fails or the prompt is no longer applicable, keep the ordinary
    // durable card path: claiming the frame without either an ACK or a card would
    // make the permission invisible forever, including after reattach.
    const autoApproved =
      grantCovered &&
      (await ctx.answerPermission!(frame.request.toolUseId, { behavior: 'allow' }).catch(
        () => false,
      )) === true;
    // Claim EVERY frame under `(turnId, frameSeq)` so the sequence stays contiguous
    // and a re-tail after a crash is idempotent (D4). Event frames also persist their
    // event inside that same transaction; other frames just claim their slot.
    const permissionEvent =
      frame.kind === 'permission-request' && !autoApproved
        ? ({
            t: 'permission',
            id: frame.request.toolUseId,
            tool: frame.request.toolName,
            input: frame.request.input,
            riskClass: 'ask',
            grantChannel: this.grantChannel,
          } as const)
        : undefined;
    const ingest: RunnerFrameIngest = {
      ...runnerFrameIngestEnvelope(frame),
      ...(frame.kind === 'event'
        ? { event: frame.event }
        : permissionEvent !== undefined
          ? { event: permissionEvent }
          : {}),
    };
    const outcome = await this.deps.store.ingestRunnerFrame(ctx.sessionId, ingest);
    // Side effects fire ONLY for a newly-claimed frame. On the live path today's single
    // tail delivers each frame once (every frame `accepted`); on a reattach a replayed
    // frame is a `duplicate` and must not re-publish an event or re-surface an already-
    // answered permission.
    const accepted = outcome.outcome === 'accepted';
    switch (frame.kind) {
      case 'session': {
        if (accepted) await ctx.hooks.onSession?.(frame.id);
        return;
      }
      case 'event': {
        // Persist-then-publish, Server-side seq authority (D2). Publish ONLY a newly
        // claimed frame — a replayed duplicate is suppressed here and reaches a
        // reconnecting client through backlog replay instead (D4).
        if (accepted && outcome.seq !== undefined && outcome.ts !== undefined) {
          this.deps.bus.publish(ctx.sessionId, {
            seq: outcome.seq,
            ts: outcome.ts,
            event: frame.event,
          });
        }
        return;
      }
      case 'permission-request': {
        if (autoApproved) {
          // The standing grant was acknowledged before the frame was claimed, so no
          // card and no push ever existed.
          return;
        }
        if (accepted) {
          // Brokered/native tools request approval before their eventual tool_call is
          // emitted. Persist + publish the prompt itself so the app can render an
          // approval card immediately and replay it after a WebSocket reconnect.
          if (outcome.seq !== undefined && outcome.ts !== undefined) {
            this.deps.bus.publish(ctx.sessionId, {
              seq: outcome.seq,
              ts: outcome.ts,
              event: permissionEvent!,
            });
          }
          ctx.hooks.onPermissionRequest?.(frame.request);
        }
        return;
      }
      case 'result': {
        // NOT gated on `accepted`: resolving an already-settled promise is a no-op on
        // the live path, and on a genuine reattach the fresh turn's `result` MUST
        // settle from the replayed terminal frame even though it ingests as a duplicate.
        ctx.resolveResult(frame.result);
        return;
      }
    }
  }

  startTurn(opts: RunTurnOptions, hooks: StartTurnHooks): RunnerTurn {
    // The Server allocates the turn id before launch (ADR 0006 D2): it is stamped on
    // every frame envelope and is the key under which the Server idempotently ingests
    // the turn's stream (D4). Stage 4: the Conductor now mints it and persists it on
    // the in-flight marker before calling here, passing it via `opts.turnId`; fall
    // back to a fresh id for any caller that does not (tests, older callers).
    const turnId = opts.turnId ?? randomUUID();
    const eventFilePath = this.deps.allocateEventFile(turnId);
    // Opt-in: route control over the REAL unix socket the RunnerServer serves (D1)
    // instead of in-process delegation. Event transport still rides the file.
    const controlSocketPath = this.deps.allocateControlSocket?.(turnId);
    if (this.deps.launchTurn !== undefined && controlSocketPath === undefined) {
      throw new Error('external runner launch requires a control socket path');
    }
    const controller = new AbortController();

    let resolveResult!: (r: RunResult) => void;
    let rejectResult!: (e: unknown) => void;
    const result = new Promise<RunResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    let settled = false;

    // Started before the tail so the file exists (or is being written) as we poll.
    let serverTurn: RunnerServerTurn | undefined;
    const externalLaunch = this.deps.launchTurn;
    const serverTurnPromise: Promise<RunnerServerTurn | undefined> =
      externalLaunch === undefined
        ? this.runnerServer.run(eventFilePath, {
            ...opts,
            turnId,
            ...(controlSocketPath !== undefined ? { controlSocketPath } : {}),
          })
        : externalLaunch(
            { ...opts, turnId },
            { eventFilePath, controlSocketPath: controlSocketPath! },
          ).then(() => undefined);
    // Bind `serverTurn` for the in-process control fallback (no socket). `undefined`
    // on a run-start failure — the tail below surfaces that as a turn rejection.
    const serverStarted = serverTurnPromise.then(
      (t) => {
        serverTurn = t;
        return t;
      },
      () => undefined,
    );

    // When routing control over the socket (D1), one reconnecting channel owns the
    // control client; connect only AFTER the RunnerServer's `run` resolves (it awaits
    // the socket listen), so an early cancel/permission is acknowledged rather than
    // dropped into an unobservable callback. Omit the socket → in-process delegation.
    const controllerId = randomUUID();
    const channel =
      controlSocketPath !== undefined
        ? new ReconnectingControlChannel(
            controlSocketPath,
            turnId,
            controllerId,
            opts.startCommandId,
            () => settled,
            RUNNER_FRAME_PROTOCOL_VERSION,
            () =>
              serverStarted.then((t) =>
                externalLaunch === undefined && t === undefined
                  ? undefined
                  : connectControl(controlSocketPath, {
                      turnId,
                      controllerId,
                      ...(opts.startCommandId !== undefined
                        ? { capability: opts.startCommandId }
                        : {}),
                      verifiedProtocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
                    }),
              ),
          )
        : undefined;

    const dispatchHooks: StartTurnHooks =
      externalLaunch === undefined || opts.onSession === undefined
        ? hooks
        : {
            ...hooks,
            onSession: async (id) => {
              await opts.onSession?.(id);
              await hooks.onSession?.(id);
            },
          };
    const dispatchCtx: FrameDispatchContext = {
      sessionId: externalLaunch === undefined ? undefined : opts.storeSessionId,
      hooks: dispatchHooks,
      resolveResult,
      // Routed control only: `channel` is initialized above, and the closure runs
      // later (from the tail), never during construction.
      ...(channel === undefined
        ? {}
        : {
            answerPermission: (toolUseId: string, decision: PermissionDecision) =>
              channel.answerPermission(toolUseId, decision),
          }),
    };

    const abortExternal = (): void => {
      if (externalLaunch !== undefined && channel !== undefined) {
        void channel.cancel().catch(() => undefined);
      }
    };
    if (externalLaunch !== undefined && opts.signal !== undefined) {
      if (opts.signal.aborted) abortExternal();
      else opts.signal.addEventListener('abort', abortExternal, { once: true });
    }

    // Drive the tail. When it resolves (a `result` frame was seen) the `result`
    // promise is already settled by the frame handler. A tail error (parse failure,
    // or the server run itself rejecting) rejects the turn's result.
    void (async (): Promise<void> => {
      try {
        // Surface a run-start failure (e.g. the RunnerServer failing to open the
        // file) as a turn rejection rather than an unhandled rejection.
        await serverTurnPromise;
        await tailFrames(eventFilePath, (frame) => this.dispatchFrame(frame, dispatchCtx), {
          signal: controller.signal,
          ...(this.deps.pollMs !== undefined ? { pollMs: this.deps.pollMs } : {}),
        });
      } catch (err) {
        rejectResult(err);
      }
    })();

    // Close the socket client once the turn settles (result or reject), so we don't
    // leak the connection. The RunnerServer tears down its socket server on settle
    // too; this drops the client side.
    const markSettled = (): void => {
      settled = true;
      opts.signal?.removeEventListener('abort', abortExternal);
      channel?.close();
    };
    void result.then(markSettled, markSettled);
    const getInProcessTurn = async (): Promise<RunnerServerTurn> => {
      const turn = serverTurn ?? (await serverTurnPromise);
      if (turn === undefined) throw new Error('external runner control socket is unavailable');
      return turn;
    };

    return {
      result,
      steer: async (message: SteerMessage): Promise<boolean> => {
        if (settled) return false;
        if (channel !== undefined) return channel.steer(message);
        const turn = await getInProcessTurn();
        if (settled) return false;
        return await turn.steer(message);
      },
      answerPermission: async (
        toolUseId: string,
        decision: PermissionDecision,
      ): Promise<boolean> => {
        if (settled) return false;
        if (channel !== undefined) return channel.answerPermission(toolUseId, decision);
        const turn = await getInProcessTurn();
        if (settled) return false;
        return await turn.answerPermission(toolUseId, decision);
      },
      cancel: async (): Promise<boolean> => {
        if (settled) return false;
        // Delegate cancel to the RunnerServer (over the socket when routing, else
        // in-process): it aborts the underlying run, which settles NORMALLY (aborted)
        // and writes a terminal `result` frame. The tail keeps running so it picks up
        // that frame and resolves `result` — we do NOT abort the tail here, or the
        // result would be lost. (`controller` remains the hard-teardown handle for an
        // abandoned turn.)
        if (channel !== undefined) return channel.cancel();
        const turn = await getInProcessTurn();
        if (settled) return false;
        return await turn.cancel();
      },
      forceCancel: (): Promise<boolean> => {
        // The boolean is a TERMINATION CERTIFICATE, not a report of whether this call
        // delivered the kill (see {@link RunnerTurn.forceCancel}): an already-settled
        // turn is proof the run no longer owns the worktree, so it answers true too.
        // Answering false would fence the session against a turn that is already gone.
        if (settled) return Promise.resolve(true);
        controller.abort();
        resolveResult({
          sessionId: opts.storeSessionId,
          exitCode: 143,
          stderr: '',
          aborted: true,
        });
        // A raw file-tail client cannot certify termination of a separately
        // launched worker; it only stopped its local tail. SupervisorRunnerClient
        // wraps this handle with the real out-of-band kill and returns true only
        // after that control plane proves the worker terminal.
        return Promise.resolve(externalLaunch === undefined);
      },
    };
  }

  /**
   * ADR 0006 Stage 4c (D7): reattach to an ALREADY-RUNNING turn instead of launching
   * one. No {@link RunnerServer} is started — the turn's agent is assumed live and its
   * artifacts durable. We re-tail the existing event file from byte zero (every already-
   * persisted frame re-ingests as a `duplicate` and fires no side effect; a NEW post-
   * crash frame is `accepted` and published), and reconnect the control socket, re-
   * surfacing still-open permission prompts from the D6 attach snapshot. The returned
   * {@link RunnerTurn} settles from the replayed (or newly-produced) terminal frame.
   */
  attach(target: RunnerAttachTarget, hooks: StartTurnHooks): RunnerTurn {
    const { turnId, sessionId, eventFilePath, controlSocketPath } = target;
    const controller = new AbortController();

    let resolveResult!: (r: RunResult) => void;
    let rejectResult!: (e: unknown) => void;
    const result = new Promise<RunResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    let settled = false;

    // A still-open prompt can reach us from TWO sources on reattach: the D6 attach
    // snapshot, and — if the Server crashed AFTER the Runner wrote the permission
    // frame but BEFORE the original tail ingested it — the re-tailed frame itself
    // (ingested as `accepted`, not a duplicate, so `dispatchFrame` fires it). Dedupe
    // by `toolUseId` so each prompt surfaces to the caller EXACTLY once, whichever
    // source wins the race.
    const surfacedPermissions = new Set<string>();
    const surfacePermission = (request: PermissionRequest): void => {
      if (surfacedPermissions.has(request.toolUseId)) return;
      surfacedPermissions.add(request.toolUseId);
      hooks.onPermissionRequest?.(request);
    };

    // Seed the session id from the recovered marker so ingest binds correctly even
    // before the (duplicate) `session` frame is re-tailed. The dispatch hooks route
    // an accepted permission frame through the same dedupe as the snapshot below.
    const dispatchCtx: FrameDispatchContext = {
      sessionId,
      hooks: { ...hooks, onPermissionRequest: surfacePermission },
      resolveResult,
      // `channel` is created just below; the closure only runs later, from the tail.
      answerPermission: (toolUseId: string, decision: PermissionDecision) =>
        channel.answerPermission(toolUseId, decision),
    };

    const controllerId = randomUUID();
    const channel = new ReconnectingControlChannel(
      controlSocketPath,
      turnId,
      controllerId,
      target.controlCapability,
      () => settled,
      target.protocolVersion,
      () =>
        connectControl(controlSocketPath, {
          turnId,
          controllerId,
          ...(target.controlCapability !== undefined
            ? { capability: target.controlCapability }
            : {}),
          ...(target.protocolVersion !== undefined
            ? { verifiedProtocolVersion: target.protocolVersion }
            : {}),
        }).then((client) => {
          // D8: re-surface still-open prompts from the D6 attach snapshot so the operator
          // can act on them again — the usual case, since the request frames re-ingest as
          // duplicates that do NOT re-fire `onPermissionRequest`.
          for (const request of client.snapshot.outstandingPermissions) {
            surfacePermission(request);
          }
          return client;
        }),
    );

    void (async (): Promise<void> => {
      try {
        await tailFrames(eventFilePath, (frame) => this.dispatchFrame(frame, dispatchCtx), {
          signal: controller.signal,
          ...(this.deps.pollMs !== undefined ? { pollMs: this.deps.pollMs } : {}),
        });
      } catch (err) {
        rejectResult(err);
      }
    })();

    const markSettled = (): void => {
      settled = true;
      channel.close();
    };
    void result.then(markSettled, markSettled);

    return {
      result,
      steer: (message: SteerMessage): Promise<boolean> =>
        settled ? Promise.resolve(false) : channel.steer(message),
      answerPermission: (toolUseId: string, decision: PermissionDecision): Promise<boolean> =>
        settled ? Promise.resolve(false) : channel.answerPermission(toolUseId, decision),
      cancel: (): Promise<boolean> => (settled ? Promise.resolve(false) : channel.cancel()),
      forceCancel: (): Promise<boolean> => {
        // Termination certificate, as in `startTurn` above: a settled reattached turn
        // has already produced its terminal frame, so true is the honest answer.
        if (settled) return Promise.resolve(true);
        controller.abort();
        resolveResult({ sessionId, exitCode: 143, stderr: '', aborted: true });
        // Reattachment is necessarily to an external worker. Closing this Server's
        // tail is not evidence that worker stopped; the supervisor wrapper supplies
        // the actual termination certificate.
        return Promise.resolve(false);
      },
    };
  }
}
