import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  appendExternalPromptData,
  type AgentEvent,
  type Attachment,
  type AttachmentUpload,
} from '@verity/events';
import { isLocalProject } from '@verity/store';
import type {
  EventStore,
  QueuedTurnOpts,
  RunningTurnRecord,
  SessionRecord,
  TranscriptStore,
} from '@verity/store';
import type { EventBus } from './bus.js';
import { AcpClaudeBackend } from './acp-claude-backend.js';
import { brokeredGrantChannel, type Backend, type BrokeredGrantChannel } from './backend.js';
import { isCodexModel } from './codex-model.js';
import { materializeFileAttachments } from './file-attachments.js';
import { buildHandoffPrompt } from './handoff.js';
import { isNoSessionInitFailure } from './ingest.js';
import { withMeetingContext } from './meeting-context.js';
import {
  buildBranchPrompt,
  buildTitlePrompt,
  sanitizeBranchName,
  sanitizeTitle,
} from './session-title.js';
import { buildVisibleMediaRepairEvent } from './visible-media-repair.js';
import {
  brokeredGrantTarget,
  brokeredGrantToolName,
  type BrokeredGrantToolName,
} from './brokered-grants.js';
export {
  brokeredGrantTarget,
  brokeredGrantToolName,
  type BrokeredGrantToolName,
} from './brokered-grants.js';
import type { PermissionDecision, PermissionRequest } from '@verity/adapter-claude';
import {
  type RunResult,
  type RunTurnOptions,
  type Spawner,
  type SteerMessage,
} from './backend-contract.js';
import {
  LoopbackRunnerClient,
  type RunnerAttachTarget,
  type RunnerClientFactory,
  type RunnerRecovery,
  type RunnerRecoveryOutcome,
  type RunnerTurn,
} from './runner-contract.js';

/** Upper bound on a single abandoned-turn discovery (ADR 0006 D7). Startup recovery
 * awaits discovery per marker before draining the queue, so a hanging seam would
 * otherwise wedge the whole restart; on timeout the turn is treated as `uncertain`
 * (kept for a later pass), never wrongly interrupted. */
const RUNNER_RECOVERY_DISCOVER_TIMEOUT_MS = 15_000;
const RUNNER_RECOVERY_RETRY_MS = 5_000;
/** How many consecutive `uncertain` discoveries a marker may collect before recovery
 * stops asking and settles it anyway. ADR 0006 D7 step 5 calls the uncertain state
 * BOUNDED, but the retry loop had no bound: a discovery seam that is permanently
 * unreachable (a missing supervisor socket, a project whose runtime directory is
 * gone) answered `uncertain` forever, so the marker was never cleared and the
 * session badged `running` — and stayed fenced against new prompts — until an
 * operator pressed Stop. Past the bound the turn is settled exactly like a
 * confirmed-dead one, with a `notice` recording that the Runner's fate was never
 * established. 24 × 5s ≈ 2min: far longer than a Sandbox restart, far shorter than
 * a human waiting on a session that will never answer. */
const RUNNER_RECOVERY_UNCERTAIN_MAX_ATTEMPTS = 24;
/** Transcript wording when the bound above runs out. Deliberately says what is and
 * is not known: the turn is over as far as Verity is concerned, but nobody proved
 * the Runner died. */
const UNCERTAIN_RECOVERY_EXHAUSTED_NOTICE =
  'This turn was left in flight by a restart and its Runner could not be reached to ' +
  'confirm whether it is still alive. Verity has stopped waiting and released the ' +
  'session — send the message again if the work did not finish.';
/** How often the in-flight liveness sweep runs. */
const TURN_LIVENESS_SWEEP_MS = 30_000;
/** How many consecutive sweeps an in-flight turn may append NO event before its
 * Runner is probed. Startup recovery only settles turns a restart left behind; a
 * Runner that dies while the Server keeps running produced no such crash, so
 * nothing reclassified it — the turn simply stopped emitting and the session
 * badged `running` until an operator noticed. Silence alone is never treated as
 * death (a long build or a slow tool legitimately emits nothing), it only triggers
 * the probe; the seam still has to CONFIRM the Runner is gone. 10 × 30s = 5min. */
const TURN_LIVENESS_IDLE_SWEEPS = 10;
/** How many silent windows may end in a confirmed-live probe before the turn is
 * released. The sandbox watchdog is the first line of defence; this server-side
 * bound also covers a worker that is alive but no longer scheduling its turn.
 * 6 × 5 minutes = 30 minutes. An uncertain probe never contributes. */
const TURN_LIVENESS_STALLED_WINDOWS = 6;
/** Transcript wording when the probe confirms an in-flight turn's Runner is gone. */
const DEAD_RUNNER_NOTICE =
  'The Runner executing this turn is gone — Verity stopped waiting and released the ' +
  'session. Any work it had already reported is above; send the message again to continue.';
const STALLED_RUNNER_NOTICE =
  'The Runner executing this turn is still alive but has produced nothing for half ' +
  'an hour — Verity stopped waiting and released the session. Send the message ' +
  'again to continue.';
/** Transcript wording when a stop could not establish that the worker died. The
 * session STAYS fenced in that state, so this is what tells the operator why it looks
 * busy with nothing running — and that Verity is still working on it by itself. */
const UNCONFIRMED_TERMINATION_NOTICE =
  'Verity could not confirm that the agent process for this turn exited, so the session ' +
  'stays reserved for it — starting a second agent could let two of them edit the same ' +
  'worktree. Retrying the shutdown in the background; the session frees itself as soon ' +
  'as the exit is confirmed.';
/** Transcript wording once that same session comes back on its own. */
const UNCONFIRMED_TERMINATION_CLEARED_NOTICE =
  'The agent process for the previous turn is confirmed gone. This session is free again.';
/** Transcript wording when the operator lifts that fence by hand. Deliberately does
 * NOT claim the process exited — nothing established that — so the transcript keeps
 * an honest record of which of the two ways the session came back. */
const UNCONFIRMED_TERMINATION_OVERRIDE_NOTICE =
  'Released by hand while the previous agent process was still unaccounted for. If it ' +
  'is in fact alive, it and the next agent share this worktree — check `git status` ' +
  'before trusting the next turn.';
const RUNNER_CANCEL_GRACE_MS = 1_000;
/** How long the stop watchdog waits, after a cancel the runner acknowledged, for
 * the aborted run loop to actually release the session before force-settling it.
 * Must comfortably exceed the backends' own SIGTERM→SIGKILL escalation (2s for
 * codex) so the natural settle path — kill, stdout EOF, run loop `finally` — wins
 * whenever it works at all; the watchdog is the fence for run loops wedged past
 * process death (e.g. a broker await that never resolves). */
const STOP_SETTLE_GRACE_MS = 5_000;
/** How many times the background reaper re-issues an out-of-band kill whose outcome
 * could not be established before leaving the session to the periodic liveness sweep.
 * Spaced by {@link RUNNER_CANCEL_GRACE_MS}, so this covers a control plane that is
 * briefly unreachable without spinning on one that is gone for good. */
const UNCONFIRMED_WORKER_REAP_ATTEMPTS = 10;
/** How long a backend handoff waits for the previous turn's ownership fence to release
 * after its cancel before refusing the switch. Derived from every bound the stop path
 * can actually spend BEFORE the fence drops, so a slow-but-working stop is never
 * mistaken for an unconfirmed worker: the settle grace, the bounded force-cancel behind
 * it, and the bounded terminal `interrupted` write inside the force-settle — plus two
 * grace windows of slack. One would leave the worst case 1s from the refusal, and the
 * bounds above are not the whole story: a bounded step can overshoot its own budget when
 * the transport underneath it has a longer timeout than the wrapper does (a supervisor
 * force-cancel that retries once spends up to two request timeouts inside a one-grace
 * bound), and the event-loop hops between the steps are unbounded under load. (The cancel
 * ack ahead of all this is awaited separately by the caller and is bounded by the same
 * grace.)
 *
 * Deliberately SHORTER than the reaper's own budget ({@link UNCONFIRMED_WORKER_REAP_ATTEMPTS}
 * × ~2 × {@link RUNNER_CANCEL_GRACE_MS}): a control plane that answers on the sixth retry
 * frees the session, but not in time for this switch. That is the right split, because the
 * two are bounding different things. This one bounds a synchronous HTTP request the
 * operator is watching, where the honest answer at 9s is a retriable refusal plus a banner
 * saying the session frees itself; the reaper bounds a background task nobody waits on, so
 * it can afford to keep trying. Raising this to cover the reaper would trade a fast, clear
 * refusal for a twenty-second hang on the same outcome. */
const BACKEND_HANDOFF_FENCE_TIMEOUT_MS =
  STOP_SETTLE_GRACE_MS +
  RUNNER_CANCEL_GRACE_MS + // bounded forceCancel
  RUNNER_CANCEL_GRACE_MS + // bounded terminal `interrupted` write
  2 * RUNNER_CANCEL_GRACE_MS; // slack
/** How long a bind waits for {@link ConductorDeps.purgeBackendArtifacts} before carrying
 * on without it. Far beyond the directory walk it normally is, and short enough that a
 * data volume gone slow costs a turn a pause rather than a stall. */
const BACKEND_ARTIFACT_PURGE_TIMEOUT_MS = 10_000;
/** Pause before an auto-resume replay — long enough for the transient conditions
 * worth replaying (a refreshed token landing, a redeployed gateway coming back) to
 * clear, short enough that a recovering session does not look stuck. */
const AUTO_RESUME_DELAY_MS = 3_000;
/** Claude's own wording when `--resume` names a conversation it does not have. */
const CLAUDE_MISSING_CONVERSATION = /No conversation found with session ID/i;
/** The ACP adapter's wording for the same thing. It answers `session/load` for a
 * conversation it cannot restore with JSON-RPC `-32002`, whose message carries the
 * requested id as the missing resource's uri. */
const ACP_RESOURCE_NOT_FOUND = /Resource not found:\s*(\S+)/i;

/**
 * True when `text` — a backend's stderr or a run failure's message — says the
 * conversation Verity tried to resume is gone.
 *
 * The ACP wording is accepted ONLY when it names the very id this turn resumed.
 * `-32002` is the adapter's generic answer for ANY missing resource, so treating
 * it as a stale-resume verdict on its own would discard a perfectly live thread
 * the moment some unrelated lookup failed. Claude's missing-conversation line is
 * unambiguous on its own and needs no such pin.
 */
function namesMissingConversation(text: string, resumeSessionId: string): boolean {
  if (CLAUDE_MISSING_CONVERSATION.test(text)) return true;
  return ACP_RESOURCE_NOT_FOUND.exec(text)?.[1] === resumeSessionId;
}
function isExternalInterruptionExitCode(exitCode: number): boolean {
  // POSIX shells report signal exits as 128 + signal. SIGINT=2, SIGTERM=15.
  return exitCode === 130 || exitCode === 143;
}

export {
  formatBrokeredSecretAliases,
  type ExternalPermissionAnswer,
  type PermissionDecisionSource,
} from './turn-system-prompt.js';
import {
  EXTERNAL_PERMISSION_ABORT_MESSAGE,
  RESUME_SYSTEM_PROMPT,
  carriesBrokeredSecretTools,
  turnSystemPrompt,
  withBackendSystemPrompt,
  type ExternalPermissionAnswer,
  type PermissionDecisionSource,
} from './turn-system-prompt.js';

/**
 * The Conductor's per-session in-flight turn handle (ADR 0006 Stage 1). Registered
 * SYNCHRONOUSLY the moment a turn is accepted — before the async spawn — so a
 * cancel/steer/answer that races the spawn still lands on the right session. It
 * owns the operator-cancel {@link AbortController} (#79); `steer` (#101) and
 * `answerPermission` (#27) forward to the live {@link RunnerTurn} once the run
 * starts and binds itself as the {@link delegate}. Before the delegate binds,
 * `steer` resolves false (caller queues) and `answerPermission` is a no-op — matching
 * the old maps, which were also empty until the run surfaced its channels. The
 * controller's signal is threaded into the run, so `cancel()` reaches the agent in
 * both windows (pre- and post-spawn). Across a codex resume-retry the same handle
 * is reused; each attempt rebinds {@link delegate} but shares the one controller
 * (as the old single-controller-per-recovery path did).
 */
class SessionTurnHandle implements RunnerTurn {
  readonly controller = new AbortController();
  /** The live per-attempt Runner turn; undefined until the run starts. */
  delegate: RunnerTurn | undefined;
  /** Set by this turn's settle path (the launch run-loop's `finally`, or
   * {@link Conductor.settleReattachedTurn}) once it has finished — the stop
   * watchdog checks it to tell a settled turn from a wedged one. */
  settled = false;
  /** The prompt_seq anchoring this turn's durable running-turn marker (set when
   * the marker is written). The force-settle path scopes its marker delete to it
   * so a delayed delete can never erase a SUCCESSOR turn's marker. */
  markerSeq: number | undefined;
  /** The transport this turn actually runs through, for brokered-secret grants
   * (ADR 0014 D3). Set from the resolved backend before the run starts, so a
   * permission prompt surfacing mid-turn is redeemed against the channel it
   * arrived on rather than a channel anyone claimed. Undefined only before a
   * backend has been resolved, which is fail-closed at both readers: no
   * auto-approval, and no grant persisted. */
  grantChannel: BrokeredGrantChannel | undefined;
  /** Which settle path owns this turn's terminal writes + release: the turn's own
   * run loop (`'run'`) or the stop watchdog's force-settle (`'force'`). Claimed
   * SYNCHRONOUSLY before any terminal side effect, so exactly one owner ever
   * writes terminal events, releases the fence, or drains the queue — a run loop
   * that unsticks mid-force-settle (or vice versa) loses the claim and skips its
   * settle entirely instead of double-writing beside a successor turn. */
  private settleOwner: 'run' | 'force' | undefined;

  /** Atomically claim settle ownership for `owner`. Single-threaded and
   * synchronous — the first claimant wins. `'run'` may re-confirm its own claim
   * (the run body claims, then its `finally` re-checks), but `'force'` is
   * single-shot: overlapping Stop watchdogs (a second Stop press arms a second
   * watchdog on the same handle) must not BOTH execute the force-settle, or they
   * would duplicate terminal markers and release a successor turn's fence.
   *
   * Deliberate boundary: once `'run'` holds the claim, the backend has already
   * returned — only store writes remain, so a force takeover is never needed. A
   * hung STORE write would wedge the force path's own writes identically (a
   * server-wide storage failure, not a per-session backend wedge), so takeover
   * could not restore the Stop guarantee anyway and would only reintroduce the
   * double-settle race this claim exists to prevent. */
  claimSettle(owner: 'run' | 'force'): boolean {
    if (this.settleOwner === undefined) {
      this.settleOwner = owner;
      return true;
    }
    return owner === 'run' && this.settleOwner === 'run';
  }

  /** True when the stop watchdog force-settled this turn. */
  get forceSettled(): boolean {
    return this.settleOwner === 'force';
  }

  /** The terminal result of the CURRENT attempt. The conductor awaits the run
   * directly (via the delegate's own `result`), so this is unused for the loopback
   * path; it satisfies the interface and lets a caller await the live turn if bound. */
  get result(): Promise<RunResult> {
    return this.delegate?.result ?? Promise.reject(new Error('turn not started'));
  }

  async steer(message: SteerMessage): Promise<boolean> {
    return (await this.delegate?.steer(message)) ?? false;
  }

  async answerPermission(toolUseId: string, decision: PermissionDecision): Promise<boolean> {
    return (await this.delegate?.answerPermission(toolUseId, decision)) ?? false;
  }

  async cancel(): Promise<boolean> {
    const newlyAborted = !this.controller.signal.aborted;
    if (newlyAborted) this.controller.abort();
    if (this.delegate !== undefined) {
      const applied = await this.delegate.cancel();
      return applied || newlyAborted;
    }
    return newlyAborted;
  }

  async forceCancel(): Promise<boolean> {
    return (await this.delegate?.forceCancel?.()) ?? false;
  }

  /** Whether an OUT-OF-BAND kill channel exists behind this handle. */
  get hasForceChannel(): boolean {
    return this.delegate?.forceCancel !== undefined;
  }

  /** Whether a SEPARATE worker owns this run. False only for a loopback/in-process
   * turn, where the abort signal plus {@link Conductor.closeSession} terminate the
   * child directly and are themselves the termination certificate. Deliberately
   * distinct from {@link hasForceChannel}: `forceCancel` is optional on the
   * {@link RunnerTurn} contract, so a runner-backed turn may have a worker and no way
   * to kill it — that is "unprovable", not "nothing to prove". */
  get hasRunnerWorker(): boolean {
    return this.delegate !== undefined;
  }
}

/** Raised when a turn is requested for a session id the store doesn't know. */
export class UnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`unknown session '${sessionId}'`);
    this.name = 'UnknownSessionError';
  }
}

/** Raised when a turn is requested while that session already has one in flight. */
export class SessionBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`session '${sessionId}' is busy with another turn`);
    this.name = 'SessionBusyError';
  }
}

/** Raised when the same parked permission already has a delivery in flight. */
export class PermissionDecisionInProgressError extends Error {
  constructor(
    readonly sessionId: string,
    readonly toolUseId: string,
  ) {
    super(`permission '${toolUseId}' for session '${sessionId}' is already being decided`);
    this.name = 'PermissionDecisionInProgressError';
  }
}

/** Raised when a turn is enqueued behind an in-flight one but the per-session
 * queue is already at {@link Conductor}'s cap — bounding the backlog so a runaway
 * sender can't pile up unbounded pending turns. */
export class QueueFullError extends Error {
  constructor(
    readonly sessionId: string,
    readonly limit: number,
  ) {
    super(`session '${sessionId}' already has ${limit} turns queued`);
    this.name = 'QueueFullError';
  }
}

/**
 * Raised when a turn targets a session whose worktree directory no longer exists
 * — e.g. an isolated worktree cleaned up after its PR merged. Resuming would spawn
 * `claude` with a missing `cwd`, which fails with `spawn ENOENT`; we reject cleanly
 * BEFORE spawning so the session is plainly unresumable (HTTP 410) rather than
 * surfacing as an opaque spawn failure. The session row is left intact (its
 * transcript is still readable); only new turns are refused.
 */
export class WorktreeMissingError extends Error {
  constructor(
    readonly sessionId: string,
    readonly worktree: string,
  ) {
    super(`session '${sessionId}' cannot resume: worktree '${worktree}' no longer exists`);
    this.name = 'WorktreeMissingError';
  }
}

/** Raised when a backend handoff cannot prove that the previous Runner terminated.
 * The session remains fenced; callers must retry the same cancellation rather than
 * starting a replacement backend optimistically. */
export class BackendTerminationUnconfirmedError extends Error {
  constructor(readonly sessionId: string) {
    super(`backend termination for session '${sessionId}' is not confirmed`);
    this.name = 'BackendTerminationUnconfirmedError';
  }
}

/** Worktree liveness probe: true iff `worktree` is an existing directory the agent
 * can be spawned in. The single source of truth for "is this session resumable" —
 * the conductor pre-flights with it (default for {@link ConductorDeps.worktreeExists},
 * injectable so unit tests don't touch the fs) and the server derives each
 * session's `resumable` flag from it so the UI can disable a dead session's input. */
export async function worktreeExists(worktree: string): Promise<boolean> {
  try {
    return (await stat(worktree)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Handed to {@link ConductorDeps.sessionBackend} so the (potentially slow)
 * preparation of a turn's backend can report itself instead of only ever being
 * visible as a failure.
 *
 * Resolving a project session's backend can take minutes when the Sandbox has to
 * be rebuilt first. Without a signal the operator sees nothing until it either
 * silently succeeds or fails hard, so a rebuild reads as a hang and a rebuild that
 * cannot happen reads as a crash. Reporting turns both into a visible "waiting on
 * infrastructure" state that resolves on its own.
 */
export interface TurnPreparationContext {
  /** Verity session whose turn is being prepared. */
  readonly sessionId: string;
  /**
   * Whether this resolution backs an operator turn that can afford to wait — the
   * only case where a slow repair is both worth doing and visible while it runs.
   *
   * False for the conductor's own background resolutions (reattaching to an
   * abandoned turn, generating an auto-title), which need a backend handle rather
   * than a working Sandbox and must not sit on — let alone trigger — a rebuild
   * nobody asked for. A resolver that repairs must gate that repair on this flag
   * and otherwise fail as fast as it always did.
   */
  readonly canWait: boolean;
  /** Report — once per resolution; later calls are ignored — that the turn is
   *  blocked on a dependency being made ready. Writes the message to the transcript
   *  and parks the session on `awaiting_dependency` until preparation settles.
   *  Fire-and-forget: the conductor owns ordering, so the caller awaits nothing.
   *  A no-op when {@link canWait} is false. */
  waitingOn(message: string): void;
}

export interface ConductorDeps {
  store: EventStore;
  /** Durable Verity-owned system context selected from the persisted session.
   * Evaluated whenever a fresh backend context starts, so an empty session can
   * receive hidden capabilities on its first real turn without a synthetic turn. */
  sessionSystemPrompt?: ((session: SessionRecord) => string | Promise<string>) | undefined;
  /** Secret alias NAMES eligible for `verity_http_request` / `verity_secret_run` in a
   * project (ADR 0011 D3); best-effort — failures or absence simply omit the list from
   * the turn context. Backend-independent: the names reach every ACP backend that can
   * call those tools over the MCP gateway. */
  brokeredSecretAliases?: ((projectId: string) => Promise<readonly string[]>) | undefined;
  /** ADR 0011 D2: does a persisted grant cover this (project, session, alias, tool, target)?
   * True auto-approves the brokered-secret prompt without operator interaction.
   * `channel` is the transport this prompt arrived on (ADR 0014 D3); the store applies
   * the ACP ceiling to it. */
  checkBrokeredHttpGrant?:
    | ((input: {
        projectId: string;
        sessionId: string;
        secretAlias: string;
        toolName: BrokeredGrantToolName;
        target: string;
        channel: BrokeredGrantChannel;
      }) => Promise<boolean>)
    | undefined;
  /** ADR 0011 D2: persist a scoped brokered-secret grant after an operator allow.
   * `channel` records which transport the operator answered on, so a decision made on
   * one never auto-approves the other (ADR 0014 D3). */
  persistBrokeredHttpGrant?:
    | ((input: {
        projectId: string;
        sessionId: string;
        secretAlias: string;
        toolName: BrokeredGrantToolName;
        target: string;
        scope: 'session' | 'project' | 'forever';
        channel: BrokeredGrantChannel;
      }) => Promise<void>)
    | undefined;
  /** Fan-out bus threaded into each turn's runner (M3-2). */
  bus?: EventBus | undefined;
  /** Verbatim transcript store; restored before resume, tailed during the turn. */
  transcript?: TranscriptStore | undefined;
  /**
   * Stage 5b Slice 2: when true, the SERVER owns verbatim transcript persistence
   * over the runner-runtime path (restore-before-resume + tail-into-DB), so the
   * per-turn `opts.transcript` is OMITTED from the runner — the in-sandbox worker
   * needs no database and the supervisor guard stays fail-closed. Default/false
   * keeps passing `opts.transcript` exactly as today (in-process persistence).
   */
  serverManagedTranscript?: boolean | undefined;
  /**
   * Remove the transcript files of a backend this session has just switched AWAY from.
   *
   * Binding a session to a new backend drops the previous backend's
   * `session_backend_state` row, and that row was the only thing naming its files on
   * the runner runtime — so without this hook they outlive every future delete of the
   * session. Losing them costs nothing: the conversation is in `events`, and the files
   * are materialized back out of it on resume.
   *
   * Awaited by the bind that displaced the rows, so the purge cannot outlive the turn
   * that caused it — but never allowed to fail it, and never for longer than
   * {@link BACKEND_ARTIFACT_PURGE_TIMEOUT_MS}. It runs only when a bind actually
   * displaced another backend, which is an operator switching model, so the directory
   * walk behind it (`codexRolloutFiles` over the runtime's rollout archive) is paid at
   * human frequency and not on the hot path of a turn.
   *
   * Two neighbouring paths that also drop a binding row do NOT call this, on purpose:
   *
   *  - A re-bind under the SAME backend (a codex thread that comes back with a new id)
   *    displaces nothing, so the hook is never invoked and the previous id's rollouts
   *    are left. They are collected by the startup sweep once that id stops being live.
   *  - {@link clearBackendSessionState} drops the row on a stale resume — the backend
   *    has just answered that the conversation or rollout does not exist, so there is
   *    nothing on disk for a purge to find, and the retry immediately re-binds the same
   *    backend. For claude the discarded id's files, if any survived, sit in the
   *    session's own `projects/<encoded-cwd>` directory, which the sweep keeps whole
   *    while the session lives and collects whole once it is deleted.
   *
   * Omit on deployments with no runner runtime, where there are no such files.
   */
  purgeBackendArtifacts?:
    | ((
        sessionId: string,
        bindings: readonly { backend: string; backendSessionId: string }[],
      ) => Promise<void>)
    | undefined;
  /** Claude home for transcript-path resolution; defaults to the runner's `~/.claude`. */
  claudeHome?: string | undefined;
  /** Spawn seam; tests inject a fake. Defaults to the runner's real spawner. */
  spawner?: Spawner | undefined;
  /** Default backend each turn runs through (ADR 0001 / #143). Defaults to
   * {@link AcpClaudeBackend} (Claude over ACP, ADR 0012); inject to route turns
   * elsewhere. */
  backend?: Backend | undefined;
  /** Optional second backend for provider-qualified models (`providerID/modelID`,
   * e.g. `deepinfra/…`) — the OpenCode backend (#143). When set, such turns route
   * here; Claude and any non-qualified model stays on {@link ConductorDeps.backend}. */
  openCodeBackend?: Backend | undefined;
  /** Optional Codex CLI backend. Models with the explicit `codex/` prefix route here. */
  codexBackend?: Backend | undefined;
  /** Optional per-session backend wrapper. Used by the multi-repo fleet path:
   * sessions bound to a project run in that project's container, while the
   * model string still chooses the inner Claude/OpenCode backend first. */
  sessionBackend?:
    | ((
        session: SessionRecord,
        selected: Backend,
        preparation: TurnPreparationContext,
      ) => Promise<Backend | undefined>)
    | undefined;
  /** Optional wrapper for stateless queries, which have no session record and
   * therefore cannot use {@link sessionBackend}. */
  queryBackend?:
    ((selected: Backend, model: string | undefined) => Promise<Backend | undefined>) | undefined;
  /**
   * Factory for the {@link RunnerClient} a turn runs through (ADR 0006 Stage 1,
   * D5). Called with the model-/session-selected {@link Backend} and returns the
   * Runner that owns that turn's lifecycle behind the boundary-ready contract.
   * Defaults to {@link LoopbackRunnerClient} — the in-process Runner — so behavior
   * is byte-for-byte identical to calling `backend.run` directly. Inject to route
   * turns through a remote Runner (Stage 2) without touching the call sites.
   */
  runner?: RunnerClientFactory | undefined;
  /**
   * ADR 0006 Stage 4c (D7): the seam startup recovery uses to decide reattach-vs-
   * settle for a turn left in flight by a crash — it discovers whether the marker's
   * Runner is still live on its Sandbox. Absent (the default) ⇒ every abandoned turn
   * is settled (`interrupted`) exactly as before, so behavior is byte-for-byte
   * unchanged until turns route through the supervisor (Stage 5) and this is wired.
   */
  runnerRecovery?: RunnerRecovery | undefined;
  /** Per-marker upper bound on {@link runnerRecovery} discovery during recovery (ms).
   * Defaults to {@link RUNNER_RECOVERY_DISCOVER_TIMEOUT_MS}; a slow/hanging seam past
   * it degrades that marker to `uncertain` so it cannot wedge startup. */
  runnerRecoveryDiscoverTimeoutMs?: number | undefined;
  /** Binary to spawn; defaults to the runner's `claude`. */
  command?: string | undefined;
  /** Default permission mode for turns (§5b); defaults to the runner's `auto`. */
  permissionMode?: string | undefined;
  /**
   * Enable the mid-turn permission approve/deny control loop on every turn (#27):
   * tools that need approval are surfaced to the operator (a `permission` event +
   * a parked decision) instead of following the CLI's own posture. The operator
   * answers via {@link Conductor.decidePermission}. Defaults to OFF — opt in once
   * the app's approve/deny UI ships, so the rollout is decoupled from this slice.
   */
  permissionControl?: boolean | undefined;
  /** Default wall-clock ceiling per turn; omit for no timeout. */
  timeoutMs?: number | undefined;
  /** Child env; defaults to the runner's `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * Seam to probe whether a session's worktree still exists before resuming a turn
   * in it (a missing dir would fail the spawn with `cwd` ENOENT). Defaults to a
   * real `fs.stat` directory check; tests inject a fake to avoid the filesystem.
   */
  worktreeExists?: ((worktree: string) => Promise<boolean>) | undefined;
  /**
   * Logging seam for a turn dispatched via {@link Conductor.dispatchTurn} that
   * fails in the background (after the caller already got its acceptance). The
   * HTTP caller has its 202 by then, so a background failure has nowhere else to
   * surface — without this hook it would be silent.
   */
  onTurnError?: ((sessionId: string, error: Error) => void) | undefined;
  /** Max turns that may be queued behind an in-flight one per session before a
   * further enqueue throws {@link QueueFullError}. Defaults to 10. */
  maxQueuedTurns?: number | undefined;
  /**
   * How often a backend-confirmed pre-execution failure is replayed on its own.
   * This deliberately excludes mid-turn crashes and every failure whose execution
   * phase is unknown: re-submitting a prompt after it may have caused an external
   * side effect is unsafe. Defaults to 1; 0 disables.
   */
  autoResumeAttempts?: number | undefined;
  /** Pause before an auto-resume replay (ms). The failures worth replaying are
   * transient, so replaying instantly tends to reproduce them. Defaults to
   * {@link AUTO_RESUME_DELAY_MS}. */
  autoResumeDelayMs?: number | undefined;
  /**
   * Optional auto-naming config. When set, once a session has `afterTurns` operator
   * prompts on record the conductor derives a short display name from the opening
   * conversation for any session the operator hasn't already named. The title is
   * produced by the SAME backend/model the session runs its turns on (routed via
   * {@link Backend.query}), so it always uses the operator's selected LLM — not a
   * hard-coded default. Off unless set, so turn-only tests never trigger it.
   * Best-effort: a failure or empty title never affects the turn, and the operator
   * can always rename manually. See {@link Conductor.maybeAutoTitle}.
   *
   * The attempt fires as soon as the operator's prompt that reaches `afterTurns` is
   * persisted — at turn START, concurrently with the turn — so the name is derived
   * from the prompt (plus any reply text already on record) WITHOUT waiting for the
   * reply to stream or the turn to settle. A settle-time attempt stays as a fallback
   * for the case the turn-start one was skipped. See {@link Conductor.maybeAutoTitle}.
   */
  autoTitle?:
    | {
        /** Number of operator prompts on record before titling is attempted (e.g. 1). */
        afterTurns: number;
        /** Wall-clock ceiling on the one-shot titling call. Defaults to 45s. */
        timeoutMs?: number | undefined;
        /**
         * Best-effort hook for the English git branch name derived at the same time
         * as the display title. The conductor never lets hook failures affect turns.
         */
        onBranchName?: ((session: SessionRecord, branchName: string) => Promise<void>) | undefined;
      }
    | undefined;
}

export interface TurnOptions {
  /** Override the conductor's default permission mode for this turn. */
  permissionMode?: string | undefined;
  /** Override the conductor's default timeout for this turn. */
  timeoutMs?: number | undefined;
  /** Override the session's stored model for this turn. */
  model?: string | undefined;
  /** Per-turn tool allowlist (names or scoped patterns, e.g. `Bash(git *)`). */
  allowedTools?: readonly string[] | undefined;
  /** Per-turn tool denylist. */
  disallowedTools?: readonly string[] | undefined;
  /** Ephemeral values injected only into this turn's agent process. Never persisted in events. */
  protectedEnvironment?: Readonly<Record<string, string>> | undefined;
  /** Reject instead of steering or queueing when another turn is active. */
  requireStandalone?: boolean | undefined;
  /**
   * Backend-neutral image uploads (v1) to send with this turn — the raw base64
   * bytes. A turn may carry attachments with an empty prompt (e.g. a bare
   * screenshot). The bytes are passed to the runner (backend translation) AND
   * stored content-addressed; the persisted `prompt` event references them by id.
   */
  attachments?: readonly AttachmentUpload[] | undefined;
}

export interface DispatchTurnOptions {
  /** Transcript text to show for this turn when it differs from the backend prompt. */
  displayPrompt?: string;
  /** Client-minted idempotency key (ADR 0008). A background-woken app can be
   * suspended by iOS before it reads the 202 and re-flush the same quick reply on
   * the next foreground; keyed dispatches dedupe so the replay returns the prior
   * result instead of dispatching a second turn. Omitted by in-app turns. */
  clientReplyId?: string;
}

interface QueuedConductorTurn {
  /** Durable queue row id. Undefined for prompts already persisted in the event log. */
  id?: string;
  prompt: string;
  opts: TurnOptions;
  displayPrompt?: string;
  /** Stored attachment refs used by queue-status consumers for lightweight previews. */
  displayAttachments?: Attachment[];
  /** True when recovery is replaying a tail prompt event and must not append it again. */
  promptAlreadyPersisted?: boolean;
  /** Auto-resume replays already spent on this turn. Travels WITH the turn: every
   * failed attempt appends events, so anchoring the budget on an event seq would
   * hand each replay a fresh one and loop forever. */
  autoResumeCount?: number;
  /** Original turn cancellation, retained until an auto-resume leaves the queue. */
  autoResumeSignal?: AbortSignal;
}

export interface RestoredQueuedTurn {
  id: string;
  prompt: string;
  attachments?: AttachmentUpload[];
}

/** A turn is dispatchable when it has prompt text OR at least one attachment — a
 * bare screenshot with no caption is valid, an empty turn with neither is not. */
function turnHasContent(prompt: string, opts: TurnOptions): boolean {
  return prompt.trim().length > 0 || (opts.attachments?.length ?? 0) > 0;
}

function isSealedStoreRecoveryError(event: AgentEvent | undefined): boolean {
  return (
    event?.t === 'error' &&
    /secret store is sealed|unlock it with the master password/i.test(event.message)
  );
}

/**
 * The `error` kinds that mean the TURN itself ended — a spawn/run failure or the
 * synthetic crash marker. The adapters ALSO emit per-line normalization errors
 * (`parse_error`, `adapter_schema_mismatch`, `adapter_invalid_event`) and the
 * sealed-store recovery error mid-stream WITHOUT ending the turn, so `t: 'error'`
 * alone must never be read as "the turn settled".
 */
const TERMINAL_ERROR_KINDS = new Set(['spawn_failed', 'run_failed', 'crashed']);

/** One dispatch of a turn against a backend — the outcome plus what the retry
 *  paths need to decide whether to run another attempt. */
interface BackendTurnAttempt {
  result: RunResult;
  backendSessionId: string | undefined;
  backend: Backend;
}

// Cap on remembered `clientReplyId`s per session (ADR 0008 idempotency). A single
// operator sends few quick replies per session; this only bounds a long-lived
// server's memory, evicting the oldest ids FIFO once exceeded.
const MAX_SEEN_REPLIES_PER_SESSION = 64;

/**
 * Whether an event settles the turn: a `result`, an operator `interrupted`, or an
 * `error` of a turn-terminal {@link TERMINAL_ERROR_KINDS} kind. Recovery uses this
 * (not a bare `t === 'error'`) so a mid-stream adapter error left in the tail by a
 * crash is NOT mistaken for a finished turn — that mistake would drop the
 * `interrupted` marker an abandoned turn needs (the CR-3 / stale-codex-resume bug).
 */
function isTurnTerminalEvent(event: AgentEvent): boolean {
  return (
    event.t === 'result' ||
    event.t === 'interrupted' ||
    (event.t === 'error' && TERMINAL_ERROR_KINDS.has(event.kind))
  );
}

/**
 * Build a compact `User:`/`Assistant:` transcript of the FIRST `maxPrompts`
 * operator turns from a session's event log, for the auto-title hook. Only the
 * operator prompts (`prompt`) and the agent's visible text (`text` deltas) are
 * kept — tool calls/results/thinking are noise for naming a topic. Stops once the
 * `(maxPrompts + 1)`-th prompt begins, so a long session never feeds its whole log.
 */
function buildConversationDigest(events: readonly AgentEvent[], maxPrompts: number): string {
  const lines: string[] = [];
  let prompts = 0;
  let pendingText = '';
  const flushAgentText = (): void => {
    const text = pendingText.trim();
    if (text.length > 0) lines.push(`Assistant: ${text}`);
    pendingText = '';
  };
  for (const event of events) {
    if (event.t === 'prompt') {
      flushAgentText();
      if (prompts >= maxPrompts) break; // opening captured; ignore the rest
      prompts += 1;
      const text = event.text.trim();
      if (text.length > 0) lines.push(`User: ${text}`);
    } else if (event.t === 'text') {
      pendingText += event.delta;
    }
  }
  flushAgentText();
  return lines.join('\n');
}

export interface StartOptions {
  /** Optional Verity-owned session id to persist the new run under. */
  sessionId?: string | undefined;
  /** Known kind for a pre-created Verity session; selects kind-specific directives. */
  sessionKind?: SessionRecord['kind'] | undefined;
  /**
   * The worktree the new agent runs in (its `cwd`). Must be an existing,
   * unused directory — §5a requires worktree↔session 1:1, enforced at the DB by
   * the store's worktree-UNIQUE. The caller (provisioning) allocates it.
   */
  worktree: string;
  /** The operator's first prompt (non-empty). */
  prompt: string;
  /**
   * Additional Verity-owned instructions for this fresh backend context. They are
   * appended to the runtime system prompt and never rendered as an operator turn.
   */
  appendSystemPrompt?: string | undefined;
  /** Persist the seed prompt in the transcript; defaults to true. */
  persistPrompt?: boolean | undefined;
  /**
   * Backend-neutral image uploads (v1) to seed the fresh agent with — the raw
   * base64 bytes, riding along with the first {@link prompt}. A spawn is never
   * attachments-only (the prompt names the branch + seeds the title), so these
   * are strictly additive. The runner feeds a spawn over stream-json stdin (it's
   * steerable), so the seed user message carries one image block per attachment;
   * the bytes are ALSO stored content-addressed so the persisted `prompt` event
   * references them by id (mirrors {@link TurnOptions.attachments}), unless
   * `persistPrompt` is false and the whole seed turn stays out of the transcript.
   */
  attachments?: readonly AttachmentUpload[] | undefined;
  /** Model; omit for claude's headless default (sonnet-4-6, §18). */
  model?: string | undefined;
  /** Permission mode; defaults to the conductor's, then the runner's `auto`. */
  permissionMode?: string | undefined;
  /** Wall-clock ceiling; defaults to the conductor's. */
  timeoutMs?: number | undefined;
  allowedTools?: readonly string[] | undefined;
  disallowedTools?: readonly string[] | undefined;
  /** Optional backend override for a fresh start before the session row exists. */
  backend?: Backend | undefined;
  /** Optional wrapper around the model-selected backend for a fresh start. */
  backendWrapper?: ((selected: Backend) => Backend) | undefined;
}

/**
 * Drives multi-turn steering of a persisted session. The default Claude backend
 * keeps a live process for hot turns and falls back to `--resume <id>` after a
 * restart/crash; other backends may still implement resume as a fresh process.
 * The session's worktree/model are resolved from the store, so the caller only
 * supplies the prompt.
 *
 * Turns on the same session are serialized so two backend turns can never race the
 * same session state. What happens to a message that arrives while one is in
 * flight depends on the entry point:
 *   - {@link dispatchTurn} (the HTTP path) first tries to STEER the running turn
 *     (#101 Stage B): the in-flight `claude` is spawned with its stdin held open,
 *     so the message is written there and the backend folds it in at its next
 *     step boundary — same turn, no wait for process exit. Only when no live
 *     channel is available (it lost the race with the turn's end) does it fall
 *     back to ENQUEUEing the message (#90 Stage A, per-session FIFO bounded by
 *     {@link ConductorDeps.maxQueuedTurns}), which runs as the next backend turn
 *     the moment the current one settles. The backlog is durably mirrored in the
 *     store, so it survives a restart — {@link recover} rebuilds the in-memory
 *     queues on startup. A queued turn can be retracted before it runs via
 *     {@link dequeue} (the operator taps it back into the input to edit/resend, #80).
 *   - {@link sendTurn} (the in-process await-the-result path) still rejects a
 *     concurrent turn with {@link SessionBusyError}.
 */
export class Conductor {
  private readonly inFlight = new Set<string>();
  /** Stop-watchdog waiters woken by {@link releaseInFlight} — how the cancel path
   * observes "the session is actually free again" regardless of WHICH settle path
   * (launch run loop, reattached tail, force-settle) released it. */
  private readonly inFlightReleaseWaiters = new Map<string, Set<() => void>>();
  /** Sessions fenced because runner discovery could not yet prove LIVE or DEAD. */
  private readonly uncertainRecovery = new Set<string>();
  private readonly uncertainRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Consecutive `uncertain` discoveries per fenced session — the bound that makes
   * the uncertain state finite ({@link RUNNER_RECOVERY_UNCERTAIN_MAX_ATTEMPTS}).
   * Reset whenever the session leaves the uncertain state by any other route. */
  private readonly uncertainRecoveryAttempts = new Map<string, number>();
  /** Per-session liveness bookkeeping for the in-flight sweep: the newest event seq
   * observed for the turn, and how many consecutive sweeps it has stood still. */
  private readonly livenessSeen = new Map<
    string,
    { seq: number; idleSweeps: number; liveProbes: number }
  >();
  private livenessSweepTimer: ReturnType<typeof setInterval> | undefined;
  /** Guards against a sweep still running when the next tick fires. */
  private livenessSweepRunning = false;
  private livenessSweepInFlight: Promise<void> | undefined;
  // Start-time locks keyed on WORKTREE (the session id doesn't exist yet): two
  // concurrent startSession calls for one worktree can't both spawn.
  private readonly starting = new Set<string>();
  // Per-session FIFO backlog of turns sent while one was in flight. Drained one at
  // a time as each turn settles, so a message sent mid-turn is delivered to claude
  // the moment it can take it ("send anytime, runs when ready"). Bounded by
  // `maxQueue` so a runaway sender can't pile up unbounded pending turns. This
  // in-memory queue is authoritative for the live drain (it keeps the raw upload
  // bytes, so a normal drain needs no blob re-fetch); it is durably MIRRORED in the
  // store (issue #80) so the backlog survives a restart — each item carries a stable
  // `id` (its store row key and the operator's retract handle, see {@link dequeue}).
  private readonly queues = new Map<string, QueuedConductorTurn[]>();
  // Stop fences new steering/enqueueing until the active turn is cancelled and the
  // durable backlog has been removed. `pendingEnqueues` closes the other side of
  // the race: an enqueue that began before the fence but is awaiting storage must
  // finish publishing its live queue item before Stop snapshots the backlog.
  private readonly stopping = new Map<string, number>();
  private readonly stopOperations = new Map<
    string,
    Promise<{ cancelled: boolean; droppedQueued: RestoredQueuedTurn[] }>
  >();
  private readonly handoffOperations = new Map<string, Promise<void>>();
  private readonly unconfirmedWorkerReapers = new Set<string>();
  // Sessions fenced because a stop could not establish that the worker exited. Sticky
  // for as long as the fence is held — the reaper set above only covers the window in
  // which a retry loop is actually running, and the operator needs to see the state
  // for the whole time the session is reserved, including after the retries run out.
  private readonly unconfirmedTermination = new Set<string>();
  // Subset of the above whose fence has been ANNOUNCED in the transcript. The two are
  // deliberately separate: the fence is entered the moment a kill goes unconfirmed, but
  // saying so is worth a pair of transcript lines only once a retry has also failed —
  // a stop that is merely slower than its own bound would otherwise print "could not
  // confirm" and "confirmed gone" a second apart on a session that stopped normally.
  private readonly announcedUnconfirmedTermination = new Set<string>();
  private readonly pendingEnqueues = new Map<string, Set<Promise<void>>>();
  // Per-session live handle for the IN-FLIGHT turn (ADR 0006 Stage 1). Present iff a
  // turn is currently running for that session. It collapses the three former
  // per-session Maps (aborter / injector / permission channel) into ONE boundary-
  // ready object: `cancel()` SIGTERMs the agent (#79), `steer()` folds an operator
  // message into the running turn (#101), `answerPermission()` resolves a parked
  // prompt (#27). Registered the moment the id is known (at accept for a resume, at
  // bind for a fresh start) and deleted when the turn settles. NB: the steer path is
  // still unbounded (as before) — a runaway sender could write many messages into
  // the live stdin. Fine for the single-operator v1; a per-turn steer cap is a
  // follow-up if multi-tenant.
  private readonly turns = new Map<string, SessionTurnHandle>();
  // In-flight best-effort backend-pointer writes issued from `onSession`, keyed by
  // session id. Only `clearBackendSessionState` reads them, to avoid deleting a row
  // that a still-open upsert would then recreate with the id being discarded.
  private readonly pendingBindPersists = new Map<string, Promise<void>>();
  // Per-session map of tool_use_id -> surfaced permission request currently awaiting
  // the operator's answer (#27). The RunnerTurn owns the actual respond channels; this
  // tracker lists what's parked ({@link pendingPermissions}) and keeps the request
  // payload so scoped brokered-HTTP grants (ADR 0011 D2) can be checked/persisted.
  // Populated by the `onPermissionRequest` hook when the runner surfaces a
  // `can_use_tool` prompt, and cleared on answer ({@link decidePermission}) or when
  // the turn settles. A turn can have several pending at once (multiple tool calls),
  // hence a map per session. The runner already fails any still-pending prompt safe
  // to DENY when the turn settles, so a dropped entry never lets a tool slip through.
  private readonly pendingPermissionRequests = new Map<string, Map<string, PermissionRequest>>();
  /**
   * The subset of {@link pendingPermissionRequests} that NO turn is waiting on, keyed
   * `sessionId\0toolUseId` (ADR 0014 D2/D4). A prompt raised by the loopback MCP gateway
   * arrives over HTTP rather than through a turn's held-open stdin, so there is no
   * `RunnerTurn.answerPermission` to write the decision to — the answer resolves the
   * caller's promise instead, and this map holds that resolver.
   *
   * They are tracked in the same pending map as turn-bound prompts on purpose: the app's
   * card, the decide route, {@link pendingPermissions} on reconnect, and the standing-grant
   * auto-approval are one surface, and a second parallel one would drift from it. What
   * differs is only who consumes the decision and where the grant channel comes from — the
   * caller states it, because there may be no live turn to read it off.
   */
  private readonly externalPermissions = new Map<
    string,
    { settle: (answer: ExternalPermissionAnswer) => void; channel: BrokeredGrantChannel }
  >();
  /** Synchronous claim fence around async permission delivery. The first manual or
   * automatic decision owns a prompt until delivery succeeds or fails. */
  private readonly permissionDecisionClaims = new Set<string>();
  // Actions parked by {@link runWhenIdle} to run the moment a session goes idle (e.g.
  // post-merge worktree housekeeping, which must never run under a live turn — it
  // force-checks-out the worktree). In-memory only: a restart between registration and
  // the settle drops them (the effect just doesn't happen; nothing is corrupted).
  private readonly deferredWhenIdle = new Map<string, Array<() => Promise<void>>>();
  // Sessions whose turn lock is currently held by MAINTENANCE ({@link runExclusive} /
  // {@link tryRunExclusive}) rather than by a turn. Stop must not force-settle these:
  // there is no agent turn to interrupt, and releasing the lock would let a queued turn
  // start beside a callback that is still rewriting the worktree.
  private readonly maintenanceLocks = new Set<string>();
  private readonly deferredAfterCurrentTurn = new Map<string, Array<() => void>>();
  private readonly maxQueue: number;
  // Auto-title bookkeeping (in-memory). `autoTitleDone` holds sessions whose titling
  // is settled — named by the operator, generated, or attempted-and-given-up — so we
  // never revisit them; `autoTitleInFlight` guards against two overlapping settles
  // spawning two generations for the same session. Both are process-local: a restart
  // just re-evaluates against the persisted name, costing at most one extra cheap
  // check on an early turn. See {@link maybeAutoTitle}.
  private readonly autoTitleDone = new Set<string>();
  private readonly autoTitleInFlight = new Set<string>();
  // Idempotency memo for `clientReplyId`-keyed dispatches (ADR 0008): session id →
  // (clientReplyId → the in-flight-or-settled dispatch promise). A replay returns
  // the SAME promise, so it never launches a second turn and mirrors the original
  // `{ queued }`. A rejected dispatch is evicted (see {@link dispatchIdempotent}) so
  // a genuine retry can run; successes stay so a late re-flush is a no-op. Bounded
  // per session by {@link MAX_SEEN_REPLIES_PER_SESSION} — process-local, so a
  // restart at worst re-runs a mid-flight reply (still ordered by the durable queue).
  private readonly seenReplies = new Map<string, Map<string, Promise<{ queued: boolean }>>>();
  // Whether new turns run with the permission control loop on (#27). Default off.
  private readonly permissionControl: boolean;
  // The default backend each turn runs through (ADR 0001 / #143). Default: the
  // `claude` runner; the conductor's orchestration around it is backend-agnostic.
  private readonly backend: Backend;
  // Optional second backend for provider-qualified models (OpenCode, #143).
  private readonly openCodeBackend: Backend | undefined;
  private readonly codexBackend: Backend | undefined;
  // Factory turning a selected backend into the Runner a turn runs through (ADR
  // 0006 Stage 1). Defaults to the in-process loopback, so `runner.startTurn` is
  // byte-for-byte equivalent to the former direct `backend.run` call.
  private readonly runnerFor: RunnerClientFactory;
  private readonly autoResumeAttempts: number;
  private readonly autoResumeDelayMs: number;

  constructor(private readonly deps: ConductorDeps) {
    this.maxQueue = deps.maxQueuedTurns ?? 10;
    this.autoResumeAttempts = deps.autoResumeAttempts ?? 1;
    this.autoResumeDelayMs = deps.autoResumeDelayMs ?? AUTO_RESUME_DELAY_MS;
    this.backend = deps.backend ?? new AcpClaudeBackend();
    this.openCodeBackend = deps.openCodeBackend;
    this.codexBackend = deps.codexBackend;
    this.permissionControl = deps.permissionControl ?? false;
    this.runnerFor = deps.runner ?? ((backend) => new LoopbackRunnerClient(backend));
  }

  /** Pick the backend for a turn by its model. The model-string FORMAT is the routing
   * contract (ADR 0001 "Model selection & routing"): `codex/...` routes to the Codex
   * CLI backend; other provider-qualified models (`providerID/modelID`, e.g.
   * `deepinfra/zai-org/GLM-5`) route to OpenCode when configured; bare Claude ids use
   * the default backend. */
  private backendKey(model: string | undefined): string {
    if (isCodexModel(model)) return 'codex';
    if (this.openCodeBackend !== undefined && model !== undefined && model.includes('/')) {
      return 'opencode';
    }
    return 'claude';
  }

  private modelBackend(model: string | undefined): Backend {
    if (isCodexModel(model)) return this.codexBackend ?? this.backend;
    if (this.openCodeBackend !== undefined && model !== undefined && model.includes('/')) {
      return this.openCodeBackend;
    }
    return this.backend;
  }

  /**
   * Resolve the backend this turn runs through, surfacing any wait it imposes.
   *
   * `sessionBackend` may have to make infrastructure ready first (the project path
   * rebuilds a Sandbox that can no longer serve the turn), which is slow and, until
   * now, invisible: the turn either eventually started or died with a red error and
   * no explanation. When the resolver reports a wait, the session is parked on
   * `awaiting_dependency` with an operator-facing note and released back to
   * `running` the moment the backend is ready — so the turn continues by itself
   * instead of ending as a crash the operator has to retry by hand.
   *
   * Status writes are best-effort: a transcript append that fails must not take the
   * turn with it, since the turn itself is fine.
   */
  private async backendForSession(
    session: SessionRecord,
    model: string | undefined,
    /** Session to report a preparation wait against — set only on the operator-turn
     *  path. Absent makes the resolution a non-waiting background one. */
    reportTo?: string,
  ): Promise<Backend> {
    const selected = this.modelBackend(model);
    if (this.deps.sessionBackend === undefined) return selected;
    // Serialized against the release below: `waitingOn` is fire-and-forget, so the
    // conductor is what guarantees the parking events land before the release does.
    let parked: Promise<void> | undefined;
    const sessionId = reportTo;
    const preparation: TurnPreparationContext = {
      sessionId: session.sessionId,
      canWait: sessionId !== undefined,
      waitingOn: (message: string) => {
        if (sessionId === undefined || parked !== undefined) return;
        parked = this.parkOnDependency(sessionId, message);
      },
    };
    try {
      return (await this.deps.sessionBackend(session, selected, preparation)) ?? selected;
    } finally {
      if (parked !== undefined && sessionId !== undefined) {
        await parked;
        // Back to `running` whatever the outcome: on success the turn is starting,
        // and on failure the terminal error that follows owns the status. Leaving
        // `awaiting_dependency` as the last status would strand the session on a
        // "Waiting" badge for the rest of the turn.
        await this.emitEvent(sessionId, { t: 'status', state: 'running' });
      }
    }
  }

  /** Park a session on `awaiting_dependency` with an operator-facing note. */
  private async parkOnDependency(sessionId: string, message: string): Promise<void> {
    await this.emitEvent(sessionId, { t: 'notice', text: message, role: 'agent' });
    await this.emitEvent(sessionId, { t: 'status', state: 'awaiting_dependency' });
  }

  /** Persist a server-authored event and fan it out. Best-effort: callers use it for
   *  transcript annotations whose failure must never fail the turn. */
  private async emitEvent(sessionId: string, event: AgentEvent): Promise<void> {
    try {
      const persisted = await this.deps.store.appendEvent(sessionId, event);
      this.deps.bus?.publish(sessionId, { seq: persisted.seq, ts: persisted.ts, event });
    } catch (error) {
      this.reportTurnError(sessionId, error);
    }
  }

  /**
   * Prepend a serialized transcript of the history the target backend HASN'T SEEN to
   * `prompt`, so it continues with context across a backend boundary (see
   * {@link buildHandoffPrompt}). `sinceSeq` is the active backend's recorded context
   * cursor (`session_backend_state.context_seq`): the events it already carries in
   * its native thread are excluded. `sinceSeq = 0` (a cold backend, no thread)
   * serializes the full history. The current turn's prompt was just persisted as the
   * trailing `prompt` event, so it's always dropped from the history. Returns `prompt`
   * unchanged when the gap holds no prior conversation (a genuinely fresh session, or
   * a same-backend resume whose thread is already current).
   */
  private async withHandoffContext(
    sessionId: string,
    prompt: string,
    sinceSeq = 0,
  ): Promise<string> {
    const events =
      sinceSeq > 0
        ? (await this.deps.store.getEventsAfter(sessionId, sinceSeq)).map((e) => e.event)
        : await this.deps.store.getEvents(sessionId);
    let lastPrompt = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.t === 'prompt') {
        lastPrompt = i;
        break;
      }
    }
    const priorEvents = lastPrompt >= 0 ? events.slice(0, lastPrompt) : events;
    return buildHandoffPrompt(priorEvents, prompt);
  }

  /**
   * True only when this session was SPAWNED on Claude — determined by the FIRST
   * `session` event (the origin backend), NOT the current `session.model` (which the
   * operator may have just switched). Used to decide whether Claude may implicitly
   * `--resume` the Verity session id: only a Claude-origin session ever created a
   * Claude thread under that id, so resuming a Codex-origin session that way is a
   * silent no-op turn (the bug this guards).
   *
   * No `session` event means no backend thread has bound yet. Empty sessions are
   * pre-created that way, so their first turn must cold-start the backend under
   * `storeSessionId`, not `--resume` a Verity UUID the backend has never seen.
   */
  private async isClaudeOriginSession(session: SessionRecord): Promise<boolean> {
    const events = await this.deps.store.getEvents(session.sessionId);
    const originSession = events.find((event) => event.t === 'session');
    return originSession?.t === 'session' && this.backendKey(originSession.model) === 'claude';
  }

  private async persistBackendSessionState(
    sessionId: string,
    backend: string,
    backendSessionId: string | undefined,
  ): Promise<void> {
    if (backendSessionId === undefined || backendSessionId.length === 0) return;
    const displaced = await this.deps.store.upsertSessionBackendState({
      sessionId,
      backend,
      backendSessionId,
      contextSeq: await this.deps.store.latestEventSeq(sessionId),
    });
    // The rows this bind just replaced are the session's previous backend, and their
    // disappearance is the last moment anything can name that backend's files. Awaited
    // so the purge cannot outlive the turn, but never allowed to fail the bind: a
    // leaked transcript is worth logging, not worth losing the resume state over.
    //
    // Bounded for the same reason it is caught. The implementation reads the store and
    // walks a runtime's rollout archive, both on a shared data volume; a volume that has
    // gone slow or hung would otherwise stall the bind — and through it the turn — for as
    // long as it stays that way. On timeout the purge is left running and the bind
    // proceeds: the worst outcome is a transcript that outlives its binding row, which is
    // precisely what the startup sweep collects.
    if (displaced.length > 0 && this.deps.purgeBackendArtifacts !== undefined) {
      try {
        await Promise.race([
          this.deps.purgeBackendArtifacts(sessionId, displaced),
          sleep(BACKEND_ARTIFACT_PURGE_TIMEOUT_MS, undefined, { ref: false }),
        ]);
      } catch {
        // Logged by the implementation; never fatal to the bind.
      }
    }
  }

  private async clearBackendSessionState(sessionId: string, backend: string): Promise<void> {
    // Let any in-flight bind persist from `onSession` settle FIRST. That write is
    // fire-and-forget, so a delete issued while it is still open could be overtaken
    // by it — re-pinning the session to the very id this clear is discarding, which
    // is exactly the wedged state the recovery paths exist to escape.
    await this.pendingBindPersists.get(sessionId);
    await this.deps.store.deleteSessionBackendState(sessionId, backend);
  }

  private isStaleCodexResume(result: RunResult): boolean {
    if (result.exitCode === 0 || result.aborted) return false;
    return /thread\/resume failed|no rollout found for thread id/i.test(result.stderr);
  }

  private isStaleClaudeResume(result: RunResult, resumeSessionId: string): boolean {
    if (result.aborted) return false;
    return namesMissingConversation(result.stderr, resumeSessionId);
  }

  /**
   * The same stale-resume verdict for a turn that failed hard instead of returning a
   * {@link RunResult}: the backend exited before `system/init`, so there is no stderr
   * to read except what the runner folded into the error. Keyed on the backend's own
   * "the conversation is gone" line, NOT on the missing init alone — that symptom is
   * also what a stream truncated after real work looks like, and re-running such a
   * turn would repeat its side effects.
   */
  private isDeadClaudeResumeError(error: unknown, resumeSessionId: string): boolean {
    if (!isNoSessionInitFailure(error)) return false;
    return error instanceof Error && namesMissingConversation(error.message, resumeSessionId);
  }

  /**
   * Materialize any `file`-kind attachments on `runOpts` into the turn's working
   * directory and fold a pointer to them into the prompt, leaving only image
   * attachments for the backend to deliver inline (#file-attachments). Returns the
   * adjusted options plus a `cleanup` the caller MUST run once the turn settles (the
   * scratch files only need to live for the run). A no-op when there are no files.
   */
  private async prepareFileAttachments(
    runOpts: RunTurnOptions,
  ): Promise<{ opts: RunTurnOptions; cleanup: () => Promise<void> }> {
    const materialized = await materializeFileAttachments(runOpts.cwd, runOpts.attachments);
    if (materialized.promptSuffix.length === 0) {
      return { opts: runOpts, cleanup: materialized.cleanup };
    }
    const opts: RunTurnOptions = {
      ...runOpts,
      prompt: `${runOpts.prompt ?? ''}${materialized.promptSuffix}`,
    };
    if (materialized.imageAttachments !== undefined)
      opts.attachments = materialized.imageAttachments;
    else delete opts.attachments;
    return { opts, cleanup: materialized.cleanup };
  }

  private async executeBackendTurn(
    sessionId: string,
    prompt: string,
    session: SessionRecord,
    opts: TurnOptions,
    resumeSessionId: string | undefined,
  ): Promise<BackendTurnAttempt> {
    let backendSessionId: string | undefined;
    // The handle was registered synchronously at turn-accept (so a cancel racing the
    // spawn lands); thread its operator-cancel signal into the run and bind the live
    // Runner turn as the handle's delegate for steer/answerPermission. If it's absent
    // (defensive — every start path registers it before calling here), fall back to a
    // fresh handle so the run still cancels/steers correctly.
    const handle = this.turns.get(sessionId) ?? new SessionTurnHandle();
    this.turns.set(sessionId, handle);
    const selectedModel = opts.model ?? session.model;
    const backendKey = this.backendKey(selectedModel);
    const backend = await this.backendForSession(session, selectedModel, sessionId);
    // Bind the brokered-grant channel before the run can surface a permission prompt
    // (ADR 0014 D3). A codex resume-retry re-enters here with the same handle and
    // rewrites it, which is correct: the retry may have fallen back to another
    // transport, and the grant channel must follow the process actually running.
    handle.grantChannel = brokeredGrantChannel(backend);
    const builtRunOpts = this.buildRunOpts(
      sessionId,
      prompt,
      session,
      opts,
      resumeSessionId === undefined,
      // Only a fresh context carries the runtime prompt, so a resumed turn has
      // nothing to tailor and skips the project read entirely.
      resumeSessionId === undefined && (await this.isLocalProjectSession(session)),
    );
    const runOpts = {
      ...builtRunOpts,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      // Internal runtime context for neutral helper commands such as
      // `verity-code-review`. This is not user configuration: it lets the helper
      // start a fresh reviewer on the same backend/model family as this turn.
      env: {
        ...(builtRunOpts.env ?? this.deps.env ?? process.env),
        VERITY_SESSION_BACKEND: backendKey,
        ...(selectedModel !== undefined ? { VERITY_SESSION_MODEL: selectedModel } : {}),
      },
      signal: handle.controller.signal,
    };
    // Per-project agent memory (ADR 0008) rides the runtime system prompt, so it is
    // injected only when initializing a backend context. Resume turns still receive
    // the compact terminology prompt, but keep memory from their existing context
    // and must not have it re-injected.
    if (resumeSessionId === undefined) {
      const sessionSystemPrompt = (await this.deps.sessionSystemPrompt?.(session))?.trim();
      if (sessionSystemPrompt) runOpts.appendSystemPrompt += `\n\n${sessionSystemPrompt}`;
      runOpts.appendSystemPrompt += await this.projectMemoryPrompt(session);
    }
    runOpts.appendSystemPrompt = withBackendSystemPrompt(
      runOpts.appendSystemPrompt,
      backend,
      await this.brokeredAliasesFor(session.projectId, backend),
    );
    // ADR 0006 Stage 4: allocate this attempt's durable turn identity and bind it
    // onto the in-flight marker BEFORE the Runner launches (D2), so a crash-then-
    // recover can discover the turn on the Sandbox supervisor and repeat the
    // idempotent StartTurn under `startCommandId`. A resume-retry runs a FRESH agent
    // and so mints a fresh pair (the retry's `markTurnRunning` already reset the
    // marker's identity to null). Best-effort like every marker write; the loopback
    // runner ignores the ids, so this is a no-op behavior change on the default path.
    const turnId = randomUUID();
    const startCommandId = randomUUID();
    await this.bindTurnIdentity(sessionId, turnId, startCommandId);
    runOpts.turnId = turnId;
    runOpts.startCommandId = startCommandId;
    const { opts: dispatchOpts, cleanup } = await this.prepareFileAttachments(runOpts);
    // Last check before a worker exists. Everything above — backend resolution, the
    // project read, the memory prompt, the identity bind, materializing attachments —
    // is awaited, and a stop that lands anywhere in that window sees `handle.delegate`
    // still undefined. The stop path reads that as "no runner worker owns this turn"
    // and force-settles on it, which is only true for as long as we do not spawn one
    // afterwards. Spawning here would put a live worker on a session whose fence has
    // already been released to its successor — the two-agents-one-worktree state this
    // whole path exists to prevent — so the losing attempt returns as an aborted turn
    // instead. Its terminal events were already written by whoever force-settled it;
    // this return only unwinds the caller.
    if (handle.forceSettled || this.turns.get(sessionId) !== handle) {
      await cleanup();
      return {
        result: { sessionId: undefined, exitCode: 0, stderr: '', aborted: true },
        backendSessionId: undefined,
        backend,
      };
    }
    // Run the turn through the Runner contract (ADR 0006 Stage 1). The RunnerTurn
    // owns the steer channel (#101) and permission answer channel (#27); it adopts
    // the handle's signal for cancel (#79). Each attempt (codex resume-retry) mints a
    // fresh RunnerTurn that rebinds the delegate — the handle always fronts the
    // in-flight attempt.
    const runner = await this.runnerFor(backend, {
      sessionId: session.sessionId,
      projectId: session.projectId,
      worktree: session.worktree,
    });
    const turn = runner.startTurn(dispatchOpts, {
      onSession: (id: string) => {
        backendSessionId = id;
        // Record the pointer the MOMENT the backend reveals it, not only once the
        // turn settles. A turn that dies mid-flight (sandbox rebuild, server
        // restart, transport drop) otherwise leaves the session with no record of
        // its backend thread at all — and the resume fallback in
        // `runBackendTurnWithResumeRecovery` then guesses the store id, naming a
        // conversation the backend never opened. Best-effort: the settle path
        // upserts the authoritative cursor right after.
        const persisted = this.persistBackendSessionState(sessionId, backendKey, id).catch(
          () => undefined,
        );
        // Published so `clearBackendSessionState` can wait it out instead of racing it.
        this.pendingBindPersists.set(sessionId, persisted);
        void persisted.then(() => {
          if (this.pendingBindPersists.get(sessionId) === persisted) {
            this.pendingBindPersists.delete(sessionId);
          }
        });
      },
      onPermissionRequest: (request) => {
        this.trackPendingPermission(sessionId, request);
      },
      ...(this.deps.bus !== undefined ? { bus: this.deps.bus } : {}),
    });
    handle.delegate = turn;
    try {
      const result = await turn.result;
      // `onSession` is the only bind a backend vouches for: it fires when the
      // conversation is actually open. `result.sessionId` is the fallback for a
      // backend that reveals its thread no earlier than the settle — but on a
      // FAILED turn that merely echoes the id we asked it to resume, it carries no
      // information at all. Persisting that echo re-pins the session to the very
      // pointer the turn just died on, so the next turn resumes the same dead
      // thread and dies identically: the session wedges for good. Report nothing
      // instead and let the caller's stale-resume recovery clear the pointer.
      const settled =
        result.exitCode !== 0 && result.sessionId === resumeSessionId
          ? undefined
          : result.sessionId;
      return { result, backendSessionId: backendSessionId ?? settled, backend };
    } finally {
      await cleanup();
    }
  }

  private async runBackendTurnWithResumeRecovery(
    sessionId: string,
    prompt: string,
    session: SessionRecord,
    opts: TurnOptions,
  ): Promise<RunResult> {
    const backendKey = this.backendKey(opts.model ?? session.model);
    // Fold any server-authored pending notes (e.g. the post-merge worktree reset)
    // into THIS turn's model prompt as provenance-labelled data and consume them. They ride the model input
    // only — the visible `prompt` event was already emitted by the caller with the
    // operator's own text, so the chat transcript stays clean while the agent still
    // learns what the server did out-of-band.
    const pendingNotes = await this.deps.store.consumePendingNotes(sessionId);
    if (pendingNotes.length > 0) {
      prompt = appendExternalPromptData(prompt, 'Verity pending session notices', {
        notices: pendingNotes,
      });
    }
    prompt = await withMeetingContext(session.worktree, prompt);
    const backendState = await this.deps.store.getSessionBackendState(sessionId, backendKey);
    const canResumeCanonicalClaudeSession =
      backendKey === 'claude' &&
      backendState === undefined &&
      (await this.isClaudeOriginSession(session));
    const resumeSessionId =
      backendState?.backendSessionId ?? (canResumeCanonicalClaudeSession ? sessionId : undefined);
    // Two handoff needs, both served by prepending a serialized transcript of the
    // history the target backend hasn't seen (see {@link withHandoffContext}):
    //   • COLD start (`resumeId === undefined`, e.g. a first Claude→Codex switch):
    //     the backend has no native thread → serialize the FULL prior history.
    //   • STALE resume (`resumeId` set but the backend's `context_seq` lags): a
    //     switch to another backend AND BACK. The native thread still holds context
    //     up to `context_seq`, but every turn run on the OTHER backend since is
    //     missing from it — serialize just that GAP. Without this, switching back to
    //     a backend silently drops everything learned while away (the model-switch
    //     context-loss bug). When the thread IS current the gap is empty and
    //     `buildHandoffPrompt` returns the prompt unchanged (the hot path).
    // A native resume with NO recorded cursor (`backendState === undefined`, the
    // claude→own-id fallback) resumes the canonical session transcript, which already
    // holds the full history — send the prompt plain, no handoff. Each variant is
    // computed lazily once and reused across a codex resume-retry.
    let coldPrompt: string | undefined;
    let gapPrompt: string | undefined;
    const promptFor = async (resumeId: string | undefined): Promise<string> => {
      if (resumeId === undefined) {
        coldPrompt ??= await this.withHandoffContext(sessionId, prompt);
        return coldPrompt;
      }
      if (backendState === undefined) return prompt;
      gapPrompt ??= await this.withHandoffContext(sessionId, prompt, backendState.contextSeq);
      return gapPrompt;
    };
    let first: BackendTurnAttempt;
    try {
      first = await this.executeBackendTurn(
        sessionId,
        await promptFor(resumeSessionId),
        session,
        opts,
        resumeSessionId,
      );
    } catch (error) {
      // A resume that names a conversation the backend does not have never opens a
      // session: the backend prints its "No conversation found" line and exits before
      // `system/init`, so ingest THROWS instead of returning a RunResult — and the
      // stale-resume check below, which reads `result.stderr`, never runs. Without
      // this branch the session is wedged for good: every later turn re-resumes the
      // same dead id and fails identically.
      //
      // Gated on the backend's own "No conversation found" line (folded into the
      // error by the runner), not on the missing init alone: a stream truncated
      // after the backend had already acted presents the same symptom, and cold
      // retrying THAT would repeat its side effects. With the reason confirmed, the
      // backend provably never opened the conversation, so nothing can be repeated.
      if (
        backendKey !== 'claude' ||
        resumeSessionId === undefined ||
        !this.isDeadClaudeResumeError(error, resumeSessionId)
      ) {
        throw error;
      }
      await this.clearBackendSessionState(sessionId, backendKey);
      await this.markTurnRunning(sessionId, await this.deps.store.latestEventSeq(sessionId));
      const retry = await this.executeBackendTurn(
        sessionId,
        await promptFor(undefined),
        session,
        opts,
        undefined,
      );
      await this.persistBackendSessionState(sessionId, backendKey, retry.backendSessionId);
      return retry.result;
    }
    if (
      backendKey === 'claude' &&
      resumeSessionId !== undefined &&
      this.isStaleClaudeResume(first.result, resumeSessionId)
    ) {
      first.backend.closeSession?.(resumeSessionId);
      await this.clearBackendSessionState(sessionId, backendKey);
      await this.markTurnRunning(sessionId, await this.deps.store.latestEventSeq(sessionId));
      const retry = await this.executeBackendTurn(
        sessionId,
        await promptFor(undefined),
        session,
        opts,
        undefined,
      );
      await this.persistBackendSessionState(sessionId, backendKey, retry.backendSessionId);
      return retry.result;
    }

    // Codex reads BOTH signals into its own ladder below rather than letting the
    // neutral branch have them: that ladder tries the Verity session id before
    // giving up on a native thread, and a refused `session/load` whose stderr
    // happens not to match the phrasebook would otherwise skip straight to a cold
    // start and lose a conversation the second rung can still find.
    const codexStale =
      backendKey === 'codex' &&
      resumeSessionId !== undefined &&
      (this.isStaleCodexResume(first.result) || first.result.staleResume === true);

    // The backend-neutral stale resume: the agent ANSWERED the resume with an error,
    // so the conversation this session is bound to is not one it can restore. Unlike
    // the two branches above, this needs no per-backend stderr phrasebook — the
    // backend reports it as {@link RunResult.staleResume} off the protocol itself.
    //
    // Without it such a session is wedged for good, because the bind is only ever
    // REPLACED by a later one and a refused resume mints no id to replace it with:
    // every subsequent turn re-resumes the same dead pointer and fails identically.
    // The case that made this concrete is a session bound before ADR 0012 Amendment 4
    // moved OpenCode onto ACP — those ids belong to the retired `opencode serve`
    // transport, and no `opencode acp` will ever know one — but nothing here is
    // specific to it: an agent that pruned its own history lands in the same place.
    //
    // Ordering: this sits after the two claude branches, which are gated on their
    // own backend and cannot both fire, and before `maybeAutoResume` further out,
    // which replays a `failedBeforeExecution` turn. Those two classifications are
    // disjoint by construction — `failedBeforeExecution` is an auth/quota refusal
    // read off stderr, `staleResume` an answered `resourceNotFound` — and the
    // backend tests pin it, but the ordering makes the overlap harmless anyway:
    // this cold retry runs first and its own result is what the replay sees.
    if (!codexStale && resumeSessionId !== undefined && first.result.staleResume === true) {
      first.backend.closeSession?.(resumeSessionId);
      await this.clearBackendSessionState(sessionId, backendKey);
      await this.markTurnRunning(sessionId, await this.deps.store.latestEventSeq(sessionId));
      const retry = await this.executeBackendTurn(
        sessionId,
        await promptFor(undefined),
        session,
        opts,
        undefined,
      );
      await this.persistBackendSessionState(sessionId, backendKey, retry.backendSessionId);
      return retry.result;
    }

    if (!codexStale) {
      await this.persistBackendSessionState(sessionId, backendKey, first.backendSessionId);
      return first.result;
    }

    await this.clearBackendSessionState(sessionId, backendKey);
    const retryResumeIds = resumeSessionId !== sessionId ? [sessionId, undefined] : [undefined];
    for (const retryResumeId of retryResumeIds) {
      // Re-anchor the in-flight marker PAST the discarded attempt's durably-persisted
      // events (its `session` + terminal `run_failed` error). Otherwise a crash mid-retry
      // leaves that superseded terminal error as the tail after the ORIGINAL anchor, and
      // recovery would read it as a settled turn instead of interrupting the abandoned one
      // (the stale-codex-resume hole this Phase-1 fix closes). Best-effort like every mark.
      await this.markTurnRunning(sessionId, await this.deps.store.latestEventSeq(sessionId));
      const retry = await this.executeBackendTurn(
        sessionId,
        await promptFor(retryResumeId),
        session,
        opts,
        retryResumeId,
      );
      if (retryResumeId !== undefined && this.isStaleCodexResume(retry.result)) continue;
      await this.persistBackendSessionState(sessionId, backendKey, retry.backendSessionId);
      return retry.result;
    }

    await this.persistBackendSessionState(sessionId, backendKey, first.backendSessionId);
    return first.result;
  }

  /** True while a turn for `sessionId` is in flight. */
  isBusy(sessionId: string): boolean {
    return this.inFlight.has(sessionId);
  }

  /**
   * A stateless one-shot model query — spawns the backend's `query` (e.g. `claude -p`)
   * ONCE with no session, transcript, worktree, or store writes, and returns its raw
   * stdout (or `undefined` on any failure, or a backend without one-shot support).
   * Routes the model exactly like a turn (bare → Claude, `provider/model` → OpenCode,
   * `codex/…` → Codex) and threads the injected spawner/command/env. Used for
   * lightweight assists such as task-draft refinement (ADR 0007); mirrors the
   * auto-title path, which is the other `backend.query` caller.
   */
  async query(input: {
    prompt: string;
    cwd: string;
    model?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<string | undefined> {
    const selected = this.modelBackend(input.model);
    const backend = (await this.deps.queryBackend?.(selected, input.model)) ?? selected;
    return this.queryWithBackend(backend, input, {
      sessionId: null,
      projectId: null,
      worktree: input.cwd,
    });
  }

  /** Run a meta-query through a backend's native one-shot support when available,
   * otherwise through a transient supervised turn. The latter restores ACP-only
   * Claude auto-title/refinement without spawning `claude -p` in the Server. */
  private async queryWithBackend(
    backend: Backend,
    input: {
      prompt: string;
      cwd: string;
      model?: string | undefined;
      signal?: AbortSignal | undefined;
    },
    context: { sessionId: string | null; projectId: string | null; worktree: string },
  ): Promise<string | undefined> {
    if (backend.query !== undefined) {
      const direct = await backend.query({
        prompt: input.prompt,
        cwd: input.cwd,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        ...(this.deps.spawner !== undefined ? { spawner: this.deps.spawner } : {}),
        ...(this.deps.command !== undefined ? { command: this.deps.command } : {}),
        ...(this.deps.env !== undefined ? { env: this.deps.env } : {}),
      });
      if (direct !== undefined) return direct;
    }
    if (backend.runnerSupervisorBackend === undefined || this.deps.runner === undefined) {
      return undefined;
    }
    const chunks: string[] = [];
    const turnId = randomUUID();
    try {
      const runner = await this.runnerFor(backend, {
        ...context,
        ephemeralEventSink: (event) => {
          if (event.t === 'text' && event.parentToolId === undefined) chunks.push(event.delta);
        },
      });
      const turn = runner.startTurn(
        {
          store: this.deps.store,
          worktree: input.cwd,
          cwd: input.cwd,
          prompt: input.prompt,
          turnId,
          startCommandId: randomUUID(),
          storeSessionId: `query-${turnId}`,
          permissionMode: 'dontAsk',
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        },
        {},
      );
      const result = await turn.result;
      if (result.exitCode !== 0 || result.aborted) return undefined;
    } catch {
      return undefined;
    }
    const text = chunks.join('').trim();
    return text.length === 0 ? undefined : text;
  }

  /**
   * Append a transcript-only "PR #N merged" marker and fan it out to live
   * subscribers. Mirrors {@link emitInterrupted}: a bare marker event — NO turn is
   * dispatched and NO agent reply is produced. It exists purely so the operator sees
   * the merge landed when they return to the chat; the agent learns of the merge from
   * the pending note the merge route leaves (folded into its next turn), not this row.
   * Best-effort at the call site — a marker failure must never fail the merge itself.
   */
  async emitMerged(sessionId: string, number: number): Promise<void> {
    const event = { t: 'merged' as const, number };
    const { seq, ts } = await this.deps.store.appendEvent(sessionId, event);
    this.deps.bus?.publish(sessionId, { seq, ts, event });
  }

  /**
   * Run `fn` when the session is idle: immediately if no turn is in flight, otherwise
   * DEFERRED until the current turn (and anything queued behind it) settles. Used for
   * post-merge worktree housekeeping that must never run under a live turn — the reset
   * force-checks-out the worktree, which would trash an in-flight turn's work. Deferred
   * actions are in-memory only: a server restart between registration and the settle
   * drops them (the effect simply doesn't happen; nothing is corrupted). Errors from a
   * deferred `fn` route to {@link ConductorDeps.onTurnError}; an immediate `fn`'s error
   * propagates to the caller.
   */
  async runWhenIdle(sessionId: string, fn: () => Promise<void>): Promise<void> {
    if (!this.inFlight.has(sessionId)) {
      await fn();
      return;
    }
    this.parkWhenIdle(sessionId, fn);
  }

  /**
   * Like {@link runWhenIdle}, but HOLDS the session's turn lock for the whole run of
   * `fn` instead of only checking it once. Idle is a point-in-time fact: a turn
   * dispatched right after `runWhenIdle`'s check runs alongside the callback, which is
   * unsafe for housekeeping that rewrites the worktree out from under a live agent.
   * Holding `inFlight` closes that window — a turn dispatched meanwhile enqueues (there
   * is no live runner to steer into) and drains the moment the lock is released.
   *
   * The lock is claimed synchronously before the first await, both on the immediate
   * path and inside the deferred flush, so no turn can slip between the check and the
   * claim. It is also marked as a MAINTENANCE lock, which "Stop" declines to
   * force-settle (see {@link cancelTurn}) — otherwise the one path that releases a lock
   * without owning it would hand the session to a queued turn mid-callback. Callbacks
   * should still be individually safe: the lock covers turns this Conductor starts, not
   * a shell the operator runs in the same worktree.
   */
  async runExclusive(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const guarded = async (): Promise<void> => {
      if (this.inFlight.has(sessionId)) {
        // A turn claimed the lock in the same tick this action was flushed; park it
        // again so it runs on THAT turn's settle rather than beside it.
        this.parkWhenIdle(sessionId, guarded);
        return;
      }
      this.inFlight.add(sessionId);
      this.maintenanceLocks.add(sessionId);
      try {
        await fn();
      } finally {
        this.maintenanceLocks.delete(sessionId);
        this.releaseTurnLock(sessionId);
      }
    };
    await this.runWhenIdle(sessionId, guarded);
  }

  /**
   * Claim the turn lock and run `fn` under it, or report that a turn is already in
   * flight — the non-deferring counterpart to {@link runExclusive}, for work a request
   * must either do now or reject (the local merge: its result is the HTTP response, so
   * it cannot be parked). The claim is synchronous, so it is also the busy CHECK: two
   * concurrent requests can never both pass it.
   */
  async tryRunExclusive<T>(
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.inFlight.has(sessionId)) return { ran: false };
    this.inFlight.add(sessionId);
    this.maintenanceLocks.add(sessionId);
    try {
      return { ran: true, value: await fn() };
    } finally {
      this.maintenanceLocks.delete(sessionId);
      this.releaseTurnLock(sessionId);
    }
  }

  /**
   * Atomically replace a session backend at a confirmed turn boundary. New turn
   * submissions are fenced before cancellation starts; the callback runs under the
   * same ownership lock only after the old Runner has exited and its turn finalized.
   *
   * The fence is the existing {@link stopping} counter — the same one {@link stopSession}
   * raises, and the same gate {@link dispatchTurnInner} and {@link drainNext} already
   * check. Reusing it is what makes a submission during the handover refuse with
   * {@link SessionBusyError} rather than queue behind the turn we are about to kill: a
   * turn queued here would drain against the OLD backend the moment the fence dropped,
   * which is the successor half of the very overlap this barrier removes. It is raised
   * before the cancel and lowered in the `finally`, so the window is never open.
   */
  async runBackendHandoff<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    this.stopping.set(sessionId, (this.stopping.get(sessionId) ?? 0) + 1);
    const previous = this.handoffOperations.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = previous.then(() => completion);
    this.handoffOperations.set(sessionId, operation);
    try {
      await previous;
      if (this.inFlight.has(sessionId)) {
        // Startup recovery can hold this fence without a live handle while Runner
        // discovery is uncertain. Ordinary Stop is intentionally allowed to give up
        // on that ambiguity and make the session usable again, but a backend handoff
        // is not an operator-requested safety override: releasing here would let the
        // replacement backend overlap the possibly-live recovered worker. Fail closed
        // and let the recovery retry (or an explicit Stop) decide the old turn first.
        if (this.uncertainRecovery.has(sessionId)) {
          throw new BackendTerminationUnconfirmedError(sessionId);
        }
        // The cancel ack only says the request was delivered. Ownership passes when
        // the FENCE drops, which happens on the settle path once termination is
        // established — so wait on that, bounded, and refuse the handoff rather than
        // start a second backend over a worker that may still hold the worktree.
        await this.cancelTurn(sessionId);
        if (!(await this.awaitFenceRelease(sessionId, BACKEND_HANDOFF_FENCE_TIMEOUT_MS))) {
          // Not every held fence means an unterminated agent. A maintenance action
          // (bind, purge, local merge — see {@link runExclusive}) holds the same lock
          // with no worker behind it at all, and reporting that as "the old backend
          // may still be alive" sends the operator after the wrong cause. It is
          // ordinary contention: transient, and retrying is the right advice.
          if (this.maintenanceLocks.has(sessionId)) throw new SessionBusyError(sessionId);
          throw new BackendTerminationUnconfirmedError(sessionId);
        }
      }
      // Claim GUARDED, not blind — a backstop, deliberately kept even though no
      // current path reaches it. Every claimant we ship either checks `stopping`
      // synchronously before claiming ({@link accept}, {@link drainNext}) or is a
      // maintenance lock the branch above already turns away, so the fence should be
      // free here. `Set.add` on an already-held lock is a SILENT no-op, though: were
      // that ever untrue, the callback would rewrite backend state under a live holder
      // and the `finally` would release a fence it never owned — the exact overlap
      // this barrier exists to prevent, in its least visible form. Refusing costs a
      // retriable 409 and nothing else.
      if (this.inFlight.has(sessionId)) throw new SessionBusyError(sessionId);
      this.inFlight.add(sessionId);
      this.maintenanceLocks.add(sessionId);
      try {
        return await fn();
      } finally {
        this.maintenanceLocks.delete(sessionId);
        this.releaseTurnLock(sessionId);
      }
    } finally {
      release();
      if (this.handoffOperations.get(sessionId) === operation) {
        this.handoffOperations.delete(sessionId);
      }
      const remaining = (this.stopping.get(sessionId) ?? 1) - 1;
      if (remaining === 0) {
        this.stopping.delete(sessionId);
        if (!this.inFlight.has(sessionId) && (this.queues.get(sessionId)?.length ?? 0) > 0) {
          this.drainNext(sessionId);
        }
      } else this.stopping.set(sessionId, remaining);
    }
  }

  /**
   * Wait until this session's turn lock drops, bounded by `timeoutMs`. Returns whether
   * the fence was observed released — a false result means the previous owner's exit
   * is still unproven and the caller must NOT claim the session.
   */
  private async awaitFenceRelease(sessionId: string, timeoutMs: number): Promise<boolean> {
    if (!this.inFlight.has(sessionId)) return true;
    const waiters = this.inFlightReleaseWaiters.get(sessionId) ?? new Set<() => void>();
    this.inFlightReleaseWaiters.set(sessionId, waiters);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake!: () => void;
    // The WAKE is the observation, not a post-hoc `inFlight` read: `releaseTurnLock`
    // wakes waiters and then drains a queued successor SYNCHRONOUSLY, while this
    // continuation only resumes a microtask later — so by the time we look, the fence
    // can legitimately be held again by the next turn. Reading that as a timeout would
    // report a perfectly normal release as an unproven exit.
    let woken = false;
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          wake = (): void => {
            woken = true;
            resolve();
          };
          waiters.add(wake);
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      const live = this.inFlightReleaseWaiters.get(sessionId);
      live?.delete(wake);
      // `releaseInFlight` is what normally drops the map entry, and on the timeout
      // path it never runs — so remove an emptied set here or a session that times
      // out once keeps an empty Set forever.
      if (live?.size === 0) this.inFlightReleaseWaiters.delete(sessionId);
    }
    // The `inFlight` read is the timeout-path fallback only: a fence that dropped
    // without ever waking us (nothing ships that today) still counts as released.
    return woken || !this.inFlight.has(sessionId);
  }

  /**
   * Release a lock claimed outside a turn and hand the session on exactly like a
   * settling turn does: drain a queued turn if one arrived while we held it, and
   * otherwise flush the idle-boundary actions that could not run meanwhile.
   */
  private releaseTurnLock(sessionId: string): void {
    this.releaseInFlight(sessionId);
    // Snapshot before draining — `drainNext` is async and has not re-set `inFlight`
    // yet, so the flush below must gate on this, not on `inFlight` (see the settle path).
    const hadQueued = (this.queues.get(sessionId)?.length ?? 0) > 0;
    this.drainNext(sessionId);
    if (!hadQueued) this.flushDeferredWhenIdle(sessionId);
  }

  /** Park an action on the next idle boundary (see {@link deferredWhenIdle}). */
  private parkWhenIdle(sessionId: string, fn: () => Promise<void>): void {
    const list = this.deferredWhenIdle.get(sessionId) ?? [];
    list.push(fn);
    this.deferredWhenIdle.set(sessionId, list);
  }

  /**
   * Run a synchronous action after the current turn releases its lock but BEFORE a
   * queued successor starts. Runs immediately when the session is already idle and
   * returns whether it was deferred. This narrower boundary is used for backend
   * model switches: closing during the live turn would kill it, while waiting for
   * full idle would let queued turns start on the stale backend process.
   */
  runAfterCurrentTurn(sessionId: string, fn: () => void): boolean {
    if (!this.inFlight.has(sessionId)) {
      fn();
      return false;
    }
    const list = this.deferredAfterCurrentTurn.get(sessionId) ?? [];
    list.push(fn);
    this.deferredAfterCurrentTurn.set(sessionId, list);
    return true;
  }

  /** Whether an action registered by {@link runAfterCurrentTurn} is still waiting. */
  hasDeferredAfterCurrentTurn(sessionId: string): boolean {
    return (this.deferredAfterCurrentTurn.get(sessionId)?.length ?? 0) > 0;
  }

  /** True from the instant a backend switch fences submissions until the old
   * Runner is confirmed terminated and the replacement metadata is committed. */
  isBackendHandoffPending(sessionId: string): boolean {
    return this.handoffOperations.has(sessionId);
  }

  private flushDeferredAfterCurrentTurn(sessionId: string): void {
    const list = this.deferredAfterCurrentTurn.get(sessionId);
    if (!list || list.length === 0) return;
    this.deferredAfterCurrentTurn.delete(sessionId);
    for (const fn of list) {
      try {
        fn();
      } catch (error) {
        this.reportTurnError(sessionId, error);
      }
    }
  }

  private clearUncertainRecoveryTimer(sessionId: string): void {
    const timer = this.uncertainRecoveryTimers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.uncertainRecoveryTimers.delete(sessionId);
  }

  /** Leave the uncertain-discovery state, dropping the attempt bound with it. Returns
   * whether the session WAS fenced by recovery, so callers keep the existing
   * `if (delete(...)) releaseInFlight(...)` idiom. */
  private leaveUncertainRecovery(sessionId: string): boolean {
    this.uncertainRecoveryAttempts.delete(sessionId);
    return this.uncertainRecovery.delete(sessionId);
  }

  /** Release this session's turn lock and run actions waiting on that exact boundary. */
  private releaseInFlight(sessionId: string): void {
    this.inFlight.delete(sessionId);
    // The fence dropping IS the recovery from an unconfirmed stop, whichever path got
    // there (reaper, late run-loop settle, or the liveness sweep).
    this.clearTerminationUnconfirmed(sessionId);
    const waiters = this.inFlightReleaseWaiters.get(sessionId);
    if (waiters !== undefined) {
      this.inFlightReleaseWaiters.delete(sessionId);
      for (const wake of waiters) wake();
    }
    this.flushDeferredAfterCurrentTurn(sessionId);
  }

  /**
   * Run any actions parked by {@link runWhenIdle}. Called from every turn-settle path
   * AFTER {@link drainNext}, but ONLY when no queued turn is about to drain — the
   * caller checks that BEFORE draining (the drain is async and hasn't re-set `inFlight`
   * yet, so an `inFlight` check here can't see it). Re-guards on `inFlight` for a fresh
   * turn dispatched concurrently: those actions then run on ITS settle instead.
   */
  private flushDeferredWhenIdle(sessionId: string): void {
    if (this.inFlight.has(sessionId)) return;
    const list = this.deferredWhenIdle.get(sessionId);
    if (!list || list.length === 0) return;
    this.deferredWhenIdle.delete(sessionId);
    void (async () => {
      for (const fn of list) {
        try {
          await fn();
        } catch (error) {
          this.reportTurnError(sessionId, error);
        }
      }
    })();
  }

  /**
   * Route a background-turn failure to the optional {@link ConductorDeps.onTurnError}
   * sink, normalising the value to an `Error` first. Guarded: a sink that itself
   * THROWS is swallowed here so it can't escalate to an unhandled rejection (which
   * crashes the Node process on modern defaults) or strand the surrounding recovery
   * logic (lock release, queue drain, start-path reject) at the `void`-ed call sites
   * where these failures are reported. Issue #24.
   */
  private reportTurnError(sessionId: string, error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    try {
      this.deps.onTurnError?.(sessionId, normalized);
    } catch {
      // A misbehaving sink must not escalate to an unhandled rejection or strand the
      // turn's recovery follow-ups; report-and-continue is the whole point of #24.
    }
  }

  private async reportBackgroundTurnFailure(sessionId: string, error: unknown): Promise<void> {
    const normalized = error instanceof Error ? error : new Error(String(error));
    try {
      const event: AgentEvent = {
        t: 'error',
        kind: 'run_failed',
        message: normalized.message,
      };
      const persisted = await this.deps.store.appendEvent(sessionId, event);
      this.deps.bus?.publish(sessionId, { seq: persisted.seq, ts: persisted.ts, event });
    } catch {
      // Best-effort only: the original failure should still reach the logging sink,
      // and reporting must never create a second failure path.
    }
    this.reportTurnError(sessionId, normalized);
  }

  /**
   * Stop the in-flight turn for `sessionId` (issue #79): abort its run, which
   * SIGTERMs the spawned `claude`. The run then settles like normal — partial
   * output stays persisted and the run path appends an `interrupted` event as the
   * turn's terminal marker. Returns `true` if a turn was actually running and got
   * signalled, `false` if the session was idle (a harmless no-op — e.g. the turn
   * finished a beat before the operator's tap). Does NOT drop queued turns; those
   * still drain (cancel one turn, not the whole backlog).
   */
  async cancelTurn(sessionId: string): Promise<boolean> {
    const turn = this.turns.get(sessionId);
    if (!turn) {
      // The lock is held by maintenance, not by a turn: nothing is running for the
      // operator to stop, and force-settling would hand the session to a queued turn
      // while the callback is still rewriting the worktree. It releases the lock itself
      // in a moment, and the queue drains then.
      if (this.maintenanceLocks.has(sessionId)) return false;
      if (!this.inFlight.has(sessionId) && !(await this.hasRunningTurnMarker(sessionId))) {
        return false;
      }
      await this.forceSettleUncancellableTurn(sessionId);
      return true;
    }
    return await this.cancelLiveTurn(sessionId, turn);
  }

  /** `turn` is deliberately a {@link SessionTurnHandle}, not a bare {@link RunnerTurn}:
   * every live turn in {@link turns} is one, and the unconfirmed-termination path below
   * needs the handle to hand the session to {@link reapUnconfirmedWorker}. A shape with
   * no handle would hold the fence with no way back. */
  private async cancelLiveTurn(sessionId: string, turn: SessionTurnHandle): Promise<boolean> {
    const timedOut = Symbol('runner-cancel-timeout');
    const rejected = Symbol('runner-cancel-rejected');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel: Promise<boolean | typeof rejected> = turn.cancel().catch((error: unknown) => {
      // A REJECTED cancel proves nothing about the backend, so it must not be
      // reported as a completed stop: fall through to the out-of-band kill below,
      // exactly like a cancel that never answered.
      this.reportTurnError(sessionId, error);
      return rejected;
    });
    const result = await Promise.race<boolean | typeof timedOut | typeof rejected>([
      cancel,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), RUNNER_CANCEL_GRACE_MS);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === false) return false; // nothing to cancel — the turn already ended
    if (result === true) {
      // The runner ACKNOWLEDGED the cancel — but an ack is not an exit. The run loop
      // behind it can still be wedged on a backend await the abort never reaches.
      // Verify in the BACKGROUND so a healthy turn keeps Stop's fast response; the
      // watchdog holds the worktree ownership fence until the turn is finalized or
      // the worker's termination is confirmed, so a caller that needs the handover
      // (see {@link runBackendHandoff}) waits on the fence, not on this ack.
      void this.watchCancelledTurnSettles(sessionId, turn);
      return true;
    }

    // A live cancel may hang behind a child process that still owns stdout. For a
    // supervisor turn, bypass its stuck per-turn control socket and terminate the
    // owning worker through the supervisor control plane. BOUNDED: when the
    // control socket itself is hung, forceCancel would otherwise wedge this very
    // path and Stop would never reach the force-settle below.
    const termination = await this.boundedForceCancel(sessionId, turn);
    // Revalidate after the forceCancel await: the run loop may have settled during
    // it and a queued successor may already be live — closeSession is keyed by
    // session id and would then terminate the SUCCESSOR's backend. Only when this
    // turn still owns the session: keep the in-process backend fallback for
    // loopback turns (and as a harmless second fence if the supervisor worker
    // exited between timeout and forceCancel), then — because a run loop can be
    // wedged past process death (e.g. a broker await that never resolves) — settle
    // from here. The settle claim makes this safe against the run loop settling late.
    //
    // `unconfirmed` is the one case that does NOT finalize: a worker that may still
    // be alive must keep sole ownership of the worktree, so the fence stays held and
    // {@link reapUnconfirmedWorker} keeps retrying the kill in the background. The
    // in-process child is still closed there — closeSession is the cheapest lever
    // against the very overlap this guards, and it does not free the fence.
    if (turn.settled || this.turns.get(sessionId) !== turn) return true;
    this.closeSession(sessionId);
    if (termination === 'unconfirmed') {
      this.reapUnconfirmedWorker(sessionId, turn);
      return true;
    }
    await this.forceSettleWedgedTurn(sessionId, turn);
    return true;
  }

  /**
   * Invoke the runner's force-cancel BOUNDED by {@link RUNNER_CANCEL_GRACE_MS}: a
   * stuck per-turn control socket must never wedge the very paths that guarantee
   * Stop.
   *
   * `confirmed` means the runner produced a termination certificate (the worker was
   * killed, or was already terminal). `none` means there is NO separate worker to
   * kill — a loopback/in-process turn, where the abort signal and {@link closeSession}
   * terminate the child directly and are themselves the certificate. `unconfirmed`
   * means the worker may still be running: either a kill was attempted and neither
   * outcome could be established, or there was no way to attempt one.
   *
   * Absent `forceCancel` is NOT `none`. `RunnerTurn.forceCancel` is optional, so a
   * runner-backed turn can own a worker with no out-of-band kill channel; reading
   * that as a certificate would restore the optimistic release this whole path exists
   * to remove, silently and for whichever client omits the method.
   *
   * `turn` is a {@link SessionTurnHandle} rather than a bare {@link RunnerTurn}:
   * {@link turns} only ever holds handles (a reattached turn from recovery is wrapped
   * in one too), and the two questions below are about the handle's delegate, which a
   * bare turn cannot answer.
   */
  private async boundedForceCancel(
    sessionId: string,
    turn: SessionTurnHandle,
  ): Promise<'confirmed' | 'unconfirmed' | 'none'> {
    if (!turn.hasRunnerWorker) return 'none';
    if (!turn.hasForceChannel) return 'unconfirmed';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = Symbol('force-cancel-timeout');
      const outcome = await Promise.race<boolean | typeof timedOut>([
        turn.forceCancel?.() ?? Promise.resolve(false),
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), RUNNER_CANCEL_GRACE_MS);
        }),
      ]);
      return outcome === true ? 'confirmed' : 'unconfirmed';
    } catch (error) {
      this.reportTurnError(sessionId, error);
      return 'unconfirmed';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Whether this session is fenced by a stop whose worker termination could not be
   * established. Distinct from {@link isBusy}: nothing is running for the operator,
   * the session is RESERVED for a process that may still be alive. Surfaced so a
   * fenced session reads as an explained state rather than an endless "busy".
   */
  hasUnconfirmedTermination(sessionId: string): boolean {
    return this.unconfirmedTermination.has(sessionId);
  }

  /** Enter the unconfirmed-termination state. The transcript announcement is delayed
   * until the retry path also fails, so a merely slow successful stop stays silent. */
  private markTerminationUnconfirmed(sessionId: string): void {
    if (this.unconfirmedTermination.has(sessionId)) return;
    this.unconfirmedTermination.add(sessionId);
  }

  /** Announce a still-unconfirmed fence once its immediate retry path is exhausted. */
  private announceTerminationUnconfirmed(sessionId: string): void {
    if (!this.unconfirmedTermination.has(sessionId)) return;
    if (this.announcedUnconfirmedTermination.has(sessionId)) return;
    this.announcedUnconfirmedTermination.add(sessionId);
    // Caught, not floated: an unreachable store is a plausible co-cause of the very
    // state being announced, and an unhandled rejection here would take the process
    // down over a missing transcript line. The flag is the load-bearing part.
    void this.emitEvent(sessionId, {
      t: 'notice',
      role: 'agent',
      text: UNCONFIRMED_TERMINATION_NOTICE,
    }).catch((error: unknown) => {
      this.reportTurnError(sessionId, error);
    });
  }

  /** Leave it again, saying so — the session became usable without the operator
   * doing anything, which is only obvious if we tell them. */
  private clearTerminationUnconfirmed(sessionId: string): void {
    if (!this.unconfirmedTermination.delete(sessionId)) return;
    if (!this.announcedUnconfirmedTermination.delete(sessionId)) return;
    void this.emitEvent(sessionId, {
      t: 'notice',
      role: 'agent',
      text: UNCONFIRMED_TERMINATION_CLEARED_NOTICE,
    }).catch((error: unknown) => {
      this.reportTurnError(sessionId, error);
    });
  }

  /**
   * The operator's way out of a fence nothing else can lift: release a session held
   * by an unconfirmed termination, on their explicit say-so.
   *
   * Every automatic path back needs the same thing — evidence that the old worker is
   * gone. The reaper needs the control plane to answer; the liveness sweep needs the
   * Runner to be provably dead. A worker that is alive but unreachable produces
   * neither, and the barrier is doing exactly what it is for: refusing to start a
   * second agent on a worktree the first may still be editing. That refusal has to be
   * overridable, or the honest answer to "my session is stuck forever" is "delete it".
   *
   * This does NOT prove the worker died — it records that the operator accepted the
   * risk. Hence the deliberately different transcript wording, and hence deleting the
   * flag BEFORE the settle: {@link releaseInFlight} would otherwise announce the
   * previous agent as "confirmed gone", which is the one thing we cannot claim here.
   *
   * Returns whether a fence was actually lifted, so a caller can tell an override
   * from a no-op on a session that had already freed itself. A running reaper needs
   * no cancelling: its own `settled` / `turns.get(...) !== handle` guards make it
   * stand down once the turn is finalized here.
   */
  async releaseUnconfirmedTermination(sessionId: string): Promise<boolean> {
    // Fence submissions across the awaited audit write. Without this, the old turn
    // can settle during the await, a successor can claim the session, and the code
    // below would mistake that successor's handle for the one being overridden.
    this.stopping.set(sessionId, (this.stopping.get(sessionId) ?? 0) + 1);
    const originalHandle = this.turns.get(sessionId);
    try {
      if (!this.unconfirmedTermination.delete(sessionId)) return false;
      this.announcedUnconfirmedTermination.delete(sessionId);
      // Awaited, unlike the notices around it: this one is the audit trail for a manual
      // override of a safety barrier, so it should be on disk before the session is
      // handed back. A store failure must still not block the release — the fence is
      // the point — so report and continue.
      try {
        await this.emitEvent(sessionId, {
          t: 'notice',
          role: 'agent',
          text: UNCONFIRMED_TERMINATION_OVERRIDE_NOTICE,
        });
      } catch (error) {
        this.reportTurnError(sessionId, error);
      }
      // Revalidate the captured owner after the await. It may have settled naturally;
      // never fetch a fresh handle here, because that could only belong to a successor.
      if (originalHandle !== undefined && this.turns.get(sessionId) === originalHandle) {
        this.closeSession(sessionId);
        originalHandle.controller.abort();
        await this.forceSettleWedgedTurn(sessionId, originalHandle);
        return true;
      }
      if (originalHandle === undefined && this.inFlight.has(sessionId)) {
        this.closeSession(sessionId);
        this.releaseTurnLock(sessionId);
      }
      return true;
    } finally {
      const remaining = (this.stopping.get(sessionId) ?? 1) - 1;
      if (remaining === 0) {
        this.stopping.delete(sessionId);
        if (!this.inFlight.has(sessionId) && (this.queues.get(sessionId)?.length ?? 0) > 0) {
          this.drainNext(sessionId);
        }
      } else {
        this.stopping.set(sessionId, remaining);
      }
    }
  }

  /**
   * Wait between reap attempts. Deliberately the global `setTimeout` rather than the
   * `node:timers/promises` one used elsewhere in this file: the promise timer is not
   * intercepted by Vitest's fake timers, so a `sleep` here would force every test that
   * exercises the reaper onto real timers and multi-second budgets. `unref` keeps a
   * pending backoff from holding the process open.
   */
  private backoff(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms).unref?.();
    });
  }

  /**
   * Keep retrying the out-of-band kill for a worker whose death could not be
   * established, until it IS established (then finalize the turn and free the
   * session) or the run loop settles on its own. Backgrounded and self-cancelling —
   * this is the near-term recovery lever for the one state the ownership barrier
   * deliberately refuses to paper over: the fence stays held while the old worker may
   * still be editing the worktree, so the session must be able to come back by itself
   * once the control plane responds again. Bounded by
   * {@link UNCONFIRMED_WORKER_REAP_ATTEMPTS}; past that the periodic liveness sweep
   * ({@link checkTurnLiveness} → {@link reconcileRunningTurnMarker}) remains the
   * standing reconciler, and {@link releaseUnconfirmedTermination} is the operator's
   * override for the one case neither can settle — a worker that is alive but whose
   * control plane never answers. So a session is never left with no path back at all.
   */
  private reapUnconfirmedWorker(sessionId: string, handle: SessionTurnHandle): void {
    this.markTerminationUnconfirmed(sessionId);
    if (this.unconfirmedWorkerReapers.has(sessionId)) return;
    this.unconfirmedWorkerReapers.add(sessionId);
    void (async (): Promise<void> => {
      try {
        // Retrying is only meaningful when there is something to retry. A runner-backed
        // turn whose client omits the optional `forceCancel` has no kill channel at all,
        // so every attempt would return `unconfirmed` for the same structural reason —
        // spend the budget on the seams that can actually answer, and tell the operator
        // now instead of twenty seconds of no-ops later. The run loop settling on its own
        // still frees the session; that path does not go through here.
        const attempts = handle.hasForceChannel ? UNCONFIRMED_WORKER_REAP_ATTEMPTS : 0;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (handle.settled || this.turns.get(sessionId) !== handle) return;
          await this.backoff(RUNNER_CANCEL_GRACE_MS);
          if (handle.settled || this.turns.get(sessionId) !== handle) return;
          if ((await this.boundedForceCancel(sessionId, handle)) === 'unconfirmed') continue;
          if (handle.settled || this.turns.get(sessionId) !== handle) return;
          this.closeSession(sessionId);
          await this.forceSettleWedgedTurn(sessionId, handle);
          return;
        }
        // Retries exhausted (or never possible) with the session still fenced. Say so
        // rather than going quiet on a state the operator can otherwise only read as
        // "busy forever": from here the periodic liveness sweep is what frees it.
        if (this.unconfirmedTermination.has(sessionId)) {
          this.announceTerminationUnconfirmed(sessionId);
          await this.emitEvent(sessionId, {
            t: 'notice',
            role: 'agent',
            text:
              'Still could not confirm that the previous agent process exited. This session ' +
              'stays reserved until the periodic liveness check can confirm it, or you ' +
              'release it by hand.',
          });
        }
      } catch (error) {
        this.reportTurnError(sessionId, error);
      } finally {
        this.unconfirmedWorkerReapers.delete(sessionId);
      }
    })();
  }

  /**
   * Background settle-verification after a cancel the runner acknowledged: give the
   * aborted run loop one grace window to release the session on its own (abort →
   * backend result → settle path → {@link releaseInFlight}); a loop that doesn't is
   * wedged behind a backend await the abort can't unstick — kill the child and
   * settle from here. This is what makes Stop a guarantee instead of a request:
   * within the grace the session accepts the next prompt again, no matter what the
   * backend does.
   */
  private async watchCancelledTurnSettles(
    sessionId: string,
    handle: SessionTurnHandle,
  ): Promise<void> {
    if (!this.inFlight.has(sessionId) || handle.settled || handle.forceSettled) return;
    try {
      // Released on its own within the grace — the normal path.
      if (await this.awaitFenceRelease(sessionId, STOP_SETTLE_GRACE_MS)) return;
      // Terminate the runner's worker through the supervisor control plane too —
      // closeSession below only covers the in-process backend, and a supervisor
      // worker left alive would keep doing external work (or overlap the successor
      // turn) after the fence releases.
      const termination = await this.boundedForceCancel(sessionId, handle);
      // Revalidate before touching session-keyed state: the loop may have settled
      // during the bounded force-cancel wait, and a queued successor may already be
      // live — closeSession is keyed by session id and would then terminate the
      // SUCCESSOR's backend, not the wedged turn's.
      if (handle.settled || this.turns.get(sessionId) !== handle) return;
      // Close the in-process child either way: it is the cheapest lever against the
      // overlap this path guards, it is harmless for a supervisor-backed turn, and it
      // does NOT free the fence — so it applies to the unconfirmed case too.
      this.closeSession(sessionId);
      // THE ownership rule, and the behaviour this fix exists to change: a kill that
      // could not be established does NOT free the fence. Releasing here is what let a
      // replacement backend start beside a worker that was still alive and editing the
      // worktree. Hand off to the background reaper instead — it keeps re-issuing the
      // kill and finalizes the turn the moment termination can be proven.
      if (termination === 'unconfirmed') {
        this.reapUnconfirmedWorker(sessionId, handle);
        return;
      }
      await this.forceSettleWedgedTurn(sessionId, handle);
    } catch (error) {
      this.reportTurnError(sessionId, error);
    }
  }

  /**
   * Settle a live turn whose run loop is wedged (its `finally` may never fire):
   * release the in-flight fence, append the terminal `interrupted` marker, clear the
   * durable running-turn marker, and drain the queue — the same steps the run
   * loop's `finally` would take, executed by the cancel path so a stuck backend
   * await can never leave the session unusable. Claims settle ownership FIRST
   * (atomically) so a run loop that unsticks later loses the claim and skips its
   * own terminal writes + release steps instead of double-writing or clobbering a
   * successor turn's fence, handle, or marker.
   */
  private async forceSettleWedgedTurn(sessionId: string, handle: SessionTurnHandle): Promise<void> {
    // Already settled, or the run loop owns the settle — nothing to free.
    if (handle.settled || !handle.claimSettle('force')) return;
    if (this.turns.get(sessionId) === handle) this.turns.delete(sessionId);
    this.clearPermissions(sessionId);
    try {
      // BOUNDED: the terminal write is ordered before the release below (SR-1), but a
      // hanging store append must not block the fence forever. This point is only
      // reached once the previous backend's termination is established, so what is at
      // stake past the bound is a stray `interrupted` marker in the transcript — not
      // two backends owning the worktree, which the barrier above already prevents.
      const timedOut = Symbol('interrupted-write-timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        this.emitInterrupted(sessionId),
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), RUNNER_CANCEL_GRACE_MS);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome === timedOut) {
        // The write may still land LATE if the store recovers after the bound — a
        // stray `interrupted` marker can then appear after a successor's prompt.
        // Accepted bounded artifact of the store-outage corner: it cannot corrupt
        // live state (fence, handle, and scoped marker are all settled here) and
        // the activity badge stays driven by isBusy.
        this.reportTurnError(
          sessionId,
          new Error('terminal interrupted write timed out — releasing the session anyway'),
        );
      }
    } catch (error) {
      this.reportTurnError(sessionId, error);
    } finally {
      // Fence release FIRST (synchronous — the very thing Stop guarantees), then
      // the marker clear fire-and-forget, mirroring the launch run loop's
      // `finally`: the terminal event was already awaited above so
      // terminal-before-clear (SR-1) holds, and a slow or failing store delete can
      // never keep the session fenced. `clearRunningTurn` catches + reports its
      // own store errors.
      this.releaseInFlight(sessionId);
      // Scoped to the wedged turn's own prompt_seq: even a delayed delete can then
      // never erase a successor turn's marker (crash-recovery anchor). An
      // undefined markerSeq means the wedge happened before this turn ever wrote
      // its marker — there is nothing of its own to clear, and an unscoped delete
      // could only ever hit a successor's row, so skip entirely.
      if (handle.markerSeq !== undefined) void this.clearRunningTurn(sessionId, handle.markerSeq);
      const hadQueued = (this.queues.get(sessionId)?.length ?? 0) > 0;
      this.drainNext(sessionId);
      this.maybeAutoTitle(sessionId);
      if (!hadQueued) this.flushDeferredWhenIdle(sessionId);
    }
  }

  private async hasRunningTurnMarker(sessionId: string): Promise<boolean> {
    try {
      return (await this.deps.store.listRunningTurns()).some(
        (marker) => marker.sessionId === sessionId,
      );
    } catch (error) {
      this.reportTurnError(sessionId, error);
      return false;
    }
  }

  /**
   * Last-resort stop for a session that is marked busy but has no live turn handle
   * in this process. This happens after bounded runner discovery returns
   * `uncertain`: the conductor must fence the session to avoid duplicate work, but
   * there is no control socket yet that {@link cancelTurn} can delegate to. A user
   * pressing Stop must still make Verity usable again, so we close any local backend
   * handle, persist an `interrupted` marker best-effort, clear durable running state,
   * release the in-memory fence, and drain any queued turn.
   */
  private async forceSettleUncancellableTurn(sessionId: string): Promise<void> {
    let marker: RunningTurnRecord | undefined;
    try {
      marker = (await this.deps.store.listRunningTurns()).find(
        (marker) => marker.sessionId === sessionId,
      );
    } catch (error) {
      this.reportTurnError(sessionId, error);
    }

    if (marker !== undefined && marker.turnId !== null) {
      const outcome = await this.discoverAbandonedRunner(marker);
      if (outcome.status === 'live') {
        await this.reattachRecoveredTurn(marker, outcome.target);
        const turn = this.turns.get(sessionId);
        if (turn !== undefined && (await this.cancelLiveTurn(sessionId, turn))) return;
      }
    }

    this.closeSession(sessionId);
    this.turns.delete(sessionId);
    this.clearPermissions(sessionId);
    this.leaveUncertainRecovery(sessionId);
    this.clearUncertainRecoveryTimer(sessionId);

    try {
      await this.emitInterrupted(sessionId);
    } catch (error) {
      this.reportTurnError(sessionId, error);
    } finally {
      await this.clearRunningTurn(sessionId, marker?.promptSeq);
      this.releaseInFlight(sessionId);
      const hadQueued = (this.queues.get(sessionId)?.length ?? 0) > 0;
      this.drainNext(sessionId);
      this.maybeAutoTitle(sessionId);
      if (!hadQueued) this.flushDeferredWhenIdle(sessionId);
    }
  }

  /** The tool_use_ids of permission prompts currently awaiting the operator's
   * answer for `sessionId` (#27) — lets the server reflect what's pending (e.g.
   * re-arm the approve/deny UI on reconnect). Empty when none are parked. */
  pendingPermissions(sessionId: string): string[] {
    return [...(this.pendingPermissionRequests.get(sessionId)?.keys() ?? [])];
  }

  /** Close any idle backend process/thread handle for a session before destructive
   * lifecycle operations such as delete or model switch. */
  closeSession(sessionId: string): void {
    this.backend.closeSession?.(sessionId);
    this.openCodeBackend?.closeSession?.(sessionId);
    this.codexBackend?.closeSession?.(sessionId);
  }

  /**
   * Answer a parked permission prompt (#27): the operator allows (optionally with
   * edited input) or denies the tool `toolUseId` proposed in `sessionId`'s
   * in-flight turn. Writes the decision over the held-open stdin, unblocking the
   * paused turn. Returns `true` when a matching pending prompt was resolved,
   * `false` when none is parked under that id — the turn already ended (the runner
   * fail-safe-denied it), the operator already answered, or the id is unknown — so
   * the caller reports 404 and the UI drops the stale prompt. Idempotent: a second
   * answer for the same id is a harmless no-op.
   */
  async decidePermission(
    sessionId: string,
    toolUseId: string,
    decision: PermissionDecision,
    options?: {
      scope?: 'once' | 'session' | 'project' | 'forever';
      onScopeSaved?: (saved: boolean) => void;
      /** How the answer was reached. Only the standing-grant path sets `grant`; the
       *  decide route omits it, because everything arriving there is a card the
       *  operator answered. Recorded by an out-of-band caller's audit trail
       *  (ADR 0014 D3), which must not claim an operator saw a card that never
       *  reached them. */
      decidedBy?: PermissionDecisionSource;
    },
  ): Promise<boolean> {
    const pending = this.pendingPermissionRequests.get(sessionId);
    const turn = this.turns.get(sessionId);
    const claim = `${sessionId}\0${toolUseId}`;
    // A gateway prompt is answered by resolving its caller's promise, not by writing
    // over a turn's stdin, so it is decidable with no turn in flight — which is the
    // normal case for it (ADR 0014 D2).
    const external = this.externalPermissions.get(claim);
    // Only a still-parked id resolves — a settled turn (fail-safe-denied), an
    // already-answered id, or an unknown session/id all report `false` so the caller
    // 404s and the UI drops the stale prompt.
    if (!pending || !pending.has(toolUseId) || (turn === undefined && external === undefined)) {
      return false;
    }
    if (this.permissionDecisionClaims.has(claim)) {
      throw new PermissionDecisionInProgressError(sessionId, toolUseId);
    }
    this.permissionDecisionClaims.add(claim);
    try {
      const request = pending.get(toolUseId);
      if (external !== undefined) {
        // Handing the decision to a waiting caller cannot half-succeed the way a stdin
        // write can, so there is no ambiguous case to leave parked: unpark and hand over
        // in one synchronous step. That also makes a duplicate answer fall through the
        // `false` gate above instead of settling the caller twice.
        this.dropExternalPermission(sessionId, toolUseId);
        external.settle({ decision, decidedBy: options?.decidedBy ?? 'card' });
      } else {
        // Remove the pending decision only after the Runner acknowledges it. An
        // unreachable/ambiguous control channel leaves the prompt pending so a caller
        // can retry the same decision instead of silently losing it.
        if (turn === undefined || !(await turn.answerPermission(toolUseId, decision))) {
          return false;
        }
        // The runner consumed the decision. Remove the prompt before any fallible
        // persistence work so a failed scoped write can never leave an actionable
        // prompt whose retry would attempt to answer an already-executed tool.
        if (this.pendingPermissionRequests.get(sessionId) !== pending || !pending.has(toolUseId)) {
          return false;
        }
        pending.delete(toolUseId);
        if (pending.size === 0) this.pendingPermissionRequests.delete(sessionId);
      }
      // Persist only after the runner acknowledged the allow, so a failed delivery
      // cannot leave behind a grant that silently approves a later request. Await
      // the write so the API never reports the requested scope as saved early.
      if (
        decision.behavior === 'allow' &&
        options?.scope !== undefined &&
        options.scope !== 'once' &&
        request !== undefined &&
        brokeredGrantToolName(request.toolName) !== undefined
      ) {
        if (decision.updatedInput !== undefined) {
          options.onScopeSaved?.(false);
          return true;
        }
        try {
          await this.persistBrokeredGrant(sessionId, request, options.scope, external?.channel);
          options.onScopeSaved?.(true);
        } catch {
          // The runner has already consumed the allow and may have executed a
          // non-idempotent request. Report the unsaved scope separately instead
          // of turning the decision into a retryable request failure.
          options.onScopeSaved?.(false);
        }
      }
      return true;
    } finally {
      this.permissionDecisionClaims.delete(claim);
    }
  }

  /** Track a surfaced permission prompt under its session + tool_use_id so
   * {@link pendingPermissions} lists it and {@link decidePermission} can resolve it.
   * Keyed by tool_use_id (the stable id the app already shows on the `tool_call`),
   * not the protocol request_id. The RunnerTurn holds the actual respond channel. */
  private trackPendingPermission(sessionId: string, request: PermissionRequest): void {
    const pending =
      this.pendingPermissionRequests.get(sessionId) ?? new Map<string, PermissionRequest>();
    pending.set(request.toolUseId, request);
    this.pendingPermissionRequests.set(sessionId, pending);
    this.maybeAutoApprove(sessionId, request);
  }

  /** ADR 0011 D2: a matching persisted grant (session, project or forever scope) answers
   * the brokered-secret prompt without operator interaction. Fail-open to the card: any
   * error just leaves the prompt pending for a manual decision. */
  private maybeAutoApprove(
    sessionId: string,
    request: PermissionRequest,
    /** Channel stated by the caller, for a prompt that no turn carries. */
    statedChannel?: BrokeredGrantChannel,
  ): void {
    const toolName = brokeredGrantToolName(request.toolName);
    if (toolName === undefined) return;
    const check = this.deps.checkBrokeredHttpGrant;
    if (check === undefined) return;
    const target = brokeredGrantTarget(toolName, request.input);
    if (target === undefined) return;
    // Which transport this prompt arrived on decides which grants may answer it
    // (ADR 0014 D3). A prompt with no live turn to read it from is left to the card:
    // guessing a channel here could hand a prompt grants it is not entitled to use.
    const channel = statedChannel ?? this.turns.get(sessionId)?.grantChannel;
    if (channel === undefined) return;
    void (async () => {
      try {
        const session = await this.deps.store.getSession(sessionId);
        const projectId = session?.projectId;
        if (projectId == null) return;
        const covered = await Promise.all(
          target.secretAliases.map((secretAlias) =>
            check({
              projectId,
              sessionId,
              channel,
              secretAlias,
              toolName: target.toolName,
              target: target.target,
            }),
          ),
        );
        if (!covered.every(Boolean)) return;
        await this.decidePermission(
          sessionId,
          request.toolUseId,
          { behavior: 'allow' },
          { decidedBy: 'grant' },
        );
      } catch {
        // Card stays pending; the operator decides manually.
      }
    })();
  }

  private async persistBrokeredGrant(
    sessionId: string,
    request: PermissionRequest,
    scope: 'session' | 'project' | 'forever',
    /** Channel stated by the caller, for a prompt that no turn carries. */
    statedChannel?: BrokeredGrantChannel,
  ): Promise<void> {
    const persist = this.deps.persistBrokeredHttpGrant;
    if (persist === undefined) throw new Error('brokered secret grant persistence is unavailable');
    const toolName = brokeredGrantToolName(request.toolName);
    if (toolName === undefined) throw new Error('tool does not support brokered secret grants');
    const target = brokeredGrantTarget(toolName, request.input);
    if (target === undefined) throw new Error('invalid brokered secret grant target');
    // The channel the operator answered on is recorded with the grant (ADR 0014 D3), so
    // it must come from the live turn — or, for a prompt no turn carries, from the caller
    // that raised it — rather than be assumed. Without one the allow still stands for this
    // call; only the standing scope is refused, which the caller reports back as an unsaved
    // scope.
    const channel = statedChannel ?? this.turns.get(sessionId)?.grantChannel;
    if (channel === undefined) throw new Error('brokered secret turn has no resolved channel');
    const session = await this.deps.store.getSession(sessionId);
    const projectId = session?.projectId;
    if (projectId == null) throw new Error('brokered secret session has no project');
    for (const secretAlias of target.secretAliases) {
      await persist({
        projectId,
        sessionId,
        scope,
        channel,
        secretAlias,
        toolName: target.toolName,
        target: target.target,
      });
    }
  }

  /** Drop all parked permission prompts for a settled turn (#27). Anything the
   * operator left unanswered is already dead by the time this runs, so this just
   * clears the now-stale tracker entries. Called on every turn-settle path alongside
   * the handle cleanup.
   *
   * ACP makes this structural: a prompt is a `session/request_permission` JSON-RPC
   * REQUEST, and a
   * settled turn has torn its connection and process down, so an unanswered one can
   * only ever end unanswered. It cannot become an allow, and it cannot hold the turn
   * open. The invariant is the same; it is now structural rather than hand-written.
   *
   * Prompts raised out of band by the gateway survive it: no turn was answering them,
   * so a turn settling says nothing about whether they are still live, and their own
   * caller holds the deadline that ends them (ADR 0014 D2). */
  private clearPermissions(sessionId: string): void {
    const pending = this.pendingPermissionRequests.get(sessionId);
    if (pending === undefined) return;
    for (const toolUseId of [...pending.keys()]) {
      if (this.externalPermissions.has(`${sessionId}\0${toolUseId}`)) continue;
      pending.delete(toolUseId);
    }
    if (pending.size === 0) this.pendingPermissionRequests.delete(sessionId);
  }

  /**
   * Raise a permission prompt that no turn is holding open, and resolve with the answer
   * (ADR 0014 D2). The loopback MCP gateway calls this: its request arrives over HTTP, so
   * there is no `can_use_tool` control request to write the decision back to, and no turn
   * whose settle would fail-safe-deny an unanswered prompt — the caller owns that deadline
   * and passes `signal`, whose abort denies.
   *
   * The prompt is written and parked exactly like a turn-bound one, so the card, the decide
   * route, {@link pendingPermissions} and the standing-grant auto-approval treat it
   * identically. Only the grant channel differs: the caller states it, because a gateway
   * call routinely arrives with no live turn to read it off.
   *
   * Rejects if the prompt cannot be written — a card the operator never sees must not leave
   * the caller waiting on an answer that cannot come.
   */
  async requestExternalPermission(params: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    channel: BrokeredGrantChannel;
    /** Explicitly false for tools, such as trusted CLI, that require a fresh decision. */
    allowStandingGrant?: boolean | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<ExternalPermissionAnswer> {
    const { sessionId, toolUseId, channel, signal } = params;
    if (this.pendingPermissionRequests.get(sessionId)?.has(toolUseId) === true) {
      throw new Error(`permission ${toolUseId} is already pending`);
    }
    const request: PermissionRequest = {
      // Nothing carries this prompt back to a protocol envelope, so there is no separate
      // request id: the tool_use_id is the only identity it has, and the only one the
      // card and the decide route use.
      requestId: toolUseId,
      toolUseId,
      toolName: params.toolName,
      input: params.input,
    };
    let settle!: (answer: ExternalPermissionAnswer) => void;
    const answered = new Promise<ExternalPermissionAnswer>((resolve) => {
      settle = resolve;
    });
    // Park before the event is written: an auto-approval or a decide arriving on the
    // event's heels must find the prompt already resolvable.
    const pending =
      this.pendingPermissionRequests.get(sessionId) ?? new Map<string, PermissionRequest>();
    pending.set(toolUseId, request);
    this.pendingPermissionRequests.set(sessionId, pending);
    this.externalPermissions.set(`${sessionId}\0${toolUseId}`, { settle, channel });
    const onAbort = (): void => {
      this.settleExternalPermission(sessionId, toolUseId, {
        decision: { behavior: 'deny', message: EXTERNAL_PERMISSION_ABORT_MESSAGE },
        decidedBy: 'card',
      });
    };
    const event: AgentEvent = {
      t: 'permission',
      id: toolUseId,
      tool: request.toolName,
      input: request.input,
      riskClass: 'ask',
      grantChannel: channel,
    };
    try {
      const persisted = await this.deps.store.appendEvent(sessionId, event);
      this.deps.bus?.publish(sessionId, { seq: persisted.seq, ts: persisted.ts, event });
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      if (params.allowStandingGrant !== false) this.maybeAutoApprove(sessionId, request, channel);
      return await answered;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.dropExternalPermission(sessionId, toolUseId);
    }
  }

  /** Hand a decision to a waiting out-of-band caller, once. A prompt already answered
   *  (or already abandoned) has no resolver left and is silently ignored, so an abort
   *  racing a decide cannot overwrite the operator's answer. */
  private settleExternalPermission(
    sessionId: string,
    toolUseId: string,
    answer: ExternalPermissionAnswer,
  ): void {
    const external = this.externalPermissions.get(`${sessionId}\0${toolUseId}`);
    if (external === undefined) return;
    this.dropExternalPermission(sessionId, toolUseId);
    external.settle(answer);
  }

  /** Forget an out-of-band prompt without answering it: drop the resolver and unpark the
   *  card, so nothing keeps offering a decision no one is waiting for. Idempotent. */
  private dropExternalPermission(sessionId: string, toolUseId: string): void {
    this.externalPermissions.delete(`${sessionId}\0${toolUseId}`);
    const pending = this.pendingPermissionRequests.get(sessionId);
    if (pending === undefined) return;
    pending.delete(toolUseId);
    if (pending.size === 0) this.pendingPermissionRequests.delete(sessionId);
  }

  /**
   * Send one steering turn (`prompt`) to an existing session, driving the
   * resumed `claude` process to completion and persisting its events. Resolves
   * with the {@link RunResult}. Throws {@link UnknownSessionError} if the session
   * isn't in the store, or {@link SessionBusyError} if a turn is already running
   * for it. Use this for in-process callers (tests, CLI) that want to await the
   * full turn; HTTP callers want {@link dispatchTurn} instead.
   */
  async sendTurn(sessionId: string, prompt: string, opts: TurnOptions = {}): Promise<RunResult> {
    const session = await this.accept(sessionId, prompt, opts); // lock held on success
    // Register the in-flight handle synchronously (before the async run) so a cancel
    // racing the spawn lands (#79).
    const sendHandle = new SessionTurnHandle();
    this.turns.set(sessionId, sendHandle);
    // The marker's prompt_seq anchor, captured for the `finally`'s scoped clear.
    let markerSeq: number | undefined;
    try {
      await this.emitPrompt(sessionId, prompt, await this.storeAttachments(opts.attachments));
      this.maybeAutoTitle(sessionId); // name from the prompt now, concurrently with the turn
      const sinceSeq = await this.deps.store.latestEventSeq(sessionId);
      markerSeq = sinceSeq;
      sendHandle.markerSeq = sinceSeq; // scope for a potential force-settle marker clear
      // Durably mark the turn in flight BEFORE the backend runs (lifecycle Phase 1):
      // if we crash mid-turn, recovery finds this marker + a non-terminal tail and
      // SETTLES the turn (interrupted) instead of re-inferring un-run work. `sinceSeq`
      // is the prompt event's seq — the recovery anchor for the terminal-tail check.
      await this.markTurnRunning(sessionId, sinceSeq);
      const result = await this.runBackendTurnWithResumeRecovery(sessionId, prompt, session, opts);
      // `result.aborted` (set by the runner at kill time) — NOT the live
      // `signal.aborted`, which a cancel racing a natural finish could flip.
      if (result.aborted) await this.emitInterrupted(sessionId);
      else {
        await this.repairVisibleMediaOutput(sessionId, prompt, sinceSeq);
        await this.ensureTerminalMarker(sessionId, sinceSeq, result);
      }
      return result;
    } finally {
      this.turns.delete(sessionId);
      this.clearPermissions(sessionId);
      this.releaseInFlight(sessionId);
      // Clear THIS turn's marker, scoped by its prompt_seq so a concurrent turn's
      // markTurnRunning can't be wiped by this late DELETE. The settling terminal event
      // was already awaited above, so the ordering holds without holding the lock.
      await this.clearRunningTurn(sessionId, markerSeq);
      this.maybeAutoTitle(sessionId);
    }
  }

  /**
   * Accept a steering turn and start it in the BACKGROUND, resolving as soon as
   * it is accepted (validated, lock claimed, process started) — not when it
   * finishes. Lets an HTTP caller answer `202 Accepted` immediately and watch
   * progress over the live WS stream (concept §5b). Rejects with the same
   * {@link SessionBusyError}/{@link UnknownSessionError} as {@link sendTurn} when
   * acceptance fails; a failure AFTER acceptance surfaces via
   * {@link ConductorDeps.onTurnError} (the caller already has its 202).
   */
  async dispatchTurn(
    sessionId: string,
    prompt: string,
    opts: TurnOptions = {},
    dispatchOpts: DispatchTurnOptions = {},
  ): Promise<{ queued: boolean }> {
    const { clientReplyId } = dispatchOpts;
    if (clientReplyId === undefined) {
      return this.dispatchTurnInner(sessionId, prompt, opts, dispatchOpts);
    }
    return this.dispatchIdempotent(sessionId, clientReplyId, () =>
      this.dispatchTurnInner(sessionId, prompt, opts, dispatchOpts),
    );
  }

  /** Memoize a `clientReplyId`-keyed dispatch so a replayed quick reply returns the
   * original result without launching a second turn (ADR 0008). See
   * {@link seenReplies}. */
  private dispatchIdempotent(
    sessionId: string,
    clientReplyId: string,
    run: () => Promise<{ queued: boolean }>,
  ): Promise<{ queued: boolean }> {
    let replies = this.seenReplies.get(sessionId);
    if (replies === undefined) {
      replies = new Map();
      this.seenReplies.set(sessionId, replies);
    }
    const existing = replies.get(clientReplyId);
    if (existing !== undefined) return existing;

    const pending = run();
    replies.set(clientReplyId, pending);
    // A rejected dispatch (queue full, transient error) never started a durable
    // turn, so forget it and let a real retry through; a resolved one stays memoized
    // so a background-suspended client's re-flush is a no-op returning the prior
    // `{ queued }`.
    void pending.catch(() => {
      if (replies.get(clientReplyId) === pending) replies.delete(clientReplyId);
    });
    // Map iteration is insertion-ordered, so the first key is the oldest.
    while (replies.size > MAX_SEEN_REPLIES_PER_SESSION) {
      const oldest = replies.keys().next().value;
      if (oldest === undefined) break;
      replies.delete(oldest);
    }
    return pending;
  }

  private async dispatchTurnInner(
    sessionId: string,
    prompt: string,
    opts: TurnOptions = {},
    dispatchOpts: DispatchTurnOptions = {},
  ): Promise<{ queued: boolean }> {
    const displayPrompt = dispatchOpts.displayPrompt ?? prompt;
    if (this.stopping.has(sessionId)) throw new SessionBusyError(sessionId);
    // Busy → first try to STEER the running turn (#101 Stage B): if it exposes a
    // live stdin channel, fold the message into it so claude injects it at its next
    // step boundary — same turn, no wait for the process to exit. Only if there's no
    // live channel (turn not steerable, or it ended in the race between the busy
    // check and the write) do we fall back to enqueueing behind it (#90 Stage A),
    // which runs the message as a fresh `--resume` turn the moment claude is free.
    // Validate the prompt here too so we never steer/queue a blank turn.
    if (this.inFlight.has(sessionId)) {
      if (opts.requireStandalone === true) throw new SessionBusyError(sessionId);
      if (!turnHasContent(prompt, opts))
        throw new Error('turn must have a prompt or an attachment');
      // A `file`-kind attachment can't be steered inline (it's delivered by
      // materializing to disk + a prompt pointer, which only happens on a fresh turn
      // dispatch). So a message carrying one skips steering and enqueues instead —
      // it runs as a `--resume` turn that materializes the file correctly. Images
      // still steer into the running turn as before.
      const hasFileAttachment = opts.attachments?.some((a) => a.kind === 'file') ?? false;
      const turn = hasFileAttachment ? undefined : this.turns.get(sessionId);
      if (
        turn &&
        (await turn.steer({
          text: prompt,
          ...(opts.attachments ? { attachments: opts.attachments } : {}),
        }))
      ) {
        // Delivered into the live turn. Persist the operator's prompt event so it
        // shows in the transcript (claude's stream doesn't echo it). Fire-and-forget
        // so it doesn't block the 202: claude can't answer the injected message
        // before a model round-trip, which in practice dwarfs this local append, so
        // the prompt event almost always lands ahead of the agent's reply to it.
        // The seq counter orders by append time, not logical time, so under extreme
        // store contention the prompt could theoretically land just after the reply
        // — a transcript blemish, never a lost turn (the message is already in claude).
        void this.persistSteeredPrompt(sessionId, displayPrompt, opts);
        return { queued: false };
      }
      if (this.stopping.has(sessionId)) throw new SessionBusyError(sessionId);
      if ((this.queues.get(sessionId)?.length ?? 0) >= this.maxQueue)
        throw new QueueFullError(sessionId, this.maxQueue);
      // Durably mirror the queued turn in the store BEFORE making it drainable, so a
      // turn that settles mid-persist can neither (a) drain a not-yet-persisted item
      // nor (b) leave an orphan row for an already-dispatched one. Attachments are
      // stored content-addressed; the row carries refs (rehydrated by {@link recover}).
      // `id` is the store row key AND the operator's retract handle ({@link dequeue}).
      const id = randomUUID();
      const enqueue = (async (): Promise<void> => {
        const storedOpts = await this.toStorableOpts(
          opts,
          displayPrompt === prompt ? undefined : displayPrompt,
        );
        await this.deps.store.enqueueTurn({
          id,
          sessionId,
          prompt,
          opts: storedOpts,
        });
        // Re-fetch the live queue AFTER the await (a concurrent enqueue may have
        // created it meanwhile) and append — the in-memory queue stays authoritative
        // for the live drain.
        const queue = this.queues.get(sessionId) ?? [];
        queue.push({
          id,
          prompt,
          opts,
          ...(displayPrompt !== prompt ? { displayPrompt } : {}),
          ...(storedOpts.attachments !== undefined
            ? { displayAttachments: storedOpts.attachments }
            : {}),
        });
        this.queues.set(sessionId, queue);
      })();
      const pending = this.pendingEnqueues.get(sessionId) ?? new Set<Promise<void>>();
      pending.add(enqueue);
      this.pendingEnqueues.set(sessionId, pending);
      try {
        await enqueue;
      } finally {
        pending.delete(enqueue);
        if (pending.size === 0) this.pendingEnqueues.delete(sessionId);
      }
      // If the in-flight turn settled DURING the persist await, its drain already ran
      // and found the queue empty (we hadn't pushed yet) — kick one now so the item
      // isn't stranded until the next turn. If it's still in flight, its settle drains.
      if (!this.inFlight.has(sessionId)) this.drainNext(sessionId);
      return { queued: true };
    }
    const session = await this.accept(sessionId, prompt, opts); // lock held on success
    this.launchAcceptedTurn(sessionId, prompt, session, opts, displayPrompt, {
      persistPrompt: true,
    });
    return { queued: false };
  }

  /**
   * Start a turn only if the session is idle at the moment the conductor claims
   * its lock. Unlike {@link dispatchTurn}, this never steers into nor queues behind
   * an in-flight turn. Server-authored automation uses it when a prompt must be a
   * standalone turn and must not be injected into the operator's active turn.
   */
  async dispatchTurnWhenIdle(
    sessionId: string,
    prompt: string,
    opts: TurnOptions = {},
    dispatchOpts: DispatchTurnOptions = {},
  ): Promise<{ accepted: boolean }> {
    let session: SessionRecord;
    try {
      session = await this.accept(sessionId, prompt, opts); // lock held on success
    } catch (error) {
      if (error instanceof SessionBusyError) return { accepted: false };
      throw error;
    }
    this.launchAcceptedTurn(
      sessionId,
      prompt,
      session,
      opts,
      dispatchOpts.displayPrompt ?? prompt,
      {
        persistPrompt: true,
      },
    );
    return { accepted: true };
  }

  private launchAcceptedTurn(
    sessionId: string,
    prompt: string,
    session: SessionRecord,
    opts: TurnOptions,
    displayPrompt: string,
    launchOpts: { persistPrompt: boolean; autoResumeCount?: number },
  ): void {
    // Register the in-flight handle synchronously so the operator can cancel/steer
    // from now, even before the async run spawns (#79/#101). Held so an auto-resume
    // can tell a cancel that lands while it waits from a turn that simply died.
    const handle = new SessionTurnHandle();
    this.turns.set(sessionId, handle);
    // Fire-and-forget: persist the operator's prompt event FIRST (so it precedes
    // claude's output in the transcript), then run; release the lock when the run
    // settles, drain the next queued turn (if any), route a background failure to
    // the logging seam.
    // The marker's prompt_seq anchor, captured for the `finally`'s scoped clear so it
    // removes only THIS turn's marker (never a newer turn's that replaced the row).
    let markerSeq: number | undefined;
    void (async () => {
      if (launchOpts.persistPrompt) {
        await this.emitPrompt(
          sessionId,
          displayPrompt,
          await this.storeAttachments(opts.attachments),
        );
        this.maybeAutoTitle(sessionId); // name from the prompt now, concurrently with the turn
      }
      const sinceSeq = await this.deps.store.latestEventSeq(sessionId);
      markerSeq = sinceSeq;
      handle.markerSeq = sinceSeq; // scope for a potential force-settle marker clear
      // Durable in-flight marker (lifecycle Phase 1) — see {@link sendTurn}. Written
      // before the backend runs so a mid-turn crash is settled by recovery, not
      // re-inferred from the tail; cleared in the `finally` below.
      await this.markTurnRunning(sessionId, sinceSeq);
      const result = await this.runBackendTurnWithResumeRecovery(sessionId, prompt, session, opts);
      // Operator-cancelled (#79): append the terminal `interrupted` marker (best
      // effort — don't let a failed marker insert block the lock release in the
      // `finally`). Partial output the agent already streamed is preserved. Keyed
      // off `result.aborted` (runner-reported at kill time), not `signal.aborted`.
      // Otherwise a non-zero exit that wrote no terminal marker (a silent backend
      // crash) is settled by ensureTerminalMarker so the session can't hang.
      // AWAIT the settling terminal event so it is durable BEFORE the `finally` clears
      // the marker — matching sendTurn. The `.catch` keeps it best-effort (a failed
      // marker insert must not block the lock release), it just enforces the order:
      // terminal event first, marker clear second. Otherwise a crash could drop the
      // marker before its terminal event lands, and recovery would re-run the tail (SR-1).
      // Claim settle ownership SYNCHRONOUSLY before any terminal side effect. If
      // the stop watchdog force-settled this turn while the loop was wedged (it
      // then owns the claim), skip every terminal write — a duplicate
      // `interrupted` or a re-queue here would land beside a successor turn's
      // transcript. The claim is atomic, so the watchdog can never interleave
      // with the writes below.
      if (!handle.claimSettle('run')) {
        // force-settled — nothing left to write
      } else if (result.aborted) {
        await this.emitInterrupted(sessionId).catch((error: unknown) => {
          this.reportTurnError(sessionId, error);
        });
      } else {
        await this.repairVisibleMediaOutput(sessionId, prompt, sinceSeq).catch((error: unknown) => {
          this.reportTurnError(sessionId, error);
        });
        // Re-queue a turn that died on its own BEFORE the `finally` snapshots the
        // queue, so its existing drain dispatches the replay. Best-effort: a failed
        // replay must never block the lock release below.
        const autoResumed = await this.maybeAutoResume(
          sessionId,
          prompt,
          opts,
          displayPrompt,
          launchOpts.autoResumeCount ?? 0,
          sinceSeq,
          result,
          handle,
        ).catch((error: unknown): false => {
          this.reportTurnError(sessionId, error);
          return false;
        });
        // A scheduled replay keeps the logical turn open: do not append a failure
        // boundary that would appear beside the eventual successful answer.
        if (autoResumed === 'cancelled') {
          await this.emitInterrupted(sessionId).catch((error: unknown) => {
            this.reportTurnError(sessionId, error);
          });
        } else if (autoResumed === false) {
          await this.ensureTerminalMarker(sessionId, sinceSeq, result).catch((error: unknown) => {
            this.reportTurnError(sessionId, error);
          });
        }
      }
    })()
      .finally(() => {
        // Idempotent re-claim: true when this run loop owns the settle (the body
        // claimed it, or the body threw before claiming and this `finally` claims
        // now so the session still releases). False when the stop watchdog
        // force-settled the wedged loop: every release step below already ran
        // there, and a successor turn may be live — re-running them here would
        // delete ITS handle, release ITS fence, and clear ITS marker.
        if (!handle.claimSettle('run')) return;
        const nextQueued = this.queues.get(sessionId)?.[0];
        const retainsCancelHandle =
          nextQueued?.autoResumeSignal === handle.controller.signal &&
          !handle.controller.signal.aborted;
        // Keep the settled turn's controller reachable while an auto-resume moves
        // through drainNext's async session lookup. launchAcceptedTurn replaces it
        // synchronously; a cancel in the gap aborts the queued replay instead.
        if (!retainsCancelHandle) this.turns.delete(sessionId);
        this.clearPermissions(sessionId);
        this.releaseInFlight(sessionId);
        // Only AFTER the fence is actually released — `settled` is the watchdog's
        // stand-down signal, and setting it any earlier would let the watchdog
        // stand down while the session is still fenced.
        handle.settled = true;
        // Clear THIS turn's marker, scoped to its prompt_seq so a late DELETE can't wipe
        // the next turn's marker (the drainNext below, or a concurrent dispatch, may
        // already have written one). Fire-and-forget: the settling terminal event was
        // awaited above, so the marker+terminal ordering holds without blocking the lock
        // release — releasing inFlight synchronously keeps `isBusy` accurate on settle.
        void this.clearRunningTurn(sessionId, markerSeq);
        // Snapshot the queue BEFORE draining: drainNext is async and won't have re-set
        // `inFlight` yet, so a deferred-action flush must gate on this, not `inFlight`.
        const hadQueued = (this.queues.get(sessionId)?.length ?? 0) > 0;
        this.drainNext(sessionId);
        this.maybeAutoTitle(sessionId);
        if (!hadQueued) this.flushDeferredWhenIdle(sessionId);
      })
      .catch((error: unknown) => {
        void this.reportBackgroundTurnFailure(sessionId, error);
      });
  }

  /** Number of turns currently queued behind the in-flight one for a session. */
  queuedCount(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  /** The turns currently queued behind the in-flight one (FIFO), each with its
   * stable `id` and prompt `text`, so the server can surface them to the UI as
   * persistent "waiting" messages the operator can tap to retract ({@link dequeue}). */
  queuedItems(sessionId: string): { id: string; text: string; attachments?: Attachment[] }[] {
    return (this.queues.get(sessionId) ?? [])
      .filter((q): q is QueuedConductorTurn & { id: string } => q.id !== undefined)
      .map((q) => ({
        id: q.id,
        text: q.displayPrompt ?? q.prompt,
        ...(q.displayAttachments !== undefined ? { attachments: q.displayAttachments } : {}),
      }));
  }

  /**
   * Retract a queued turn before it runs (issue #80): drop it from the live queue
   * AND the durable store, and return its prompt so the caller can put it back in
   * the operator's input to edit/resend. Returns `undefined` if `id` isn't (or is no
   * longer) queued — e.g. the operator tapped a bubble that just drained — so the
   * caller reports 404 and the stale bubble simply disappears. Idempotent: a miss
   * still issues the durable delete in case the row outlived the in-memory entry.
   */
  async dequeue(
    sessionId: string,
    id: string,
  ): Promise<Omit<RestoredQueuedTurn, 'id'> | undefined> {
    const queue = this.queues.get(sessionId);
    const index = queue ? queue.findIndex((q) => q.id === id) : -1;
    if (!queue || index < 0) {
      // Already gone from the live queue (drained / retracted) — best-effort durable
      // cleanup, then report "not found" so the client just drops the stale bubble.
      await this.deps.store.deleteQueuedTurn(id);
      return undefined;
    }
    const [item] = queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(sessionId);
    await this.deps.store.deleteQueuedTurn(id);
    // `item` is always defined (index came from findIndex on this same array); the
    // guard is for the type-checker under noUncheckedIndexedAccess.
    if (!item) return undefined;
    return {
      prompt: item.displayPrompt ?? item.prompt,
      ...(item.opts.attachments !== undefined ? { attachments: [...item.opts.attachments] } : {}),
    };
  }

  /**
   * Drop the WHOLE pending backlog for a session — live queue + durable rows — and
   * return each dropped turn's `id` and `prompt`, in FIFO order. This is {@link
   * dequeue} for the entire queue at once, used by the Stop route (#79) so that
   * cancelling the in-flight turn also halts everything queued behind it. Without
   * this, the head of the backlog drains into a fresh turn the instant the
   * cancelled turn settles ({@link drainNext} in the run's `finally`), so "Stop"
   * appears to do nothing while the next queued message just keeps going. Returning
   * the prompts lets the caller put the text back in the operator's input to
   * edit/resend (like a retract), so a Stop never silently eats a typed message.
   * Idempotent: an empty/unknown queue returns `[]`. Every live turn is returned;
   * an id-less entry (e.g. a recovered tail prompt) receives a response-only id so
   * its text can still be restored. Only durable ids are deleted from the store.
   */
  async clearQueue(sessionId: string): Promise<RestoredQueuedTurn[]> {
    const pendingEnqueues = this.pendingEnqueues.get(sessionId);
    if (pendingEnqueues !== undefined) await Promise.all([...pendingEnqueues]);
    const queue = this.queues.get(sessionId);
    // Drop the live queue up front (sync) so a settle racing this cancel can't
    // drain a head that we're about to delete. The durable deletes then follow.
    this.queues.delete(sessionId);
    const dropped = queue ?? [];
    const durable = dropped.filter(
      (q): q is QueuedConductorTurn & { id: string } => q.id !== undefined,
    );
    try {
      await this.deps.store.deleteQueuedTurns(durable.map((q) => q.id));
    } catch (error) {
      // The durable delete is transactional. Restore the same live snapshot too,
      // so a failed Stop neither loses prompts now nor changes restart recovery.
      if (queue !== undefined && queue.length > 0) this.queues.set(sessionId, queue);
      throw error;
    }
    return dropped.map((q) => ({
      id: q.id ?? randomUUID(),
      prompt: q.displayPrompt ?? q.prompt,
      ...(q.opts.attachments !== undefined ? { attachments: [...q.opts.attachments] } : {}),
    }));
  }

  /**
   * Atomically stop a session from the caller's perspective: fence new sends,
   * remove every enqueue that started before the fence, and signal the active turn.
   * Cancellation is attempted even when durable queue cleanup fails.
   */
  async stopSession(
    sessionId: string,
  ): Promise<{ cancelled: boolean; droppedQueued: RestoredQueuedTurn[] }> {
    const existing = this.stopOperations.get(sessionId);
    if (existing !== undefined) return await existing;
    const operation = this.performStopSession(sessionId);
    this.stopOperations.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.stopOperations.get(sessionId) === operation) {
        this.stopOperations.delete(sessionId);
      }
    }
  }

  private async performStopSession(
    sessionId: string,
  ): Promise<{ cancelled: boolean; droppedQueued: RestoredQueuedTurn[] }> {
    this.stopping.set(sessionId, (this.stopping.get(sessionId) ?? 0) + 1);
    let droppedQueued: RestoredQueuedTurn[] = [];
    let clearError: unknown;
    try {
      try {
        droppedQueued = await this.clearQueue(sessionId);
      } catch (error) {
        clearError = error;
      }
      const cancelled = await this.cancelTurn(sessionId);
      if (clearError !== undefined)
        throw clearError instanceof Error ? clearError : new Error('queue cleanup failed');
      return { cancelled, droppedQueued };
    } finally {
      const remainingStops = (this.stopping.get(sessionId) ?? 1) - 1;
      if (remainingStops === 0) {
        this.stopping.delete(sessionId);
        // A failed transactional clear restored the live queue. If cancellation
        // settled while the fence was up, its normal drain was suppressed; wake
        // the backlog now so it cannot remain stranded behind an idle session.
        if (!this.inFlight.has(sessionId) && (this.queues.get(sessionId)?.length ?? 0) > 0) {
          this.drainNext(sessionId);
        }
      } else {
        this.stopping.set(sessionId, remainingStops);
      }
    }
  }

  /**
   * Rebuild the in-memory queues from the durable store on startup (issue #80), so
   * a backlog of turns sent while busy survives a server restart. Recovers each
   * session's turns in their enqueued (FIFO) order, rehydrating any attachment refs
   * back into uploads, then kicks one drain per session — the head turn dispatches
   * and each subsequent turn drains as the prior settles. It also recovers tail
   * prompt events that were persisted just before a server restart, where no queue
   * row exists yet. A no-op when neither source has work. Call once after the store
   * is migrated and before serving.
   */
  async recover(): Promise<void> {
    try {
      await this.recoverInner();
    } finally {
      // Arm the in-flight liveness sweep only once recovery has finished, but arm it
      // even if recovery THREW. Both halves matter. Recovery owns every open marker
      // while it runs — it has not yet fenced the ones it hasn't reached — so a sweep
      // overlapping it could probe and settle a marker recovery is about to reattach.
      // And the server latches queued-turn recovery run-once even when it throws, so
      // arming only on the success path would leave a process whose recovery failed
      // with no liveness coverage at all — exactly the circumstances that make a stuck
      // turn likely.
      this.startTurnLivenessSweep();
    }
  }

  private async recoverInner(): Promise<void> {
    const sessions = new Set<string>();
    // Lifecycle Phase 1: settle turns that were in flight when the process died
    // FIRST. A durable `running_turns` marker whose tail is non-terminal means the
    // turn was abandoned mid-flight — append `interrupted` (never re-run: side
    // effects may already have happened, and a steered prompt is already in the
    // agent's context). `handled` sessions are then skipped by the tail-prompt
    // recovery below, so an abandoned/steered turn is settled, not re-inferred.
    const handled = new Set<string>();
    await this.recoverAbandonedTurns(handled);
    await this.recoverOrphanTailPrompts(sessions, handled);
    const rows = await this.deps.store.listQueuedTurns();
    for (const row of rows) {
      try {
        // Rehydrate before touching the queue so a row that fails to rehydrate (e.g.
        // a blob-store error reading its attachment) is skipped cleanly — one bad row
        // must NOT strand the whole backlog at startup. Logged + skipped, not fatal.
        const opts = await this.toRuntimeOpts(row.opts);
        const queue = this.queues.get(row.sessionId) ?? [];
        queue.push({
          id: row.id,
          prompt: row.prompt,
          opts,
          ...(row.opts.attachments !== undefined
            ? { displayAttachments: row.opts.attachments }
            : {}),
          ...(row.opts.displayPrompt !== undefined
            ? { displayPrompt: row.opts.displayPrompt }
            : {}),
        });
        this.queues.set(row.sessionId, queue);
        sessions.add(row.sessionId);
      } catch (error) {
        this.reportTurnError(row.sessionId, error);
      }
    }
    // Nothing is in flight at startup, so drain each session's head turn now.
    for (const sessionId of sessions) this.drainNext(sessionId);
  }

  /**
   * Lifecycle Phase 1: settle every turn left in flight by a crash/restart. For
   * each durable `running_turns` marker, look at the events after its prompt
   * anchor: a terminal one (result/error/interrupted) means the turn actually
   * finished and only the marker cleanup was lost — just drop the marker. A
   * non-terminal tail means the turn was abandoned mid-flight — append the
   * terminal `interrupted` marker so it stops badging `running`, then drop the
   * marker. Either way the turn is NEVER re-run (fixes SR-1 steered-double-run and
   * CR-3 mid-turn-drop). Records the session id in `handled` so the tail-prompt
   * recovery skips it. Best-effort per marker: one failure can't strand the rest.
   */
  private async recoverAbandonedTurns(handled: Set<string>): Promise<void> {
    for (const marker of await this.deps.store.listRunningTurns()) {
      try {
        // Step 3: a terminal event already in the log means the turn actually finished
        // and only the marker cleanup was lost — drop the marker, never reattach.
        const after = await this.deps.store.getEventsAfter(marker.sessionId, marker.promptSeq);
        if (after.some((e) => isTurnTerminalEvent(e.event))) {
          if (this.leaveUncertainRecovery(marker.sessionId)) {
            this.releaseInFlight(marker.sessionId);
          }
          await this.deps.store.clearRunningTurn(marker.sessionId);
          handled.add(marker.sessionId);
          continue;
        }
        // Steps 1/4/5/6 (D7): try to reattach a LIVE runner before settling. Without a
        // discovery seam — or for a legacy marker that carries no turn identity — this
        // collapses to the unchanged "settle as interrupted" path.
        const outcome = await this.discoverAbandonedRunner(marker);
        if (outcome.status === 'uncertain') {
          // Step 5: bounded discovery — the Runner's fate is unknown, so do NOT
          // interrupt, do NOT re-run, and KEEP the marker for a later pass to resolve.
          // A surviving turn is never inferred only from the event tail.
          this.inFlight.add(marker.sessionId);
          this.uncertainRecovery.add(marker.sessionId);
          this.scheduleUncertainRecovery(marker);
          handled.add(marker.sessionId);
          continue;
        }
        if (outcome.status === 'live') {
          // Step 4: reattach and continue tailing instead of settling. Mark handled
          // BEFORE the fallible reattach so a reattach failure can never leave this
          // turn's trailing prompt to be re-run by recoverOrphanTailPrompts (SR-1);
          // reattachRecoveredTurn settles + releases the turn itself on failure.
          handled.add(marker.sessionId);
          await this.reattachRecoveredTurn(marker, outcome.target);
          continue;
        }
        // Step 6: confirmed dead — settle (`interrupted`) and drop the marker.
        await this.emitInterrupted(marker.sessionId);
        await this.deps.store.clearRunningTurn(marker.sessionId);
        if (this.leaveUncertainRecovery(marker.sessionId)) {
          this.releaseInFlight(marker.sessionId);
        }
        handled.add(marker.sessionId);
      } catch (error) {
        this.reportTurnError(marker.sessionId, error);
      }
    }
  }

  /**
   * Arm the in-flight liveness sweep (idempotent). Started once {@link recover} has
   * finished so it covers the whole life of a running Server, and stopped by
   * {@link drainOnShutdown}. `unref`'d: a pending sweep must never hold the process
   * open.
   */
  private startTurnLivenessSweep(): void {
    if (this.livenessSweepTimer !== undefined) return;
    const timer = setInterval(() => {
      if (this.livenessSweepInFlight !== undefined) return;
      const sweep = this.runTurnLivenessSweep();
      this.livenessSweepInFlight = sweep;
      void sweep.finally(() => {
        if (this.livenessSweepInFlight === sweep) this.livenessSweepInFlight = undefined;
      });
    }, TURN_LIVENESS_SWEEP_MS);
    timer.unref?.();
    this.livenessSweepTimer = timer;
  }

  private async stopTurnLivenessSweep(timeoutMs: number): Promise<void> {
    if (this.livenessSweepTimer === undefined) return;
    clearInterval(this.livenessSweepTimer);
    this.livenessSweepTimer = undefined;
    this.livenessSeen.clear();
    if (this.livenessSweepInFlight !== undefined) {
      await Promise.race([
        this.livenessSweepInFlight,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
    }
  }

  /**
   * Whether the sweep is still allowed to act. Clearing the interval does NOT stop a
   * sweep already in progress: it can sit in a probe for the whole discovery timeout
   * and come back long after shutdown began. Acting then would be actively wrong —
   * {@link drainOnShutdown} deliberately LEAVES reattachable markers open so their
   * external Worker survives the restart for D7 recovery, and a late `cancelTurn`
   * would kill exactly that Worker (plus write to a store that is being torn down).
   * So every step of a sweep that follows an await re-checks this and bails.
   */
  private get livenessSweepArmed(): boolean {
    return this.livenessSweepTimer !== undefined;
  }

  /**
   * One sweep over every durable in-flight marker. Sessions the recovery path already
   * owns (`uncertainRecovery`) are skipped — it has its own bounded retry and settling
   * both from here would double-write. Best-effort per marker: one failure can't
   * strand the rest, and a failing store just defers the sweep to the next tick.
   */
  private async runTurnLivenessSweep(): Promise<void> {
    // One sweep at a time. Each probe is bounded by the discovery timeout, so a few
    // unreachable Runners already push a sweep past the interval — exactly the broken
    // deployment this exists for. Overlapping sweeps would advance the same idle
    // window twice and could settle one marker from two ticks at once.
    if (this.livenessSweepRunning) return;
    this.livenessSweepRunning = true;
    try {
      let markers: RunningTurnRecord[];
      try {
        markers = await this.deps.store.listRunningTurns();
      } catch {
        // A store blip must not be read as "no turns are running" — that would drop
        // every session's idle history and restart all their windows. Skip this tick.
        return;
      }
      const open = new Set(markers.map((marker) => marker.sessionId));
      for (const sessionId of [...this.livenessSeen.keys()]) {
        if (!open.has(sessionId)) this.livenessSeen.delete(sessionId);
      }
      for (const marker of markers) {
        if (!this.livenessSweepArmed) return; // stopped mid-sweep (shutdown)
        if (this.uncertainRecovery.has(marker.sessionId)) continue;
        try {
          await this.checkTurnLiveness(marker);
        } catch (error) {
          this.reportTurnError(marker.sessionId, error);
        }
      }
    } finally {
      this.livenessSweepRunning = false;
    }
  }

  /**
   * Advance one marker's idle window, and probe its Runner once the window is full.
   * The event log is the activity signal rather than an in-memory frame counter: it
   * is what a reattached turn, a supervisor-written transcript and a locally-run turn
   * all update, so one rule covers every transport.
   */
  private async checkTurnLiveness(marker: RunningTurnRecord): Promise<void> {
    // `MAX(seq)` rather than reading the tail: this runs for every in-flight turn on
    // every sweep, and a long turn's tail grows without bound — all that is needed
    // here is whether the number moved. Floored at the marker's anchor so the very
    // first window starts from the prompt even for a turn that has emitted nothing.
    const newest = Math.max(
      await this.deps.store.latestEventSeq(marker.sessionId),
      marker.promptSeq,
    );
    if ((this.pendingPermissionRequests.get(marker.sessionId)?.size ?? 0) > 0) {
      this.livenessSeen.set(marker.sessionId, { seq: newest, idleSweeps: 0, liveProbes: 0 });
      return;
    }
    const seen = this.livenessSeen.get(marker.sessionId);
    if (seen === undefined || seen.seq !== newest) {
      this.livenessSeen.set(marker.sessionId, { seq: newest, idleSweeps: 0, liveProbes: 0 });
      return;
    }
    const idleSweeps = seen.idleSweeps + 1;
    this.livenessSeen.set(marker.sessionId, {
      seq: newest,
      idleSweeps,
      liveProbes: seen.liveProbes,
    });
    if (idleSweeps < TURN_LIVENESS_IDLE_SWEEPS) return;
    // The handle whose Runner is about to be probed — captured here so the settle below
    // can tell "still the turn I probed" from "the session moved on while I probed".
    const probed = this.turns.get(marker.sessionId);
    const outcome = await this.probeInFlightRunner(marker);
    // `uncertain` proves nothing and resets the confirmed-live count. `live` is a
    // positive observation: the Runner exists, but an unchanged transcript says
    // its turn is making no visible progress.
    const liveProbes = outcome.status === 'live' ? seen.liveProbes + 1 : 0;
    const stalled = outcome.status === 'live' && liveProbes >= TURN_LIVENESS_STALLED_WINDOWS;
    if (outcome.status !== 'dead' && !stalled) {
      this.livenessSeen.set(marker.sessionId, { seq: newest, idleSweeps: 0, liveProbes });
      return;
    }
    this.livenessSeen.delete(marker.sessionId);
    if (!this.livenessSweepArmed) return;
    if (stalled) {
      // A live verdict without the exact in-memory handle cannot be cancelled
      // turn-safely: a session-scoped fallback could overtake this turn settling
      // and hit its queued successor. Leave it open and require another window.
      if (probed === undefined) {
        this.livenessSeen.set(marker.sessionId, {
          seq: newest,
          idleSweeps: 0,
          liveProbes: TURN_LIVENESS_STALLED_WINDOWS - 1,
        });
        return;
      }
      const stalledNotice: AgentEvent = {
        t: 'notice',
        role: 'agent',
        text: STALLED_RUNNER_NOTICE,
      };
      // Atomically claim the still-silent transcript and close its frame stream,
      // but do not publish yet: every abort path removes exactly this fence+notice.
      let claimed: { seq: number; ts: number; fenceSeq: number; noticeSeq: number | null } | null;
      try {
        claimed = await this.deps.store.fenceRunningTurnIfSilent(marker, newest, stalledNotice);
      } catch (error) {
        this.reportTurnError(marker.sessionId, error);
        return;
      }
      if (claimed === null) return;
      const rollBackClaim = async (): Promise<void> => {
        try {
          await this.deps.store.releaseRunningTurnFence(
            marker,
            claimed.noticeSeq,
            claimed.fenceSeq,
          );
        } catch (error) {
          this.reportTurnError(marker.sessionId, error);
        }
      };
      if (!this.livenessSweepArmed || this.turns.get(marker.sessionId) !== probed) {
        await rollBackClaim();
        return;
      }

      probed.controller.abort();
      const termination = await this.boundedForceCancel(marker.sessionId, probed);
      if (
        !this.livenessSweepArmed ||
        probed.settled ||
        this.turns.get(marker.sessionId) !== probed
      ) {
        await rollBackClaim();
        return;
      }
      if (termination === 'unconfirmed') {
        await rollBackClaim();
        this.reapUnconfirmedWorker(marker.sessionId, probed);
        return;
      }
      const live = this.turns.get(marker.sessionId);
      if (!this.livenessSweepArmed || live !== probed) {
        await rollBackClaim();
        return;
      }
      this.deps.bus?.publish(marker.sessionId, {
        seq: claimed.seq,
        ts: claimed.ts,
        event: stalledNotice,
      });
      this.deps.store.scheduleMessageProjection();
      this.closeSession(marker.sessionId);
      await this.forceSettleWedgedTurn(marker.sessionId, live);
      return;
    }
    // The verdict is about ONE turn as it was ONE probe ago — up to the discovery
    // timeout. Since then the probed turn may have spoken, finished with a result, or
    // handed the session to a queued successor. Write the notice CONDITIONALLY on both
    // halves of what was observed: the marker still anchoring this turn, and the log not
    // having moved since `newest`. One statement, so unlike a re-read it cannot be
    // overtaken between the check and the write — a notice claiming the Runner is gone
    // can never land after that Runner's own result. Nothing written means the
    // observation is out of date, and out-of-date verdicts are dropped whole.
    const noticeSeq = await this.emitEventForTurn(
      { ...marker, silentSinceSeq: newest },
      {
        t: 'notice',
        role: 'agent',
        text: DEAD_RUNNER_NOTICE,
      },
    );
    if (noticeSeq === null) return;
    // Re-validate before the destructive half: settling acts on the SESSION, and the
    // notice write is long enough for the turn to be replaced, for the Runner to speak
    // after all, or for shutdown to begin. The notice carries the silence forward — it
    // landed only while the log was still where the probe left it, so requiring it to
    // still be the NEWEST event extends that proof up to here.
    if (!(await this.deadVerdictStillApplies(marker, noticeSeq))) return;
    // A dead Runner cannot emit again. A stalled Runner is deliberately still
    // alive, so fence its turn BEFORE releasing the session: even an acknowledged
    // cancel may race with a final frame, and that frame must never land in a
    // queued successor's transcript. A transient fencing failure leaves the turn
    // in flight and retries after another confirmed-live window.
    // What the checks above and below guard is the SESSION moving on, not the Runner
    // coming back: `dead` is only ever a supervisor-CONFIRMED absence (see
    // {@link probeInFlightRunner} — no seam, no turn id, or any ambiguity answers
    // `uncertain` and returns above), so there is no Runner left to resume speaking.
    // A turn that spoke on its own account has therefore been replaced or settled by
    // the time it shows up here, which is exactly what the marker, the silence and the
    // handle identity below test.
    //
    // Aim the settle at the TURN, not the session. `this.turns` is read and used with
    // no await in between, so a successor that took the session over since the probe is
    // detected here rather than cancelled — a read that merely PRECEDES a session-keyed
    // cancel can always be overtaken. The settle below reuses the Stop path's own
    // force-settle, so it keeps the terminal event ahead of the marker clear and a
    // crash mid-settle leaves an orphan tail recovery can finish rather than a
    // dropped one.
    const live = this.turns.get(marker.sessionId);
    if (live !== undefined) {
      if (live !== probed) return; // a different turn holds the session now
      // The supervisor liveness verdict is already the termination certificate;
      // do not require the dead turn's per-turn control socket to acknowledge a
      // redundant cancel before finalizing it.
      //
      // Detach THIS side from the dead Runner. Skipping the cancel round-trip is
      // about not waiting on a control socket nobody is listening on; it is not a
      // reason to leave the turn attached. Two things stay armed otherwise: the
      // handle's abort signal, which still gates the auto-resume continuation, and
      // — for a reattached turn — the runner client's frame tail, which runs until
      // its own force-cancel aborts it. Both levers are local. The force is bounded
      // as everywhere else, so a seam that never answers costs this sweep a second
      // rather than wedging it, and its verdict is deliberately ignored: the
      // supervisor already CONFIRMED the Runner gone, which is the stronger
      // certificate — this call is cleanup, not proof.
      live.controller.abort();
      await this.boundedForceCancel(marker.sessionId, live);
      // Revalidate after that await, as every session-keyed step does: the turn may
      // have settled or handed the session to a successor while it ran, and
      // closeSession/force-settle are keyed by session id.
      if (live.settled || this.turns.get(marker.sessionId) !== live) return;
      // The Runner is confirmed gone, so any in-process backend client state for this
      // session is orphaned too. The Stop path this used to take frees it; skipping it
      // here would leak a child per dead Runner. Ordered BEFORE the settle exactly as
      // there: closeSession is keyed by session id, and the settle is what lets a
      // queued successor start, so closing after it could terminate the SUCCESSOR's
      // backend.
      this.closeSession(marker.sessionId);
      await this.forceSettleWedgedTurn(marker.sessionId, live);
      return;
    }
    // No handle at all: the fence is held by a turn whose object is already gone, so
    // there is nothing turn-scoped left to aim at and only the session-keyed force
    // settle can release it. Guarded by `probed` for the same reason as above — if the
    // turn we probed still had a handle, its disappearance means it has moved on.
    if (probed !== undefined) return;
    await this.cancelTurn(marker.sessionId);
  }

  /**
   * {@link emitEvent}, but the append lands only while `anchor` is still the session's
   * in-flight turn AND that turn has stayed silent since the sweep last looked. Returns
   * the seq it landed at, or `null` — the caller settles a turn on the strength of that
   * write, so a write that failed or was refused proves nothing about the turn and must
   * not license one. A store blip therefore costs the sweep a window, not a wrongly
   * killed turn: the marker stays open and the next window probes it again.
   */
  private async emitEventForTurn(
    anchor: RunningTurnRecord & { silentSinceSeq: number },
    event: AgentEvent,
  ): Promise<number | null> {
    try {
      const persisted = await this.deps.store.appendEventForRunningTurn(
        anchor.sessionId,
        anchor,
        event,
      );
      if (persisted === null) return null;
      this.deps.bus?.publish(anchor.sessionId, {
        seq: persisted.seq,
        ts: persisted.ts,
        event,
      });
      return persisted.seq;
    } catch (error) {
      this.reportTurnError(anchor.sessionId, error);
      return null;
    }
  }

  /**
   * Shut an abandoned turn's Runner out of the session's log before the turn is settled
   * on a verdict that never confirmed the Runner gone. Returns whether the session is
   * safe to release: a fence that could not be written leaves a possibly-live Runner
   * able to stream into a successor's transcript, which is worse than staying fenced
   * for another retry — so the caller retries instead of settling.
   *
   * A turn with no identity was never bound to a Runner and has no frame stream to
   * close, so there is nothing to fence and nothing to wait for.
   */
  private async fenceAbandonedTurn(marker: RunningTurnRecord): Promise<boolean> {
    if (marker.turnId === null) return true;
    try {
      await this.deps.store.fenceAbandonedTurn(marker.sessionId, marker.turnId);
      return true;
    } catch (error) {
      this.reportTurnError(marker.sessionId, error);
      return false;
    }
  }

  /**
   * Whether a `dead` probe verdict may still be acted on destructively. The awaits it
   * follows are long enough to invalidate it:
   *
   * - The probed turn can settle on its own and a QUEUED SUCCESSOR can start — and
   *   `cancelTurn` is keyed by session id, so acting on the stale verdict would kill
   *   a healthy new turn. Re-read the marker and require it to still be the same turn.
   * - Shutdown can begin at any point. {@link drainOnShutdown} deliberately leaves
   *   reattachable markers OPEN so their external Worker survives the restart for D7
   *   reattach; settling one here would kill exactly that Worker.
   * - The Runner can speak again — a probe answers `dead` for a Sandbox that was merely
   *   unreachable too. `noticeSeq` is the last event the log was proven to end at, so
   *   anything after it is the turn contradicting the verdict, and it keeps its turn.
   */
  private async deadVerdictStillApplies(
    marker: RunningTurnRecord,
    noticeSeq: number,
  ): Promise<boolean> {
    if (!this.livenessSweepArmed) return false;
    const current = (await this.deps.store.listRunningTurns()).find(
      (row) => row.sessionId === marker.sessionId,
    );
    if (await this.spokeSince(marker.sessionId, noticeSeq)) return false;
    // Re-checked AFTER the reads as well: shutdown can begin while they are outstanding,
    // and a marker snapshot taken before that says nothing about the turn's fate after.
    if (!this.livenessSweepArmed) return false;
    return (
      current !== undefined &&
      current.turnId === marker.turnId &&
      current.promptSeq === marker.promptSeq
    );
  }

  /** Whether the session's log has moved past `seq`. */
  private async spokeSince(sessionId: string, seq: number): Promise<boolean> {
    return (await this.deps.store.latestEventSeq(sessionId)) > seq;
  }

  /**
   * Probe the Runner of a turn believed to be RUNNING. Deliberately not
   * {@link discoverAbandonedRunner}: that one answers `dead` when no seam is wired or
   * the marker carries no turn id, which is the right default for a turn a restart
   * already abandoned but would be fatal here — it would settle healthy turns on
   * every deployment that has no discovery seam. Absent proof, the turn stands.
   */
  private async probeInFlightRunner(marker: RunningTurnRecord): Promise<RunnerRecoveryOutcome> {
    if (this.deps.runnerRecovery === undefined || marker.turnId === null) {
      return { status: 'uncertain' };
    }
    return await this.discoverAbandonedRunner(marker);
  }

  /** Retry only one uncertain marker; never re-run full startup recovery/queue loading. */
  private scheduleUncertainRecovery(marker: RunningTurnRecord): void {
    if (this.uncertainRecoveryTimers.has(marker.sessionId)) return;
    const timer = setTimeout(() => {
      this.uncertainRecoveryTimers.delete(marker.sessionId);
      void this.retryUncertainRecovery(marker);
    }, RUNNER_RECOVERY_RETRY_MS);
    timer.unref?.();
    this.uncertainRecoveryTimers.set(marker.sessionId, timer);
  }

  private async retryUncertainRecovery(marker: RunningTurnRecord): Promise<void> {
    if (!this.uncertainRecovery.has(marker.sessionId)) return;
    try {
      const current = (await this.deps.store.listRunningTurns()).find(
        (row) => row.sessionId === marker.sessionId,
      );
      if (current === undefined) {
        this.leaveUncertainRecovery(marker.sessionId);
        this.releaseInFlight(marker.sessionId);
        this.drainNext(marker.sessionId);
        return;
      }
      // A marker for a DIFFERENT turn means the session moved on while this retry was
      // scheduled: that turn holds the fence, so releasing it here would drain a second
      // prompt on top of a running one. Drop the recovery state and leave the fence.
      if (current.turnId !== marker.turnId || current.promptSeq !== marker.promptSeq) {
        this.leaveUncertainRecovery(marker.sessionId);
        return;
      }
      const after = await this.deps.store.getEventsAfter(marker.sessionId, marker.promptSeq);
      if (after.some((event) => isTurnTerminalEvent(event.event))) {
        await this.deps.store.clearRunningTurn(marker.sessionId);
        this.leaveUncertainRecovery(marker.sessionId);
        this.releaseInFlight(marker.sessionId);
        this.drainNext(marker.sessionId);
        return;
      }
      // Anchor the silence BEFORE probing, not after. Discovery is bounded in seconds,
      // and a turn that emits inside that window has disproved the verdict the probe is
      // about to return — anchoring afterwards would fold that speech into the baseline
      // and settle a turn that had just proved it was alive. Same rule as the sweep:
      // the verdict is only as good as the log was when the observation started.
      const anchorSeq = Math.max(
        await this.deps.store.latestEventSeq(marker.sessionId),
        marker.promptSeq,
      );
      const outcome = await this.discoverAbandonedRunner(marker);
      if (outcome.status === 'live') {
        await this.reattachRecoveredTurn(marker, outcome.target);
        return;
      }
      if (await this.spokeSince(marker.sessionId, anchorSeq)) {
        // The turn spoke while it was being probed. That is proof of life the seam could
        // not give, and it outranks a verdict formed without it: give the bound back, so
        // a turn that keeps speaking is never settled and one that goes quiet again is
        // judged on a fresh window rather than on a spent counter.
        this.uncertainRecoveryAttempts.delete(marker.sessionId);
        this.scheduleUncertainRecovery(marker);
        return;
      }
      // Discovery is bounded in SECONDS, and Stop can force-settle this session while it
      // runs: the fence then belongs to whatever Stop drained next, and settling on this
      // verdict would interrupt that successor and clear ITS marker. Stop leaves the
      // uncertain state on its way through, so losing it means the session moved on
      // without us and nothing here may touch it.
      if (!this.uncertainRecovery.has(marker.sessionId)) return;
      const anchored = (await this.deps.store.listRunningTurns()).find(
        (row) => row.sessionId === marker.sessionId,
      );
      if (anchored === undefined) {
        // Settled by something that left the recovery fence behind — release it, or the
        // session badges `running` with nothing running, the very state this path exists
        // to end. A marker belonging to a DIFFERENT turn is the other case: it is held by
        // an owner of its own, so it is left alone, fence included.
        this.leaveUncertainRecovery(marker.sessionId);
        this.releaseInFlight(marker.sessionId);
        this.drainNext(marker.sessionId);
        return;
      }
      if (anchored.turnId !== marker.turnId || anchored.promptSeq !== marker.promptSeq) {
        this.leaveUncertainRecovery(marker.sessionId);
        return;
      }
      // The settle below writes across several more awaits, and a successor can claim
      // the session inside any of them. Every write is therefore anchored to THIS turn's
      // marker and to the log as it stood before the probe — the scoped clear at the end
      // protects a successor's marker, but nothing except the anchor keeps this turn's
      // notice and `interrupted` out of the successor's transcript.
      let silentSinceSeq = anchorSeq;
      if (outcome.status === 'uncertain') {
        // ADR 0006 D7 step 5 is BOUNDED: a seam that can never answer must not fence
        // the session forever. Past the bound, fall through to the settle below —
        // the same terminal write a confirmed-dead Runner gets, plus a notice so the
        // transcript says the turn was abandoned rather than finished.
        const attempts = (this.uncertainRecoveryAttempts.get(marker.sessionId) ?? 0) + 1;
        this.uncertainRecoveryAttempts.set(marker.sessionId, attempts);
        if (attempts < RUNNER_RECOVERY_UNCERTAIN_MAX_ATTEMPTS) {
          this.scheduleUncertainRecovery(marker);
          return;
        }
        // Anything below can fail and be retried from the top — the settle writes, the
        // marker clear — and every retry lands here again, since the bound is already
        // spent. The log itself says whether this was already announced, so the notice
        // is written once per turn rather than once per attempt at settling it.
        const announced = after.some(
          (row) =>
            row.event.t === 'notice' && row.event.text === UNCERTAIN_RECOVERY_EXHAUSTED_NOTICE,
        );
        if (!announced) {
          const noticeSeq = await this.emitEventForTurn(
            { ...anchored, silentSinceSeq },
            { t: 'notice', role: 'agent', text: UNCERTAIN_RECOVERY_EXHAUSTED_NOTICE },
          );
          if (noticeSeq === null) return this.scheduleUncertainRecovery(marker);
          silentSinceSeq = noticeSeq;
        }
        // The Runner this gives up on was never CONFIRMED gone — that is what makes the
        // verdict uncertain. Unlike a dead one it can still come back, so close the log
        // to it before releasing the session: frames from an abandoned turn must not
        // land in the transcript of whatever runs next. Best-effort, and first, so a
        // fence that fails costs a retry rather than settling with the door open.
        if (!(await this.fenceAbandonedTurn(marker))) {
          return this.scheduleUncertainRecovery(marker);
        }
      }
      const settled = await this.emitEventForTurn(
        { ...anchored, silentSinceSeq },
        { t: 'interrupted' },
      );
      // Refused: the marker is no longer this turn's, or the session has spoken since the
      // anchor — either way the settle would be writing into someone else's turn. Come
      // back and re-read the whole state instead of pushing a stale verdict through.
      if (settled === null) return this.scheduleUncertainRecovery(marker);
      await this.deps.store.clearRunningTurn(marker.sessionId, marker.promptSeq);
      this.leaveUncertainRecovery(marker.sessionId);
      this.releaseInFlight(marker.sessionId);
      this.drainNext(marker.sessionId);
    } catch (error) {
      this.reportTurnError(marker.sessionId, error);
      this.scheduleUncertainRecovery(marker);
    }
  }

  /**
   * ADR 0006 D7 step 4: reattach to a still-live Runner discovered for an abandoned
   * marker. Registers the session's control handle (so steer/cancel/answer reach the
   * reattached turn), re-tails its durable stream through {@link RunnerClient.attach}
   * (idempotent — a replayed frame is a no-op), and continues in the BACKGROUND until
   * the replayed-or-new terminal frame settles it. On settle it records the terminal
   * event (if the log still lacks one) and clears the marker, exactly like a normal
   * turn end. Falls back to settling if the session vanished or the runner cannot
   * reattach.
   */
  private async reattachRecoveredTurn(
    marker: RunningTurnRecord,
    target: RunnerAttachTarget,
  ): Promise<void> {
    // `handle` is set only once the in-flight lock is taken; the catch uses it to
    // decide whether a failure needs the full lock/handle release or just a settle.
    let handle: SessionTurnHandle | undefined;
    const inheritedUncertainFence = this.leaveUncertainRecovery(marker.sessionId);
    try {
      const session = await this.deps.store.getSession(marker.sessionId);
      if (session === undefined) {
        // The session was deleted while the turn was abandoned — nothing to reattach to.
        await this.deps.store.clearRunningTurn(marker.sessionId);
        if (inheritedUncertainFence) this.releaseInFlight(marker.sessionId);
        return;
      }
      // Claim the recovered turn BEFORE resolving its project backend. A Sandbox
      // repair consults this in-flight set; taking the lock later left a gap where
      // it could recreate the container between discovery and `runner.attach()`.
      this.inFlight.add(marker.sessionId);
      handle = new SessionTurnHandle();
      handle.markerSeq = marker.promptSeq;
      this.turns.set(marker.sessionId, handle);
      // `attach` never runs the backend, but the factory needs one; the session's
      // backend composes the same Docker/model wrapper the original turn used.
      const backend = await this.backendForSession(session, session.model);
      // A reattached turn re-surfaces its still-open prompts, so it needs the same
      // channel binding a fresh turn gets (ADR 0014 D3).
      handle.grantChannel = brokeredGrantChannel(backend);
      const runner = await this.runnerFor(backend, {
        sessionId: session.sessionId,
        projectId: session.projectId,
        worktree: session.worktree,
      });
      if (runner.attach === undefined) {
        // The configured runner cannot reattach (e.g. loopback) — settle as interrupted.
        await this.settleReattachedTurn(marker, handle, undefined);
        return;
      }
      // Hold the in-flight lock for the whole reattach so a queued/new prompt cannot
      // start a SECOND turn for this session while the recovered one is still running
      // (recovery runs before the queue drains, so this cannot contend).
      const boundHandle = handle;
      const turn = runner.attach(target, {
        onPermissionRequest: (request) => this.trackPendingPermission(marker.sessionId, request),
        ...(this.deps.bus !== undefined ? { bus: this.deps.bus } : {}),
      });
      boundHandle.delegate = turn;
      // Continue tailing in the background; settle when the terminal frame arrives.
      void turn.result.then(
        (result) => this.settleReattachedTurn(marker, boundHandle, result),
        (error) => {
          this.reportTurnError(marker.sessionId, error);
          return this.settleReattachedTurn(marker, boundHandle, undefined);
        },
      );
    } catch (error) {
      // Any failure setting up the reattach — a session/backend lookup rejecting, or a
      // synchronous `attach` throw — must not leave the turn badging `running` or leak
      // the in-flight lock/handle. Settle it: once the lock+handle were taken,
      // settleReattachedTurn releases them; otherwise interrupt + drop the marker.
      this.reportTurnError(marker.sessionId, error);
      if (handle !== undefined) {
        await this.settleReattachedTurn(marker, handle, undefined);
      } else {
        await this.emitInterrupted(marker.sessionId);
        await this.deps.store.clearRunningTurn(marker.sessionId);
        if (inheritedUncertainFence) this.releaseInFlight(marker.sessionId);
      }
    }
  }

  /**
   * Discover an abandoned turn's Runner (ADR 0006 D7 step 1), BOUNDED so a slow or
   * hanging seam cannot wedge the startup recovery of the OTHER sessions (recovery
   * runs before the queue drains). Nothing to discover — no seam, or a legacy marker
   * with no turn id — resolves to `dead` (the unchanged legacy settle). A discovery
   * error or a timeout resolves to `uncertain`: keep the marker for a later restart
   * rather than wrongly interrupting a turn that may still be live.
   */
  private async discoverAbandonedRunner(marker: RunningTurnRecord): Promise<RunnerRecoveryOutcome> {
    if (this.deps.runnerRecovery === undefined || marker.turnId === null) {
      return { status: 'dead' };
    }
    const turnId = marker.turnId;
    const discovery = this.deps.runnerRecovery
      .discover({ sessionId: marker.sessionId, turnId, startCommandId: marker.startCommandId })
      .catch((error: unknown): RunnerRecoveryOutcome => {
        this.reportTurnError(marker.sessionId, error);
        return { status: 'uncertain' };
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<RunnerRecoveryOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: 'uncertain' }),
        this.deps.runnerRecoveryDiscoverTimeoutMs ?? RUNNER_RECOVERY_DISCOVER_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([discovery, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Close out a reattached turn once its terminal frame settles it: record the
   * terminal event if the log still lacks one (the abandoned turn's own result), then
   * release the handle + in-flight lock + marker and drain any queued turns — the same
   * end-of-turn bookkeeping a fresh turn does. */
  private async settleReattachedTurn(
    marker: RunningTurnRecord,
    handle: SessionTurnHandle,
    result: RunResult | undefined,
  ): Promise<void> {
    // Claim settle ownership SYNCHRONOUSLY before any terminal side effect — if the
    // stop watchdog force-settled this turn while the reattach tail was wedged, it
    // owns the claim and every write/release below must be skipped (a duplicate
    // write would land beside a successor turn's transcript).
    const ownsSettle = handle.claimSettle('run');
    try {
      if (!ownsSettle) {
        // force-settled — nothing left to write
      } else if (result !== undefined) {
        if (result.aborted) await this.emitInterrupted(marker.sessionId);
        else await this.ensureTerminalMarker(marker.sessionId, marker.promptSeq, result);
      } else {
        // The reattach tail failed without a terminal result — settle so the session
        // stops badging `running`.
        await this.emitInterrupted(marker.sessionId);
      }
    } catch (error) {
      this.reportTurnError(marker.sessionId, error);
    } finally {
      if (ownsSettle) {
        // Only tear down if this reattach still owns the session handle (defensive — the
        // in-flight lock should have prevented any replacement).
        if (this.turns.get(marker.sessionId) === handle) this.turns.delete(marker.sessionId);
        this.clearPermissions(marker.sessionId);
        this.releaseInFlight(marker.sessionId);
        // `settled` only AFTER the fence release (the watchdog's stand-down
        // signal), and the scoped marker clear fire-and-forget AFTER both —
        // matching the launch run loop: the terminal event was already awaited
        // above, so terminal-before-clear (SR-1) still holds, and a slow or
        // failing store delete can neither keep the session fenced nor stand the
        // watchdog down early.
        handle.settled = true;
        void this.clearRunningTurn(marker.sessionId, marker.promptSeq);
        this.drainNext(marker.sessionId);
      }
    }
  }

  private async recoverOrphanTailPrompts(
    sessions: Set<string>,
    handled: Set<string>,
  ): Promise<void> {
    for (const session of await this.deps.store.listSessions()) {
      // A session whose in-flight turn was just settled by marker-driven recovery
      // must NOT also have its trailing prompt re-run — that IS the SR-1 double-run.
      if (handled.has(session.sessionId)) continue;
      try {
        const events = await this.deps.store.getEvents(session.sessionId);
        const prompts: Extract<AgentEvent, { t: 'prompt' }>[] = [];
        let i = events.length - 1;
        while (i >= 0 && isSealedStoreRecoveryError(events[i])) i -= 1;
        for (; i >= 0; i--) {
          const event = events[i];
          if (event?.t !== 'prompt') break;
          prompts.unshift(event);
        }
        if (prompts.length === 0) continue;
        const queue = this.queues.get(session.sessionId) ?? [];
        for (const prompt of prompts) {
          queue.push({
            prompt: prompt.text,
            opts: await this.toRuntimeOpts(
              prompt.attachments !== undefined ? { attachments: prompt.attachments } : {},
            ),
            displayPrompt: prompt.text,
            promptAlreadyPersisted: true,
          });
        }
        this.queues.set(session.sessionId, queue);
        sessions.add(session.sessionId);
      } catch (error) {
        this.reportTurnError(session.sessionId, error);
      }
    }
  }

  /** Dispatch the next queued turn (FIFO) once the lock is free — called when a
   * turn settles. Drops the turn's durable mirror row (it's leaving the queue, so a
   * restart mustn't recover + re-run it) then dispatches it as a fresh turn. A
   * queued turn that fails to dispatch (e.g. its worktree vanished meanwhile) routes
   * to {@link ConductorDeps.onTurnError} and we move on to the next, so one bad turn
   * can't strand the rest of the backlog. */
  private drainNext(sessionId: string): void {
    if (this.stopping.has(sessionId)) return;
    const queue = this.queues.get(sessionId);
    const next = queue?.shift();
    if (!next) return;
    if (queue && queue.length === 0) this.queues.delete(sessionId);
    void (async () => {
      if (next.autoResumeSignal?.aborted) {
        // Cancel may land after maybeAutoResume enqueues but before this drain.
        // Terminalize the original prompt before continuing with a real queued
        // turn; otherwise restart recovery could mistake it for an orphan tail.
        await this.emitInterrupted(sessionId).catch((error: unknown) => {
          this.reportTurnError(sessionId, error);
        });
        const retained = this.turns.get(sessionId);
        if (retained?.controller.signal === next.autoResumeSignal) {
          this.turns.delete(sessionId);
        }
        this.drainNext(sessionId);
        return;
      }
      if (next.promptAlreadyPersisted) {
        // Recovered tail prompt ({@link recoverOrphanTailPrompts}): already durable,
        // no queue row to drop — just claim the lock and run it.
        const session = await this.accept(sessionId, next.prompt, next.opts);
        if (next.autoResumeSignal?.aborted) {
          // accept() claimed the lock while cancellation raced its async lookups.
          // Terminalize before releasing it, so a queued successor cannot overtake
          // the interrupted boundary in the transcript.
          await this.emitInterrupted(sessionId).catch((error: unknown) => {
            this.reportTurnError(sessionId, error);
          });
          this.releaseInFlight(sessionId);
          const retained = this.turns.get(sessionId);
          if (retained?.controller.signal === next.autoResumeSignal) {
            this.turns.delete(sessionId);
          }
          this.drainNext(sessionId);
          return;
        }
        this.launchAcceptedTurn(
          sessionId,
          next.prompt,
          session,
          next.opts,
          next.displayPrompt ?? next.prompt,
          {
            persistPrompt: false,
            ...(next.autoResumeCount === undefined
              ? {}
              : { autoResumeCount: next.autoResumeCount }),
          },
        );
        return;
      }
      if (next.id !== undefined) {
        // Durable queued turn (SR-5): claim the lock FIRST, then delete the row AND
        // persist the prompt in ONE store txn ({@link EventStore.drainQueuedTurn}) so
        // a crash can neither drop the row (double-run on restart) nor drop the prompt
        // (lost turn). Persisting only AFTER the lock is held means a busy race can't
        // strand an already-persisted prompt with no turn to run it.
        let session: SessionRecord;
        try {
          session = await this.accept(sessionId, next.prompt, next.opts);
        } catch (error) {
          if (error instanceof SessionBusyError) {
            // A concurrent turn claimed the lock during our async setup. The row is
            // still durable (not yet deleted) — put the item back at the FRONT so its
            // FIFO position holds, and let that turn's settle drain it next.
            const q = this.queues.get(sessionId) ?? [];
            q.unshift(next);
            this.queues.set(sessionId, q);
            return;
          }
          throw error;
        }
        // The lock is now held. Any failure before launchAcceptedTurn takes ownership
        // of the release must release it here, or the session hangs busy forever.
        try {
          const attachments = await this.storeAttachments(next.opts.attachments);
          const text = next.displayPrompt ?? next.prompt;
          const event: AgentEvent =
            attachments && attachments.length > 0
              ? { t: 'prompt', text, attachments: [...attachments] }
              : { t: 'prompt', text };
          const persisted = await this.deps.store.drainQueuedTurn(next.id, sessionId, event);
          if (!persisted) {
            // The row was already drained/retracted by a concurrent path (run-once
            // latch) — nothing was persisted, so release the lock and bail.
            this.releaseInFlight(sessionId);
            return;
          }
          this.deps.bus?.publish(sessionId, { seq: persisted.seq, ts: persisted.ts, event });
          this.launchAcceptedTurn(sessionId, next.prompt, session, next.opts, text, {
            persistPrompt: false,
          });
        } catch (error) {
          // The atomic drain rolled back (row still durable, prompt not persisted).
          // Put the head turn back at the FRONT (mirroring the SessionBusyError path)
          // so it keeps its FIFO slot and is retried in order — NOT overtaken by the
          // next queued turn and stranded until a restart. Release the lock, log, and
          // re-drain the same head item. A transient failure converges on the retry;
          // if the process dies first, the surviving row recovers it exactly once.
          const q = this.queues.get(sessionId) ?? [];
          q.unshift(next);
          this.queues.set(sessionId, q);
          this.releaseInFlight(sessionId);
          this.reportTurnError(sessionId, error);
          this.drainNext(sessionId);
          return;
        }
        return;
      }
      // No id and not pre-persisted (not produced by any current path) — fall back to
      // a fresh dispatch so the turn is never silently dropped.
      await this.dispatchTurn(
        sessionId,
        next.prompt,
        next.opts,
        next.displayPrompt !== undefined ? { displayPrompt: next.displayPrompt } : {},
      );
    })().catch((error: unknown) => {
      this.reportTurnError(sessionId, error);
      this.drainNext(sessionId); // skip the failed turn, try the next
    });
  }

  /**
   * Start a NEW session: spawn a fresh `claude -p` (no `--resume`) in
   * `worktree`, resolve with the backend-minted session id the moment it binds
   * (the first `session` event), and let the run continue in the background —
   * the operator can subscribe to the live stream as soon as they have the id.
   * A failure AFTER the id is known routes to {@link ConductorDeps.onTurnError}
   * (like {@link dispatchTurn}); a failure BEFORE it binds rejects this call.
   *
   * The lock key is the worktree (the session id doesn't exist yet): a
   * concurrent start for the same worktree rejects with {@link SessionBusyError}.
   */
  async startSession(opts: StartOptions): Promise<{ sessionId: string }> {
    if (opts.prompt.trim().length === 0) throw new Error('turn prompt must be non-empty');
    // NB: on this path `SessionBusyError.sessionId` carries the WORKTREE (the
    // session id doesn't exist yet). Server maps it to a generic 409 without
    // reflecting the path; don't read `.sessionId` as an id on the start path.
    if (this.starting.has(opts.worktree)) throw new SessionBusyError(opts.worktree);
    this.starting.add(opts.worktree);

    // The in-flight handle owns the operator-cancel signal (#79) + steer channel
    // (#101). It's constructed here (before the run) so its signal can thread into
    // the start opts; it's REGISTERED under the session id the moment the id binds
    // (below), matching the old aborter/injector registration timing.
    const handle = new SessionTurnHandle();
    // A spawn under a preallocated id runs against a session row the caller has
    // already written (with its project), so the same lookup the turn path uses
    // classifies this fresh context too. A spawn whose id the backend still has
    // to mint has no row and no project to read, and keeps the default posture.
    //
    // This is the first await after the start lock is taken, and the lock is only
    // released from inside the promise below — so a throwing read has to release
    // it here or the worktree stays permanently unstartable for this conductor.
    let localProject: boolean;
    try {
      localProject = await this.isLocalProjectSpawn(opts.sessionId);
    } catch (error) {
      this.starting.delete(opts.worktree);
      throw error;
    }
    return new Promise<{ sessionId: string }>((resolve, reject) => {
      let boundId: string | undefined;
      let markerSeq: number | undefined;
      // Allocate the Runner recovery identity before startTurn. A fresh session
      // used to omit both ids, making a live first turn undiscoverable after a
      // Server restart even once its public session id had bound.
      const turnId = randomUUID();
      const startCommandId = randomUUID();
      const runOpts = {
        ...this.buildStartOpts(opts, localProject, (sessionId) => {
          if (boundId !== undefined) return;
          const publicSessionId = opts.sessionId ?? sessionId;
          boundId = publicSessionId;
          this.starting.delete(opts.worktree); // bound → release the start lock
          this.inFlight.add(publicSessionId); // serialize turns against the still-running spawn
          this.turns.set(publicSessionId, handle); // operator can cancel/steer now (#79/#101)
          // The session row exists now (either preallocated by the server or
          // created by ingest from the backend `session` event), so persist the
          // operator's first prompt → it shows in the transcript.
          // RETURN the promise: ingest awaits onSession, so the prompt INSERT lands
          // before claude's next event (deterministic order, no pooled-store race).
          // The `.catch` swallows so a failed prompt event logs but doesn't kill the
          // live session — it just resolves, and ingest continues. Seed images are
          // stored content-addressed and referenced by id on the event (same as a
          // steering turn) so they render in the transcript, not just reach the model.
          return (
            (
              opts.persistPrompt === false
                ? Promise.resolve()
                : this.storeAttachments(opts.attachments).then((attachments) =>
                    this.emitPrompt(publicSessionId, opts.prompt, attachments),
                  )
            )
              .catch((error: unknown) => {
                this.reportTurnError(publicSessionId, error);
              })
              .then(async () => {
                const seq = await this.deps.store.latestEventSeq(publicSessionId);
                markerSeq = seq;
                handle.markerSeq = seq;
                await this.markTurnRunning(publicSessionId, seq);
                await this.bindTurnIdentity(publicSessionId, turnId, startCommandId);
              })
              .then(() =>
                this.persistBackendSessionState(
                  publicSessionId,
                  this.backendKey(opts.model),
                  sessionId,
                ),
              )
              // Name from the prompt now — concurrently with the still-running spawn —
              // once it's on record, rather than waiting for the reply or the settle.
              .then(() => this.maybeAutoTitle(publicSessionId))
              .catch((error: unknown) => {
                this.reportTurnError(publicSessionId, error);
              })
              .then(() => resolve({ sessionId: publicSessionId }))
          );
        }),
        signal: handle.controller.signal, // operator-cancel for the initial run (#79)
        steerable: true, // hold stdin open so the operator can steer the first turn (#101)
        turnId,
        startCommandId,
      };
      // Route the fresh run through the Runner contract (ADR 0006 Stage 1). The
      // RunnerTurn adopts the handle's cancel signal and surfaces the steer channel
      // (bound as the handle's delegate). A `can_use_tool` prompt that fires BEFORE
      // the session binds has no id to park under — deny it safe immediately (matching
      // the old buildStartOpts behavior); otherwise track it under the bound id.
      void (async () => {
        // A project/Agent Loop caller may pre-create the Verity session so its
        // project and kind are known before the backend context starts. Include
        // that project's memory on this initial turn; later resume turns already
        // carry it in their persisted backend context.
        // A pre-created session (project/Agent Loop) carries its project id before
        // the backend context starts; a truly fresh, project-less control-plane
        // spawn (e.g. the concierge) has none. Capture it here so the runner
        // context reflects the real project (or `null`).
        let contextProjectId: string | null = null;
        if (opts.sessionId !== undefined) {
          const session = await this.deps.store.getSession(opts.sessionId);
          if (session !== undefined) {
            runOpts.appendSystemPrompt += await this.projectMemoryPrompt(session);
            contextProjectId = session.projectId;
          }
        }
        const selected = opts.backend ?? this.modelBackend(runOpts.model);
        const backend = opts.backendWrapper?.(selected) ?? selected;
        // The fresh-spawn turn resolves its backend here rather than through
        // `backendForSession`, so it has to bind the grant channel here too — before
        // `startTurn` can raise a prompt (ADR 0014 D3). Without it a project-scoped
        // grant would stop auto-approving on a session's very first turn.
        handle.grantChannel = brokeredGrantChannel(backend);
        runOpts.appendSystemPrompt = withBackendSystemPrompt(
          runOpts.appendSystemPrompt,
          backend,
          await this.brokeredAliasesFor(contextProjectId, backend),
        );
        const { opts: dispatchOpts, cleanup } = await this.prepareFileAttachments(runOpts);
        // On the fresh-spawn path the backend mints the session id during
        // `startTurn`, so it isn't known yet here: pass the pre-created id when the
        // caller supplied one, else `null` (never fabricate an id). The built-in
        // factories ignore this context, so this is inert on the default path.
        const runner = await this.runnerFor(backend, {
          sessionId: opts.sessionId ?? null,
          projectId: contextProjectId,
          worktree: opts.worktree,
        });
        const turn = runner.startTurn(dispatchOpts, {
          onPermissionRequest: (request) => {
            const id = boundId;
            if (id === undefined) {
              // No session to park under yet — deny safe rather than register an
              // orphan the operator would never be shown. Explicit rather than left
              // to the turn tearing the connection down, because this prompt is
              // answerable right now and the agent is still waiting on it.
              void handle.answerPermission(request.toolUseId, {
                behavior: 'deny',
                message: 'session not yet established',
              });
              return;
            }
            if (this.permissionControl) this.trackPendingPermission(id, request);
          },
          ...(this.deps.bus !== undefined ? { bus: this.deps.bus } : {}),
        });
        handle.delegate = turn;
        try {
          return await turn.result;
        } finally {
          await cleanup();
        }
      })()
        .then(async (result) => {
          if (!handle.claimSettle('run')) return;
          const id = boundId; // capture for the nested closure (boundId is mutable)
          if (id !== undefined) {
            // Persist a cancellation's terminal marker before releasing the turn
            // fence. Otherwise a queued successor can start and append its prompt
            // first, after which this old turn's `interrupted` event terminalizes
            // the new turn. The write is best-effort, but its ordering is strict.
            if (result.aborted) {
              try {
                await this.emitInterrupted(id);
              } catch (error) {
                this.reportTurnError(id, error);
              }
            } else if (result.exitCode !== 0) {
              try {
                await this.ensureTerminalMarker(id, markerSeq ?? 0, result);
              } catch (error) {
                this.reportTurnError(id, error);
              }
            }
            await this.clearRunningTurn(id, markerSeq).catch((clearError: unknown) => {
              this.reportTurnError(id, clearError);
            });
            this.turns.delete(id);
            this.clearPermissions(id);
            this.releaseInFlight(id);
            const hadQueued = (this.queues.get(id)?.length ?? 0) > 0;
            this.drainNext(id);
            this.maybeAutoTitle(id);
            if (!hadQueued) this.flushDeferredWhenIdle(id);
            return;
          }
          // Ran to completion without ever binding a session (no `session` event).
          this.starting.delete(opts.worktree);
          reject(new Error('session did not start: no session event'));
        })
        .catch(async (error: unknown) => {
          if (!handle.claimSettle('run')) return;
          const err = error instanceof Error ? error : new Error(String(error));
          if (boundId !== undefined) {
            const id = boundId;
            // Persist the failure and clear its recovery marker while the old turn
            // still owns the fence. A queued successor must never append its prompt
            // before this terminal event.
            await this.reportBackgroundTurnFailure(id, err).catch((reportError: unknown) => {
              this.reportTurnError(id, reportError);
            });
            await this.clearRunningTurn(id, markerSeq).catch((clearError: unknown) => {
              this.reportTurnError(id, clearError);
            });
            this.turns.delete(id);
            this.clearPermissions(id);
            this.releaseInFlight(id);
            const hadQueued = (this.queues.get(id)?.length ?? 0) > 0;
            this.drainNext(id); // same: don't strand turns queued during the run
            if (!hadQueued) this.flushDeferredWhenIdle(id);
            return;
          }
          this.starting.delete(opts.worktree);
          reject(err);
        });
    });
  }

  /**
   * Validate the prompt, atomically claim the per-session lock, and resolve the
   * session. On success the lock is HELD (the caller must release it once its
   * run settles); on any post-claim failure the lock is released before
   * throwing. The claim is synchronous before the first await, so two concurrent
   * turns for one session can never both pass the guard. The busy check precedes
   * the claim, so a {@link SessionBusyError} never releases the OTHER turn's lock.
   */
  private async accept(
    sessionId: string,
    prompt: string,
    opts: TurnOptions = {},
  ): Promise<SessionRecord> {
    // Reject empty turns (no prompt AND no attachment): a blank `--resume` turn
    // would spawn a process and burn tokens for nothing (§13a). A bare screenshot
    // (attachment, empty prompt) is valid content and passes.
    if (!turnHasContent(prompt, opts)) throw new Error('turn must have a prompt or an attachment');
    if (this.inFlight.has(sessionId)) throw new SessionBusyError(sessionId);
    this.inFlight.add(sessionId);
    try {
      const session = await this.deps.store.getSession(sessionId);
      if (!session) throw new UnknownSessionError(sessionId);
      // Pre-flight the worktree: a resume spawns `claude` with `cwd: worktree`, and
      // a missing dir fails with `spawn ENOENT`. Reject here (lock released below)
      // so a session whose worktree was cleaned up is plainly unresumable, never a
      // spawn failure that could escape as an unhandled rejection.
      const exists = this.deps.worktreeExists ?? worktreeExists;
      if (!(await exists(session.worktree))) {
        throw new WorktreeMissingError(sessionId, session.worktree);
      }
      return session;
    } catch (error) {
      this.releaseInFlight(sessionId); // release only our just-claimed lock
      throw error;
    }
  }

  /**
   * Persist each uploaded image content-addressed in the store and return the
   * `prompt`-event references (id = the SHA-256 hash). Returns `undefined` for a
   * turn with no attachments. The heavy base64 is stored once here, NOT inlined
   * into the event — so opening a session never transfers the image backlog.
   */
  private async storeAttachments(
    uploads?: readonly AttachmentUpload[],
  ): Promise<Attachment[] | undefined> {
    if (!uploads || uploads.length === 0) return undefined;
    return Promise.all(
      uploads.map(async (u): Promise<Attachment> => {
        const id = await this.deps.store.putAttachment(u.mediaType, u.data);
        // Carry `fileName` for file attachments so the transcript can label them and a
        // rehydrated queued turn can re-materialize them under the right name.
        return u.kind === 'file'
          ? { kind: 'file', mediaType: u.mediaType, fileName: u.fileName, id }
          : { kind: 'image', mediaType: u.mediaType, id };
      }),
    );
  }

  /**
   * Serialize a turn's options for the durable queue (issue #80): copy the scalar
   * options verbatim and replace the heavy raw `attachments` uploads with their
   * content-addressed references (stored once in the blob table), so a queued
   * screenshot survives a restart without bloating the row. The inverse of
   * {@link toRuntimeOpts}.
   */
  private async toStorableOpts(opts: TurnOptions, displayPrompt?: string): Promise<QueuedTurnOpts> {
    const attachments = await this.storeAttachments(opts.attachments);
    return {
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.allowedTools !== undefined ? { allowedTools: [...opts.allowedTools] } : {}),
      ...(opts.disallowedTools !== undefined ? { disallowedTools: [...opts.disallowedTools] } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(displayPrompt !== undefined ? { displayPrompt } : {}),
    };
  }

  /**
   * Rehydrate a {@link QueuedTurnOpts} read back from the durable queue into runtime
   * {@link TurnOptions} (issue #80): the inverse of {@link toStorableOpts}. Each
   * attachment reference is re-read from the content-addressed blob store and
   * re-encoded as a base64 upload so the recovered turn dispatches exactly like a
   * freshly-sent one. A ref whose blob is missing is dropped (the turn still runs).
   */
  private async toRuntimeOpts(stored: QueuedTurnOpts): Promise<TurnOptions> {
    let attachments: AttachmentUpload[] | undefined;
    if (stored.attachments && stored.attachments.length > 0) {
      const uploads: AttachmentUpload[] = [];
      for (const ref of stored.attachments) {
        let data: string | undefined;
        if (ref.id !== undefined) {
          const blob = await this.deps.store.getAttachment(ref.id);
          if (blob) data = blob.bytes.toString('base64');
        } else if (ref.data !== undefined) {
          data = ref.data;
        }
        if (data === undefined) continue;
        uploads.push(
          ref.kind === 'file'
            ? { kind: 'file', mediaType: ref.mediaType, fileName: ref.fileName, data }
            : { kind: 'image', mediaType: ref.mediaType, data },
        );
      }
      if (uploads.length > 0) attachments = uploads;
    }
    return {
      ...(stored.permissionMode !== undefined ? { permissionMode: stored.permissionMode } : {}),
      ...(stored.timeoutMs !== undefined ? { timeoutMs: stored.timeoutMs } : {}),
      ...(stored.model !== undefined ? { model: stored.model } : {}),
      ...(stored.allowedTools !== undefined ? { allowedTools: stored.allowedTools } : {}),
      ...(stored.disallowedTools !== undefined ? { disallowedTools: stored.disallowedTools } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
    };
  }

  /**
   * Persist the operator's prompt as a canonical `prompt` event (so the
   * operator's own message shows in the transcript — claude's stream doesn't
   * echo it) and fan it out to live subscribers.
   */
  private async emitPrompt(
    sessionId: string,
    text: string,
    attachments?: readonly Attachment[],
    steered = false,
  ): Promise<void> {
    const event =
      attachments && attachments.length > 0
        ? {
            t: 'prompt' as const,
            text,
            attachments: [...attachments],
            ...(steered ? { steered } : {}),
          }
        : { t: 'prompt' as const, text, ...(steered ? { steered } : {}) };
    const { seq, ts } = await this.deps.store.appendEvent(sessionId, event);
    this.deps.bus?.publish(sessionId, { seq, ts, event });
  }

  /**
   * Persist the operator's prompt for a message that was STEERED into a live turn
   * (#101) — store its attachments content-addressed, then append the `prompt`
   * event. Best-effort: a failure routes to {@link ConductorDeps.onTurnError}
   * rather than rejecting, because the message has already been delivered to claude
   * (the caller returned its 202); a missing prompt event is a transcript blemish,
   * not a lost turn.
   */
  private async persistSteeredPrompt(
    sessionId: string,
    prompt: string,
    opts: TurnOptions,
  ): Promise<void> {
    try {
      await this.emitPrompt(sessionId, prompt, await this.storeAttachments(opts.attachments), true);
    } catch (error) {
      this.reportTurnError(sessionId, error);
    }
  }

  /**
   * Persist + fan out the terminal `interrupted` marker for an operator-cancelled
   * turn (issue #79), so the transcript shows the turn ended by operator action
   * (any partial output before it stays). Same persist→publish path as the prompt.
   */
  private async emitInterrupted(sessionId: string): Promise<void> {
    const event = { t: 'interrupted' as const };
    const { seq, ts } = await this.deps.store.appendEvent(sessionId, event);
    this.deps.bus?.publish(sessionId, { seq, ts, event });
  }

  /**
   * Best-effort durable "a turn is in flight" marker (lifecycle Phase 1). Written
   * before the backend runs so a mid-turn crash is settled by {@link recover}
   * rather than re-inferred from the event tail. A write failure only degrades to
   * the pre-Phase-1 behavior (a crash badges `running` until the next turn), so it
   * must never fail the turn — swallowed + logged.
   */
  private async markTurnRunning(sessionId: string, promptSeq: number): Promise<void> {
    try {
      await this.deps.store.markTurnRunning({ sessionId, promptSeq });
    } catch (error) {
      this.reportTurnError(sessionId, error);
    }
  }

  /**
   * Best-effort bind of the Server-allocated turn identity onto the in-flight
   * marker (ADR 0006 Stage 4, D2), so recovery can discover the turn on the Sandbox
   * supervisor and repeat its idempotent StartTurn. Swallowed + logged like
   * {@link markTurnRunning}: a bind failure only degrades Stage 4 recovery back to
   * settle-from-tail — it must never fail the turn. The marker row already exists
   * (the caller's `markTurnRunning` ran first); a missing row makes this a no-op.
   */
  private async bindTurnIdentity(
    sessionId: string,
    turnId: string,
    startCommandId: string,
  ): Promise<void> {
    try {
      await this.deps.store.bindTurnIdentity(sessionId, { turnId, startCommandId });
    } catch (error) {
      this.reportTurnError(sessionId, error);
    }
  }

  /**
   * Best-effort clear of the in-flight marker once a turn settles. Swallows so a
   * failed clear can neither mask the turn result nor block the lock release; a
   * stale marker self-heals (recovery finds its tail already terminal and just
   * drops it).
   */
  private async clearRunningTurn(sessionId: string, promptSeq?: number): Promise<void> {
    try {
      await this.deps.store.clearRunningTurn(sessionId, promptSeq);
    } catch (error) {
      this.reportTurnError(sessionId, error);
    }
  }

  /**
   * Replay a turn whose backend positively confirms the prompt never began.
   *
   * A silent CLI failure before its protocol start marker would otherwise be
   * terminalized and leave the session idle until another message arrives. The
   * backend's explicit `failedBeforeExecution` classification distinguishes that
   * safe case from mid-turn failures, where execution or external side effects may
   * already have happened and replay is therefore forbidden.
   *
   * Re-queued exactly like {@link recoverOrphanTailPrompts} replays a tail prompt
   * after a restart: `promptAlreadyPersisted` reuses the operator's ORIGINAL prompt
   * event instead of forging a second one, so the chat shows one message and one
   * answer. Enqueued from the run body, so the `finally` that already drains the
   * queue dispatches it.
   *
   * Deliberately NOT replayed: an operator cancel (`aborted`, or a signal exit
   * code), a turn whose budget is spent, any unclassified failure, or a turn that
   * persisted an event before dying (see the defense-in-depth guard below).
   */
  private async maybeAutoResume(
    sessionId: string,
    prompt: string,
    opts: TurnOptions,
    displayPrompt: string,
    spent: number,
    sinceSeq: number,
    result: RunResult,
    handle: SessionTurnHandle,
  ): Promise<boolean | 'cancelled'> {
    if (this.autoResumeAttempts <= 0) return false;
    if (result.aborted || result.exitCode === 0) return false;
    if (isExternalInterruptionExitCode(result.exitCode)) return false;
    if (spent >= this.autoResumeAttempts) return false;
    if (result.failedBeforeExecution !== true) return false;

    // Defense in depth: the backend phase signal is the authority because missing
    // transcript events alone cannot rule out an external side effect. Structured
    // rate-limit metadata is safe and must survive retry exhaustion; anything else
    // means the attempt progressed too far to replay.
    const produced = await this.deps.store.getEventsAfter(sessionId, sinceSeq);
    if (produced.some(({ event }) => event.t !== 'rate_limit')) return false;

    try {
      await sleep(this.autoResumeDelayMs, undefined, { signal: handle.controller.signal });
    } catch (error) {
      if (handle.controller.signal.aborted) return 'cancelled';
      throw error;
    }
    // Close the timer-boundary race: cancellation may be delivered after the
    // abortable sleep resolves but before this continuation gets to enqueue.
    if (handle.controller.signal.aborted) return 'cancelled';

    const queue = this.queues.get(sessionId) ?? [];
    // Front of the queue: this turn's prompt precedes anything enqueued while it
    // was running, and the transcript must not reorder around a replay.
    queue.unshift({
      prompt,
      opts,
      displayPrompt,
      promptAlreadyPersisted: true,
      autoResumeCount: spent + 1,
      autoResumeSignal: handle.controller.signal,
    });
    this.queues.set(sessionId, queue);
    return true;
  }

  /**
   * Safety net: if a turn's backend process exits non-zero WITHOUT emitting a
   * terminal event (and wasn't operator-cancelled), the session would badge
   * `running` forever — e.g. codex crashing before `thread.started` writes no
   * `error`/`result` at all. Append a synthetic terminal `error` so EVERY
   * non-zero exit settles, whatever the backend did. No-op when the turn
   * succeeded, was operator-cancelled, or the backend already wrote a terminal
   * marker (result/error/interrupted) since `sinceSeq` (the pre-run event seq) —
   * so a backend that DOES report its own crash (e.g. claude) is never
   * double-marked.
   */
  private async ensureTerminalMarker(
    sessionId: string,
    sinceSeq: number,
    result: RunResult,
  ): Promise<void> {
    if (result.aborted || result.exitCode === 0) return;
    const after = await this.deps.store.getEventsAfter(sessionId, sinceSeq);
    const settled = after.some((e) => isTurnTerminalEvent(e.event));
    if (settled) return;
    if (isExternalInterruptionExitCode(result.exitCode)) {
      await this.emitInterrupted(sessionId);
      return;
    }
    const tail = result.stderr ? `: ${result.stderr.slice(-500)}` : '';
    const event = {
      t: 'error' as const,
      kind: 'crashed',
      message: `agent exited with code ${result.exitCode} without a terminal event${tail}`,
    };
    const { seq, ts } = await this.deps.store.appendEvent(sessionId, event);
    this.deps.bus?.publish(sessionId, { seq, ts, event });
  }

  private async repairVisibleMediaOutput(
    sessionId: string,
    prompt: string,
    sinceSeq: number,
  ): Promise<void> {
    const events = (await this.deps.store.getEventsAfter(sessionId, sinceSeq)).map((e) => e.event);
    const event = buildVisibleMediaRepairEvent(prompt, events);
    if (event === undefined) return;
    const { seq, ts } = await this.deps.store.appendEvent(sessionId, event);
    this.deps.bus?.publish(sessionId, { seq, ts, event });
  }

  /**
   * Graceful-shutdown drain (P0b): for every session with a turn in flight,
   * append a best-effort terminal `interrupted` marker before the process exits,
   * so a turn abandoned by a server restart doesn't badge `running` forever
   * (SR-2). The agent process is killed by the exit; surviving the restart + live
   * reattach is a later slice (ADR-0006 §5a). Bounded so a wedged store can't
   * hang shutdown, and failures are swallowed — a missing marker self-heals on
   * the next turn, a stuck shutdown wouldn't. Call from the server's `onClose`
   * hook, which runs while the store is still alive (before `db.destroy`).
   *
   * Supervisor-backed turns are different: their Runner process lives outside the
   * Server and can be discovered by the durable `turn_id` marker after restart.
   * Marking those turns `interrupted` during a graceful restart makes startup
   * recovery see a terminal event and skip the reattach path while the external
   * Worker keeps running detached. Leave those markers open for D7 recovery.
   */
  async drainOnShutdown(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await this.stopTurnLivenessSweep(timeoutMs);
    const sessions = [...this.turns.keys()];
    if (sessions.length === 0) return;
    const reattachable = new Set(
      (await this.deps.store.listRunningTurns())
        .filter((marker) => marker.turnId !== null)
        .map((marker) => marker.sessionId),
    );
    const interruptSessions = sessions.filter((sessionId) => !reattachable.has(sessionId));
    if (interruptSessions.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
    });
    await Promise.race([
      Promise.allSettled(interruptSessions.map((s) => this.emitInterrupted(s))).then(
        () => undefined,
      ),
      bounded,
    ]);
    if (timer) clearTimeout(timer);
  }

  /**
   * Best-effort auto-naming, fired at turn START — right after the operator's prompt is
   * persisted, concurrently with the still-running turn — and again after the turn
   * settles as a fallback. No-ops unless the {@link ConductorDeps.autoTitle} hook is
   * configured and the session is still unnamed with at least `afterTurns` operator
   * prompts on record. When it fires it reads the opening events, asks the hook for a
   * 2–3 word title (using the session's model), and persists it as the display name.
   * Fully self-contained and fire-and-forget: it never throws into the turn path, and it
   * marks the session done on the first attempt so a failed generation doesn't retry on
   * every turn. Firing at turn start means the name is derived from the prompt (plus any
   * reply text already on record) without waiting for the reply to stream or settle.
   */
  private maybeAutoTitle(sessionId: string): void {
    const autoTitle = this.deps.autoTitle;
    if (!autoTitle) return;
    if (this.autoTitleDone.has(sessionId) || this.autoTitleInFlight.has(sessionId)) return;
    this.autoTitleInFlight.add(sessionId);
    void (async () => {
      try {
        const session = await this.deps.store.getSession(sessionId);
        // Unknown session, or the operator already named it (at spawn or via rename):
        // settle it so we never look again — auto-titling never overwrites a name.
        if (!session || session.name !== null) {
          this.autoTitleDone.add(sessionId);
          return;
        }
        const events = await this.deps.store.getEvents(sessionId);
        const prompts = events.reduce((n, e) => (e.t === 'prompt' ? n + 1 : n), 0);
        if (prompts < autoTitle.afterTurns) return; // too few chats yet — retry next settle
        // Route through the SAME backend the session runs turns on, picked by its
        // model (Claude / Codex / OpenCode, plus any per-session Docker wrapper), so
        // the title is generated by the operator's selected LLM. A backend without a
        // one-shot `query` simply yields no title (we still settle below).
        const backend = await this.backendForSession(session, session.model);
        const digest = buildConversationDigest(events, autoTitle.afterTurns);
        const prompt = buildTitlePrompt(digest);
        // Settle regardless of outcome: an empty/failed generation must not re-run on
        // every subsequent turn (the operator can still rename manually).
        this.autoTitleDone.add(sessionId);
        if (prompt.length === 0) return;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), autoTitle.timeoutMs ?? 45_000);
        let raw: string | undefined;
        try {
          raw = await this.queryWithBackend(
            backend,
            {
              prompt,
              model: session.model,
              cwd: session.worktree,
              signal: controller.signal,
            },
            {
              sessionId: session.sessionId,
              projectId: session.projectId,
              worktree: session.worktree,
            },
          );
          const title = raw !== undefined ? sanitizeTitle(raw) : undefined;
          if (title !== undefined && title.length > 0) {
            // Guarded write: skip if the operator named the session DURING this ~45s
            // query (renameSessionIfUnnamed is a no-op when a name already exists), so
            // auto-titling never clobbers a manual rename. If the operator took over the
            // name, don't auto-derive a branch either — they're driving.
            const named = await this.deps.store.renameSessionIfUnnamed(sessionId, title);
            if (named && autoTitle.onBranchName !== undefined) {
              // Contained per the `onBranchName` contract ("the conductor never lets
              // hook failures affect turns"). The title is already persisted at this
              // point, so everything below is a pure bonus: a worktree that isn't a git
              // repo (control-plane sessions), a rename git refuses, or a throwing hook
              // must not reach `reportTurnError` — that surfaces to the operator as a
              // failed turn even though their turn ran fine.
              try {
                const branchPrompt = buildBranchPrompt(digest);
                if (branchPrompt.length > 0) {
                  const branchRaw = await this.queryWithBackend(
                    backend,
                    {
                      prompt: branchPrompt,
                      model: session.model,
                      cwd: session.worktree,
                      signal: controller.signal,
                    },
                    {
                      sessionId: session.sessionId,
                      projectId: session.projectId,
                      worktree: session.worktree,
                    },
                  );
                  const branchName =
                    branchRaw !== undefined ? sanitizeBranchName(branchRaw) : undefined;
                  if (branchName !== undefined) await autoTitle.onBranchName(session, branchName);
                }
              } catch {
                // Swallowed on purpose — the session keeps its auto-title and its
                // existing branch label.
              }
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        this.reportTurnError(sessionId, error);
      } finally {
        this.autoTitleInFlight.delete(sessionId);
      }
    })();
  }

  /**
   * The names of the project's brokered secrets, or `undefined` when the session has
   * no project, the deployment wires no resolver, or the lookup fails.
   *
   * Gated on whether the backend can reach the tools at all, NOT on which of the two
   * channels carries them. The names answer "which `secretAlias` may I pass", and every
   * ACP turn reaching the tools through the loopback MCP gateway has to answer it.
   * Omitting them leaves ACP sessions guessing names, and a guess is indistinguishable from the
   * secret not existing, which pushes an agent toward reading Doppler itself.
   *
   * Skipping the lookup for a backend that carries no brokered tools also spares it a
   * provider round trip whose answer nothing would read.
   *
   * Fail-soft on purpose: the alias list is an aid, not an authorization step. The
   * broker re-checks every alias at call time, so a missing list costs discoverability
   * and nothing else, and a provider outage must not fail the turn.
   */
  private async brokeredAliasesFor(
    projectId: string | null | undefined,
    backend: Backend,
  ): Promise<readonly string[] | undefined> {
    if (!carriesBrokeredSecretTools(backend)) return undefined;
    if (projectId == null || this.deps.brokeredSecretAliases === undefined) return undefined;
    try {
      return await this.deps.brokeredSecretAliases(projectId);
    } catch {
      return undefined;
    }
  }

  /**
   * The project's operator-curated agent memory (ADR 0008), wrapped as a system-
   * prompt section, or an empty string when the session has no project or the
   * project has no memory set. Read via the sealed-safe raw path: memory is
   * plaintext (never encrypted), so this resolves even while the secret store is
   * sealed, exactly like the public settings read. The header frames the block as
   * curated-but-stale context, not authoritative instructions (see ADR 0008
   * "Security").
   */
  private async projectMemoryPrompt(session: SessionRecord): Promise<string> {
    if (session.projectId === null) return '';
    const settings = await this.deps.store.getProjectSettingsRaw(session.projectId);
    const memory = settings?.memory?.trim();
    if (memory === undefined || memory.length === 0) return '';
    return `\n\n## Project memory (operator-curated; may be stale — verify before relying on it)\n${memory}`;
  }

  /** Whether this session's project was created without a GitHub repository, so
   *  the turn prompt must drop its remote-bound directives. Control-plane and
   *  legacy sessions carry no project row to classify and keep the GitHub-shaped
   *  posture every session had before this existed.
   *
   *  A store failure is NOT swallowed. The classification is installed once per
   *  backend context and then lives for the whole conversation, so guessing
   *  through a transient error would durably seed a remote-less project with the
   *  very push/PR guidance this exists to remove. Failing the turn is also what
   *  the adjacent {@link projectMemoryPrompt} read already does on the same
   *  fresh-context path, so a down store fails it either way. */
  private async isLocalProjectSession(session: SessionRecord): Promise<boolean> {
    if (session.projectId === null) return false;
    const project = await this.deps.store.getProject(session.projectId);
    return project !== undefined && isLocalProject(project);
  }

  /** {@link isLocalProjectSession} for the spawn path, which is handed an id
   *  rather than a record. An unknown id is not an error here: `startSession`
   *  accepts a spawn whose session the backend still has to mint. */
  private async isLocalProjectSpawn(sessionId: string | undefined): Promise<boolean> {
    if (sessionId === undefined) return false;
    const session = await this.deps.store.getSession(sessionId);
    return session !== undefined && (await this.isLocalProjectSession(session));
  }

  private buildRunOpts(
    sessionId: string,
    prompt: string,
    session: SessionRecord,
    opts: TurnOptions,
    includeRuntimePrompt: boolean,
    localProject: boolean,
  ): RunTurnOptions {
    const permissionMode = opts.permissionMode ?? this.deps.permissionMode;
    const timeoutMs = opts.timeoutMs ?? this.deps.timeoutMs;
    // exactOptionalPropertyTypes: omit absent keys rather than assign undefined.
    return {
      store: this.deps.store,
      worktree: session.worktree,
      cwd: session.worktree,
      prompt,
      // Install runtime directives only when this turn starts a backend context.
      // Resumed contexts already carry the heavy runtime policy, but still receive
      // compact convergence directives that must affect existing long-lived
      // sessions: user-facing terminology and visible-media output contracts.
      // Fresh Agent Loop contexts additionally receive their proposal contract.
      appendSystemPrompt: includeRuntimePrompt
        ? turnSystemPrompt(session.kind, localProject)
        : RESUME_SYSTEM_PROMPT,
      model: opts.model ?? session.model,
      storeSessionId: sessionId,
      // Hold stdin open so a mid-turn operator message can be folded into THIS
      // running turn (#101). The steer channel the runner surfaces via `onSteer` is
      // captured by the RunnerClient and exposed as `RunnerTurn.steer`.
      steerable: true,
      // Mid-turn permission control loop (#27): surface each prompt so the operator
      // can approve/deny via decidePermission. Only when the conductor is configured
      // for it; otherwise the legacy posture applies. The runner's `onPermissionRequest`
      // is wired by the RunnerClient (which owns the respond channel and forwards the
      // inbound request to the conductor's `onPermissionRequest` hook).
      ...(this.permissionControl ? { permissionControl: true } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.disallowedTools !== undefined ? { disallowedTools: opts.disallowedTools } : {}),
      ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
      ...(this.deps.spawner !== undefined ? { spawner: this.deps.spawner } : {}),
      ...(this.deps.command !== undefined ? { command: this.deps.command } : {}),
      ...(this.deps.transcript !== undefined && this.deps.serverManagedTranscript !== true
        ? { transcript: this.deps.transcript }
        : {}),
      ...(this.deps.claudeHome !== undefined ? { claudeHome: this.deps.claudeHome } : {}),
      ...(this.deps.bus !== undefined ? { bus: this.deps.bus } : {}),
      ...(this.deps.env !== undefined || opts.protectedEnvironment !== undefined
        ? { env: { ...(this.deps.env ?? process.env), ...opts.protectedEnvironment } }
        : {}),
    };
  }

  private buildStartOpts(
    opts: StartOptions,
    localProject: boolean,
    onSession: (id: string) => void | Promise<void>,
  ): RunTurnOptions {
    const permissionMode = opts.permissionMode ?? this.deps.permissionMode;
    const timeoutMs = opts.timeoutMs ?? this.deps.timeoutMs;
    // Fresh run: NO resumeSessionId. cwd = worktree. onSession surfaces the
    // claude-minted id early. Model omitted → claude's headless default.
    return {
      store: this.deps.store,
      ...(opts.sessionId !== undefined ? { storeSessionId: opts.sessionId } : {}),
      worktree: opts.worktree,
      cwd: opts.worktree,
      prompt: opts.prompt,
      // Same per-turn directives (choices #97 + delegation #138) on a fresh session.
      appendSystemPrompt:
        opts.appendSystemPrompt === undefined
          ? turnSystemPrompt(opts.sessionKind, localProject)
          : `${turnSystemPrompt(opts.sessionKind, localProject)}\n\n${opts.appendSystemPrompt}`,
      onSession,
      // Mid-turn permission control loop (#27) for the first turn of a fresh session.
      // The runner's `onPermissionRequest` is wired by the RunnerClient; startSession's
      // hook parks it under the bound id (or denies safe before the id binds).
      ...(this.permissionControl ? { permissionControl: true } : {}),
      // Images seed the fresh agent riding along with the prompt. Non-empty
      // attachments flip the runner onto its stream-json stdin path (the spawn is
      // already steerable, so that path is live), feeding one image block per
      // upload in the seed user message.
      ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.disallowedTools !== undefined ? { disallowedTools: opts.disallowedTools } : {}),
      ...(this.deps.spawner !== undefined ? { spawner: this.deps.spawner } : {}),
      ...(this.deps.command !== undefined ? { command: this.deps.command } : {}),
      ...(this.deps.transcript !== undefined && this.deps.serverManagedTranscript !== true
        ? { transcript: this.deps.transcript }
        : {}),
      ...(this.deps.claudeHome !== undefined ? { claudeHome: this.deps.claudeHome } : {}),
      ...(this.deps.bus !== undefined ? { bus: this.deps.bus } : {}),
      ...(this.deps.env !== undefined ? { env: this.deps.env } : {}),
    };
  }
}
