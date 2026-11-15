import type { stat } from 'node:fs/promises';
import type { EventStore, SessionRecord, TranscriptStore } from '@verity/store';
import type { EventBus } from './bus.js';
import type { AcpClaudeBackend } from './acp-claude-backend.js';
import type { Backend, BrokeredGrantChannel } from './backend.js';
import type { BrokeredGrantToolName } from './brokered-grants.js';
import type { Spawner } from './backend-contract.js';
import type {
  LoopbackRunnerClient,
  RunnerClientFactory,
  RunnerRecovery,
} from './runner-contract.js';
import type { TurnPreparationContext } from './conductor.js';

export interface ConductorDeps {
  /** Project migrations run before claiming a turn, so no live backend sees a replaced path. */
  prepareSession?: ((sessionId: string) => Promise<void>) | undefined;
  /** Filesystem preparation and publication, awaited while the turn owns its session. */
  ensureWorkspace?: ((session: SessionRecord) => Promise<void>) | undefined;
  prepareWorkspace?: ((session: SessionRecord) => Promise<void>) | undefined;
  settleWorkspace?: ((session: SessionRecord) => Promise<void>) | undefined;
  store: EventStore;
  /** A session changed in a way no event records: it started or stopped
   * working, or received an automatic name. Lets live overviews refresh the row.
   * Must not throw; called synchronously. */
  onSessionChanged?: ((sessionId: string, change: 'activity' | 'name') => void) | undefined;
  /** Server-resolved scoped Instructions/Memory; never selected by request options. */
  agentContext?:
    | ((
        session: SessionRecord,
        initiatedBy?: { userId: string },
      ) => Promise<{ fingerprint: string; prompt: string; compact?: boolean }>)
    | undefined;
  /**
   * Whose backend thread a turn resumes (ADR 0023 §3–4): `undefined` for the
   * project's original sandbox and turns without a person, otherwise a stable tag
   * of the person. A native thread lives in one account and one sandbox, so each
   * person resumes only their own and catches up on the others' turns from the
   * transcript.
   */
  backendStateScope?:
    | ((
        session: SessionRecord,
        initiatedBy: { userId: string } | undefined,
      ) => Promise<string | undefined>)
    | undefined;
  /** Project overview.md contents for a fresh backend context. */
  projectOverview?: ((projectId: string) => Promise<string | undefined>) | undefined;
  /** Bounded decision references refreshed on every turn, including resumed contexts. */
  projectDecisionDirectory?: ((projectId: string) => Promise<string>) | undefined;
  /** Durable Verity-owned system context selected from the persisted session.
   * Evaluated whenever a fresh backend context starts, so an empty session can
   * receive hidden capabilities on its first real turn without a synthetic turn. */
  sessionSystemPrompt?: ((session: SessionRecord) => string | Promise<string>) | undefined;
  /** The "Assigned tasks" section for a session (docs/TASKS_AND_QUICK_CAPTURE_CONCEPT.md
   * §6.2). Rebuilt on EVERY turn, resumed contexts included, so compaction or a
   * backend switch cannot lose the list; empty when nothing is assigned. */
  assignedTasksPrompt?: ((session: SessionRecord) => string | Promise<string>) | undefined;
  /** Secret alias NAMES eligible for `verity_http_request` / `verity_secret_run` in a
   * project (ADR 0011 D3); best-effort — failures or absence simply omit the list from
   * the turn context. Backend-independent: the names reach every ACP backend that can
   * call those tools over the MCP gateway. */
  /** Secret alias names for a turn; resolved with the turn's person's Doppler
   *  connection (ADR 0023 §3), so `initiatedBy` is part of the lookup. */
  brokeredSecretAliases?:
    | ((
        projectId: string,
        initiatedBy: { readonly userId: string } | undefined,
      ) => Promise<readonly string[]>)
    | undefined;
  /** ADR 0011 D2: does a persisted grant cover this (project, session, alias, tool, target)?
   * True auto-approves the brokered-secret prompt without operator interaction.
   * `channel` is the transport this prompt arrived on (ADR 0014 D3); the store applies
   * the ACP ceiling to it. */
  checkBrokeredHttpGrant?:
    | ((input: {
        projectId: string;
        sessionId: string;
        /** The turn's person (null for a turn without one); only their grants apply. */
        userId: string | null;
        secretAlias: string;
        toolName: BrokeredGrantToolName;
        target: string;
        channel: BrokeredGrantChannel;
        bindingId?: string;
      }) => Promise<boolean>)
    | undefined;
  /** ADR 0011 D2: persist a scoped brokered-secret grant after an operator allow.
   * `channel` records which transport the operator answered on, so a decision made on
   * one never auto-approves the other (ADR 0014 D3). */
  persistBrokeredHttpGrant?:
    | ((input: {
        projectId: string;
        sessionId: string;
        /** The person who answered the card; the grant is their consent. */
        userId: string;
        secretAlias: string;
        toolName: BrokeredGrantToolName;
        target: string;
        scope: 'session' | 'project' | 'forever';
        channel: BrokeredGrantChannel;
        bindingId?: string;
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
   * `BACKEND_ARTIFACT_PURGE_TIMEOUT_MS`. It runs only when a bind actually
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
   * Defaults to `RUNNER_RECOVERY_DISCOVER_TIMEOUT_MS`; a slow/hanging seam past
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
   * answers via `Conductor.decidePermission`. Defaults to OFF — opt in once
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
   * further enqueue throws `QueueFullError`. Defaults to 10. */
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
   * `AUTO_RESUME_DELAY_MS`. */
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
