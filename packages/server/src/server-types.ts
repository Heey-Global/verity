import type { AgentEvent, Attachment, RateLimitState, UsageTotals } from '@verity/events';
import type {
  EventStore,
  ProjectRecord,
  SessionAutomationStatus,
  SessionRecord,
  VeritySettingsPatch,
  VeritySettingsRecord,
} from '@verity/store';
import type { AttentionSignal } from './attention.js';
import type { ClaudeCredentialStatus } from './claudeUsage.js';
import type { PullRequestStatus } from './forge-provider.js';
import type { ProjectAgent } from './project-agent-policy.js';
import type { SandboxUpdateStatus } from './sandbox-updates.js';
import type { SessionGoogleStatus } from './session-google-status.js';
import type { SessionStatus } from './status.js';
import type { ToolkitCarrier, ToolkitDriftVerdict } from './toolkit-drift.js';
import type { VulnerabilitySummary } from './vulnerability-session.js';

/** What the reconciler knows about a sandbox update that the image checker cannot:
 *  whether the automatic repair has given up, and whether it is being held off by
 *  a turn. Passed as one value so a call site cannot read one and forget the
 *  other — they are overlaid onto the same status by the same function. */
export interface SandboxRepairVerdicts {
  unrepaired: ReadonlySet<string>;
  turnBlocked: ReadonlySet<string>;
}

export type PublicVeritySettingsRecord = Omit<
  VeritySettingsRecord,
  | 'gitSshPrivateKey'
  | 'gitSshPublicKey'
  | 'gitKnownHosts'
  | 'gitAllowedSigners'
  | 'githubAppPrivateKey'
  | 'dopplerServiceToken'
  | 'transcribeApiKey'
  | 'claudeCodeOauthCredentialsJson'
  | 'codexAuthJson'
  | 'opencodeApiKey'
  | 'googleDriveRefreshToken'
  | 'uplinkSubscriptionKey'
> & {
  gitSshPrivateKeyConfigured: boolean;
  gitSshPublicKeyConfigured: boolean;
  gitKnownHostsConfigured: boolean;
  gitAllowedSignersConfigured: boolean;
  githubAppPrivateKeyConfigured: boolean;
  dopplerServiceTokenConfigured: boolean;
  transcribeApiKeyConfigured: boolean;
  /** Always false: Verity no longer bundles a local transcription backend, so
   * meeting audio is only transcribed by a configured remote one. Kept on the
   * wire so an older app build keeps parsing this response — and keeps its local
   * option disabled — instead of failing schema validation. */
  transcribeLocalAvailable: boolean;
  /** True when a remote transcription backend is effectively configured — the
   * app's own settings or, failing that, the deployment environment supply both
   * a base URL and a model. The stored fields alone cannot answer this (an
   * environment-configured deployment stores neither), so the app would either
   * call a working backend unconfigured or, worse, call an unconfigured one
   * ready and then have every upload rejected. */
  transcribeExternalConfigured: boolean;
  /** Always false, and no longer stored: the nightly sandbox auto-update policy
   * these two toggles set is gone, because Verity repairs its own sandboxes (see
   * `SandboxSelfRepairState`). Kept on the wire for the same reason as
   * `transcribeLocalAvailable` — an app build from before the removal requires
   * both booleans, and an app one release behind the Server is the NORMAL state
   * for as long as it takes the user to install an update, since the Server
   * updates itself. Without them that app fails settings validation outright.
   * Drop together with the columns in a later release. */
  sandboxAutoUpdateSecurity: boolean;
  sandboxAutoUpdateNormal: boolean;
  claudeCodeOauthCredentialsConfigured: boolean;
  claudeCredentialStatus?: ClaudeCredentialStatus;
  codexAuthJsonConfigured: boolean;
  /** Plan labels derived from the stored logins (`agent-subscription.ts`). */
  claudeSubscriptionPlan: string | null;
  codexSubscriptionPlan: string | null;
  opencodeApiKeyConfigured: boolean;
  /** True once a Drive refresh token is stored (ADR 0009). The client id +
   *  account email pass through as plaintext for the connect UI. */
  googleDriveConnected: boolean;
  uplinkSubscriptionKeyConfigured: boolean;
};

export interface ProjectSettingsRecord {
  devcontainerEnabled?: boolean;
  projectId: string;
  dopplerTokenRef: string | null;
  dopplerToken: string | null;
  dopplerProject: string | null;
  dopplerConfig: string | null;
  dopplerMintedToken: string | null;
  dopplerMintedTokenSlug: string | null;
  defaultBranch: string | null;
  defaultModel: string | null;
  memory: string | null;
  googleDriveFolderId: string | null;
  googleDriveFolderName: string | null;
  googleDriveAccessMode: 'read-only' | 'read-write';
  /** Agents sessions in this project may use; null permits every connected agent. */
  allowedAgents: ProjectAgent[] | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ProjectSettingsKey =
  | 'devcontainerEnabled'
  | 'dopplerTokenRef'
  | 'dopplerToken'
  | 'dopplerProject'
  | 'dopplerConfig'
  | 'dopplerMintedToken'
  | 'dopplerMintedTokenSlug'
  | 'defaultBranch'
  | 'defaultModel'
  | 'memory'
  | 'googleDriveFolderId'
  | 'googleDriveFolderName'
  | 'googleDriveAccessMode'
  | 'allowedAgents';

export type ProjectSettingsPatch = {
  [K in ProjectSettingsKey]?: ProjectSettingsRecord[K] | undefined;
};

export type PublicProjectSettingsRecord = Omit<
  ProjectSettingsRecord,
  'dopplerTokenRef' | 'dopplerToken' | 'dopplerMintedToken' | 'dopplerMintedTokenSlug'
>;

// `hiddenAt` is an internal soft-delete marker: hidden projects are filtered out
// of `listProjects` before serialization, so the field would always be null on
// the wire and adds nothing for clients — omit it from the public shape.
export interface PublicProjectRecord extends Omit<
  ProjectRecord,
  'hiddenAt' | 'kind' | 'state' | 'sleepCompatibilityFingerprint'
> {
  kind?: ProjectRecord['kind'];
  /** Legacy-compatible coarse state. Sleeping projects remain usable and wake on
   * demand, so clients predating sleep/wake render them as active. */
  state: Exclude<ProjectRecord['state'], 'sleeping_starting' | 'sleeping' | 'waking'>;
  /** Detailed lifecycle state for clients that understand sandbox sleep/wake. */
  lifecycleState?: ProjectRecord['state'];
  /** Latest published release for the overview version badge (#release-badge).
   *  All null when GitHub isn't configured, the repo has no releases, or the
   *  lookup hasn't resolved yet — the overview then simply shows no version. */
  latestReleaseTag: string | null;
  latestReleaseName: string | null;
  latestReleaseUrl: string | null;
  latestReleasePublishedAt: string | null;
  vulnerabilitySummary?: VulnerabilitySummary | undefined;
  sandboxUpdate: SandboxUpdateStatus;
  /** Whether this project's recorded attestation verdict still holds against the
   *  toolkit this Server ships — `null` for every row the drift report declines
   *  to judge (see `isDriftReportable`: the control plane, and anything not
   *  `active`). Null is "no subject", NOT "clean". */
  toolkitDrift: ProjectToolkitDrift | null;
}

/** The drift verdict as the app needs it: the judgement, plus the carrier that
 *  decides which remedy applies. The report's `name` is omitted — the client
 *  already knows which project it is holding. */
export interface ProjectToolkitDrift {
  verdict: Exclude<ToolkitDriftVerdict, 'unknown'>;
  carrier: ToolkitCarrier;
}

export interface VeritySettingsStore extends EventStore {
  getVeritySettings(): Promise<VeritySettingsRecord | undefined>;
  updateVeritySettings(patch: VeritySettingsPatch): Promise<VeritySettingsRecord>;
  updateTranscribeBackendMode(mode: 'local' | 'external'): Promise<void>;
}

export interface ProjectSettingsStore extends EventStore {
  getProjectSettings(projectId: string): Promise<ProjectSettingsRecord | undefined>;
  updateProjectSettings(
    projectId: string,
    patch: ProjectSettingsPatch,
  ): Promise<ProjectSettingsRecord | undefined>;
}

export interface ProjectDeleteStore extends EventStore {
  hideProject(projectId: string): Promise<boolean>;
}

/**
 * The remote backend a recording would ACTUALLY be sent to right now.
 *
 * The encrypted app settings are the only transcription configuration. Unset
 * settings mean there is no backend; there is no deployment fallback or bundled
 * backend to stand in. One function so the answer the
 * app renders (`GET /settings`, `GET /settings/transcription`) cannot drift from
 * the one the upload path enforces in `runMeetingTranscriptionCommand`: a stored URL
 * takes the whole backend selection with it.
 */
export interface EffectiveExternalTranscription {
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly apiKeyConfigured: boolean;
}

/** Response of `GET /models`: the currently usable model ids plus spawn default. */
export interface ModelList {
  /** Every currently usable model id. Claude and Codex appear only when the matching
   * subscription login exists in Verity settings; OpenCode provider-qualified ids
   * appear when the backend enumerates them. */
  models: string[];
  /** Preferred picker order for clients that support provider-defined ranking. Every
   * id also remains present in `models`; older clients may keep their own ordering. */
  modelOrder?: string[] | undefined;
  /** Less-prominent models that clients may place behind a generic "More models"
   * disclosure. Every id also remains present in `models`. */
  moreModels?: string[] | undefined;
  /** The id a fresh spawn defaults to. Omitted when no model is currently usable. */
  default?: string | undefined;
}

/** The log-derived half of an activity poll: the events the status derivation
 *  runs over, and whether the session has a task lifecycle at all. */
export interface ActivityProjection {
  events: AgentEvent[];
  hasTaskLifecycle: boolean;
}

/** One rejected attachment, named the way the operator sees it in the composer. */
export interface RejectedTurnAttachment {
  index: number;
  fileName?: string;
  reason: string;
}

/** One {@link SESSION_ARTIFACT_PURGE_TIMEOUT_MS} shared by a whole run of deletes, so a
 *  project teardown is bounded by that budget rather than by it times the session count.
 *  Mutable and passed by reference on purpose: each delete spends from it what it waited. */
export interface SessionArtifactPurgeBudget {
  remainingMs: number;
}

/** The answer `DELETE /projects/:id` settled on, carried as a value so a second
 *  request that joined the first can replay its status code too. */
export type ProjectDeleteOutcome = {
  code: number;
  body: { projectId: string } | { error: string };
};

/** What `POST /sessions` answers with: the created (or already existing) session,
 * a project that first has to finish provisioning, warnings the operator must
 * confirm, or an error. */
export type SpawnResult =
  // `existing` marks the idempotent answer to a repeated client-minted id: this
  // call did not mint the session, so a caller that would follow a create with a
  // prepared first turn knows not to send it twice.
  | { sessionId: string; existing?: true }
  | { project: PublicProjectRecord; awaitingProvisioning: true }
  | { requiresConfirmation: true; warnings: string[] }
  | { error: string; status?: 'sealed' };

/** Compact PR status for a session's current branch, carried on the list so the
 * overview can mark merge-ready / merge-blocked / CI-failed sessions (#387). A projection of the
 * richer {@link PullRequestStatus} (drops title/url/checks the list doesn't need). */
export interface SessionPrSummary {
  viewerCanMerge?: boolean;
  phase: PullRequestStatus['phase'];
  pipeline: PullRequestStatus['pipeline'];
  mergeable: PullRequestStatus['mergeable'];
  /** Carried so the overview can mark a CONFLICTED session (`'dirty'`): such a PR has
   * no checks at all, so `pipeline`/`mergeable` alone can't tell it apart from a PR
   * whose CI simply hasn't started. */
  mergeState?: PullRequestStatus['mergeState'];
}

export interface SessionSummary extends SessionRecord {
  linked?: boolean;
  /** Position within a manually ordered overview group; null means automatic. */
  sortOrder?: number | null;
  status: SessionStatus;
  /** Permission ids currently awaiting a decision. Carried on the list so the
   * overview can retire its "Needs input" badge optimistically after answering. */
  pendingPermissions: string[];
  /** Present only when awaiting_input is specifically the parked permission above. */
  permissionAwaitingInput?: true;
  /** Cumulative token usage across the session's turns (§13a). */
  usage: UsageTotals;
  /** Latest 5-hour rate-limit state observed in the session log, if any. */
  rateLimit?: RateLimitState;
  /** Latest active 5-hour rate-limit states by provider, latest reset first. */
  rateLimits?: RateLimitState[];
  /** Whether a steering turn can still be sent: false once the session's worktree
   * is gone (e.g. an isolated worktree cleaned up after its PR merged). The UI
   * disables the input + flags such a session instead of letting a turn 410. */
  resumable: boolean;
  /** Compact PR status for the current branch (#387). `null` = looked up, no open
   * PR; ABSENT = GitHub not configured (no `branchPrStatus`) or not yet resolved. */
  pr?: SessionPrSummary | null;
  /** Cached full status lets an opened session paint its PR bar before revalidation. */
  pullRequest?: PullRequestStatus | null;
  /** The worktree's current branch, from the branch-label cache, so the overview
   * can show the session's issue (`<type>/<issue>-<slug>`). ABSENT while the label
   * is cold, the worktree is gone, or branch switching is not configured. */
  branch?: string;
  /** Background work can continue while the main agent awaits input. */
  backgroundWorking?: boolean;
  /** Nonempty agent-text events; compared against the synced
   * read marker to show the overview unread dot. */
  eventCount: number;
  /** Version associated with eventCount; absent in summaries from older servers. */
  agentTextCounterVersion?: 'agent-text-v2';
  /** Timestamp of the newest canonical event, for metadata-only recency displays. */
  lastActivityAt: number | null;
  /**
   * Conditions about THIS session worth interrupting the operator for — currently
   * only `sandbox_disconnected` (see `attention.ts`). Absent when there is
   * nothing to report, which is the overwhelmingly common case.
   *
   * On the summary rather than in the list envelope's `attention` because it is a
   * per-SESSION fact: a fleet-wide banner cannot name the session it is about.
   *
   * It rides the DEFAULT response rather than needing `?envelope=1` because it
   * safely can. What forced the envelope was the top-level array→object switch,
   * which an installed app parsing `z.array(...)` cannot survive. Each ELEMENT is
   * parsed with a `z.object(...)`, whose default is to strip unknown keys — so an
   * old build ignores this field rather than failing on it.
   */
  attention?: AttentionSignal[];
  /** The session's recurring automation, so the overview can mark sessions with
   * scheduled work. Absent when the session has none. */
  automation?: { status: SessionAutomationStatus };
}

/**
 * The opt-in (`GET /sessions?envelope=1`) form of the session list: the same
 * array, plus anything server-level the operator needs to see. `attention` is
 * absent when the Server is healthy — see `attention.ts` for why it rides this
 * response instead of a channel of its own.
 */
export interface SessionListEnvelope {
  sessionReordering?: true;
  sessions: SessionSummary[];
  attention?: AttentionSignal[];
}

export interface SessionDetail extends SessionSummary {
  googleStatus?: SessionGoogleStatus | undefined;
  /** True while a turn is in flight for this session (the agent is working) —
   * the live "Agent is working…" signal, server-authoritative so it survives
   * the app navigating away + back. */
  busy: boolean;
  /** Turns queued behind the in-flight one (#90), FIFO — shown as persistent
   * "waiting to send" messages. Each carries a stable `id` so the operator can tap
   * it to retract the queued turn (#80). Server-backed so they're not lost on
   * navigation. */
  queued: { id: string; text: string; attachments?: Attachment[] }[];
}
