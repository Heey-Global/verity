import { createHash, randomUUID } from 'node:crypto';
import {
  type AgentEvent,
  SESSION_PROJECTION_EVENT_TYPES,
  externalizeToolResultImages,
  externalizeToolResultText,
  parseAgentEvent,
} from '@verity/events';
import { type Kysely, type Selectable, sql, type Transaction } from 'kysely';
import { type SecretCipher, createPassthroughCipher } from './crypto.js';
import { isManagedDevServerHostPort, nextFreeDevServerHostPort } from './dev-server-ports.js';
export {
  DEV_SERVER_HOST_PORT_RANGES,
  DevServerPortRangeExhaustedError,
} from './dev-server-ports.js';
import { scrubNulEscapes } from './nul-scrub.js';
import { redactSecrets } from './redact.js';
import { computeNextRun } from './schedule.js';
import type {
  Database,
  PublicPreviewSharesTable,
  QueuedTurnOpts,
  ScheduleConfig,
} from './schema.js';

/** A stored image blob: its media type and raw bytes (for serving). */
export interface AttachmentBlob {
  mediaType: string;
  bytes: Buffer;
}

export {
  backfillInlineAttachments,
  backfillToolResultImages,
  backfillToolResultText,
} from './attachment-backfills.js';

export interface SessionRecord {
  sessionId: string;
  worktree: string;
  model: string;
  /** Operator-assigned display name; `null` until set at spawn or via rename. */
  name: string | null;
  /** Project the session runs in (concept §19); `null` for project-less
   *  (or pre-projects-slice) sessions. */
  projectId: string | null;
  /** Ordinary chat session or the durable home of an Agent Loop. */
  kind: 'normal' | 'agent_loop';
  /** Operator's "last seen" mark for the overview unread dot (#387): the session's
   *  `eventCount` at the last open. `null` = never opened → not unread. Global, so
   *  it syncs across devices; advanced monotonically by {@link EventStore.setSessionSeen}. */
  lastSeenEventCount: number | null;
}

/** Input to {@link EventStore.createSession}: a {@link SessionRecord} whose
 * `name` is optional (a fresh session starts nameless unless the operator named
 * it at spawn). */
export type SessionInput = Omit<
  SessionRecord,
  'name' | 'projectId' | 'kind' | 'lastSeenEventCount'
> & {
  name?: string | null;
  projectId?: string | null;
  kind?: 'normal' | 'agent_loop';
};

/**
 * Multi-repo fleet-registry project state (concept §19.3, #174). Mirrors the
 * `projects.state` column as a closed string-enum at the app layer. Transitions
 * guarded by a `SELECT … FOR UPDATE` lock (§19.3):
 *   `absent → cloning → container_starting → active`
 *   `cloning|container_starting → failed`
 *   `failed → cloning` (retry via deprovision + re-provision, §19.8).
 */
export type ProjectState = 'absent' | 'cloning' | 'container_starting' | 'active' | 'failed';
export type ProjectSetupState = 'pending' | 'secrets_skipped' | 'complete';
export type ProjectKind = 'github' | 'control_plane' | 'local';

/** Reserved `owner` for projects created without a GitHub repository. Keeps them
 *  inside the existing `UNIQUE(owner, repo)` identity without a nullable owner,
 *  and makes "is this project on GitHub yet" a single-column question. The
 *  leading underscores are forbidden by GitHub's account-name grammar, so this
 *  namespace cannot collide with an installation repository. */
// Leading underscores make this impossible as a GitHub account name while
// remaining safe in the DB, Docker names, and managed clone paths.
export const LOCAL_PROJECT_OWNER = '__local__';

/** Thrown when `(owner, repo)` is spoken for by a DIFFERENT project than the one
 *  writing. Carries the driver's unique-violation code so existing callers that
 *  branch on `23505` keep working; exported so the installation sync can tell
 *  "a link is mid-flight" apart from a genuine write failure. */
export class ProjectIdentityClaimConflict extends Error {
  readonly code = '23505';
}

/** Whether a project has no GitHub repository behind it (yet). */
export function isLocalProject(project: Pick<ProjectRecord, 'kind'>): boolean {
  return project.kind === 'local';
}

/**
 * Whether a project row is an unadopted installation-sync placeholder — a row
 * {@link syncProjectsFromInstallation} minted purely because the GitHub App can
 * SEE the repository, not because anyone added it as a project.
 *
 * This exists because those placeholders otherwise make `link-github`
 * unreachable: the sync registers every visible repo within seconds of its
 * creation, so by the time an operator points a local project at a freshly
 * created empty repo, Verity already holds `(owner, repo)` itself and reports
 * its own bookkeeping row as "already registered as a project". The set of repos
 * the linker can push to and the set the sync claims are the SAME set, so
 * without adoption the feature can never succeed.
 *
 * `overviewVisible=false` is the durable provenance marker: explicit project
 * addition sets it true and installation sync deliberately leaves it false.
 * Record-level half of the test only; the authoritative check
 * additionally requires that nothing was ever worked on in the project, which
 * needs a query — see the store's `retireInstallationPlaceholder`. Callers
 * that only hold a {@link ProjectRecord} use this for an early-out and let the
 * store transaction have the final word.
 */
export function isInstallationPlaceholder(
  project: Pick<ProjectRecord, 'kind' | 'state' | 'overviewVisible'>,
): boolean {
  return (
    project.kind === 'github' && project.state === 'absent' && project.overviewVisible !== true
  );
}

/** Multi-repo fleet-registry project record (`projects` row, concept §19.2). */
export interface ProjectRecord {
  id: string;
  owner: string;
  repo: string;
  containerName: string;
  kind?: ProjectKind;
  /** Host clone-directory name override; `null` = derive `<owner>-<repo>`. Set
   *  for `local` projects and preserved when they are linked to GitHub, so the
   *  clone (and every session worktree persisted under it) never moves. */
  cloneDir?: string | null;
  imageRef: string | null;
  /** The image the operator pinned for this project, or `null` when Verity
   *  chooses the default. Configuration, not observation: it says what the next
   *  provisioning must start from.
   *
   *  {@link imageRef} is normally what the last provisioning selected, but a pin
   *  is written into BOTH, so between the pin and the next provisioning the two
   *  agree while the Sandbox still runs the older image. Equal values therefore
   *  mean the effective image is the pinned one — which is what settles that
   *  Verity did not build it, whatever the image is named. */
  imageOverrideRef?: string | null;
  /** Content identity of the runner-boundary trust root the last provisioning
   *  judged this project against. `null`/absent = unknown, which is NOT the same
   *  as current — see `projects.toolkit_identity`. */
  toolkitIdentity?: string | null;
  state: ProjectState;
  archived?: boolean;
  provisionError: string | null;
  provisionWarning: string | null;
  /** Soft-delete marker: `null` = visible, a `Date` = operator-hidden. Hidden
   *  projects are excluded from {@link EventStore.listProjects} by default. */
  hiddenAt: Date | null;
  /** Operator-defined overview order; `null` for projects never manually sorted. */
  sortOrder?: number | null;
  /** Operator's overview fold state; `true` when the project group is collapsed.
   *  Persisted so the expand/collapse choice syncs across devices. */
  collapsed?: boolean;
  /** True once the repo was explicitly added as a Verity project. Paused
   *  (`state='absent'`) projects with this flag stay visible in the overview. */
  overviewVisible?: boolean;
  setupStatus?: ProjectSetupState;
  /** Persisted display-cache of the repo's latest GitHub release (overview version
   *  badge). All `null` until a lookup resolves / for a repo with no releases.
   *  `latestReleasePublishedAt` is GitHub's ISO string (display-only). Written by
   *  {@link EventStore.updateProjectReleaseStatus}; the live freshness is owned by
   *  the server's in-memory release service. */
  latestReleaseTag: string | null;
  latestReleaseName: string | null;
  latestReleaseUrl: string | null;
  latestReleasePublishedAt: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** When {@link EventStore.updateProjectState} last wrote `state`. Use this —
   *  never `updatedAt` — to reason about how long a project has been in its
   *  current provisioning state: `updatedAt` is bumped by unrelated writers
   *  (installation sync, release badge, sort order) that leave `state` alone. */
  stateChangedAt: Date;
}

export interface MessageSearchInput {
  query: string;
  sessionId?: string;
  projectId?: string;
  limit?: number;
  cursor?: { rank: number; createdAt: number; id: number };
}

export interface MessageSearchResult {
  id: number;
  sessionId: string;
  sessionName: string | null;
  projectId: string | null;
  projectName: string | null;
  role: 'user' | 'agent';
  kind: 'prompt' | 'text' | 'notice';
  text: string;
  firstEventSeq: number;
  createdAt: number;
  rank: number;
}

/** Input to {@link EventStore.updateProjectReleaseStatus} — the latest-release
 *  fields refreshed independently of the installation-sync upsert. A plain shape
 *  (not the server's `ReleaseSummary`) so the store stays free of server types. */
export interface ProjectReleaseStatus {
  tag: string | null;
  name: string | null;
  url: string | null;
  publishedAt: string | null;
}

/** Input to {@link EventStore.upsertProject} — everything but the DB-managed
 * `created_at`/`updated_at`/`provision_error` columns. `id` is caller-supplied
 * (UUID) so an upsert can target an existing row. */
export interface ProjectUpsertInput {
  id: string;
  owner: string;
  repo: string;
  containerName: string;
  kind?: ProjectKind;
  /** Explicit host clone-directory name; omit to derive `<owner>-<repo>`. Only
   *  written on INSERT — an existing row keeps whatever directory its clone
   *  already lives in. */
  cloneDir?: string | null;
  imageRef?: string | null;
  state: ProjectState;
  archived?: boolean;
  /** When `true`, an upsert that hits an existing (owner, repo) row clears its
   *  `hidden_at` — the "re-add a previously deleted project" path (POST
   *  /projects). The GitHub-installation sync omits it, so a re-sync never
   *  un-hides an operator-removed project. */
  restore?: boolean;
  /** Mark this repo as intentionally added to the project overview. Installation
   *  sync omits it so unadded `absent` repos stay picker-only. */
  overviewVisible?: boolean;
}

export interface SessionBackendStateRecord {
  sessionId: string;
  backend: string;
  backendSessionId: string;
  contextSeq: number;
  updatedAt: Date;
}

/** The terminal states an Agent Loop run can settle in (ADR 0008). */
export type AgentLoopRunOutcome = 'ok' | 'acted' | 'error' | 'skipped';

/** The lifecycle status of an Agent Loop (ADR 0008 §7). Only `enabled` fires. */
export type AgentLoopStatus = 'draft' | 'enabled' | 'paused';

/** Raised when a caller tries to arm a loop that has not proven its current
 * script in a successful test run. Routes translate this to a 409 response. */
export class AgentLoopNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentLoopNotReadyError';
  }
}

/** Stable fingerprint used to bind a green test to the complete executable
 * Agent Loop configuration that ran. Any config edit must require a new test. */
export function agentLoopConfigFingerprint(config: {
  script: string | null;
  schedule: ScheduleConfig | null;
  reactionPrompt: string | null;
  reactionModel: string | null;
}): string {
  const canonical = JSON.stringify({
    script: config.script,
    schedule: config.schedule,
    reactionPrompt: config.reactionPrompt,
    reactionModel: config.reactionModel,
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** App-facing Agent Loop record (camelCase), decoupled from the snake_case row.
 *  See {@link AgentLoopsTable} for column semantics. */
export interface AgentLoopRecord {
  id: string;
  projectId: string;
  name: string;
  status: AgentLoopStatus;
  /** Structured schedule; null on a draft with no schedule yet. */
  schedule: ScheduleConfig | null;
  /** The loop's script; null on a draft with none authored yet. */
  script: string | null;
  /** Fallback turn prompt; null until authored. */
  reactionPrompt: string | null;
  reactionModel: string | null;
  /** The loop's durable session, if any. */
  sessionId: string | null;
  /** Fingerprint of the complete config last proven by a green test run. */
  testedScriptFingerprint: string | null;
  consecutiveErrorCount: number;
  lastRunAt: Date | null;
  lastOutcome: AgentLoopRunOutcome | null;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Input to {@link EventStore.createAgentLoop}. Only `projectId`/`name` are
 *  required; a loop is born a `draft` with no schedule/script yet. `id`/
 *  timestamps are store-managed. */
export interface AgentLoopCreateInput {
  projectId: string;
  name: string;
  schedule?: ScheduleConfig | null;
  script?: string | null;
  reactionPrompt?: string | null;
  reactionModel?: string | null;
}

/** Partial update for {@link EventStore.updateAgentLoop}. Only the operator-owned
 *  fields; `next_run_at` is recomputed by the store when `schedule`/`status`
 *  change. Every field optional — an absent key leaves the column untouched. */
export interface AgentLoopPatch {
  name?: string;
  status?: AgentLoopStatus;
  schedule?: ScheduleConfig | null;
  script?: string | null;
  reactionPrompt?: string | null;
  reactionModel?: string | null;
  sessionId?: string | null;
}

/** One Agent Loop run-history entry (ADR 0008). */
export interface AgentLoopRunRecord {
  id: string;
  loopId: string;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: AgentLoopRunOutcome;
  exitCode: number | null;
  detail: string | null;
  sessionId: string | null;
  isTest: boolean;
}

export interface ProjectSettingsRecord {
  projectId: string;
  dopplerTokenRef: string | null;
  dopplerToken: string | null;
  /** Operator-authorized Doppler binding (#320): plaintext project + config. */
  dopplerProject: string | null;
  dopplerConfig: string | null;
  /** Cached scoped read-only minted token (#320). SECRET — encrypted at rest
   *  exactly like {@link ProjectSettingsRecord.dopplerToken}. */
  dopplerMintedToken: string | null;
  /** Doppler identifier (`slug`) of {@link ProjectSettingsRecord.dopplerMintedToken}
   *  (#320 follow-up). PLAINTEXT — an opaque token identifier, not a credential;
   *  used to best-effort revoke the superseded token on rebind. */
  dopplerMintedTokenSlug: string | null;
  defaultBranch: string | null;
  defaultModel: string | null;
  /** Per-project agent memory (ADR 0008). PLAINTEXT free-text, never encrypted;
   *  injected into each session's runtime system prompt at context init. */
  memory: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type ProjectSettingsKey =
  | 'dopplerTokenRef'
  | 'dopplerToken'
  | 'dopplerProject'
  | 'dopplerConfig'
  | 'dopplerMintedToken'
  | 'dopplerMintedTokenSlug'
  | 'defaultBranch'
  | 'defaultModel'
  | 'memory';

export type ProjectSettingsPatch = {
  [K in ProjectSettingsKey]?: ProjectSettingsRecord[K] | undefined;
};

/** One dev server (preview process) of a project. */
export interface DevServerRecord {
  id: string;
  projectId: string;
  sourceKey: string | null;
  name: string;
  command: string | null;
  url: string | null;
  workdir: string | null;
  hostPort: string | null;
  containerPort: string | null;
  /** Session whose worktree this server previews instead of the main checkout;
   *  null = serve main. Cleared automatically when the session is deleted. */
  previewSessionId: string | null;
  autoStart: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DevServerCreateInput {
  projectId: string;
  sourceKey?: string | null;
  name?: string;
  command?: string | null;
  url?: string | null;
  workdir?: string | null;
  hostPort?: string | null;
  containerPort?: string | null;
  autoStart?: boolean;
  sortOrder?: number;
}

export type DevServerPatch = {
  name?: string;
  command?: string | null;
  url?: string | null;
  workdir?: string | null;
  hostPort?: string | null;
  containerPort?: string | null;
  previewSessionId?: string | null;
  autoStart?: boolean;
  sortOrder?: number;
};

export interface DevServerDetectionStateRecord {
  projectId: string;
  fingerprint: string;
  detectedAt: Date;
  reviewedFingerprint: string | null;
  reviewedAt: Date | null;
}

export type PublicPreviewShareState =
  'creating' | 'active' | 'revoking' | 'revoked' | 'expired' | 'failed';

export interface PublicPreviewShareRecord {
  id: string;
  projectId: string;
  devServerId: string | null;
  containerGeneration: string;
  targetPort: number | null;
  targetKind?: 'dev-server' | 'static-folder';
  staticPath?: string | null;
  state: PublicPreviewShareState;
  publicOrigin: string;
  edgeUrl: string;
  pinHash: string;
  connectorToken: string;
  sessionSecret: string;
  connectorContainerName: string;
  connectorContainerId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  failure: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicPreviewShareCreateInput {
  id: string;
  projectId: string;
  devServerId: string | null;
  containerGeneration: string;
  targetPort: number | null;
  targetKind?: 'dev-server' | 'static-folder';
  staticPath?: string | null;
  publicOrigin: string;
  edgeUrl: string;
  pinHash: string;
  connectorToken: string;
  sessionSecret: string;
  connectorContainerName: string;
  expiresAt: Date;
}

/** The Verity-owned Claude-egress CA + gateway server identity (singleton). The
 *  `caKeyPem`/`gatewayKeyPem` are decrypted on read; they are SECRETS and never
 *  leave the server. */
export interface ClaudeEgressCaRecord {
  caCertPem: string;
  caKeyPem: string;
  gatewayServerName: string;
  gatewayCertPem: string;
  gatewayKeyPem: string;
  caExpiresAt: Date;
  gatewayExpiresAt: Date;
}

/** A per-project Claude-egress client certificate. `keyPem` is decrypted on read
 *  (a SECRET); the cert + fingerprint are non-secret. */
export interface ClaudeEgressClientCertRecord {
  projectId: string;
  certPem: string;
  keyPem: string;
  fingerprint256: string;
  expiresAt: Date;
}

/** Thrown by {@link EventStore.createSession} when the session's project has
 *  been soft-deleted (`hidden_at` set). Project deletion reaps the project's
 *  sessions, so a session inserted afterwards would outlive its project and
 *  reappear in the overview as an orphan. Callers map this to the same 404 an
 *  unknown project id gets — a hidden project is gone as far as spawning is
 *  concerned. */
export class DeletedProjectError extends Error {
  constructor(readonly projectId: string) {
    super(`project ${projectId} has been deleted`);
    this.name = 'DeletedProjectError';
  }
}

/** Soft cap on per-project agent memory (ADR 0008), enforced in the shared store
 *  layer so BOTH write paths (operator UI full-replace and agent broker append)
 *  are bounded — otherwise a large blob would bloat every injected system prompt.
 *  A "few KB" per the ADR; an over-cap write is REJECTED (see
 *  {@link ProjectMemoryTooLargeError}), never silently truncated. */
export const PROJECT_MEMORY_MAX_CHARS = 8_000;

/** Thrown by {@link EventStore.updateProjectSettings} / {@link EventStore.appendProjectMemory}
 *  when a memory write would exceed {@link PROJECT_MEMORY_MAX_CHARS}. Callers (the
 *  memory broker route, the settings API) map this to a 4xx rather than persisting
 *  a truncated blob. */
export class ProjectMemoryTooLargeError extends Error {
  constructor(
    readonly length: number,
    readonly max: number,
  ) {
    super(`project memory too large: ${length} characters exceeds the ${max}-character limit`);
    this.name = 'ProjectMemoryTooLargeError';
  }
}

export interface VeritySettingsRecord {
  gitUserName: string | null;
  gitUserEmail: string | null;
  gitSshPrivateKeyPath: string | null;
  gitSshPrivateKey: string | null;
  gitSshPublicKeyPath: string | null;
  gitSshPublicKey: string | null;
  gitKnownHostsPath: string | null;
  gitKnownHosts: string | null;
  gitAllowedSignersPath: string | null;
  gitAllowedSigners: string | null;
  githubAppId: string | null;
  githubAppInstallationId: string | null;
  githubAppPrivateKey: string | null;
  /** Account-level Doppler Service Account token (#320). A secret, encrypted at
   *  rest; decrypted on read via {@link EventStore.getVeritySettings}. */
  dopplerServiceToken: string | null;
  transcribeBaseUrl?: string | null;
  /** OpenAI-compatible transcription token, encrypted at rest. */
  transcribeApiKey?: string | null;
  transcribeModel?: string | null;
  /** Explicit selection made by the app. Null preserves the legacy environment
   * fallback for installations that predate the first-use chooser. */
  transcribeBackendMode?: 'local' | 'external' | null;
  /** Full Claude OAuth credential state from `~/.claude/.credentials.json`.
   *  A secret, encrypted at rest; used by the server to refresh access tokens
   *  for Claude account usage probes. */
  claudeCodeOauthCredentialsJson: string | null;
  /** Subscription-login credential acquired from `codex login`. The encrypted
   *  database value is projected only to the agent gateway credential authority;
   *  it is never materialized into an agent runtime or Sandbox. */
  codexAuthJson: string | null;
  /** Google Drive connection (ADR 0009). Client id + account email are non-secret;
   *  the refresh token is a secret, encrypted at rest and decrypted on read via
   *  {@link EventStore.getVeritySettings}. */
  googleDriveClientId: string | null;
  googleDriveAccountEmail: string | null;
  googleDriveRefreshToken: string | null;
  /** Verity Uplink subscription credential, encrypted at rest. */
  uplinkSubscriptionKey?: string | null;
  /** Stable identity assigned and validated by the Uplink. */
  uplinkInstallationId?: string | null;
  advancedModeEnabled?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type VeritySettingsKey =
  | 'advancedModeEnabled'
  | 'gitUserName'
  | 'gitUserEmail'
  | 'gitSshPrivateKeyPath'
  | 'gitSshPrivateKey'
  | 'gitSshPublicKeyPath'
  | 'gitSshPublicKey'
  | 'gitKnownHostsPath'
  | 'gitKnownHosts'
  | 'gitAllowedSignersPath'
  | 'gitAllowedSigners'
  | 'githubAppId'
  | 'githubAppInstallationId'
  | 'githubAppPrivateKey'
  | 'dopplerServiceToken'
  | 'transcribeBaseUrl'
  | 'transcribeApiKey'
  | 'transcribeModel'
  | 'transcribeBackendMode'
  | 'claudeCodeOauthCredentialsJson'
  | 'codexAuthJson'
  | 'googleDriveClientId'
  | 'googleDriveAccountEmail'
  | 'googleDriveRefreshToken'
  | 'uplinkSubscriptionKey'
  | 'uplinkInstallationId';

export type VeritySettingsPatch = {
  [K in VeritySettingsKey]?: VeritySettingsRecord[K] | undefined;
};

/** Master-password key-derivation metadata (non-secret): the scrypt salt and a
 *  verifier (a fixed marker encrypted under the derived key). The raw key is
 *  never stored — only re-derived in memory on unlock. */
export interface SecretKeyMetaRecord {
  salt: string;
  verifier: string;
}

/** A minted per-device API token as stored: an opaque public `id` (for listing/
 *  revoking), the SHA-256 `tokenHash` the gate matches against, and an optional
 *  human `label`. The raw token itself is never persisted. */
export interface AuthTokenRecord {
  id: string;
  tokenHash: string;
  label: string | null;
  createdAt: number;
}

export interface DevicePushTokenRecord {
  authTokenId: string;
  expoToken: string;
  platform: 'ios';
  createdAt: number;
  updatedAt: number;
}

export interface PushReceiptRecord {
  receiptId: string;
  expoToken: string;
  availableAt: number;
  attempts: number;
  createdAt: number;
}

/** A persisted event tagged with its monotonic sequence (the bigserial id) and
 * its real persist time. `seq` orders + keys the event; `ts` is the row's
 * `created_at` as epoch milliseconds — store/transport metadata alongside `seq`,
 * NOT part of the canonical {@link AgentEvent} payload. Surfaced so the client can
 * show real wall-clock times instead of using `seq` as a `createdAt` proxy (#32). */
export interface SequencedEvent {
  seq: number;
  /** The row's `created_at` as epoch milliseconds (non-decreasing with `seq`). */
  ts: number;
  event: AgentEvent;
}

/**
 * How many session ids one `in (…)` list carries — see
 * {@link EventStore.listSessionProjectionFacts}. Postgres refuses a statement
 * with more than 65535 bind parameters outright, and `GET /sessions` passes
 * EVERY session of a deployment at once, so an unchunked list turns a big
 * install into a route that throws rather than one that is slow. Well under the
 * ceiling on purpose: the extra round trips are cheap next to the per-session
 * reads this replaced, and the queries spend parameters on the type filter too.
 */
const PROJECTION_ID_CHUNK = 500;

/** Split `items` into chunks of at most {@link PROJECTION_ID_CHUNK}. */
function idChunks<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += PROJECTION_ID_CHUNK) {
    chunks.push(items.slice(at, at + PROJECTION_ID_CHUNK));
  }
  return chunks;
}

/**
 * What the overview projections need from one session's log — see
 * {@link EventStore.listSessionProjectionFacts}.
 */
export interface SessionProjectionFacts {
  /** Total persisted events (#387) — the unread counter, and the ONLY thing that
   *  distinguishes an empty log (status `idle`) from one holding nothing the
   *  status projection reads (status `running`). */
  eventCount: number;
  /** `created_at` of the newest event in epoch ms; null for an empty log. */
  lastActivityAt: number | null;
  /** Ascending by seq, filtered to {@link SESSION_PROJECTION_EVENT_TYPES}. */
  events: SequencedEvent[];
}

/** A turn persisted in the durable backlog (issue #80): its retract handle, the
 * session it belongs to, the prompt, and the per-turn options (attachments as
 * content-addressed refs). `seq` is the FIFO order the conductor recovers them in. */
export interface QueuedTurnRecord {
  id: string;
  seq: number;
  sessionId: string;
  prompt: string;
  opts: QueuedTurnOpts;
}

/** Input to {@link EventStore.enqueueTurn}: a queued turn minus the `seq` the
 * database assigns. */
export type QueuedTurnInput = Omit<QueuedTurnRecord, 'seq'>;

/** The durable "a turn is in flight for this session" marker (lifecycle Phase 1).
 * Written before a turn launches, cleared on its terminal event; a record still
 * present at startup means the turn was abandoned by a crash/restart. */
export interface RunningTurnRecord {
  sessionId: string;
  /** Seq of the prompt event this turn is executing — recovery/reattach anchor. */
  promptSeq: number;
  startedAt: Date;
  /** ADR 0006 Stage 4: the Server-allocated turn id bound before launch (D2), or
   * null before an attempt binds it / on the loopback path. Recovery discovers the
   * turn on the supervisor by this id. */
  turnId: string | null;
  /** ADR 0006 Stage 4: the idempotency key for this turn's StartTurn (D2), or null
   * as for {@link turnId}. Recovery repeats StartTurn under it. */
  startCommandId: string | null;
}

/**
 * The narrow persistence seam the Runner's ingest path drives (ADR 0006 D2). It
 * is EXACTLY the three {@link EventStore} methods the runner/ingest/backend
 * path touches — `appendEvent` (persist a stream event, returning its assigned
 * `seq`/`ts`), plus `createSession`/`getSession` for the session-bind bookkeeping.
 *
 * Retyping `RunTurnOptions.store` from the concrete {@link EventStore} to this
 * interface lets a Runner be handed a substitute sink (e.g. the Stage 2 file-sink
 * that writes events to the event stream file instead of the DB) WITHOUT the
 * Runner gaining DB access (D2: the Server persists; the Runner does not touch the
 * DB). The real {@link EventStore} `implements EventSink`, so every existing
 * caller passes it unchanged.
 */
export interface EventSink {
  appendEvent(sessionId: string, event: AgentEvent): Promise<{ seq: number; ts: number }>;
  createSession(session: SessionInput): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
}

/**
 * The only Runner frame protocol version the Server ingests (ADR 0006 D3). The
 * envelope the Runner stamps carries this so a Server that predates a future
 * protocol bump rejects an unknown frame rather than misreading it. Kept here in
 * `@verity/store` as the single source of truth — `@verity/session` (which depends
 * on this package) imports it to stamp outgoing frames, so writer and reader can
 * never drift.
 */
export const RUNNER_FRAME_PROTOCOL_VERSION = 1;

type ProjectionDb = Kysely<Database> | Transaction<Database>;
const MESSAGE_PROJECTION_VERSION = 1;
const pendingMessageProjectionByDb = new WeakMap<Kysely<Database>, Promise<void>>();
const pendingMessageBackfillsByDb = new WeakMap<Kysely<Database>, Set<Promise<void>>>();

export async function waitForPendingMessageProjections(db: Kysely<Database>): Promise<void> {
  await (pendingMessageProjectionByDb.get(db) ?? Promise.resolve());
}

/**
 * Wait until no projection work is in flight against `db` — the ordered live
 * chain AND every recovery/search backfill.
 *
 * {@link waitForPendingMessageProjections} covers only the first. That is enough
 * to observe a projected event, but not to know the database is quiet: a live
 * projection that declines its slot enqueues a backfill *as it resolves*, and
 * {@link EventStore.ingestRunnerFrame} schedules one unawaited by design. Those
 * run on their own connection, so a caller that needs exclusive access (a test
 * harness truncating between tests) must wait for them too — otherwise its
 * TRUNCATE takes AccessExclusiveLock on the tables the backfill is midway
 * through reading and the two deadlock (40P01).
 *
 * The queues are re-read across a barrier because draining one can enqueue into
 * the other; the loop settles once a full pass adds nothing.
 */
export async function waitForMessageProjectionWork(db: Kysely<Database>): Promise<void> {
  for (;;) {
    const live = pendingMessageProjectionByDb.get(db) ?? Promise.resolve();
    const backfills = [...(pendingMessageBackfillsByDb.get(db) ?? [])];
    await Promise.all([live, ...backfills.map((backfill) => backfill.catch(() => undefined))]);
    // Let completion handlers enqueue a recovery backfill before checking that
    // the two queues stayed unchanged across the barrier.
    await Promise.resolve();
    if (
      (pendingMessageProjectionByDb.get(db) ?? live) === live &&
      (pendingMessageBackfillsByDb.get(db)?.size ?? 0) === 0
    ) {
      return;
    }
  }
}

async function finalizeOpenMessage(db: ProjectionDb, sessionId: string): Promise<void> {
  await db
    .updateTable('messages')
    .set({ finalized: true })
    .where('session_id', '=', sessionId)
    .where('finalized', '=', false)
    .execute();
}

/** Fold one persisted canonical event into the rebuildable visible-message view. */
async function projectMessageEvent(
  db: ProjectionDb,
  sessionId: string,
  seq: number,
  createdAt: Date,
  event: AgentEvent,
): Promise<void> {
  if (event.t === 'task' || event.t === 'session') return;

  if (event.t === 'text' && event.parentToolId === undefined) {
    const open = await db
      .selectFrom('messages')
      .select(['id', 'text'])
      .where('session_id', '=', sessionId)
      .where('finalized', '=', false)
      .where('role', '=', 'agent')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (open !== undefined) {
      await db
        .updateTable('messages')
        .set({ text: open.text + event.delta, last_event_seq: seq })
        .where('id', '=', open.id)
        .execute();
    } else {
      await db
        .insertInto('messages')
        .values({
          session_id: sessionId,
          role: 'agent',
          kind: 'text',
          text: event.delta,
          first_event_seq: seq,
          last_event_seq: seq,
          created_at: createdAt,
        })
        .onConflict((oc) => oc.columns(['session_id', 'first_event_seq']).doNothing())
        .execute();
    }
    return;
  }

  await finalizeOpenMessage(db, sessionId);
  if (event.t === 'prompt') {
    await db
      .insertInto('messages')
      .values({
        session_id: sessionId,
        role: 'user',
        kind: 'prompt',
        text: event.text,
        first_event_seq: seq,
        last_event_seq: seq,
        finalized: true,
        created_at: createdAt,
      })
      .onConflict((oc) => oc.columns(['session_id', 'first_event_seq']).doNothing())
      .execute();
  } else if (event.t === 'notice') {
    await db
      .insertInto('messages')
      .values({
        session_id: sessionId,
        role: event.role === 'operator' ? 'user' : 'agent',
        kind: 'notice',
        text: event.text,
        first_event_seq: seq,
        last_event_seq: seq,
        finalized: true,
        created_at: createdAt,
      })
      .onConflict((oc) => oc.columns(['session_id', 'first_event_seq']).doNothing())
      .execute();
  }
}

/**
 * The Server-side ingest descriptor for one Runner frame (ADR 0006 D4). It is the
 * transport-neutral projection of `@verity/session`'s `RunnerFrame` — carrying only
 * what the idempotent DB claim needs, so `@verity/store` never has to import the
 * session frame union (avoiding a package cycle). `event` normally contains the
 * transported event frame; a permission-request frame may instead carry the
 * server-authored `permission` event that makes the parked prompt durable and
 * replayable. Session/result frames omit it and persist no event row, but still
 * claim their `(turnId, frameSeq)` so the sequence stays contiguous. `payloadHash`
 * is treated as an opaque token: the Server stores it and compares it on replay
 * but never recomputes it, so the hashing algorithm lives solely Runner-side.
 */
export interface RunnerFrameIngest {
  protocolVersion: number;
  runnerInstanceId: string;
  turnId: string;
  frameSeq: number;
  payloadHash: string;
  /** The event to persist — present for event frames and surfaced permission requests. */
  event?: AgentEvent;
  /** Marks the final `result` frame. Its claim atomically closes the matching
   * running-turn marker and fences all later frames for this turn. */
  terminal?: true;
}

/** The outcome of {@link EventStore.ingestRunnerFrame}. `accepted` means the frame
 * was newly claimed (and any `event` newly persisted) — the caller should publish it
 * to live subscribers. `duplicate` means the frame was already ingested (a replay
 * after a crash) — it must NOT be re-published; a reconnecting client receives it via
 * backlog replay instead. `seq`/`ts` are the persisted event's identity, present for
 * event frames in both outcomes. They are consumed today only on the `accepted` path;
 * the `duplicate` seq/ts is carried for the reattach slice (which will re-derive a
 * frame's seq after a post-commit-pre-publish crash) and is not yet read by any
 * caller. */
export interface RunnerFrameIngestResult {
  outcome: 'accepted' | 'duplicate';
  seq?: number;
  ts?: number;
}

/**
 * The `payload_hash` that marks a `runner_frames` row as a FENCE rather than a frame
 * the Runner produced — see {@link EventStore.fenceAbandonedTurn}. A real hash is a
 * Runner-minted token, so this cannot collide with one; using the existing column
 * keeps the fence inside the table whose primary key already orders a turn's frames.
 */
const ABANDONED_TURN_FENCE_HASH = 'verity:abandoned-turn-fence';

/** The `runner_instance_id` a fence carries when the turn never streamed a frame, so
 * there is no real instance to name. Excluded from the turn→instance binding check. */
const ABANDONED_TURN_FENCE_INSTANCE = 'verity:abandoned-turn-fence';

/**
 * The durable source of truth (concept §5a). Wraps the append-only Postgres
 * event log. Every event is validated against the canonical contract before it
 * is persisted and again when it is read back, so the log can never hold — or
 * hand out — an event that violates the schema.
 */
export class EventStore implements EventSink {
  /** PGlite does not enforce table-lock conflicts across its concurrent async
   * transactions, so serialize this rare dual-unique mutation in-process too.
   * The SQL table lock below remains the cross-process Postgres guard. */
  private pushTokenMutationTail: Promise<void> = Promise.resolve();
  private devServerPortMutationTail: Promise<void> = Promise.resolve();
  /** PGlite does not model PostgreSQL advisory-lock contention across concurrent
   * transactions, so mirror the per-turn DB lock in-process for tests/local mode. */
  private readonly runnerFrameIngestTails = new Map<string, Promise<void>>();
  private messageBackfillTail: Promise<void> = Promise.resolve();
  private messageBackfillRunning = false;
  private messageBackfillRequested = false;
  private readonly messageLiveProjectionTails = new Map<string, Promise<void>>();
  /** One session's event appends run one at a time — see {@link withSessionEventAppend}. */
  private readonly sessionEventAppendTails = new Map<string, Promise<void>>();

  /**
   * Serialize every append to one session's event log.
   *
   * A conditional append ({@link appendEventForRunningTurn}) tests the log it is about
   * to write into. Under READ COMMITTED that test only sees what had COMMITTED when the
   * statement began, so a concurrent append — a Runner frame ingest in particular, whose
   * insert sits inside a multi-statement transaction — can be invisible to the predicate
   * and still take the lower id. The result would be a message about a turn that had
   * already spoken, placed after what it spoke.
   *
   * Serializing the appends removes the overlap instead of trying to detect it: each one
   * commits before the next begins, so the predicate reads a settled log. Server
   * generations overlap during reattach/cutover, so this in-process tail is only half of
   * it: every append also takes {@link sessionEventAppendLock} inside its transaction, so
   * the ordering holds between processes too. The tail is what makes that lock effective
   * under PGlite, which does not model advisory-lock contention between its concurrent
   * transactions — the same belt-and-braces pairing frame ingest and the message
   * projection already use.
   */
  private async withSessionEventAppend<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const predecessor = this.sessionEventAppendTails.get(sessionId);
    let release!: () => void;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionEventAppendTails.set(sessionId, queued);
    // Only an append that actually has a predecessor waits. An uncontended one issues
    // its statement in the caller's tick, as it did before there was a queue — the tail
    // is claimed synchronously above, so skipping the hop cannot reorder anything.
    if (predecessor !== undefined) await predecessor;
    try {
      return await run();
    } finally {
      release();
      if (this.sessionEventAppendTails.get(sessionId) === queued) {
        this.sessionEventAppendTails.delete(sessionId);
      }
    }
  }

  /** Serialize one turn's frame claims in-process (PGlite has no advisory locks). */
  private async withRunnerFrameTurn<T>(turnId: string, run: () => Promise<T>): Promise<T> {
    const predecessor = this.runnerFrameIngestTails.get(turnId) ?? Promise.resolve();
    let release!: () => void;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.runnerFrameIngestTails.set(turnId, queued);
    await predecessor;
    try {
      return await run();
    } finally {
      release();
      if (this.runnerFrameIngestTails.get(turnId) === queued) {
        this.runnerFrameIngestTails.delete(turnId);
      }
    }
  }

  /**
   * Transaction-scoped lock every append to one session's log takes first, so appends
   * from overlapping Server generations cannot interleave either. Taken BEFORE a
   * per-turn frame lock wherever both are held, so the two never deadlock.
   */
  private async sessionEventAppendLock(tx: Kysely<Database>, sessionId: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtext(${this.sessionEventAppendLockKey(sessionId)}))`.execute(
      tx,
    );
  }

  /** The one string every event-append lock hashes, transaction-scoped or inline. */
  private sessionEventAppendLockKey(sessionId: string): string {
    return `events:${sessionId}`;
  }

  private enqueuePersistedMessageEvent(
    sessionId: string,
    seq: number,
    createdAt: Date,
    event: AgentEvent,
  ): void {
    const predecessor = this.messageLiveProjectionTails.get(sessionId) ?? Promise.resolve();
    const current = predecessor
      .catch(() => undefined)
      .then(async () => {
        const projected = await this.db.transaction().execute(async (tx) => {
          await sql`select pg_advisory_xact_lock(hashtext(${'messages:' + sessionId}))`.execute(tx);
          const state = await tx
            .selectFrom('message_projection_state')
            .select(['last_event_seq', 'projection_version'])
            .where('session_id', '=', sessionId)
            .executeTakeFirst();
          if (state !== undefined && state.projection_version !== MESSAGE_PROJECTION_VERSION) {
            return false;
          }
          const previous = await tx
            .selectFrom('events')
            .select((eb) => eb.fn.max('id').as('seq'))
            .where('session_id', '=', sessionId)
            .where('id', '<', seq)
            .executeTakeFirst();
          if (Number(state?.last_event_seq ?? 0) !== Number(previous?.seq ?? 0)) return false;
          await projectMessageEvent(tx, sessionId, seq, createdAt, event);
          await tx
            .insertInto('message_projection_state')
            .values({
              session_id: sessionId,
              last_event_seq: seq,
              projection_version: MESSAGE_PROJECTION_VERSION,
            })
            .onConflict((oc) =>
              oc.column('session_id').doUpdateSet({
                last_event_seq: seq,
                projection_version: MESSAGE_PROJECTION_VERSION,
              }),
            )
            .execute();
          return true;
        });
        return projected;
      });
    const safeCurrent = current.catch(() => false);
    const tail = safeCurrent.then(() => undefined);
    this.messageLiveProjectionTails.set(sessionId, tail);
    const pending = Promise.all([
      pendingMessageProjectionByDb.get(this.db) ?? Promise.resolve(),
      tail,
    ]).then(() => undefined);
    pendingMessageProjectionByDb.set(this.db, pending);
    void safeCurrent.then((projected) => {
      if (!projected) this.scheduleMessageProjection();
    });
    void tail.finally(() => {
      if (this.messageLiveProjectionTails.get(sessionId) === tail) {
        this.messageLiveProjectionTails.delete(sessionId);
      }
    });
  }

  /**
   * @param cipher Encrypts/decrypts secret columns at the DB boundary (ADR 0002
   *   D3). Defaults to a passthrough (plaintext) cipher so tests and un-keyed
   *   deployments behave exactly as before; production passes a real
   *   {@link SecretCipher} whose key is derived from the master password.
   */
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher = createPassthroughCipher(),
  ) {}

  /** Encrypt a normalized secret value for storage (null stays null). */
  private encryptSecret(value: string | null): string | null {
    return value === null ? null : this.cipher.encrypt(value);
  }

  /** Decrypt a stored secret value on read (null stays null; plaintext passes
   *  through untouched for rows written before encryption was enabled). */
  private decryptSecret(value: string | null): string | null {
    return value === null ? null : this.cipher.decrypt(value);
  }

  /** Read the central Doppler identity as owned, erasable bytes. */
  async getDopplerServiceTokenBytes(): Promise<Buffer | undefined> {
    const row = await this.db
      .selectFrom('verity_settings')
      .select('doppler_service_token')
      .where('id', '=', 'global')
      .executeTakeFirst();
    const stored = row?.doppler_service_token;
    return stored === null || stored === undefined ? undefined : this.cipher.decryptBytes(stored);
  }

  /** Record an authenticated external rotation without restoring the credential. */
  async confirmLegacyDopplerCredentialRemediation(input: {
    projectId: string;
    actorId: string;
    evidence: 'external-credential-rotated';
    requestId: string;
  }): Promise<boolean> {
    const result = await sql`
      update doppler_legacy_cutovers
      set credential_remediated_at = now(),
          remediation_actor_id = ${input.actorId},
          remediation_evidence = ${input.evidence},
          remediation_request_id = ${input.requestId}
      where project_id = ${input.projectId}
        and manual_credential = true
        and runtime_cutover_at is not null
        and credential_remediated_at is null
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0) > 0;
  }

  /**
   * Register a session. The `worktree` UNIQUE constraint enforces the strict
   * 1:1 session ↔ worktree invariant (§5a) — a duplicate session id or worktree
   * rejects at the database, never silently overwrites.
   *
   * A project-bound session additionally takes a SHARE lock on its project row
   * for the length of the insert, and refuses a project that is already hidden
   * ({@link DeletedProjectError}). Deleting a project reaps its sessions, and
   * the check the route makes before that cannot cover a spawn that is already
   * under way: it read the project a worktree-creation ago. The lock decides
   * that race in the database instead of in wall-clock order — `hideProject`'s
   * UPDATE waits behind an in-flight insert (so the delete's final reap sees
   * that session), and an insert that arrives after the hide committed reads
   * `hidden_at` set and rejects. Without it a session could land after the last
   * reap and outlive its project, which is the whole bug.
   */
  async createSession(session: SessionInput): Promise<void> {
    const values = {
      session_id: session.sessionId,
      worktree: session.worktree,
      model: session.model,
      initial_model: session.model,
      name: session.name ?? null,
      project_id: session.projectId ?? null,
      kind: session.kind ?? 'normal',
    };
    const projectId = session.projectId;
    if (projectId === undefined || projectId === null) {
      await this.db.insertInto('sessions').values(values).execute();
      return;
    }
    await this.db.transaction().execute(async (tx) => {
      const project = await tx
        .selectFrom('projects')
        .select('hidden_at')
        // SHARE, not UPDATE: concurrent spawns for the same project must not
        // serialize against each other, only against a delete.
        .forShare()
        .where('id', '=', projectId)
        .executeTakeFirst();
      // An unknown project id is left to the foreign key — same rejection, and
      // the FK is the authority on it.
      if (project?.hidden_at != null) throw new DeletedProjectError(projectId);
      await tx.insertInto('sessions').values(values).execute();
    });
  }

  /** The immutable model choice of the newest ordinary session in a scope.
   * Legacy rows written before `initial_model` existed fall back to their current
   * model. Used only to seed a subsequent session; runtime model switches never
   * rewrite the remembered creation choice. */
  async getLastCreatedSessionModel(projectId: string | null): Promise<string | undefined> {
    let query = this.db
      .selectFrom('sessions')
      .select(['initial_model', 'model'])
      .where('kind', '=', 'normal');
    query =
      projectId === null
        ? query.where('project_id', 'is', null)
        : query.where('project_id', '=', projectId);
    const row = await query
      .orderBy('created_at', 'desc')
      .orderBy('session_id', 'desc')
      .executeTakeFirst();
    return row?.initial_model ?? row?.model;
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const row = await this.db
      .selectFrom('sessions')
      .select([
        'session_id',
        'worktree',
        'model',
        'name',
        'project_id',
        'kind',
        'last_seen_event_count',
      ])
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      worktree: row.worktree,
      model: row.model,
      name: row.name,
      projectId: row.project_id,
      kind: row.kind as 'normal' | 'agent_loop',
      lastSeenEventCount: row.last_seen_event_count,
    };
  }

  async listSessions(): Promise<SessionRecord[]> {
    const rows = await this.db
      .selectFrom('sessions')
      .select([
        'session_id',
        'worktree',
        'model',
        'name',
        'project_id',
        'kind',
        'last_seen_event_count',
      ])
      // session_id tiebreaker: `created_at` is `now()` (tx-start), so rapid
      // inserts can share a timestamp — without this the order is unspecified.
      .orderBy('created_at', 'asc')
      .orderBy('session_id', 'asc')
      .execute();
    return rows.map((r) => ({
      sessionId: r.session_id,
      worktree: r.worktree,
      model: r.model,
      name: r.name,
      projectId: r.project_id,
      kind: r.kind as 'normal' | 'agent_loop',
      lastSeenEventCount: r.last_seen_event_count,
    }));
  }

  /**
   * Set (or clear, with `null`) a session's project binding. Returns `true` if a
   * row matched (`UPDATE` affected a row), `false` if the session id is unknown.
   * Pure metadata: never touches the durable event log. Used by the
   * provisioning+dispatch paths (slice 3) to attach a session to its project when
   * `POST /sessions` triggers auto-provisioning.
   *
   * The non-null case can throw a Postgres FK-violation error if `projectId`
   * refers to a project row that no longer exists (race with a concurrent
   * `deleteProject` in slice 3, or a buggy caller) — the boolean return only
   * signals session-unknown, NOT project-unknown. Callers MUST handle the throw
   * separately; the typical response is to surface it as a 4xx (or retry with
   * the project re-resolved via GitHub sync).
   */
  async setSessionProject(sessionId: string, projectId: string | null): Promise<boolean> {
    if (projectId !== null) {
      return await this.db.transaction().execute(async (tx) => {
        const project = await tx
          .selectFrom('projects')
          .select('hidden_at')
          .forShare()
          .where('id', '=', projectId)
          .executeTakeFirst();
        if (project?.hidden_at != null) throw new DeletedProjectError(projectId);
        const result = await tx
          .updateTable('sessions')
          .set({ project_id: projectId })
          .where('session_id', '=', sessionId)
          .executeTakeFirst();
        return result.numUpdatedRows > 0n;
      });
    }
    const result = await this.db
      .updateTable('sessions')
      .set({ project_id: null })
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Set (or clear, with `null`) a session's operator-assigned display name.
   * Returns `true` if a row matched, `false` if the session id is unknown — the
   * caller (server) maps `false` to a 404 rather than silently succeeding. Pure
   * metadata: never touches the durable event log.
   */
  async renameSession(sessionId: string, name: string | null): Promise<boolean> {
    const result = await this.db
      .updateTable('sessions')
      .set({ name })
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Guarded auto-title write: set the name ONLY if it is still null. Returns true
   * if it named the session, false if a name was already set — e.g. the operator
   * renamed it DURING the (up to ~45s) title generation. The `name IS NULL`
   * predicate is enforced atomically at write time, so auto-titling can never
   * clobber an operator's manual rename (the TOCTOU the unguarded rename had).
   */
  async renameSessionIfUnnamed(sessionId: string, name: string): Promise<boolean> {
    const result = await this.db
      .updateTable('sessions')
      .set({ name })
      .where('session_id', '=', sessionId)
      .where('name', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Switch the engine/model a running session uses from its next turn onward
   * (#switch-engine). The model string is the backend-routing contract (ADR 0001):
   * persisting it here makes the user's pick stick instead of reverting to the
   * spawn model after one turn. A Verity session has exactly one active agent
   * backend; model switches clear old backend resume handles so switching back starts
   * from the durable transcript rather than reviving a second live thread. Returns
   * `true` if a row matched, `false` if the session id is unknown (caller maps
   * `false` to a 404). Pure metadata: never touches the durable event log.
   */
  async setSessionModel(sessionId: string, model: string): Promise<boolean> {
    const result = await this.db
      .updateTable('sessions')
      .set({ model })
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Advance a session's "last seen" mark for the overview unread dot (#387) to
   * `eventCount`. Global (no per-device scoping), so clearing an unread dot on one
   * device clears it everywhere. MONOTONIC: `greatest(coalesce(current, 0), …)`
   * never moves the mark backward, so a stale poll writing an older count can't
   * resurrect a cleared dot. The row is always touched when the session exists
   * (even when the value is unchanged), so `numUpdatedRows` cleanly distinguishes
   * an unknown session id — the caller (server) maps `false` to a 404. Pure
   * metadata: never touches the durable event log.
   */
  async setSessionSeen(sessionId: string, eventCount: number): Promise<boolean> {
    const result = await this.db
      .updateTable('sessions')
      .set({
        last_seen_event_count: sql<number>`greatest(coalesce(last_seen_event_count, 0), ${eventCount})`,
      })
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async getSessionBackendState(
    sessionId: string,
    backend: string,
  ): Promise<SessionBackendStateRecord | undefined> {
    const row = await this.db
      .selectFrom('session_backend_state')
      .select(['session_id', 'backend', 'backend_session_id', 'context_seq', 'updated_at'])
      .where('session_id', '=', sessionId)
      .where('backend', '=', backend)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      backend: row.backend,
      backendSessionId: row.backend_session_id,
      contextSeq: Number(row.context_seq),
      updatedAt: row.updated_at,
    };
  }

  /**
   * Bind a session to one backend's resume state, replacing any other backend's.
   *
   * Returns the bindings that were DISPLACED by this write — the rows for backends the
   * session has just switched away from. They are returned rather than dropped because
   * each one names transcript files on the runner runtime, and this row was the only
   * pointer to them: once it is gone nothing can resolve those paths again, so a caller
   * that wants them cleaned up has exactly this one chance. Losing them is safe (the
   * conversation itself lives in `events`; the on-disk files are materialized back out
   * of it), but leaving the files is a leak that no later session delete can reach.
   */
  async upsertSessionBackendState(input: {
    sessionId: string;
    backend: string;
    backendSessionId: string;
    contextSeq: number;
  }): Promise<SessionBackendStateRecord[]> {
    return await this.db.transaction().execute(async (tx) => {
      // Read before delete rather than `DELETE … RETURNING`: this runs on every bind,
      // against both the Postgres and PGlite dialects, and the extra round trip inside
      // the transaction is cheaper than a dialect-specific surprise here.
      const displaced = await tx
        .selectFrom('session_backend_state')
        .select(['session_id', 'backend', 'backend_session_id', 'context_seq', 'updated_at'])
        .where('session_id', '=', input.sessionId)
        .where('backend', '!=', input.backend)
        .execute();
      await tx
        .deleteFrom('session_backend_state')
        .where('session_id', '=', input.sessionId)
        .where('backend', '!=', input.backend)
        .execute();
      await tx
        .insertInto('session_backend_state')
        .values({
          session_id: input.sessionId,
          backend: input.backend,
          backend_session_id: input.backendSessionId,
          context_seq: input.contextSeq,
        })
        .onConflict((oc) =>
          oc.columns(['session_id', 'backend']).doUpdateSet({
            backend_session_id: input.backendSessionId,
            context_seq: input.contextSeq,
            updated_at: sql`now()`,
          }),
        )
        .execute();
      return displaced.map((row) => ({
        sessionId: row.session_id,
        backend: row.backend,
        backendSessionId: row.backend_session_id,
        contextSeq: Number(row.context_seq),
        updatedAt: row.updated_at,
      }));
    });
  }

  async deleteSessionBackendState(sessionId: string, backend: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('session_backend_state')
      .where('session_id', '=', sessionId)
      .where('backend', '=', backend)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async getSessionBackendStates(sessionId: string): Promise<SessionBackendStateRecord[]> {
    const rows = await this.db
      .selectFrom('session_backend_state')
      .select(['session_id', 'backend', 'backend_session_id', 'context_seq', 'updated_at'])
      .where('session_id', '=', sessionId)
      .execute();
    return rows.map((row) => ({
      sessionId: row.session_id,
      backend: row.backend,
      backendSessionId: row.backend_session_id,
      contextSeq: Number(row.context_seq),
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Every id under which a backend still knows a LIVE session — the union of the
   * `session_backend_state` bindings and the Verity session ids themselves (a
   * cold-started claude thread is opened under the Verity id, so that id names a file
   * on disk before any binding row exists).
   *
   * This is the spare-list for the startup artifact sweep: a transcript file whose id
   * is not in here belongs to a session that no longer exists. Deliberately one query
   * over both tables rather than per-session lookups — the sweep asks once, for all of
   * them, and a partial answer here would delete a live conversation.
   */
  async listLiveBackendSessionIds(): Promise<string[]> {
    const [bindings, sessions] = await Promise.all([
      this.db.selectFrom('session_backend_state').select('backend_session_id').execute(),
      this.db.selectFrom('sessions').select('session_id').execute(),
    ]);
    return [
      ...new Set([
        ...bindings.map((row) => row.backend_session_id),
        ...sessions.map((row) => row.session_id),
      ]),
    ];
  }

  /**
   * The worktree path of every session that still exists. `sessions.worktree` is unique,
   * so this is one entry per session and needs no dedup.
   *
   * The startup artifact sweep needs this because a backend id is not enough to decide
   * ownership of a claude artifact: switching a session to another backend drops the row
   * naming its claude id, so the id stops being live while the session does not. Claude
   * files its transcripts under a directory named for the session's cwd — its worktree —
   * which stays true across every switch, so this is the fact the sweep can trust. See
   * `session-artifact-sweep.ts`.
   */
  async listSessionWorktrees(): Promise<string[]> {
    const rows = await this.db.selectFrom('sessions').select('worktree').execute();
    return rows.map((row) => row.worktree);
  }

  async deleteSessionBackendStates(sessionId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('session_backend_state')
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async deleteProjectSessionBackendStates(projectId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('session_backend_state')
      .where(
        'session_id',
        'in',
        this.db.selectFrom('sessions').select('session_id').where('project_id', '=', projectId),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /**
   * Append a server-authored note for the agent to see on its NEXT turn (see
   * {@link SessionPendingNoteTable}). Not a chat message and not a turn — the
   * conductor folds pending notes into the next backend turn's model prompt and
   * consumes them. Used by the post-merge worktree reset so the agent learns its
   * branch moved without a visible transcript line.
   */
  async appendPendingNote(sessionId: string, note: string): Promise<void> {
    await this.db
      .insertInto('session_pending_note')
      .values({ session_id: sessionId, note })
      .execute();
  }

  /**
   * Read and DELETE all pending notes for a session (consume-once), oldest first.
   * Single `DELETE … RETURNING` so a note can't be double-consumed by a concurrent
   * turn. Returns the note texts in insert order; empty when there are none.
   */
  async consumePendingNotes(sessionId: string): Promise<string[]> {
    const rows = await this.db
      .deleteFrom('session_pending_note')
      .where('session_id', '=', sessionId)
      .returning(['id', 'note'])
      .execute();
    // `execute()` returns a fresh array, so sort it in place. Postgres does not
    // guarantee RETURNING order (and DELETE takes no ORDER BY), so sort by the
    // serial `id` to restore insert order.
    return rows.sort((a, b) => Number(a.id) - Number(b.id)).map((r) => r.note);
  }

  /**
   * Record that a server-authored automation already fired for this session. Returns
   * `true` only for the first caller that inserts the marker; concurrent/repeated
   * attempts for the same `(session, marker)` return `false`.
   */
  async markSessionAutomation(sessionId: string, marker: string): Promise<boolean> {
    const result = await this.db
      .insertInto('session_automation_marker')
      .values({ session_id: sessionId, marker })
      .onConflict((oc) => oc.columns(['session_id', 'marker']).doNothing())
      .executeTakeFirst();
    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  async hasSessionAutomationMarker(sessionId: string, marker: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('session_automation_marker')
      .select('session_id')
      .where('session_id', '=', sessionId)
      .where('marker', '=', marker)
      .executeTakeFirst();
    return row !== undefined;
  }

  async deleteSessionAutomationMarker(sessionId: string, marker: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('session_automation_marker')
      .where('session_id', '=', sessionId)
      .where('marker', '=', marker)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async latestEventSeq(sessionId: string): Promise<number> {
    const row = await this.db
      .selectFrom('events')
      .select((eb) => eb.fn.max('id').as('seq'))
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return Number(row?.seq ?? 0);
  }

  /** Bring the rebuildable message view up to date in resumable event batches. */
  private async backfillMessageProjectionUnlocked(): Promise<void> {
    const sessions = await this.listSessions();
    for (const session of sessions) {
      for (;;) {
        const processed = await this.db.transaction().execute(async (tx) => {
          await sql`select pg_advisory_xact_lock(hashtext(${'messages:' + session.sessionId}))`.execute(
            tx,
          );
          let state = await tx
            .selectFrom('message_projection_state')
            .select(['last_event_seq', 'projection_version'])
            .where('session_id', '=', session.sessionId)
            .executeTakeFirst();
          if (state !== undefined && state.projection_version !== MESSAGE_PROJECTION_VERSION) {
            await tx.deleteFrom('messages').where('session_id', '=', session.sessionId).execute();
            await tx
              .deleteFrom('message_projection_state')
              .where('session_id', '=', session.sessionId)
              .execute();
            state = undefined;
          }
          const rows = await tx
            .selectFrom('events')
            .select(['id', 'payload', 'created_at'])
            .where('session_id', '=', session.sessionId)
            .where('id', '>', Number(state?.last_event_seq ?? 0))
            .orderBy('id', 'asc')
            .limit(500)
            .execute();
          for (const row of rows) {
            await projectMessageEvent(
              tx,
              session.sessionId,
              Number(row.id),
              row.created_at,
              row.payload,
            );
          }
          const last = rows.at(-1);
          if (last !== undefined) {
            await tx
              .insertInto('message_projection_state')
              .values({
                session_id: session.sessionId,
                last_event_seq: Number(last.id),
                projection_version: MESSAGE_PROJECTION_VERSION,
              })
              .onConflict((oc) =>
                oc.column('session_id').doUpdateSet({
                  last_event_seq: Number(last.id),
                  projection_version: MESSAGE_PROJECTION_VERSION,
                }),
              )
              .execute();
          }
          return rows.length;
        });
        if (processed === 0) break;
      }
    }
  }

  scheduleMessageProjection(): void {
    if (this.messageBackfillRunning) {
      this.messageBackfillRequested = true;
      return;
    }
    this.messageBackfillRunning = true;
    const current = this.messageBackfillTail
      .catch(() => undefined)
      .then(async () => {
        await waitForPendingMessageProjections(this.db);
        do {
          this.messageBackfillRequested = false;
          await this.backfillMessageProjectionUnlocked();
        } while (this.messageBackfillRequested);
      })
      .finally(() => {
        this.messageBackfillRunning = false;
      });
    this.messageBackfillTail = current;
    let pendingBackfills = pendingMessageBackfillsByDb.get(this.db);
    if (pendingBackfills === undefined) {
      pendingBackfills = new Set();
      pendingMessageBackfillsByDb.set(this.db, pendingBackfills);
    }
    pendingBackfills.add(current);
    void current.then(
      () => pendingBackfills.delete(current),
      () => pendingBackfills.delete(current),
    );
    void current.catch(() => undefined);
  }

  /** Wait until both ordered live projection and any recovery/search backfill are
   * idle. This is a lifecycle barrier, not an error-reporting seam: live failures
   * are intentionally contained so canonical event persistence stays successful.
   * The barrier waits for all resulting recovery attempts, but does not assert that
   * a deliberately unavailable projection became healthy. */
  async waitForMessageProjectionIdle(): Promise<void> {
    for (;;) {
      await waitForMessageProjectionWork(this.db);
      if (this.messageLiveProjectionTails.size === 0) return;
      // A settled tail unregisters from the map in a `finally` that is one
      // microtask behind the queue barrier above; give it that turn instead of
      // spinning on the map.
      await Promise.resolve();
    }
  }

  async searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]> {
    // Never let replay race the ordered live projector for the same events. A
    // short live tail lands first; if it is still busy after the latency budget,
    // return the currently indexed view and let that tail finish asynchronously.
    const liveCaughtUp = await Promise.race([
      waitForPendingMessageProjections(this.db).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    if (liveCaughtUp) {
      this.scheduleMessageProjection();
      await Promise.race([
        this.messageBackfillTail.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    }
    const query = input.query.trim();
    if (query.length === 0) return [];
    const tsQuery = sql`websearch_to_tsquery('simple', ${query})`;
    const rank = sql<number>`ts_rank_cd(to_tsvector('simple', m.text), ${tsQuery})`;
    let select = this.db
      .selectFrom('messages as m')
      .innerJoin('sessions as s', 's.session_id', 'm.session_id')
      .leftJoin('projects as p', 'p.id', 's.project_id')
      .select([
        'm.id',
        'm.session_id',
        's.name as session_name',
        's.project_id',
        'm.role',
        'm.kind',
        'm.first_event_seq',
        'm.created_at',
        rank.as('search_rank'),
        sql<string>`ts_headline(
          'simple', m.text, ${tsQuery},
          'MaxWords=35, MinWords=12, ShortWord=2, MaxFragments=2, StartSel=⟦, StopSel=⟧'
        )`.as('snippet'),
        sql<string | null>`case when p.id is null then null else p.owner || '/' || p.repo end`.as(
          'project_name',
        ),
      ])
      .where('m.finalized', '=', true)
      .where(sql<boolean>`to_tsvector('simple', m.text) @@ ${tsQuery}`);
    if (input.sessionId !== undefined) select = select.where('m.session_id', '=', input.sessionId);
    if (input.projectId !== undefined) select = select.where('s.project_id', '=', input.projectId);
    if (input.cursor !== undefined) {
      const cursorDate = new Date(input.cursor.createdAt);
      select = select.where(
        sql<boolean>`(${rank} < ${input.cursor.rank}) or
          (${rank} = ${input.cursor.rank} and m.created_at < ${cursorDate}) or
          (${rank} = ${input.cursor.rank} and m.created_at = ${cursorDate} and m.id < ${input.cursor.id})`,
      );
    }
    const rows = await select
      .orderBy(rank, 'desc')
      .orderBy('m.created_at', 'desc')
      .orderBy('m.id', 'desc')
      .limit(Math.min(input.limit ?? 30, 100))
      .execute();
    return rows.map((row) => ({
      id: Number(row.id),
      sessionId: row.session_id,
      sessionName: row.session_name,
      projectId: row.project_id,
      projectName: row.project_name,
      role: row.role,
      kind: row.kind,
      text: row.snippet.replace(/[⟦⟧]/g, ''),
      firstEventSeq: Number(row.first_event_seq),
      createdAt: row.created_at.getTime(),
      rank: row.search_rank,
    }));
  }

  /**
   * Permanently delete a session and its durable log. The `events` and
   * `transcript_lines` foreign keys are `restrict`, so the child rows must go
   * first; all three deletes run in one transaction so a failure can never leave
   * orphaned events/lines pointing at a missing session (or, conversely, a
   * session stripped of its log). Returns `true` if a session row matched,
   * `false` if the id is unknown — the caller (server) maps `false` to a 404.
   *
   * This is the ONE delete path through the otherwise append-only store: it
   * removes a whole session on operator request, not individual events.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    await waitForPendingMessageProjections(this.db);
    return this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('transcript_lines').where('session_id', '=', sessionId).execute();
      await tx.deleteFrom('events').where('session_id', '=', sessionId).execute();
      // A session-scoped secret permission (ADR 0011 D2) is supposed to die with its
      // session, but nothing else expires it: it carries no expiry and no foreign key.
      // Left behind it would stay listed as live forever, and would auto-approve again
      // if this id were ever restored or reused. Ending it belongs in this transaction.
      await tx
        .updateTable('secret_provider_permissions')
        .set({ state: 'revoked', updated_at: new Date().toISOString() })
        .where('session_id', '=', sessionId)
        .where('state', '=', 'active')
        .execute();
      const result = await tx
        .deleteFrom('sessions')
        .where('session_id', '=', sessionId)
        .executeTakeFirst();
      return result.numDeletedRows > 0n;
    });
  }

  /**
   * Append one canonical event to the session's log. Validates against the
   * canonical schema first and refuses to persist anything invalid — the store
   * is the last line of defense behind the adapter's own guarantee. Returns the
   * assigned `seq` (bigserial id) and the row's `created_at` as epoch
   * milliseconds (`ts`), so the live fan-out can broadcast the real persist time
   * alongside `seq` (#32) — matching what the read paths surface.
   */
  async appendEvent(sessionId: string, event: AgentEvent): Promise<{ seq: number; ts: number }> {
    const { type, payload } = await this.prepareEventRow(event);
    // Takes the cross-process append lock like every other writer. Server generations
    // overlap during reattach/cutover, so "the generation that writes a session's events
    // is the generation that sweeps it" is a convention, not something the database
    // enforces: a draining generation can still be streaming a live turn's output through
    // here while the new one probes that same turn. An advisory lock only orders holders
    // OF it, so an append that skipped it would be invisible to
    // {@link appendEventForRunningTurn}'s predicate and still take the lower id — exactly
    // the reversal that lock exists to rule out.
    //
    // Taken from the insert's own source rather than by opening a transaction around it:
    // a lone statement is its own transaction, so an `xact` lock acquired while producing
    // the row to insert is held across the insert and released at its commit — the same
    // window a BEGIN/lock/INSERT/COMMIT would give, at one round trip instead of four.
    // This is the hot path for a locally-run turn's every streamed delta.
    const row = await this.withSessionEventAppend(sessionId, async () => {
      const result = await sql<{ id: number; created_at: Date }>`
        insert into events (session_id, type, payload)
        select ${sessionId}, ${type}, ${payload}::jsonb
        from (select pg_advisory_xact_lock(hashtext(${this.sessionEventAppendLockKey(sessionId)}))) as _lock
        returning id, created_at
      `.execute(this.db);
      const inserted = result.rows[0];
      if (inserted === undefined) throw new Error(`failed to append event to session ${sessionId}`);
      return inserted;
    });
    this.enqueuePersistedMessageEvent(
      sessionId,
      Number(row.id),
      row.created_at,
      JSON.parse(payload) as AgentEvent,
    );
    return { seq: Number(row.id), ts: row.created_at.getTime() };
  }

  /**
   * {@link appendEvent}, but the row lands ONLY while `sessionId`'s in-flight marker
   * still anchors exactly the given turn (`prompt_seq` AND `turn_id`) and that turn has
   * stayed silent since `silentSinceSeq`. Returns `null` when it no longer does — the
   * turn spoke, settled, or was replaced — and then nothing was written.
   *
   * For an OUT-OF-BAND observer that reaches a verdict about one turn over seconds of
   * probing (the liveness sweep) and wants to say so in that turn's transcript. Checking
   * first would only narrow the race: the turn's own terminal event, the marker clear
   * that follows it, and the successor it drains can all land between the check and the
   * insert — putting a message about a dead turn after a successful result, or into a
   * healthy turn's transcript. `insert … select … where` is one statement, so what it
   * tests cannot be overtaken by what it writes, and {@link withSessionEventAppend}
   * keeps a concurrent append from being invisible to the test yet ordered before it.
   *
   * `turn_id` is part of the anchor, not just `prompt_seq`: a resume-retry re-anchors the
   * SAME `prompt_seq` as a fresh attempt with a new identity ({@link markTurnRunning}),
   * so `prompt_seq` alone would let a verdict about the previous attempt through.
   * `silentSinceSeq` is the newest event the observer saw before forming its verdict;
   * requiring the log not to have moved keeps this free of any notion of which events
   * end a turn — ANY new event means the observation is out of date.
   */
  async appendEventForRunningTurn(
    sessionId: string,
    anchor: { promptSeq: number; turnId: string | null; silentSinceSeq: number },
    event: AgentEvent,
  ): Promise<{ seq: number; ts: number } | null> {
    const { type, payload } = await this.prepareEventRow(event);
    const result = await this.withSessionEventAppend(sessionId, () =>
      this.db.transaction().execute(async (tx) => {
        await this.sessionEventAppendLock(tx, sessionId);
        return await sql<{ id: number; created_at: Date }>`
          insert into events (session_id, type, payload)
          select ${sessionId}, ${type}, ${payload}::jsonb
          from running_turns
          where session_id = ${sessionId}
            and prompt_seq = ${anchor.promptSeq}
            and turn_id is not distinct from ${anchor.turnId}
            and not exists (
              select 1 from events
              where session_id = ${sessionId} and id > ${anchor.silentSinceSeq}
            )
          returning id, created_at
        `.execute(tx);
      }),
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    this.enqueuePersistedMessageEvent(
      sessionId,
      Number(row.id),
      row.created_at,
      JSON.parse(payload) as AgentEvent,
    );
    return { seq: Number(row.id), ts: row.created_at.getTime() };
  }

  /** Validate, externalize, and redact an event into the exact `(type, payload)`
   * an `events` row stores. Shared by {@link appendEvent} and the Runner-frame
   * ingest path so both persist byte-identical rows. Runs the content-addressed
   * externalization (which writes to `attachments`) — that is idempotent and safe
   * to perform BEFORE the ingest transaction, so the transaction stays a tight
   * `events` + `runner_frames` claim. */
  private async prepareEventRow(event: AgentEvent): Promise<{ type: string; payload: string }> {
    const parsed = parseAgentEvent(event);
    if (!parsed.success) {
      throw new Error(`refusing to persist invalid event: ${parsed.error.message}`);
    }
    // Externalize a tool result's heavy inline payloads into the content-addressed
    // blob table, so the PERSISTED event carries lazy refs (images #115, and large
    // text bodies) instead of the full bytes — a reload transfers only previews +
    // the visible images, not the whole backlog. The caller's `event` is left
    // untouched (only a copy is stored), so the live broadcast still ships the
    // inline bytes the client already has and can render without a round-trip.
    const canonical = parsed.data;
    const toStore =
      canonical.t === 'tool_result' ? await this.externalizeToolResult(canonical) : canonical;
    // Redact recognized credentials from the PERSISTED copy (audit M9). Token
    // characters never include JSON structural chars, so redacting the serialized
    // payload keeps it valid JSON. The caller's live `event` is left untouched, so
    // the broadcast to the operator's own device is unaffected.
    // Scrub U+0000 from the PERSISTED copy last: PostgreSQL rejects a `jsonb`
    // document that carries one, which used to abort the whole turn on any agent
    // output echoing a NUL. Runs after redaction so both rewrites see the same
    // serialized string; the caller's live `event` again stays untouched.
    return { type: canonical.t, payload: scrubNulEscapes(redactSecrets(JSON.stringify(toStore))) };
  }

  /**
   * Ingest one Runner frame idempotently (ADR 0006 D4) — the restart-safe seam that
   * lets a new Server re-tail a turn's append-only frame file from byte zero without
   * duplicating events. In ONE transaction this:
   *
   *   1. verifies the immutable `turn_id → runner_instance_id` binding;
   *   2. returns `duplicate` if `(turn_id, frame_seq)` is already claimed — after
   *      checking the replay carries the SAME `payload_hash` (a changed one is
   *      corruption, not a duplicate);
   *   3. otherwise enforces contiguity (`frame_seq` 1, or `frame_seq - 1` present);
   *   4. persists the `event` row when the frame carries one; and
   *   5. claims `(turn_id, frame_seq)` under the primary key; and
   *   6. for a terminal frame, closes the matching `running_turns` marker.
   *
   * Only a newly-claimed frame returns `accepted` — the caller publishes those to
   * live subscribers and suppresses `duplicate`s (which reconnecting clients receive
   * through backlog replay). A single file tail delivers serially, while overlapping
   * Server generations are serialized by the per-turn in-process queue plus the
   * PostgreSQL transaction advisory lock below.
   *
   */
  async ingestRunnerFrame(
    sessionId: string,
    frame: RunnerFrameIngest,
  ): Promise<RunnerFrameIngestResult> {
    // Two kinds of frame decide what a conditional append sees: one that carries an
    // event appends to the session's log, and a TERMINAL one closes the marker that
    // append tests. Both do it from inside a multi-statement transaction, so either can
    // be invisible to a concurrent {@link appendEventForRunningTurn} — which would then
    // write "the Runner is gone" onto a turn that had just ended normally. Both join the
    // session's append order; a frame that only claims a mid-turn seq stays out of it.
    if (frame.event === undefined && frame.terminal !== true) {
      return await this.ingestRunnerFrameInner(sessionId, frame);
    }
    return await this.withSessionEventAppend(sessionId, () =>
      this.ingestRunnerFrameInner(sessionId, frame),
    );
  }

  private async ingestRunnerFrameInner(
    sessionId: string,
    frame: RunnerFrameIngest,
  ): Promise<RunnerFrameIngestResult> {
    if (frame.protocolVersion !== RUNNER_FRAME_PROTOCOL_VERSION) {
      throw new Error(
        `unsupported runner frame protocol version ${frame.protocolVersion} ` +
          `(this server ingests version ${RUNNER_FRAME_PROTOCOL_VERSION})`,
      );
    }
    if (!Number.isInteger(frame.frameSeq) || frame.frameSeq < 1) {
      throw new Error(`runner frame seq must be a positive integer, got ${frame.frameSeq}`);
    }
    if (frame.terminal === true && frame.event !== undefined) {
      throw new Error('runner terminal frame cannot also carry an event');
    }
    // The fence below is recognized by its reserved `payload_hash`, and nothing
    // constrains what a Runner puts in that column — so refuse the sentinel here
    // rather than trust that no frame carries it. This is what makes "a row with
    // this hash is a fence" true instead of merely likely: a frame claiming it is
    // rejected before it can be stored, so no turn can be fenced by its own stream.
    if (frame.payloadHash === ABANDONED_TURN_FENCE_HASH) {
      throw new Error(
        `runner frame refused: payload hash ${ABANDONED_TURN_FENCE_HASH} is reserved ` +
          'for recovery fences',
      );
    }
    // Prepare the event row (validate + externalize + redact) BEFORE the transaction:
    // externalization writes content-addressed `attachments` rows that are idempotent
    // and harmless if the transaction later rolls back, keeping the claim atomic and small.
    const eventRow =
      frame.event !== undefined ? await this.prepareEventRow(frame.event) : undefined;

    const predecessor = this.runnerFrameIngestTails.get(frame.turnId) ?? Promise.resolve();
    let release!: () => void;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.runnerFrameIngestTails.set(frame.turnId, queued);
    await predecessor;
    try {
      return await this.db.transaction().execute(async (tx) => {
        // Multiple Server generations may overlap during reattach/cutover. Serialize
        // claims for one turn across processes, not merely within one file tail, so
        // terminal fencing cannot race a later frame. The lock is transaction-scoped.
        // An ingest that appends an event or closes the marker takes the session's
        // append lock first, in that order everywhere, so it cannot be invisible to a
        // conditional append yet ordered ahead of it — and the two locks cannot be
        // taken in opposite orders.
        if (eventRow !== undefined || frame.terminal === true) {
          await this.sessionEventAppendLock(tx, sessionId);
        }
        await sql`select pg_advisory_xact_lock(hashtext(${frame.turnId}))`.execute(tx);

        // (0) the turn was abandoned by recovery — refuse everything from the fence on.
        // Contiguity puts every already-claimed frame below it, so a replay of what the
        // turn said while it still held the session stays a valid duplicate below.
        const fence = await tx
          .selectFrom('runner_frames')
          .select('frame_seq')
          .where('turn_id', '=', frame.turnId)
          .where('payload_hash', '=', ABANDONED_TURN_FENCE_HASH)
          .executeTakeFirst();
        if (fence !== undefined && frame.frameSeq >= Number(fence.frame_seq)) {
          throw new Error(
            `runner frame refused: turn ${frame.turnId} was abandoned by recovery at seq ` +
              `${fence.frame_seq}, refusing seq ${frame.frameSeq}`,
          );
        }

        // (1) immutable turn → runner-instance binding. Fence rows are excluded: the
        // fence may have been planted before the turn ever streamed a frame, and its
        // placeholder instance id is not the turn's binding.
        const bound = await tx
          .selectFrom('runner_frames')
          .select(['runner_instance_id', 'session_id'])
          .where('turn_id', '=', frame.turnId)
          .where('payload_hash', '!=', ABANDONED_TURN_FENCE_HASH)
          .limit(1)
          .executeTakeFirst();
        if (bound !== undefined && bound.runner_instance_id !== frame.runnerInstanceId) {
          throw new Error(
            `runner frame corruption: turn ${frame.turnId} is bound to runner instance ` +
              `${bound.runner_instance_id}, refusing a frame from ${frame.runnerInstanceId}`,
          );
        }
        if (bound !== undefined && bound.session_id !== sessionId) {
          throw new Error(
            `runner frame corruption: turn ${frame.turnId} is bound to session ` +
              `${bound.session_id}, refusing a frame for ${sessionId}`,
          );
        }

        // (2) already claimed → duplicate (a replay). Guard the payload hash.
        const existing = await tx
          .selectFrom('runner_frames')
          .select(['payload_hash', 'event_id', 'terminal'])
          .where('turn_id', '=', frame.turnId)
          .where('frame_seq', '=', frame.frameSeq)
          .executeTakeFirst();
        if (existing !== undefined) {
          if (existing.payload_hash !== frame.payloadHash) {
            throw new Error(
              `runner frame corruption: (turn ${frame.turnId}, seq ${frame.frameSeq}) was ` +
                `replayed with a changed payload`,
            );
          }
          // Rolling-deploy compatibility: pre-0053/older Servers wrote result claims
          // without the terminal bit. A hash-identical replay from a new Server carries
          // the missing kind information, so promote that claim and close its marker in
          // this transaction. This is idempotent and scoped away from newer turns.
          if (frame.terminal === true && !existing.terminal) {
            const later = await tx
              .selectFrom('runner_frames')
              .select('frame_seq')
              .where('turn_id', '=', frame.turnId)
              .where('frame_seq', '>', frame.frameSeq)
              .executeTakeFirst();
            if (later !== undefined) {
              throw new Error(
                `runner frame corruption: cannot promote terminal seq ${frame.frameSeq} for turn ` +
                  `${frame.turnId}; later seq ${later.frame_seq} already exists`,
              );
            }
            await tx
              .updateTable('runner_frames')
              .set({ terminal: true })
              .where('turn_id', '=', frame.turnId)
              .where('frame_seq', '=', frame.frameSeq)
              .execute();
            await tx
              .deleteFrom('running_turns')
              .where('session_id', '=', sessionId)
              .where('turn_id', '=', frame.turnId)
              .execute();
          }
          if (existing.event_id !== null) {
            const ev = await tx
              .selectFrom('events')
              .select('created_at')
              .where('id', '=', existing.event_id)
              .executeTakeFirst();
            if (ev !== undefined) {
              return {
                outcome: 'duplicate',
                seq: Number(existing.event_id),
                ts: ev.created_at.getTime(),
              };
            }
          }
          return { outcome: 'duplicate' };
        }

        // A result is the final frame (D3). Once its claim commits, a second result
        // or any other later frame is corruption rather than another harmless replay.
        // Same-sequence replays returned above remain valid duplicates.
        const terminal = await tx
          .selectFrom('runner_frames')
          .select('frame_seq')
          .where('turn_id', '=', frame.turnId)
          .where('terminal', '=', true)
          .executeTakeFirst();
        if (terminal !== undefined) {
          throw new Error(
            `runner frame corruption: turn ${frame.turnId} already terminated at seq ` +
              `${terminal.frame_seq}, refusing seq ${frame.frameSeq}`,
          );
        }

        // (3) contiguity: seq 1 is the anchor; otherwise the predecessor must exist.
        if (frame.frameSeq > 1) {
          const prev = await tx
            .selectFrom('runner_frames')
            .select('frame_seq')
            .where('turn_id', '=', frame.turnId)
            .where('frame_seq', '=', frame.frameSeq - 1)
            .executeTakeFirst();
          if (prev === undefined) {
            throw new Error(
              `runner frame gap: turn ${frame.turnId} received seq ${frame.frameSeq} ` +
                `before seq ${frame.frameSeq - 1}`,
            );
          }
        }

        // (4) persist the event, if any — atomically with the claim below.
        let eventId: number | null = null;
        let result: RunnerFrameIngestResult = { outcome: 'accepted' };
        if (eventRow !== undefined) {
          const row = await tx
            .insertInto('events')
            .values({ session_id: sessionId, type: eventRow.type, payload: eventRow.payload })
            .returning(['id', 'created_at'])
            .executeTakeFirstOrThrow();
          eventId = Number(row.id);
          result = { outcome: 'accepted', seq: eventId, ts: row.created_at.getTime() };
        }

        // (5) claim (turn_id, frame_seq) under the primary key.
        await tx
          .insertInto('runner_frames')
          .values({
            turn_id: frame.turnId,
            frame_seq: frame.frameSeq,
            runner_instance_id: frame.runnerInstanceId,
            session_id: sessionId,
            payload_hash: frame.payloadHash,
            event_id: eventId,
            terminal: frame.terminal === true,
          })
          .execute();

        // Scope by BOTH session and turn identity: a late terminal from an older turn
        // must never delete a newer marker for the same session. This delete commits
        // atomically with the terminal claim, eliminating the append/commit crash gap.
        if (frame.terminal === true) {
          await tx
            .deleteFrom('running_turns')
            .where('session_id', '=', sessionId)
            .where('turn_id', '=', frame.turnId)
            .execute();
        }

        return result;
      });
    } finally {
      if (eventRow !== undefined) this.scheduleMessageProjection();
      release();
      if (this.runnerFrameIngestTails.get(frame.turnId) === queued) {
        this.runnerFrameIngestTails.delete(frame.turnId);
      }
    }
  }

  /**
   * Close a turn's frame stream for good, for a Runner that was never confirmed gone.
   *
   * ADR 0006 D7 step 5 gives up on a Runner the discovery seam can never answer for and
   * settles its turn so the session is usable again. That verdict is a bound, not proof:
   * the Runner may still be alive and may still stream. A confirmed-dead one is fenced
   * by its own terminal frame; this one has none, so nothing would stop its frames from
   * appending into the transcript of whatever turn holds the session next.
   *
   * The fence is a `runner_frames` row claiming the next sequence with a reserved
   * `payload_hash`, so it lives under the primary key that already orders a turn's
   * frames and needs no state of its own. Everything from that sequence on is refused;
   * a replay of a frame the turn claimed while it still held the session sits below the
   * fence and stays a valid duplicate. Idempotent — fencing an already-fenced turn is a
   * no-op, so the retry that follows a failed settle does not stack fences.
   *
   * What this cannot do is stop the Runner itself. A Runner that cannot be reached
   * cannot be killed, so its side effects on the worktree are the residual cost of
   * bounding step 5 — the fence bounds what reaches the LOG, not what reaches the disk.
   */
  async fenceAbandonedTurn(sessionId: string, turnId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${turnId}))`.execute(tx);
      const rows = await tx
        .selectFrom('runner_frames')
        .select(['frame_seq', 'runner_instance_id', 'payload_hash'])
        .where('turn_id', '=', turnId)
        .orderBy('frame_seq', 'desc')
        .execute();
      if (rows.some((row) => row.payload_hash === ABANDONED_TURN_FENCE_HASH)) return;
      const last = rows[0];
      await tx
        .insertInto('runner_frames')
        .values({
          turn_id: turnId,
          frame_seq: last === undefined ? 1 : Number(last.frame_seq) + 1,
          // Carry the turn's real binding when it has one, so the instance check keeps
          // reading the same value whether or not the fence row is present.
          runner_instance_id: last?.runner_instance_id ?? ABANDONED_TURN_FENCE_INSTANCE,
          session_id: sessionId,
          payload_hash: ABANDONED_TURN_FENCE_HASH,
          event_id: null,
          terminal: true,
        })
        .execute();
    });
  }

  /**
   * Fence a still-running turn only if it has remained silent through `latestSeq`.
   *
   * The turn advisory lock is the same lock used by runner-frame ingestion, making
   * the silence check and fence insertion atomic with respect to a late frame. A
   * changed marker or any newer event refuses the fence and leaves the turn alone.
   */
  async fenceRunningTurnIfSilent(
    anchor: RunningTurnRecord,
    latestSeq: number,
    event?: AgentEvent,
  ): Promise<{ seq: number; ts: number; fenceSeq: number; noticeSeq: number | null } | null> {
    if (anchor.turnId === null) return null;
    const turnId = anchor.turnId;
    const eventRow = event === undefined ? undefined : await this.prepareEventRow(event);
    const result = await this.withSessionEventAppend(anchor.sessionId, () =>
      this.withRunnerFrameTurn(turnId, () =>
        this.db.transaction().execute(async (tx) => {
          // Keep the global order used by event-bearing frame ingestion: session
          // append lock first, then turn lock. The former makes the MAX(events.id)
          // predicate atomic with every canonical event writer; the latter makes
          // the fence atomic with every frame claim.
          await this.sessionEventAppendLock(tx, anchor.sessionId);
          await sql`select pg_advisory_xact_lock(hashtext(${turnId}))`.execute(tx);
          const marker = await tx
            .selectFrom('running_turns')
            .select(['prompt_seq', 'turn_id'])
            .where('session_id', '=', anchor.sessionId)
            .executeTakeFirst();
          if (
            marker === undefined ||
            Number(marker.prompt_seq) !== anchor.promptSeq ||
            marker.turn_id !== turnId
          ) {
            return null;
          }
          const newest = await tx
            .selectFrom('events')
            .select((eb) => eb.fn.max('id').as('seq'))
            .where('session_id', '=', anchor.sessionId)
            .executeTakeFirst();
          if (Number(newest?.seq ?? 0) !== latestSeq) return null;

          const rows = await tx
            .selectFrom('runner_frames')
            .select(['frame_seq', 'runner_instance_id', 'payload_hash'])
            .where('turn_id', '=', turnId)
            .orderBy('frame_seq', 'desc')
            .execute();
          if (rows.some((row) => row.payload_hash === ABANDONED_TURN_FENCE_HASH)) return null;

          let persisted: { seq: number; ts: number } = { seq: latestSeq, ts: Date.now() };
          if (eventRow !== undefined) {
            const inserted = await tx
              .insertInto('events')
              .values({
                session_id: anchor.sessionId,
                type: eventRow.type,
                payload: eventRow.payload,
              })
              .returning(['id', 'created_at'])
              .executeTakeFirstOrThrow();
            persisted = { seq: Number(inserted.id), ts: inserted.created_at.getTime() };
          }

          const last = rows[0];
          await tx
            .insertInto('runner_frames')
            .values({
              turn_id: turnId,
              frame_seq: last === undefined ? 1 : Number(last.frame_seq) + 1,
              runner_instance_id: last?.runner_instance_id ?? ABANDONED_TURN_FENCE_INSTANCE,
              session_id: anchor.sessionId,
              payload_hash: ABANDONED_TURN_FENCE_HASH,
              event_id: null,
              terminal: true,
            })
            .execute();
          return {
            ...persisted,
            fenceSeq: last === undefined ? 1 : Number(last.frame_seq) + 1,
            noticeSeq: eventRow === undefined ? null : persisted.seq,
          };
        }),
      ),
    );
    return result;
  }

  /** Undo a stalled-turn fence when shutdown won immediately after it committed. */
  async releaseRunningTurnFence(
    anchor: RunningTurnRecord,
    noticeSeq: number | null,
    fenceSeq: number,
  ): Promise<void> {
    if (anchor.turnId === null) return;
    const turnId = anchor.turnId;
    let projectionInvalidated = false;
    await this.withSessionEventAppend(anchor.sessionId, () =>
      this.withRunnerFrameTurn(turnId, () =>
        this.db.transaction().execute(async (tx) => {
          await this.sessionEventAppendLock(tx, anchor.sessionId);
          await sql`select pg_advisory_xact_lock(hashtext(${turnId}))`.execute(tx);
          const removed = await tx
            .deleteFrom('runner_frames')
            .where('turn_id', '=', turnId)
            .where('frame_seq', '=', fenceSeq)
            .where('payload_hash', '=', ABANDONED_TURN_FENCE_HASH)
            .executeTakeFirst();
          if (removed.numDeletedRows === 0n) return;
          if (noticeSeq !== null) {
            const deleted = await tx
              .deleteFrom('events')
              .where('session_id', '=', anchor.sessionId)
              .where('id', '=', noticeSeq)
              .executeTakeFirst();
            if (deleted.numDeletedRows > 0n) {
              // The search view may already contain this provisional notice and its
              // cursor may point beyond the now-removed event. Reset it in the same
              // transaction, then rebuild from the surviving canonical log after
              // commit. Serialize with both live projection and backfill before
              // resetting: either may already have read the notice and would
              // otherwise reinsert it after this transaction commits. A rollback
              // therefore restores both canonical and projected state together.
              await sql`select pg_advisory_xact_lock(hashtext(${
                'messages:' + anchor.sessionId
              }))`.execute(tx);
              await tx.deleteFrom('messages').where('session_id', '=', anchor.sessionId).execute();
              await tx
                .deleteFrom('message_projection_state')
                .where('session_id', '=', anchor.sessionId)
                .execute();
              projectionInvalidated = true;
            }
          }
        }),
      ),
    );
    if (projectionInvalidated) this.scheduleMessageProjection();
  }

  /** Rewrite a `tool_result`'s heavy inline payloads to content-addressed refs:
   * inline images → `id` refs (#115), and a large text output → a truncated preview
   * plus an `outputRef` to the full body. A no-op (returns the same event) when it
   * carries neither. Images are externalized first so the stored full-text body
   * already references images by id rather than re-embedding their base64. */
  private async externalizeToolResult(
    event: Extract<AgentEvent, { t: 'tool_result' }>,
  ): Promise<AgentEvent> {
    const imaged = await externalizeToolResultImages(event.output, (mediaType, data) =>
      this.putAttachment(mediaType, data),
    );
    const texted = await externalizeToolResultText(imaged.output, (jsonText) =>
      this.putTextBlob(jsonText),
    );
    if (!imaged.changed && texted.ref === undefined) return event;
    return {
      ...event,
      output: texted.output,
      ...(texted.ref !== undefined ? { outputRef: texted.ref } : {}),
    };
  }

  /**
   * Store a UTF-8 text blob content-addressed by the SHA-256 of its bytes, reusing
   * the `attachments` table (a generic content-addressed blob store). Idempotent —
   * identical text dedupes to one row. Returns the hash — the `id` a `tool_result`'s
   * `outputRef` references and a consumer fetches by. Stored as `application/json`
   * because the externalized body is the JSON serialization of the tool output.
   */
  async putTextBlob(jsonText: string): Promise<string> {
    // Redact credentials from the externalized tool-output blob too (audit M9), so
    // a token echoed in a large tool result isn't persisted in clear. Content-
    // addressed by the REDACTED bytes, so the event's outputRef stays consistent.
    const bytes = Buffer.from(redactSecrets(jsonText), 'utf8');
    const hash = createHash('sha256').update(bytes).digest('hex');
    await this.db
      .insertInto('attachments')
      .values({ hash, media_type: 'application/json', bytes })
      .onConflict((oc) => oc.column('hash').doNothing())
      .execute();
    return hash;
  }

  /**
   * Store an image blob from its base64 payload, content-addressed by the SHA-256
   * of the decoded bytes. Idempotent: a re-upload of identical bytes is a no-op
   * (ON CONFLICT DO NOTHING), so the same image dedupes to one row. Returns the
   * hash — the `id` a `prompt` event references and the client fetches by.
   */
  async putAttachment(mediaType: string, base64Data: string): Promise<string> {
    const bytes = Buffer.from(base64Data, 'base64');
    const hash = createHash('sha256').update(bytes).digest('hex');
    await this.db
      .insertInto('attachments')
      .values({ hash, media_type: mediaType, bytes })
      .onConflict((oc) => oc.column('hash').doNothing())
      .execute();
    return hash;
  }

  /** Read a stored blob by its hash (for serving over HTTP); `undefined` if unknown. */
  async getAttachment(hash: string): Promise<AttachmentBlob | undefined> {
    const row = await this.db
      .selectFrom('attachments')
      .select(['media_type', 'bytes'])
      .where('hash', '=', hash)
      .executeTakeFirst();
    if (!row) return undefined;
    return { mediaType: row.media_type, bytes: Buffer.from(row.bytes) };
  }

  /** Read a session's full event log in append order. Validates each payload. */
  async getEvents(sessionId: string): Promise<AgentEvent[]> {
    const sequenced = await this.getEventsAfter(sessionId, 0);
    return sequenced.map((s) => s.event);
  }

  /**
   * Read a backward page of history: the newest `limit` events with `seq <
   * beforeSeq`, returned in ascending `seq` order (ready to prepend to the
   * transcript). Omit `beforeSeq` (or pass a value past the head) for the most
   * recent page. Lets a long session open with only its tail and fetch older
   * turns on scroll-up, instead of replaying the whole log. `hasMore` tells the
   * caller whether still-older events exist before the page.
   */
  async getEventsBeforeSeq(
    sessionId: string,
    limit: number,
    beforeSeq?: number,
  ): Promise<{ events: SequencedEvent[]; hasMore: boolean }> {
    let q = this.db
      .selectFrom('events')
      .select(['id', 'payload', 'created_at'])
      .where('session_id', '=', sessionId);
    if (beforeSeq !== undefined) q = q.where('id', '<', beforeSeq);
    // One extra row probes whether an older page exists, then is dropped.
    const rows = await q
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const hasMore = rows.length > limit;
    const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
    const events = page.map((row) => {
      const parsed = parseAgentEvent(row.payload);
      if (!parsed.success) {
        throw new Error(`corrupt event payload in session ${sessionId}: ${parsed.error.message}`);
      }
      return { seq: Number(row.id), ts: row.created_at.getTime(), event: parsed.data };
    });
    return { events, hasMore };
  }

  /**
   * Read events with `seq > afterSeq` (the bigserial id) in order, each tagged
   * with its `seq`. `afterSeq = 0` returns the full log. The cursor lets a WS
   * client page a backlog and resume after a reconnect without re-sending it.
   */
  async getEventsAfter(sessionId: string, afterSeq: number): Promise<SequencedEvent[]> {
    const rows = await this.db
      .selectFrom('events')
      .select(['id', 'payload', 'created_at'])
      .where('session_id', '=', sessionId)
      .where('id', '>', afterSeq)
      .orderBy('id', 'asc')
      .execute();
    return rows.map((row) => {
      const parsed = parseAgentEvent(row.payload);
      if (!parsed.success) {
        throw new Error(`corrupt event payload in session ${sessionId}: ${parsed.error.message}`);
      }
      return { seq: Number(row.id), ts: row.created_at.getTime(), event: parsed.data };
    });
  }

  /**
   * Read what the overview projections need from a set of session logs, WITHOUT
   * hydrating those logs.
   *
   * The session list, the session detail and the project detail each derive five
   * things per session: the status badge, the cumulative usage, the latest
   * rate-limit states, `eventCount` (the unread badge compares it against
   * `lastSeenEventCount`) and `lastActivityAt`. Deriving them used to mean
   * `getEventsAfter(id, 0)` per
   * session on a route the app polls every two seconds: every row of every log
   * off the heap, its jsonb payload parsed and Zod-validated, to answer a badge
   * and two numbers — enough of it to saturate the connection pool and stall
   * every other request behind it.
   *
   * The first three read only {@link SESSION_PROJECTION_EVENT_TYPES}, which the
   * denormalized `events.type` column can filter on directly (index
   * `events_session_id_type_id_idx`). What that removes is the payload: the heap
   * fetches, the JSON parse and the validation, which is where essentially all of
   * the cost was.
   *
   * WHAT IT DOES NOT REMOVE: the counters still scan one index entry per event,
   * because both are exact facts about the whole log — `count(*)` for the unread
   * badge, `max(id)` for "last activity", which an event OUTSIDE the slice (a
   * streaming `text`) also moves. So this is still linear in log length, just
   * index-only rather than a heap sweep. Making it sublinear means maintaining a
   * per-session counter on the append path, which is a bigger change than a read
   * path can make on its own. A caller that does not need the counters should ask
   * {@link listSessionProjectionEvents} instead and skip that scan entirely —
   * which is what the activity poll, the most frequent of these routes, does.
   *
   * BATCHED ON PURPOSE: `GET /sessions` needs every session at once, so this
   * answers all of them in two queries (the slice, then the counters) rather than
   * two per session — two per {@link PROJECTION_ID_CHUNK} sessions, precisely,
   * since the bind-parameter ceiling forces a chunk loop above that many ids.
   * Sessions with an empty log are present in the map with
   * `eventCount: 0` — absent from the map means the session id was not asked for.
   */
  async listSessionProjectionFacts(
    sessionIds: readonly string[],
  ): Promise<Map<string, SessionProjectionFacts>> {
    const facts = new Map<string, SessionProjectionFacts>(
      sessionIds.map((sessionId) => [
        sessionId,
        { eventCount: 0, lastActivityAt: null, events: [] },
      ]),
    );
    if (facts.size === 0) return facts;
    const chunks = idChunks([...facts.keys()]);

    // The slice and totals must describe the SAME log prefix. Under Postgres'
    // default READ COMMITTED isolation each statement gets a new snapshot, so a
    // result or rate-limit event appended between them could appear in only one
    // half and briefly produce a status/usage combination that never existed.
    // REPEATABLE READ fixes the snapshot for the complete batched read, including
    // every chunk on installs large enough to cross the bind-parameter ceiling.
    await this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (tx) => {
        await this.readProjectionSlices(
          chunks,
          new Map([...facts].map(([sessionId, entry]) => [sessionId, entry.events])),
          tx,
        );

        // `count(*)` and the newest row's timestamp, in one index scan per session.
        //
        // The timestamp rides along as a correlated subquery keyed by the group's own
        // `max(id)` — a primary-key lookup per session, not a second scan — rather than
        // as a follow-up statement. That is one round trip instead of two, and it puts
        // the count and the timestamp in ONE snapshot, so they can no longer disagree
        // about where the log ends.
        //
        // The timestamp is that of the row with the highest id rather than
        // `max(created_at)`: `created_at` defaults to `now()`, which is transaction-
        // START time, so two events appended from overlapping transactions can carry
        // timestamps in the opposite order from their seq. The transcript's own
        // ordering is by seq, and this has to agree with it.
        for (const ids of chunks) {
          const totals = await tx
            .selectFrom('events')
            .select((eb) => [
              'session_id',
              eb.fn.countAll<string | number | bigint>().as('event_count'),
              sql<Date | null>`(select newest.created_at from events as newest
                 where newest.id = max(events.id))`.as('last_activity_at'),
            ])
            .where('session_id', 'in', ids)
            .groupBy('session_id')
            .execute();
          for (const row of totals) {
            const entry = facts.get(row.session_id);
            if (entry === undefined) continue;
            entry.eventCount = Number(row.event_count);
            entry.lastActivityAt = row.last_activity_at?.getTime() ?? null;
          }
        }
      });
    return facts;
  }

  /**
   * The projection slice ALONE, for callers that need the events and not the
   * counters.
   *
   * `GET /sessions/:id/activity` is the whole reason this exists. It polls every
   * 1.5 s per open session, and it reads the log for exactly one question: is a
   * background task still open behind a turn that already reported its result. It
   * never returns `eventCount` or `lastActivityAt` — and those are the half of
   * {@link listSessionProjectionFacts} that stays LINEAR in log length, because
   * `count(*)` is an exact fact about the whole log while the slice is an index
   * range over eight discriminants. Charging the hottest poll a full-log index
   * scan for two numbers it discards is the same shape of waste this change
   * removed from the routes, one level down.
   *
   * A separate method rather than a flag on the other one, because the flag would
   * have to leave `eventCount: 0` behind — and a zero count is not an absence,
   * it is what {@link deriveSessionStatusFromProjection} reads as `idle`.
   */
  async listSessionProjectionEvents(
    sessionIds: readonly string[],
  ): Promise<Map<string, SequencedEvent[]>> {
    const slices = new Map<string, SequencedEvent[]>(
      sessionIds.map((sessionId) => [sessionId, []]),
    );
    if (slices.size === 0) return slices;
    await this.readProjectionSlices(idChunks([...slices.keys()]), slices);
    return slices;
  }

  /** The slice read shared by {@link listSessionProjectionFacts} and
   *  {@link listSessionProjectionEvents}: appends each session's projected events,
   *  in `seq` order, to the array already sitting under its id. */
  private async readProjectionSlices(
    chunks: readonly (readonly string[])[],
    into: ReadonlyMap<string, SequencedEvent[]>,
    db: Kysely<Database> | Transaction<Database> = this.db,
  ): Promise<void> {
    for (const ids of chunks) {
      const rows = await db
        .selectFrom('events')
        .select(['session_id', 'id', 'payload', 'created_at'])
        .where('session_id', 'in', ids)
        .where('type', 'in', [...SESSION_PROJECTION_EVENT_TYPES])
        .orderBy('session_id', 'asc')
        .orderBy('id', 'asc')
        .execute();
      for (const row of rows) {
        const events = into.get(row.session_id);
        if (events === undefined) continue;
        const parsed = parseAgentEvent(row.payload);
        if (!parsed.success) {
          // Same contract as {@link getEventsAfter}: a payload that does not
          // parse is a corrupted log, not a row to skip past. Batching widens the
          // blast radius — one bad row now fails the whole list rather than one
          // session — and that is the right trade: events are validated on the
          // way IN, so a row that fails on the way out means the database no
          // longer holds what the server wrote, and a badge quietly rendered from
          // the surviving rows would hide it.
          throw new Error(
            `corrupt event payload in session ${row.session_id}: ${parsed.error.message}`,
          );
        }
        events.push({ seq: Number(row.id), ts: row.created_at.getTime(), event: parsed.data });
      }
    }
  }

  /**
   * Persist one queued turn to the durable backlog (issue #80). The conductor
   * mirrors its in-memory FIFO queue here so a turn sent while the session was busy
   * survives a server restart. The bigserial `seq` is assigned by the database and
   * fixes the FIFO order; `id` is the conductor-minted retract handle.
   */
  async enqueueTurn(input: QueuedTurnInput): Promise<void> {
    await this.db
      .insertInto('queued_turns')
      .values({
        id: input.id,
        session_id: input.sessionId,
        prompt: input.prompt,
        opts: JSON.stringify(input.opts),
      })
      .execute();
  }

  /**
   * Remove one queued turn from the durable backlog by its `id` — called when the
   * turn dispatches (drained as the session goes idle) or the operator retracts it
   * (issue #80). Returns `true` if a row matched, `false` if it was already gone (a
   * harmless no-op: e.g. a retract racing the drain that just dispatched it).
   */
  async deleteQueuedTurn(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('queued_turns').where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Remove a backlog snapshot atomically: either every queued row is deleted or
   * none is. Stop uses this so a storage failure cannot leave a partially deleted
   * backlog split between live memory and durable recovery. */
  async deleteQueuedTurns(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.transaction().execute(async (tx) => {
      for (const id of ids) {
        await tx.deleteFrom('queued_turns').where('id', '=', id).execute();
      }
    });
  }

  /**
   * Read the entire durable backlog across all sessions in FIFO order, for the
   * conductor to rebuild its in-memory queues on startup (issue #80). Ordered by
   * `seq` so each session's turns recover in the order they were enqueued.
   */
  async listQueuedTurns(): Promise<QueuedTurnRecord[]> {
    const rows = await this.db
      .selectFrom('queued_turns')
      .select(['id', 'seq', 'session_id', 'prompt', 'opts'])
      .orderBy('seq', 'asc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      seq: Number(row.seq),
      sessionId: row.session_id,
      prompt: row.prompt,
      opts: row.opts,
    }));
  }

  /** Mark a turn in flight for `sessionId` (upsert — only one turn runs at a time).
   * Recovery reads these at startup: a marker still present means the turn was
   * abandoned by a crash/restart and must be settled rather than re-inferred. */
  async markTurnRunning(input: { sessionId: string; promptSeq: number }): Promise<void> {
    await this.db
      .insertInto('running_turns')
      .values({
        session_id: input.sessionId,
        prompt_seq: input.promptSeq,
      })
      .onConflict((oc) =>
        oc.column('session_id').doUpdateSet({
          prompt_seq: input.promptSeq,
          started_at: sql`now()`,
          // Re-anchoring the marker (a resume-retry starts a FRESH attempt) drops the
          // previous attempt's bound identity — the new attempt rebinds via
          // {@link bindTurnIdentity} before its Runner launches (ADR 0006 D2). Leaving
          // the stale turn_id would let recovery discover the wrong (superseded) turn.
          turn_id: null,
          start_command_id: null,
        }),
      )
      .execute();
  }

  /** ADR 0006 Stage 4: bind the Server-allocated turn identity onto the in-flight
   * marker BEFORE the Runner launches (D2), so recovery can discover the turn on the
   * Sandbox supervisor and repeat its idempotent StartTurn. Scoped to `sessionId`
   * (one turn runs at a time under the session lock); a no-op if the marker is gone.
   * Best-effort like {@link markTurnRunning} — never on the turn's critical path. */
  async bindTurnIdentity(
    sessionId: string,
    identity: { turnId: string; startCommandId: string },
  ): Promise<void> {
    await this.db
      .updateTable('running_turns')
      .set({ turn_id: identity.turnId, start_command_id: identity.startCommandId })
      .where('session_id', '=', sessionId)
      .execute();
  }

  /** Clear the in-flight marker for `sessionId` once its turn reaches a terminal
   * event. Idempotent — a no-op if no marker is present. When `promptSeq` is given,
   * the delete is SCOPED to that anchor (`prompt_seq = ?`), so a settling turn's
   * late clear can only remove ITS OWN marker, never a newer turn's marker that
   * already replaced the row (the settle-vs-next-turn race). Omit `promptSeq` to
   * drop the marker unconditionally (recovery). */
  async clearRunningTurn(sessionId: string, promptSeq?: number): Promise<void> {
    let query = this.db.deleteFrom('running_turns').where('session_id', '=', sessionId);
    if (promptSeq !== undefined) {
      query = query.where('prompt_seq', '=', promptSeq);
    }
    await query.execute();
  }

  /** All in-flight markers. At startup a non-empty result flags sessions whose
   * turn was abandoned by a crash/restart. */
  async listRunningTurns(): Promise<RunningTurnRecord[]> {
    const rows = await this.db
      .selectFrom('running_turns')
      .select(['session_id', 'prompt_seq', 'started_at', 'turn_id', 'start_command_id'])
      .execute();
    return rows.map((row) => ({
      sessionId: row.session_id,
      promptSeq: Number(row.prompt_seq),
      startedAt: new Date(row.started_at),
      turnId: row.turn_id,
      startCommandId: row.start_command_id,
    }));
  }

  /**
   * Atomically drain a queued turn (lifecycle Phase 1, SR-5): in ONE transaction,
   * delete its durable `queued_turns` row AND append its prompt `event`. Either the
   * turn leaves the queue and its prompt is persisted, or neither — closing the
   * `delete → persist` window where a crash dropped the row (double-run on restart)
   * or dropped the prompt (lost turn). Returns the appended event's `seq`/`ts` for
   * the live broadcast, or `undefined` if the row was already gone (a concurrent
   * drain/retract won the race — the run-once latch: nothing persisted, no turn).
   *
   * The event is the drained turn's prompt (never a `tool_result`), so it needs no
   * blob externalization — its attachments are already content-addressed refs.
   */
  async drainQueuedTurn(
    id: string,
    sessionId: string,
    event: AgentEvent,
  ): Promise<{ seq: number; ts: number } | undefined> {
    const parsed = parseAgentEvent(event);
    if (!parsed.success) {
      throw new Error(`refusing to persist invalid event: ${parsed.error.message}`);
    }
    const payload = scrubNulEscapes(redactSecrets(JSON.stringify(event)));
    const persisted = await this.withSessionEventAppend(sessionId, () =>
      this.db.transaction().execute(async (tx) => {
        await this.sessionEventAppendLock(tx, sessionId);
        const del = await tx.deleteFrom('queued_turns').where('id', '=', id).executeTakeFirst();
        if (del.numDeletedRows === 0n) return undefined;
        const row = await tx
          .insertInto('events')
          .values({
            session_id: sessionId,
            type: event.t,
            payload,
          })
          .returning(['id', 'created_at'])
          .executeTakeFirstOrThrow();
        return { seq: Number(row.id), ts: row.created_at.getTime() };
      }),
    );
    // Enqueue only AFTER the transaction commits. Doing this inside the callback
    // could project a prompt from a transaction that subsequently rolled back;
    // omitting it entirely left successfully drained prompts absent from search
    // until an unrelated backfill happened to run.
    if (persisted !== undefined) {
      this.enqueuePersistedMessageEvent(
        sessionId,
        persisted.seq,
        new Date(persisted.ts),
        JSON.parse(payload) as AgentEvent,
      );
    }
    return persisted;
  }

  // ─── Multi-repo fleet registry (concept §19, #174) ─────────────────────────

  private projectRowToRecord(row: {
    id: string;
    owner: string;
    repo: string;
    container_name: string;
    kind?: string | null;
    clone_dir?: string | null;
    image_ref: string | null;
    image_override_ref?: string | null;
    toolkit_identity?: string | null;
    state: string;
    archived?: boolean | null;
    provision_error: string | null;
    provision_warning: string | null;
    hidden_at: Date | null;
    sort_order: number | null;
    collapsed?: boolean | null;
    overview_visible?: boolean | null;
    setup_status: string;
    latest_release_tag: string | null;
    latest_release_name: string | null;
    latest_release_url: string | null;
    latest_release_published_at: string | null;
    created_at: Date;
    updated_at: Date;
    state_changed_at?: Date | null;
  }): ProjectRecord {
    return {
      id: row.id,
      owner: row.owner,
      repo: row.repo,
      containerName: row.container_name,
      kind: (row.kind ?? 'github') as ProjectKind,
      cloneDir: row.clone_dir ?? null,
      imageRef: row.image_ref,
      imageOverrideRef: row.image_override_ref ?? null,
      toolkitIdentity: row.toolkit_identity ?? null,
      // Trusting the column to only ever hold one of the five state values; the
      // app layer writes through {@link upsertProject}/{@link updateProjectState}
      // which take a {@link ProjectState}. A drift here means a stray writer ATK-
      // bypassed those — assertable by a future CHECK constraint, not in v1.
      state: row.state as ProjectState,
      archived: row.archived ?? false,
      provisionError: row.provision_error,
      provisionWarning: row.provision_warning,
      hiddenAt: row.hidden_at,
      sortOrder: row.sort_order,
      collapsed: row.collapsed ?? false,
      overviewVisible: row.overview_visible ?? false,
      setupStatus: row.setup_status as ProjectSetupState,
      latestReleaseTag: row.latest_release_tag,
      latestReleaseName: row.latest_release_name,
      latestReleaseUrl: row.latest_release_url,
      latestReleasePublishedAt: row.latest_release_published_at,
      createdAt: row.created_at,
      // Falls back to `updated_at` only for a row read through a projection that
      // predates the column (test doubles); the migration backfills the same
      // value, so the two agree for every real row.
      stateChangedAt: row.state_changed_at ?? row.updated_at,
      updatedAt: row.updated_at,
    };
  }

  private readonly projectColumns = [
    'id',
    'kind',
    'owner',
    'repo',
    'container_name',
    'kind',
    'clone_dir',
    'image_ref',
    'image_override_ref',
    'toolkit_identity',
    'state',
    'archived',
    'provision_error',
    'provision_warning',
    'hidden_at',
    'sort_order',
    'collapsed',
    'overview_visible',
    'setup_status',
    'latest_release_tag',
    'latest_release_name',
    'latest_release_url',
    'latest_release_published_at',
    'created_at',
    'updated_at',
    'state_changed_at',
  ] as const;

  /**
   * Idempotent upsert on `(owner, repo)`. Re-running the GitHub-installation sync
   * (slice 2) calls this with the same `(owner, repo)` and an `absent` state; the
   * ON CONFLICT branch keeps the existing `state`/`provision_error`-state (the
   * provisioning worker owns those fields, GitHub-sync must not clobber them).
   * `container_name` and an explicitly supplied image override are refreshed
   * from the input. Provisioning separately records its effective image.
   *
   * This method is the single lowercase-canonicalization site for the
   * `projects` table: `owner`, `repo`, `container_name` are passed through
   * `.toLowerCase()` BEFORE the write. The schema's `CHECK (owner = lower(owner)
   * AND repo = lower(repo))` constraint (§19.2 lowercase-persist guarantee) is
   * the DB-side backstop against direct writers; calling code that bypasses
   * `upsertProject` and hits the table via raw SQL must lowercase itself or
   * the CHECK throws.
   *
   * @returns the post-upsert row (CREATE form for a brand-new repo, UPDATE form
   *          for an existing one with the merged fields). Returned via
   *          `INSERT … ON CONFLICT DO UPDATE … RETURNING *` — atomic with the
   *          write, no separate SELECT that could race a concurrent
   *          `deleteProject` (slice 3) between insert and lookup.
   */
  async upsertProject(input: ProjectUpsertInput): Promise<ProjectRecord> {
    // Lowercase the canonical (owner, repo) and the derived container_name so
    // the persisted form honours §19.0/§19.2's lowercase-persist contract
    // (without forcing every caller — including GitHub-sync — to remember).
    const owner = input.owner.toLowerCase();
    const repo = input.repo.toLowerCase();
    const containerName = input.containerName.toLowerCase();
    const legacyContainerNames = [`dev-${owner}--${repo}`, `dev-${owner}-${repo}`];
    const shouldMigrateLegacyContainerName = containerName.startsWith('verity-');

    const row = await this.db.transaction().execute(async (tx) => {
      const claimed = await tx
        .insertInto('project_identity_claims')
        .values({ owner, repo, project_id: input.id })
        .onConflict((conflict) => conflict.columns(['owner', 'repo']).doNothing())
        .returning('project_id')
        .executeTakeFirst();
      if (claimed === undefined) {
        const [claim, existing] = await Promise.all([
          tx
            .selectFrom('project_identity_claims')
            .select('project_id')
            .where('owner', '=', owner)
            .where('repo', '=', repo)
            .executeTakeFirstOrThrow(),
          tx
            .selectFrom('projects')
            .select('id')
            .where('owner', '=', owner)
            .where('repo', '=', repo)
            .executeTakeFirst(),
        ]);
        if (existing === undefined || claim.project_id !== existing.id) {
          throw new ProjectIdentityClaimConflict(`project identity ${owner}/${repo} is reserved`);
        }
      }
      return tx
        .insertInto('projects')
        .values({
          id: input.id,
          owner,
          repo,
          container_name: containerName,
          kind: input.kind ?? 'github',
          clone_dir: input.cloneDir ?? null,
          image_ref: input.imageRef ?? null,
          image_override_ref: input.imageRef ?? null,
          state: input.state,
          archived: input.archived ?? false,
          overview_visible: input.overviewVisible ?? false,
          provision_error: null,
          provision_warning: null,
        })
        .onConflict((oc) =>
          oc.columns(['owner', 'repo']).doUpdateSet({
            // Preserve custom adopted container names, but migrate old deterministic
            // `dev-<owner>--<repo>` / `dev-<owner>-<repo>` rows to the current
            // canonical `verity-<owner>--<repo>` name. Without this, fresh servers
            // can keep pointing at a legacy Dogfood container and miss current
            // runtime mounts and gateway routing configuration.
            container_name: shouldMigrateLegacyContainerName
              ? sql`case when projects.container_name in (${sql.join(legacyContainerNames)}) then ${containerName} else projects.container_name end`
              : sql`projects.container_name`,
            // Provisioning-owned state stays untouched (the worker's
            // `cloning/container_starting/active/failed` survives a sync pass).
            // The image fields are only touched when the caller EXPLICITLY sets an
            // override: `input.imageRef === undefined` means
            // "I have no opinion, leave what's pinned" (preserves a slice-3 pin
            // across slice-2 list refreshes), while `null` means "explicitly
            // clear the pin" (operator-driven unpin). Slice 2's sync passes
            // undefined → no-op.
            // `toolkit_identity` travels with `image_ref` because it is a
            // statement ABOUT that image: an operator pinning a NEW one has
            // pinned something nothing has attested, and carrying the old
            // verdict forward would let the new image inherit an all-clear it
            // never earned. The next provisioning writes the real answer.
            //
            // Which is why the clear is conditional on the image actually
            // moving. Re-saving the same pin — an idempotent settings write, a
            // re-add of a project that never changed — leaves the effective
            // image exactly as attested, so discarding the verdict there would
            // manufacture an "unknown toolkit" warning about an image that was
            // checked and passed, and it would stay wrong until the next
            // provisioning. `is distinct from` compares against the PRE-update
            // row (`projects.` in an ON CONFLICT update), and treats a null on
            // either side as a difference rather than as unknown.
            ...(input.imageRef !== undefined
              ? {
                  image_ref: input.imageRef,
                  image_override_ref: input.imageRef,
                  toolkit_identity: sql<
                    string | null
                  >`case when projects.image_ref is distinct from ${input.imageRef} then null else projects.toolkit_identity end`,
                }
              : {}),
            ...(input.kind !== undefined ? { kind: input.kind } : {}),
            ...(input.archived !== undefined ? { archived: input.archived } : {}),
            ...(input.overviewVisible !== undefined
              ? { overview_visible: input.overviewVisible }
              : {}),
            // `restore` (the POST /projects re-add path) un-hides an existing
            // row. Omitted by the installation sync, so a re-sync of a repo the
            // operator deleted keeps it hidden rather than resurrecting it.
            ...(input.restore === true ? { hidden_at: null } : {}),
            updated_at: sql`now()`,
          }),
        )
        .returningAll()
        .executeTakeFirst();
    });
    if (!row) {
      // The only way `RETURNING *` returns undefined here is if the ORM/dialect
      // drops the returning clause — a contract bug, not a runtime path.
      throw new Error('verity: upsertProject RETURNING yielded no row — dialect bug');
    }
    return this.projectRowToRecord(row);
  }

  /** Insert a project without adopting an existing `(owner, repo)` row. Used for
   * operator-named local projects, where returning another concurrent request's
   * clone would cross an ownership boundary. A conflict is surfaced atomically
   * as the database's unique violation. */
  async createProject(input: ProjectUpsertInput): Promise<ProjectRecord> {
    const owner = input.owner.toLowerCase();
    const repo = input.repo.toLowerCase();
    const row = await this.db.transaction().execute(async (tx) => {
      const claimed = await tx
        .insertInto('project_identity_claims')
        .values({ owner, repo, project_id: input.id })
        .onConflict((conflict) => conflict.columns(['owner', 'repo']).doNothing())
        .returning('project_id')
        .executeTakeFirst();
      if (claimed === undefined) {
        throw new ProjectIdentityClaimConflict(`project identity ${owner}/${repo} is reserved`);
      }
      return tx
        .insertInto('projects')
        .values({
          id: input.id,
          owner,
          repo,
          container_name: input.containerName.toLowerCase(),
          kind: input.kind ?? 'github',
          clone_dir: input.cloneDir ?? null,
          image_ref: input.imageRef ?? null,
          image_override_ref: input.imageRef ?? null,
          state: input.state,
          archived: input.archived ?? false,
          overview_visible: input.overviewVisible ?? false,
          provision_error: null,
          provision_warning: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return this.projectRowToRecord(row);
  }

  async getProject(id: string): Promise<ProjectRecord | undefined> {
    const row = await this.db
      .selectFrom('projects')
      .select(this.projectColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.projectRowToRecord(row) : undefined;
  }

  async getProjectByOwnerRepo(owner: string, repo: string): Promise<ProjectRecord | undefined> {
    // Lookup-form mirrors the persistence-form (lowercase, §19.0/§19.2): a row
    // persisted from `'heey-global'/'VERITY'` lives as `'verity'` on disk, so the
    // caller can pass the raw GitHub-display form without having to know about
    // our persistence normalisation.
    const row = await this.db
      .selectFrom('projects')
      .select(this.projectColumns)
      .where('owner', '=', owner.toLowerCase())
      .where('repo', '=', repo.toLowerCase())
      .executeTakeFirst();
    return row ? this.projectRowToRecord(row) : undefined;
  }

  /**
   * Move a `local` project onto a GitHub repository: rewrite `(owner, repo)` and
   * flip `kind` to `github`, by ID rather than through the `(owner, repo)` upsert
   * (whose ON CONFLICT branch would target the WRONG row — the GitHub-side
   * identity we are moving TO).
   *
   * `container_name` is left alone: the container already exists under its
   * local-project name and renaming it would mean recreating it for nothing.
   * `clone_dir` is pinned to whatever directory the clone occupies right now, so
   * the derived `<owner>-<repo>` path change does NOT relocate it — sessions
   * persist absolute worktree paths under that directory.
   *
   * Returns `undefined` when the project no longer exists. Throws the driver's
   * unique-violation when `(owner, repo)` is already registered — the caller maps
   * that to a conflict rather than silently merging two projects.
   */
  async linkProjectToGitHub(
    id: string,
    target: { owner: string; repo: string },
  ): Promise<ProjectRecord | undefined> {
    const row = await this.db.transaction().execute(async (tx) => {
      const existing = await tx
        .selectFrom('projects')
        .select(this.projectColumns)
        .forUpdate()
        .where('id', '=', id)
        .where('kind', '=', 'local')
        .executeTakeFirst();
      if (existing === undefined) return undefined;
      const targetOwner = target.owner.toLowerCase();
      const targetRepo = target.repo.toLowerCase();
      // The placeholder stays intact while publication runs. Retire it only in
      // this final transaction, alongside the local project's identity rewrite,
      // so a pre-publication failure can restore its claim without losing any of
      // its dependent configuration.
      await this.retireInstallationPlaceholder(tx, targetOwner, targetRepo, id);
      await tx
        .insertInto('project_identity_claims')
        .values({ owner: targetOwner, repo: targetRepo, project_id: id })
        .onConflict((conflict) => conflict.columns(['owner', 'repo']).doNothing())
        .execute();
      const claim = await tx
        .selectFrom('project_identity_claims')
        .select('project_id')
        .where('owner', '=', targetOwner)
        .where('repo', '=', targetRepo)
        .executeTakeFirst();
      if (claim?.project_id !== id) {
        throw new ProjectIdentityClaimConflict(
          `project identity ${targetOwner}/${targetRepo} is not reserved`,
        );
      }
      const updated = await tx
        .updateTable('projects')
        .set({
          owner: targetOwner,
          repo: targetRepo,
          kind: 'github',
          clone_dir: existing.clone_dir ?? `${existing.owner}-${existing.repo}`,
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .where('kind', '=', 'local')
        .returningAll()
        .executeTakeFirst();
      if (updated !== undefined) {
        await tx
          .deleteFrom('project_identity_claims')
          .where('owner', '=', existing.owner)
          .where('repo', '=', existing.repo)
          .where('project_id', '=', id)
          .execute();
      }
      return updated;
    });
    return row ? this.projectRowToRecord(row) : undefined;
  }

  /**
   * Drop the installation sync's placeholder row for `(owner, repo)` so a link
   * can take the identity over, and report whether it did.
   *
   * Adoption is deliberately narrow. The row must be a picker-only GitHub
   * project (`overview_visible=false`) that is `absent` AND carry no sessions —
   * `sessions.project_id` is `ON DELETE SET NULL`, so
   * deleting a project that was ever worked in would silently orphan its
   * transcripts rather than fail loudly. Everything else about the row IS
   * discarded with it via `ON DELETE CASCADE` (project settings, secret
   * bindings, dev-server config). That is acceptable precisely here: the caller
   * only reaches this path for a repository the provisioner has verified to be
   * EMPTY on GitHub, so a placeholder pointing at it holds configuration for a
   * project that never had any code, and the operator is in the act of saying
   * which project that repository should belong to.
   *
   * Runs inside the caller's transaction so the delete, the claim, and the
   * project rewrite commit as one unit — a concurrent installation sync can
   * neither observe a half-adopted identity nor recreate the placeholder
   * between the steps.
   */
  private async retireInstallationPlaceholder(
    tx: Transaction<Database>,
    owner: string,
    repo: string,
    forProjectId: string,
  ): Promise<boolean> {
    const holder = await tx
      .selectFrom('projects')
      .select(['id', 'kind', 'state', 'overview_visible'])
      .where('owner', '=', owner)
      .where('repo', '=', repo)
      .where('id', '!=', forProjectId)
      .executeTakeFirst();
    if (holder === undefined) return false;
    if (
      !isInstallationPlaceholder({
        kind: holder.kind as ProjectKind,
        state: holder.state as ProjectState,
        overviewVisible: holder.overview_visible,
      })
    ) {
      return false;
    }
    if (await this.installationPlaceholderHasDependents(tx, holder.id)) return false;
    await tx.deleteFrom('project_identity_claims').where('project_id', '=', holder.id).execute();
    await tx.deleteFrom('projects').where('id', '=', holder.id).execute();
    return true;
  }

  /** A sync placeholder is disposable only while no project-scoped durable
   * state has attached to it. Keep this list aligned with direct `projects.id`
   * foreign keys in migrations; identity claims are excluded because adoption
   * deliberately transfers/deletes that bookkeeping row. */
  private async installationPlaceholderHasDependents(
    tx: Transaction<Database>,
    projectId: string,
  ): Promise<boolean> {
    const result = await sql<{ has_dependents: boolean }>`
      select exists (
        select 1 from sessions where project_id = ${projectId}
        union all select 1 from project_settings where project_id = ${projectId}
        union all select 1 from agent_loops where project_id = ${projectId}
        union all select 1 from dev_servers where project_id = ${projectId}
        union all select 1 from dev_server_detection_state where project_id = ${projectId}
        union all select 1 from claude_egress_client_certs where project_id = ${projectId}
        union all select 1 from signing_capabilities where project_id = ${projectId}
        union all select 1 from secret_provider_credentials where project_id = ${projectId}
        union all select 1 from secret_provider_bindings where project_id = ${projectId}
        union all select 1 from secret_aliases where project_id = ${projectId}
        union all select 1 from secret_provider_permissions where project_id = ${projectId}
        union all select 1 from secret_execution_profiles where project_id = ${projectId}
        union all select 1 from brokered_http_consumptions where project_id = ${projectId}
        union all select 1 from public_preview_shares where project_id = ${projectId}
      ) as has_dependents
    `.execute(tx);
    return result.rows[0]?.has_dependents === true;
  }

  async reserveProjectIdentity(
    id: string,
    target: { owner: string; repo: string },
  ): Promise<boolean> {
    const owner = target.owner.toLowerCase();
    const repo = target.repo.toLowerCase();
    return this.db.transaction().execute(async (tx) => {
      const project = await tx
        .selectFrom('projects')
        .select(['id', 'owner', 'repo'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (project === undefined) return false;
      const claims = await tx
        .selectFrom('project_identity_claims')
        .select(['owner', 'repo'])
        .where('project_id', '=', id)
        .execute();
      // A local project normally owns its current local identity plus at most
      // one pending GitHub target. If a prior push was ambiguous, only that
      // exact target may be retried; reserving a second target would strand the
      // first claim and could publish the same project to multiple repositories.
      const hasDifferentPendingTarget = claims.some(
        (claim) =>
          (claim.owner !== project.owner || claim.repo !== project.repo) &&
          (claim.owner !== owner || claim.repo !== repo),
      );
      if (hasDifferentPendingTarget) return false;
      // Keep a sync placeholder (and all of its dependent configuration) intact
      // while publication runs; only transfer its claim temporarily. The final
      // link transaction retires it atomically with the identity rewrite, while
      // releaseProjectIdentity restores the claim after a known failed push.
      const holder = await tx
        .selectFrom('projects')
        .select(['id', 'kind', 'state', 'overview_visible'])
        .forUpdate()
        .where('owner', '=', owner)
        .where('repo', '=', repo)
        .where('id', '!=', id)
        .executeTakeFirst();
      if (holder !== undefined) {
        if (
          !isInstallationPlaceholder({
            kind: holder.kind as ProjectKind,
            state: holder.state as ProjectState,
            overviewVisible: holder.overview_visible,
          })
        ) {
          return false;
        }
        if (await this.installationPlaceholderHasDependents(tx, holder.id)) return false;
        // Hide the placeholder before releasing its row lock. createSession
        // takes a SHARE lock and rejects hidden projects, so this closes the
        // check-vs-spawn race for the entire external push window. `infinity`
        // marks a row that was visible before reservation; an already-hidden
        // placeholder keeps its original timestamp.
        await tx
          .updateTable('projects')
          .set({
            hidden_at: sql`case when hidden_at is null then 'infinity'::timestamptz else hidden_at end`,
            updated_at: sql`now()`,
          })
          .where('id', '=', holder.id)
          .execute();
        await tx
          .updateTable('project_identity_claims')
          .set({ project_id: id })
          .where('owner', '=', owner)
          .where('repo', '=', repo)
          .where('project_id', '=', holder.id)
          .execute();
      }
      await tx
        .insertInto('project_identity_claims')
        .values({ owner, repo, project_id: id })
        .onConflict((conflict) => conflict.columns(['owner', 'repo']).doNothing())
        .execute();
      const claim = await tx
        .selectFrom('project_identity_claims')
        .select('project_id')
        .where('owner', '=', owner)
        .where('repo', '=', repo)
        .executeTakeFirst();
      return claim?.project_id === id;
    });
  }

  async releaseProjectIdentity(id: string, target: { owner: string; repo: string }): Promise<void> {
    const owner = target.owner.toLowerCase();
    const repo = target.repo.toLowerCase();
    await this.db.transaction().execute(async (tx) => {
      // Serialize with finalization on the source project. If another request
      // already completed the link, a failed older attempt must not release the
      // now-canonical GitHub identity claim.
      const local = await tx
        .selectFrom('projects')
        .select('id')
        .forUpdate()
        .where('id', '=', id)
        .where('kind', '=', 'local')
        .executeTakeFirst();
      if (local === undefined) return;
      const placeholder = await tx
        .selectFrom('projects')
        .select(['id', 'kind', 'state', 'overview_visible'])
        .forUpdate()
        .where('owner', '=', owner)
        .where('repo', '=', repo)
        .where('id', '!=', id)
        .executeTakeFirst();
      if (
        placeholder !== undefined &&
        isInstallationPlaceholder({
          kind: placeholder.kind as ProjectKind,
          state: placeholder.state as ProjectState,
          overviewVisible: placeholder.overview_visible,
        })
      ) {
        // Only reservations of formerly-visible placeholders use the infinity
        // marker. Preserve a placeholder that was already soft-deleted.
        await tx
          .updateTable('projects')
          .set({ hidden_at: null, updated_at: sql`now()` })
          .where('id', '=', placeholder.id)
          .where('hidden_at', '=', sql<Date>`'infinity'::timestamptz`)
          .execute();
        await tx
          .updateTable('project_identity_claims')
          .set({ project_id: placeholder.id })
          .where('owner', '=', owner)
          .where('repo', '=', repo)
          .where('project_id', '=', id)
          .execute();
        return;
      }
      await tx
        .deleteFrom('project_identity_claims')
        .where('owner', '=', owner)
        .where('repo', '=', repo)
        .where('project_id', '=', id)
        .execute();
    });
  }

  /**
   * All registered projects, ordered by operator-defined `sort_order` first and
   * then `(created_at, id)` so listing is stable across paginated runs. Rows with
   * no manual order sort after manually ordered rows.
   *
   * Soft-deleted (hidden) projects are excluded by default so the mobile picker
   * and the installation-sync return value never show a repo the operator
   * removed. Pass `{ includeHidden: true }` for the first-run-bootstrap check
   * (embedded startup) that must know whether ANY project row exists, hidden or
   * not, before it seeds the config file.
   */
  async listProjects(opts?: { includeHidden?: boolean }): Promise<ProjectRecord[]> {
    let query = this.db
      .selectFrom('projects')
      .select(this.projectColumns)
      .orderBy(sql`sort_order is null`)
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc');
    if (opts?.includeHidden !== true) {
      query = query.where('hidden_at', 'is', null);
    }
    const rows = await query.execute();
    return rows.map((r) => this.projectRowToRecord(r));
  }

  async reorderProjects(ids: string[]): Promise<ProjectRecord[]> {
    if (new Set(ids).size !== ids.length) {
      throw new Error('duplicate project id in reorderProjects');
    }
    await this.db.transaction().execute(async (tx) => {
      const visibleRows = await tx
        .selectFrom('projects')
        .select('id')
        .where('hidden_at', 'is', null)
        .where('kind', '!=', 'control_plane')
        .where((eb) => eb.or([eb('state', '!=', 'absent'), eb('setup_status', '=', 'pending')]))
        .execute();
      const visibleIds = new Set(visibleRows.map((row) => row.id));
      if (visibleIds.size !== ids.length || ids.some((id) => !visibleIds.has(id))) {
        throw new Error('project order must include every visible project exactly once');
      }
      const sortOrderCase = sql<number>`(case ${sql.ref('id')} ${sql.join(
        ids.map((id, index) => sql`when ${id} then ${index}`),
        sql.raw(' '),
      )} end)::integer`;
      await tx
        .updateTable('projects')
        .set({ sort_order: sortOrderCase, updated_at: sql`now()` })
        .where('hidden_at', 'is', null)
        .where('kind', '!=', 'control_plane')
        .where((eb) => eb.or([eb('state', '!=', 'absent'), eb('setup_status', '=', 'pending')]))
        .execute();
    });
    return this.listProjects();
  }

  /**
   * Persist the operator's overview fold state for a single project. Global (no
   * per-device/per-operator scoping), so every device reading `listProjects`
   * sees the same value — this is what makes the sidebar collapse sync across
   * devices. Idempotent; returns whether a row matched.
   */
  async setProjectCollapsed(id: string, collapsed: boolean): Promise<boolean> {
    const result = await this.db
      .updateTable('projects')
      .set({ collapsed, updated_at: sql`now()` })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Soft-delete: mark a project hidden (`hidden_at = now()`) instead of dropping
   * the row. Keeps the row — and its stable id/settings — so the
   * GitHub-installation sync's re-upsert can't resurrect it (the sync leaves
   * `hidden_at` untouched; only an explicit restore clears it). Idempotent: a
   * second hide just refreshes the timestamp. Returns whether a row matched.
   */
  async hideProject(id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('projects')
      .set({ hidden_at: sql`now()`, updated_at: sql`now()` })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async deleteProject(id: string): Promise<boolean> {
    const result = await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('project_identity_claims').where('project_id', '=', id).execute();
      return tx.deleteFrom('projects').where('id', '=', id).executeTakeFirst();
    });
    return result.numDeletedRows > 0n;
  }

  /**
   * Atomic state transition for a project (concept §19.3, used by the
   * provisioning worker). The body of this method runs a single UPDATE through
   * the store's outer connection — it does NOT hold the `SELECT … FOR UPDATE`
   * lock the worker needs around the `state != 'active' → clone → run → active`
   * transition. Slice 3 will refactor this (likely to accept a caller-supplied
   * `Kysely<Database>` so the lock + the UPDATE go through the same tx); until
   * then, slice-1 callers are testing-only and the concurrency invariant is
   * documented but not enforced here.
   *
   * @param provisionError NULL-binding: pass `null` to clear. A non-null value
   *                       is ONLY written alongside `state='failed'`.
   * @param provisionWarning NULL-binding: pass `null` to clear. A non-null value
   *                         is only used for active projects that provisioned
   *                         with non-fatal operator-visible caveats.
   * @returns the resulting row; `undefined` if the project id is unknown.
   *
   * Together with the provisioner's in-transaction twin (`updateProjectStateInTx`)
   * this is the only writer of `state_changed_at`, and it moves it on every call
   * — including a repeat write of the same state, which is a fresh provisioning
   * attempt entering that phase, not a no-op. That makes the column mean "when
   * the worker last claimed this state", which is exactly the age the
   * stale-provisioning sweep needs.
   */
  async updateProjectState(
    id: string,
    state: ProjectState,
    provisionError: string | null = null,
    provisionWarning: string | null = null,
  ): Promise<ProjectRecord | undefined> {
    await this.db
      .updateTable('projects')
      .set({
        state,
        provision_error: provisionError,
        provision_warning: provisionWarning,
        state_changed_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
    return this.getProject(id);
  }

  /** Record the effective image selected by provisioning without changing the
   * operator-configured override in `image_override_ref`.
   *
   * `toolkitIdentity` is the content identity of the runner-boundary trust root
   * that this provisioning verified the image against, and it is written in the
   * SAME statement as the image on purpose: the two are one verdict about one
   * image. It is required, and `null` — "nothing verified this" — is a real
   * answer a caller must give rather than omit. An optional argument would let
   * a new image silently inherit the previous image's verdict, which is the
   * exact false all-clear the drift report exists to remove. */
  async recordProjectImageRef(
    id: string,
    imageRef: string,
    toolkitIdentity: string | null,
  ): Promise<void> {
    await this.db
      .updateTable('projects')
      .set({
        image_ref: imageRef,
        toolkit_identity: toolkitIdentity,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async setProjectSetupStatus(
    id: string,
    status: ProjectSetupState,
  ): Promise<ProjectRecord | undefined> {
    await this.db
      .updateTable('projects')
      .set({ setup_status: status, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
    return this.getProject(id);
  }

  /**
   * Refresh a project's latest-release display cache (overview version badge).
   * Independent of {@link updateProjectState}/{@link upsertProject}: touches ONLY
   * the `latest_release_*` columns (and `updated_at`), so a release refresh never
   * disturbs the provisioning-worker-owned `state` or the installation-sync fields.
   * A no-op (0 rows) for an unknown id. `published_at` is stored verbatim as
   * GitHub's ISO string (display-only, never queried).
   */
  async updateProjectReleaseStatus(id: string, status: ProjectReleaseStatus): Promise<void> {
    await this.db
      .updateTable('projects')
      .set({
        latest_release_tag: status.tag,
        latest_release_name: status.name,
        latest_release_url: status.url,
        latest_release_published_at: status.publishedAt,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
  }

  // ─── Agent Loops: recurring automations ("der Loop", ADR 0008) ─────────────

  private agentLoopRowToRecord(row: {
    id: string;
    project_id: string;
    name: string;
    status: string;
    schedule_kind: string | null;
    schedule_config: ScheduleConfig | null;
    script: string | null;
    reaction_prompt: string | null;
    reaction_model: string | null;
    session_id: string | null;
    tested_script_fingerprint: string | null;
    consecutive_error_count: number;
    last_run_at: Date | null;
    last_outcome: string | null;
    next_run_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }): AgentLoopRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      status: row.status as AgentLoopStatus,
      schedule: row.schedule_config,
      script: row.script,
      reactionPrompt: row.reaction_prompt,
      reactionModel: row.reaction_model,
      sessionId: row.session_id,
      testedScriptFingerprint: row.tested_script_fingerprint,
      consecutiveErrorCount: row.consecutive_error_count,
      lastRunAt: row.last_run_at,
      lastOutcome: row.last_outcome as AgentLoopRunOutcome | null,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private readonly agentLoopColumns = [
    'id',
    'project_id',
    'name',
    'status',
    'schedule_kind',
    'schedule_config',
    'script',
    'reaction_prompt',
    'reaction_model',
    'session_id',
    'tested_script_fingerprint',
    'consecutive_error_count',
    'last_run_at',
    'last_outcome',
    'next_run_at',
    'created_at',
    'updated_at',
  ] as const;

  /**
   * Create an Agent Loop. Every loop is born a `draft`; no caller can bypass the
   * creation-time test gate by smuggling an enabled status into the insert.
   */
  async createAgentLoop(input: AgentLoopCreateInput): Promise<AgentLoopRecord> {
    const schedule = input.schedule ?? null;
    const row = await this.db
      .insertInto('agent_loops')
      .values({
        id: randomUUID(),
        project_id: input.projectId,
        name: input.name,
        status: 'draft',
        schedule_kind: schedule ? schedule.kind : null,
        schedule_config: schedule ? JSON.stringify(schedule) : null,
        script: input.script ?? null,
        reaction_prompt: input.reactionPrompt ?? null,
        reaction_model: input.reactionModel ?? null,
        next_run_at: null,
      })
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new Error('verity: createAgentLoop RETURNING yielded no row — dialect bug');
    return this.agentLoopRowToRecord(row);
  }

  async getAgentLoop(id: string): Promise<AgentLoopRecord | undefined> {
    const row = await this.db
      .selectFrom('agent_loops')
      .select(this.agentLoopColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.agentLoopRowToRecord(row) : undefined;
  }

  /** Agent Loops for one project, newest first. */
  async listAgentLoops(projectId: string): Promise<AgentLoopRecord[]> {
    const rows = await this.db
      .selectFrom('agent_loops')
      .select(this.agentLoopColumns)
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map((r) => this.agentLoopRowToRecord(r));
  }

  /**
   * Partial update. When `schedule` or `status` changes, `next_run_at` is
   * recomputed here so the scheduler stays consistent: moving to `enabled`
   * (or rescheduling an enabled loop) arms it from now; moving to `draft`/`paused`
   * clears its due time. Returns the updated record, or `undefined` for an
   * unknown id.
   */
  async updateAgentLoop(id: string, patch: AgentLoopPatch): Promise<AgentLoopRecord | undefined> {
    const set: Record<string, unknown> = { updated_at: sql`now()` };
    let enableGuard: { fingerprint: string } | undefined;
    const configChanged =
      patch.script !== undefined ||
      patch.schedule !== undefined ||
      patch.reactionPrompt !== undefined ||
      patch.reactionModel !== undefined;
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.script !== undefined) {
      set.script = patch.script;
    }
    if (patch.reactionPrompt !== undefined) set.reaction_prompt = patch.reactionPrompt;
    if (patch.reactionModel !== undefined) set.reaction_model = patch.reactionModel;
    if (patch.sessionId !== undefined) set.session_id = patch.sessionId;
    // A green test belongs to the complete executable config. Any edit wins over
    // a simultaneous enable request and immediately disarms the loop.
    if (configChanged) {
      set.tested_script_fingerprint = null;
      set.status = 'draft';
      set.next_run_at = null;
    } else if (patch.status !== undefined) set.status = patch.status;
    if (patch.schedule !== undefined) {
      set.schedule_kind = patch.schedule ? patch.schedule.kind : null;
      set.schedule_config = patch.schedule ? JSON.stringify(patch.schedule) : null;
    }

    // Recompute the due time whenever the schedule or the status moves. Uses the
    // incoming schedule if given, else the stored one — so a bare enable arms
    // against the existing schedule. Only an `enabled` loop is armed.
    const scheduleChanged = patch.schedule !== undefined;
    const statusChanged = patch.status !== undefined;
    if (configChanged || statusChanged) {
      const existing = await this.getAgentLoop(id);
      if (existing) {
        const schedule = scheduleChanged ? (patch.schedule ?? null) : existing.schedule;
        const status = configChanged ? 'draft' : (patch.status ?? existing.status);
        if (status === 'enabled') {
          if (!schedule) throw new AgentLoopNotReadyError('Agent Loop needs a schedule');
          if (!existing.script?.trim())
            throw new AgentLoopNotReadyError('Agent Loop needs a script');
          const fingerprint = agentLoopConfigFingerprint(existing);
          if (existing.testedScriptFingerprint !== fingerprint) {
            throw new AgentLoopNotReadyError('Test the current Agent Loop config before enabling');
          }
          enableGuard = { fingerprint };
        }
        set.next_run_at =
          status === 'enabled' && schedule
            ? computeNextRun(schedule, new Date()).toISOString()
            : null;
      }
    }

    let update = this.db.updateTable('agent_loops').set(set).where('id', '=', id);
    // Close enable-vs-edit races: any config edit clears the stored fingerprint,
    // so the exact tested config must still be current when this UPDATE lands.
    if (enableGuard) {
      update = update.where('tested_script_fingerprint', '=', enableGuard.fingerprint);
    }
    const row = await update.returningAll().executeTakeFirst();
    if (!row && enableGuard && (await this.getAgentLoop(id))) {
      throw new AgentLoopNotReadyError('Agent Loop changed while it was being enabled');
    }
    return row ? this.agentLoopRowToRecord(row) : undefined;
  }

  /** Atomically bind a replacement session only while the loop is still
   * unbound. This closes route-vs-scheduler recovery races: exactly one created
   * session wins and callers can clean up any losing candidate. */
  async linkAgentLoopSessionIfMissing(
    id: string,
    sessionId: string,
  ): Promise<AgentLoopRecord | undefined> {
    const row = await this.db
      .updateTable('agent_loops')
      .set({ session_id: sessionId, updated_at: sql`now()` })
      .where('id', '=', id)
      .where('session_id', 'is', null)
      .returningAll()
      .executeTakeFirst();
    return row ? this.agentLoopRowToRecord(row) : undefined;
  }

  /** Mark exactly the config snapshot used by a successful test run as proven.
   * Conditional predicates close the test-vs-edit race for every config field. */
  async markAgentLoopTestPassed(
    id: string,
    testedConfig: AgentLoopRecord,
  ): Promise<AgentLoopRecord | undefined> {
    if (!testedConfig.script?.trim()) throw new AgentLoopNotReadyError('Agent Loop needs a script');
    let update = this.db
      .updateTable('agent_loops')
      .set({
        tested_script_fingerprint: agentLoopConfigFingerprint(testedConfig),
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .where('script', '=', testedConfig.script);
    update = testedConfig.schedule
      ? update
          .where('schedule_kind', '=', testedConfig.schedule.kind)
          .where('schedule_config', '=', testedConfig.schedule)
      : update.where('schedule_kind', 'is', null).where('schedule_config', 'is', null);
    update =
      testedConfig.reactionPrompt === null
        ? update.where('reaction_prompt', 'is', null)
        : update.where('reaction_prompt', '=', testedConfig.reactionPrompt);
    update =
      testedConfig.reactionModel === null
        ? update.where('reaction_model', 'is', null)
        : update.where('reaction_model', '=', testedConfig.reactionModel);
    const row = await update.returningAll().executeTakeFirst();
    return row ? this.agentLoopRowToRecord(row) : undefined;
  }

  async deleteAgentLoop(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('agent_loops').where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /**
   * Enabled loops whose `next_run_at` is at or before `now` — the scheduler's due
   * set for one pass. Ordered by due time so the earliest-overdue runs first.
   */
  async listDueAgentLoops(now: Date): Promise<AgentLoopRecord[]> {
    const rows = await this.db
      .selectFrom('agent_loops')
      .select(this.agentLoopColumns)
      .where('status', '=', 'enabled')
      .where('next_run_at', 'is not', null)
      .where('next_run_at', '<=', now)
      .orderBy('next_run_at', 'asc')
      .execute();
    return rows.map((r) => this.agentLoopRowToRecord(r));
  }

  /**
   * The earliest `next_run_at` across enabled loops, or `null` if none is
   * scheduled — the scheduler sleeps until this instant instead of polling.
   */
  async nextAgentLoopDueAt(): Promise<Date | null> {
    const row = await this.db
      .selectFrom('agent_loops')
      .select((eb) => eb.fn.min('next_run_at').as('next'))
      .where('status', '=', 'enabled')
      .where('next_run_at', 'is not', null)
      .executeTakeFirst();
    return row?.next ?? null;
  }

  /**
   * Record that a loop ran: stamp `last_run_at` and advance `next_run_at` to the
   * next scheduled slot (or clear it if no longer enabled). The scheduler computes
   * the next slot from the loop's own schedule via {@link computeNextRun} and
   * passes it in, so the store never re-derives scheduling policy.
   */
  async claimAgentLoopRun(id: string, ranAt: Date, nextRunAt: Date | null): Promise<boolean> {
    const result = await this.db
      .updateTable('agent_loops')
      .set({
        last_run_at: ranAt.toISOString(),
        next_run_at: nextRunAt ? nextRunAt.toISOString() : null,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .where('status', '=', 'enabled')
      .where('next_run_at', 'is not', null)
      .where('next_run_at', '<=', ranAt)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Open a run-history row for a loop pass. Returns its id so the scheduler can
   *  close it with {@link finishAgentLoopRun} once the pass settles. */
  async startAgentLoopRun(loopId: string): Promise<AgentLoopRunRecord> {
    const row = await this.db
      .insertInto('agent_loop_runs')
      .values({ id: randomUUID(), loop_id: loopId, outcome: 'ok' })
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new Error('verity: startAgentLoopRun RETURNING yielded no row — dialect bug');
    return this.agentLoopRunRowToRecord(row);
  }

  /** Close a run-history row with its terminal outcome, optional detail, exit
   *  code, and the session it used (if any). */
  async finishAgentLoopRun(
    runId: string,
    result: {
      outcome: AgentLoopRunOutcome;
      detail?: string | null;
      sessionId?: string | null;
      exitCode?: number | null;
      isTest?: boolean;
    },
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const run = await tx
        .selectFrom('agent_loop_runs')
        .select('loop_id')
        .where('id', '=', runId)
        .executeTakeFirst();
      if (!run) return;
      await tx
        .updateTable('agent_loop_runs')
        .set({
          finished_at: sql`now()`,
          outcome: result.outcome,
          detail: result.detail ?? null,
          session_id: result.sessionId ?? null,
          exit_code: result.exitCode ?? null,
          ...(result.isTest !== undefined ? { is_test: result.isTest } : {}),
        })
        .where('id', '=', runId)
        .execute();

      // Test runs prove config but must not trip or reset the production circuit.
      if (result.isTest === true) return;
      const loop = await tx
        .selectFrom('agent_loops')
        .select('consecutive_error_count')
        .where('id', '=', run.loop_id)
        .forUpdate()
        .executeTakeFirst();
      if (!loop) return;
      const errorCount =
        result.outcome === 'error'
          ? loop.consecutive_error_count + 1
          : result.outcome === 'ok' || result.outcome === 'acted'
            ? 0
            : loop.consecutive_error_count;
      const circuitOpen = errorCount >= 5;
      await tx
        .updateTable('agent_loops')
        .set({
          last_run_at: sql`now()`,
          last_outcome: result.outcome,
          consecutive_error_count: errorCount,
          ...(circuitOpen ? { status: 'paused', next_run_at: null } : {}),
          updated_at: sql`now()`,
        })
        .where('id', '=', run.loop_id)
        .execute();
    });
  }

  /** Run history for a loop, newest first, capped at `limit` (default 50). */
  async listAgentLoopRuns(loopId: string, limit = 50): Promise<AgentLoopRunRecord[]> {
    const rows = await this.db
      .selectFrom('agent_loop_runs')
      .selectAll()
      .where('loop_id', '=', loopId)
      .orderBy('seq', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => this.agentLoopRunRowToRecord(r));
  }

  async getAgentLoopRun(id: string): Promise<AgentLoopRunRecord | undefined> {
    const row = await this.db
      .selectFrom('agent_loop_runs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.agentLoopRunRowToRecord(row) : undefined;
  }

  private agentLoopRunRowToRecord(row: {
    id: string;
    loop_id: string;
    started_at: Date;
    finished_at: Date | null;
    outcome: string;
    exit_code: number | null;
    detail: string | null;
    session_id: string | null;
    is_test: boolean;
  }): AgentLoopRunRecord {
    return {
      id: row.id,
      loopId: row.loop_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      outcome: row.outcome as AgentLoopRunOutcome,
      exitCode: row.exit_code,
      detail: row.detail,
      sessionId: row.session_id,
      isTest: row.is_test,
    };
  }

  private projectSettingsRowToRecord(
    row: {
      project_id: string;
      doppler_token_ref: string | null;
      doppler_token: string | null;
      doppler_project: string | null;
      doppler_config: string | null;
      doppler_minted_token: string | null;
      doppler_minted_token_slug: string | null;
      default_branch: string | null;
      default_model: string | null;
      memory: string | null;
      created_at: Date;
      updated_at: Date;
      // See veritySettingsRowToRecord: false → no decrypt (sealed-safe public read).
    },
    decrypt = true,
  ): ProjectSettingsRecord {
    return {
      projectId: row.project_id,
      dopplerTokenRef: row.doppler_token_ref,
      dopplerToken: decrypt ? this.decryptSecret(row.doppler_token) : row.doppler_token,
      dopplerProject: row.doppler_project,
      dopplerConfig: row.doppler_config,
      dopplerMintedToken: decrypt
        ? this.decryptSecret(row.doppler_minted_token)
        : row.doppler_minted_token,
      dopplerMintedTokenSlug: row.doppler_minted_token_slug,
      defaultBranch: row.default_branch,
      defaultModel: row.default_model,
      memory: row.memory,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private readonly projectSettingsColumns = [
    'project_id',
    'doppler_token_ref',
    'doppler_token',
    'doppler_project',
    'doppler_config',
    'doppler_minted_token',
    'doppler_minted_token_slug',
    'default_branch',
    'default_model',
    'memory',
    'created_at',
    'updated_at',
  ] as const;

  private veritySettingsRowToRecord(
    row: {
      git_user_name: string | null;
      git_user_email: string | null;
      git_ssh_private_key_path: string | null;
      git_ssh_private_key: string | null;
      git_ssh_public_key_path: string | null;
      git_ssh_public_key: string | null;
      git_known_hosts_path: string | null;
      git_known_hosts: string | null;
      git_allowed_signers_path: string | null;
      git_allowed_signers: string | null;
      github_app_id: string | null;
      github_app_installation_id: string | null;
      github_app_private_key: string | null;
      doppler_service_token: string | null;
      transcribe_base_url: string | null;
      transcribe_api_key: string | null;
      transcribe_model: string | null;
      transcribe_backend_mode: string | null;
      claude_code_oauth_credentials_json: string | null;
      codex_auth_json: string | null;
      google_drive_client_id: string | null;
      google_drive_account_email: string | null;
      google_drive_refresh_token: string | null;
      uplink_subscription_key: string | null;
      uplink_installation_id: string | null;
      advanced_mode_enabled: boolean;
      created_at: Date;
      updated_at: Date;
      // When false, secret columns are returned in their STORED (possibly
      // encrypted) form without decrypting — for public read paths that only
      // strip/`configured`-check them, so they work while the store is sealed.
    },
    decrypt = true,
  ): VeritySettingsRecord {
    return {
      advancedModeEnabled: row.advanced_mode_enabled,
      gitUserName: row.git_user_name,
      gitUserEmail: row.git_user_email,
      gitSshPrivateKeyPath: row.git_ssh_private_key_path,
      gitSshPrivateKey: decrypt
        ? this.decryptSecret(row.git_ssh_private_key)
        : row.git_ssh_private_key,
      gitSshPublicKeyPath: row.git_ssh_public_key_path,
      gitSshPublicKey: row.git_ssh_public_key,
      gitKnownHostsPath: row.git_known_hosts_path,
      gitKnownHosts: row.git_known_hosts,
      gitAllowedSignersPath: row.git_allowed_signers_path,
      gitAllowedSigners: row.git_allowed_signers,
      githubAppId: row.github_app_id,
      githubAppInstallationId: row.github_app_installation_id,
      githubAppPrivateKey: decrypt
        ? this.decryptSecret(row.github_app_private_key)
        : row.github_app_private_key,
      dopplerServiceToken: decrypt
        ? this.decryptSecret(row.doppler_service_token)
        : row.doppler_service_token,
      transcribeBaseUrl: row.transcribe_base_url,
      transcribeApiKey: decrypt
        ? this.decryptSecret(row.transcribe_api_key)
        : row.transcribe_api_key,
      transcribeModel: row.transcribe_model,
      transcribeBackendMode:
        row.transcribe_backend_mode === 'local' || row.transcribe_backend_mode === 'external'
          ? row.transcribe_backend_mode
          : null,
      claudeCodeOauthCredentialsJson: decrypt
        ? this.decryptSecret(row.claude_code_oauth_credentials_json)
        : row.claude_code_oauth_credentials_json,
      codexAuthJson: decrypt ? this.decryptSecret(row.codex_auth_json) : row.codex_auth_json,
      googleDriveClientId: row.google_drive_client_id,
      googleDriveAccountEmail: row.google_drive_account_email,
      googleDriveRefreshToken: decrypt
        ? this.decryptSecret(row.google_drive_refresh_token)
        : row.google_drive_refresh_token,
      uplinkSubscriptionKey: decrypt
        ? this.decryptSecret(row.uplink_subscription_key)
        : row.uplink_subscription_key,
      uplinkInstallationId: row.uplink_installation_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private readonly veritySettingsColumns = [
    'advanced_mode_enabled',
    'git_user_name',
    'git_user_email',
    'git_ssh_private_key_path',
    'git_ssh_private_key',
    'git_ssh_public_key_path',
    'git_ssh_public_key',
    'git_known_hosts_path',
    'git_known_hosts',
    'git_allowed_signers_path',
    'git_allowed_signers',
    'github_app_id',
    'github_app_installation_id',
    'github_app_private_key',
    'doppler_service_token',
    'transcribe_base_url',
    'transcribe_api_key',
    'transcribe_model',
    'transcribe_backend_mode',
    'claude_code_oauth_credentials_json',
    'codex_auth_json',
    'google_drive_client_id',
    'google_drive_account_email',
    'google_drive_refresh_token',
    'uplink_subscription_key',
    'uplink_installation_id',
    'advanced_mode_enabled',
    'created_at',
    'updated_at',
  ] as const;

  async getVeritySettings(): Promise<VeritySettingsRecord | undefined> {
    const row = await this.db
      .selectFrom('verity_settings')
      .select(this.veritySettingsColumns)
      .where('id', '=', 'global')
      .executeTakeFirst();
    return row ? this.veritySettingsRowToRecord(row) : undefined;
  }

  /**
   * Read settings WITHOUT decrypting the secret columns — for public read paths
   * (GET /settings, first-run seeding) that only strip or `configured`-check
   * secrets. Works while the store is sealed; the returned record's secret
   * fields hold the STORED (possibly encrypted) form, so they must NOT be used
   * as plaintext.
   */
  async getVeritySettingsRaw(): Promise<VeritySettingsRecord | undefined> {
    const row = await this.db
      .selectFrom('verity_settings')
      .select(this.veritySettingsColumns)
      .where('id', '=', 'global')
      .executeTakeFirst();
    return row ? this.veritySettingsRowToRecord(row, false) : undefined;
  }

  async updateVeritySettings(patch: VeritySettingsPatch): Promise<VeritySettingsRecord> {
    const values = {
      id: 'global',
      advanced_mode_enabled: patch.advancedModeEnabled ?? false,
      git_user_name: normalizeSetting(patch.gitUserName),
      git_user_email: normalizeSetting(patch.gitUserEmail),
      git_ssh_private_key_path: normalizeSetting(patch.gitSshPrivateKeyPath),
      git_ssh_private_key: this.encryptSecret(normalizeSetting(patch.gitSshPrivateKey)),
      git_ssh_public_key_path: normalizeSetting(patch.gitSshPublicKeyPath),
      git_ssh_public_key: normalizeSetting(patch.gitSshPublicKey),
      git_known_hosts_path: normalizeSetting(patch.gitKnownHostsPath),
      git_known_hosts: normalizeSetting(patch.gitKnownHosts),
      git_allowed_signers_path: normalizeSetting(patch.gitAllowedSignersPath),
      git_allowed_signers: normalizeSetting(patch.gitAllowedSigners),
      github_app_id: normalizeSetting(patch.githubAppId),
      github_app_installation_id: normalizeSetting(patch.githubAppInstallationId),
      github_app_private_key: this.encryptSecret(normalizeSetting(patch.githubAppPrivateKey)),
      doppler_service_token: this.encryptSecret(normalizeSetting(patch.dopplerServiceToken)),
      transcribe_base_url: normalizeSetting(patch.transcribeBaseUrl),
      transcribe_api_key: this.encryptSecret(normalizeSetting(patch.transcribeApiKey)),
      transcribe_model: normalizeSetting(patch.transcribeModel),
      transcribe_backend_mode: normalizeSetting(patch.transcribeBackendMode),
      claude_code_oauth_credentials_json: this.encryptSecret(
        normalizeSetting(patch.claudeCodeOauthCredentialsJson),
      ),
      codex_auth_json: this.encryptSecret(normalizeSetting(patch.codexAuthJson)),
      google_drive_client_id: normalizeSetting(patch.googleDriveClientId),
      google_drive_account_email: normalizeSetting(patch.googleDriveAccountEmail),
      google_drive_refresh_token: this.encryptSecret(
        normalizeSetting(patch.googleDriveRefreshToken),
      ),
      uplink_subscription_key: this.encryptSecret(normalizeSetting(patch.uplinkSubscriptionKey)),
      uplink_installation_id: normalizeSetting(patch.uplinkInstallationId),
    };
    const row = await this.db
      .insertInto('verity_settings')
      .values(values)
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          ...(patch.advancedModeEnabled !== undefined
            ? { advanced_mode_enabled: patch.advancedModeEnabled }
            : {}),
          ...(patch.gitUserName !== undefined
            ? { git_user_name: normalizeSetting(patch.gitUserName) }
            : {}),
          ...(patch.gitUserEmail !== undefined
            ? { git_user_email: normalizeSetting(patch.gitUserEmail) }
            : {}),
          ...(patch.gitSshPrivateKeyPath !== undefined
            ? { git_ssh_private_key_path: normalizeSetting(patch.gitSshPrivateKeyPath) }
            : {}),
          ...(patch.gitSshPrivateKey !== undefined
            ? { git_ssh_private_key: this.encryptSecret(normalizeSetting(patch.gitSshPrivateKey)) }
            : {}),
          ...(patch.gitSshPublicKeyPath !== undefined
            ? { git_ssh_public_key_path: normalizeSetting(patch.gitSshPublicKeyPath) }
            : {}),
          ...(patch.gitSshPublicKey !== undefined
            ? { git_ssh_public_key: normalizeSetting(patch.gitSshPublicKey) }
            : {}),
          ...(patch.gitKnownHostsPath !== undefined
            ? { git_known_hosts_path: normalizeSetting(patch.gitKnownHostsPath) }
            : {}),
          ...(patch.gitKnownHosts !== undefined
            ? { git_known_hosts: normalizeSetting(patch.gitKnownHosts) }
            : {}),
          ...(patch.gitAllowedSignersPath !== undefined
            ? { git_allowed_signers_path: normalizeSetting(patch.gitAllowedSignersPath) }
            : {}),
          ...(patch.gitAllowedSigners !== undefined
            ? { git_allowed_signers: normalizeSetting(patch.gitAllowedSigners) }
            : {}),
          ...(patch.githubAppId !== undefined
            ? { github_app_id: normalizeSetting(patch.githubAppId) }
            : {}),
          ...(patch.githubAppInstallationId !== undefined
            ? { github_app_installation_id: normalizeSetting(patch.githubAppInstallationId) }
            : {}),
          ...(patch.githubAppPrivateKey !== undefined
            ? {
                github_app_private_key: this.encryptSecret(
                  normalizeSetting(patch.githubAppPrivateKey),
                ),
              }
            : {}),
          ...(patch.dopplerServiceToken !== undefined
            ? {
                doppler_service_token: this.encryptSecret(
                  normalizeSetting(patch.dopplerServiceToken),
                ),
              }
            : {}),
          ...(patch.transcribeBaseUrl !== undefined
            ? { transcribe_base_url: normalizeSetting(patch.transcribeBaseUrl) }
            : {}),
          ...(patch.transcribeApiKey !== undefined
            ? {
                transcribe_api_key: this.encryptSecret(normalizeSetting(patch.transcribeApiKey)),
              }
            : {}),
          ...(patch.transcribeModel !== undefined
            ? { transcribe_model: normalizeSetting(patch.transcribeModel) }
            : {}),
          ...(patch.transcribeBackendMode !== undefined
            ? { transcribe_backend_mode: normalizeSetting(patch.transcribeBackendMode) }
            : {}),
          ...(patch.claudeCodeOauthCredentialsJson !== undefined
            ? {
                claude_code_oauth_credentials_json: this.encryptSecret(
                  normalizeSetting(patch.claudeCodeOauthCredentialsJson),
                ),
              }
            : {}),
          ...(patch.codexAuthJson !== undefined
            ? { codex_auth_json: this.encryptSecret(normalizeSetting(patch.codexAuthJson)) }
            : {}),
          ...(patch.googleDriveClientId !== undefined
            ? { google_drive_client_id: normalizeSetting(patch.googleDriveClientId) }
            : {}),
          ...(patch.googleDriveAccountEmail !== undefined
            ? { google_drive_account_email: normalizeSetting(patch.googleDriveAccountEmail) }
            : {}),
          ...(patch.googleDriveRefreshToken !== undefined
            ? {
                google_drive_refresh_token: this.encryptSecret(
                  normalizeSetting(patch.googleDriveRefreshToken),
                ),
              }
            : {}),
          ...(patch.uplinkSubscriptionKey !== undefined
            ? {
                uplink_subscription_key: this.encryptSecret(
                  normalizeSetting(patch.uplinkSubscriptionKey),
                ),
              }
            : {}),
          ...(patch.uplinkInstallationId !== undefined
            ? { uplink_installation_id: normalizeSetting(patch.uplinkInstallationId) }
            : {}),
          ...(patch.advancedModeEnabled !== undefined
            ? { advanced_mode_enabled: patch.advancedModeEnabled }
            : {}),
          updated_at: sql`now()`,
        }),
      )
      .returning(this.veritySettingsColumns)
      .executeTakeFirst();
    if (!row) {
      throw new Error('verity: updateVeritySettings RETURNING yielded no row — dialect bug');
    }
    return this.veritySettingsRowToRecord(row);
  }

  /** Persist the non-secret first-use transcription choice without decrypting
   * unrelated settings. This remains available while the secret store is sealed. */
  async updateTranscribeBackendMode(mode: 'local' | 'external'): Promise<void> {
    await this.db
      .insertInto('verity_settings')
      .values({ id: 'global', transcribe_backend_mode: mode })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({ transcribe_backend_mode: mode, updated_at: sql`now()` }),
      )
      .execute();
  }

  // ── Dev servers (multi-dev-server data model, slice 1) ───────────────────────
  private devServerRowToRecord(row: {
    id: string;
    project_id: string;
    source_key: string | null;
    name: string;
    command: string | null;
    url: string | null;
    workdir: string | null;
    host_port: string | null;
    container_port: string | null;
    preview_session_id: string | null;
    auto_start: boolean;
    sort_order: number;
    created_at: Date;
    updated_at: Date;
  }): DevServerRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      sourceKey: row.source_key,
      name: row.name,
      command: row.command,
      url: row.url,
      workdir: row.workdir,
      hostPort: row.host_port,
      containerPort: row.container_port,
      previewSessionId: row.preview_session_id,
      autoStart: row.auto_start,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private readonly devServerColumns = [
    'id',
    'project_id',
    'source_key',
    'name',
    'command',
    'url',
    'workdir',
    'host_port',
    'container_port',
    'preview_session_id',
    'auto_start',
    'sort_order',
    'created_at',
    'updated_at',
  ] as const;

  /** Dev servers for one project, in their configured display order. */
  async listDevServers(projectId: string): Promise<DevServerRecord[]> {
    const rows = await this.db
      .selectFrom('dev_servers')
      .select(this.devServerColumns)
      .where('project_id', '=', projectId)
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map((r) => this.devServerRowToRecord(r));
  }

  async getDevServer(id: string): Promise<DevServerRecord | undefined> {
    const row = await this.db
      .selectFrom('dev_servers')
      .select(this.devServerColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.devServerRowToRecord(row) : undefined;
  }

  private devServerPortMutation<T>(operation: () => Promise<T>): Promise<T> {
    const mutation = this.devServerPortMutationTail.then(operation);
    this.devServerPortMutationTail = mutation.then(
      () => undefined,
      () => undefined,
    );
    return mutation;
  }

  private async allocateDevServerHostPort(tx: Transaction<Database>): Promise<string> {
    const rows = await tx
      .selectFrom('dev_servers')
      .select('host_port')
      .where('host_port', 'is not', null)
      .execute();
    return nextFreeDevServerHostPort(
      new Set(rows.flatMap((row) => (row.host_port === null ? [] : [row.host_port]))),
    );
  }

  async createDevServer(input: DevServerCreateInput): Promise<DevServerRecord> {
    return this.devServerPortMutation(() =>
      this.db.transaction().execute(async (tx) => {
        await sql`lock table dev_servers in share row exclusive mode`.execute(tx);
        await tx
          .insertInto('project_settings')
          .values({ project_id: input.projectId })
          .onConflict((oc) => oc.column('project_id').doNothing())
          .execute();
        await tx
          .selectFrom('project_settings')
          .select('project_id')
          .where('project_id', '=', input.projectId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const row = await tx
          .insertInto('dev_servers')
          .values({
            id: randomUUID(),
            project_id: input.projectId,
            source_key: normalizeSetting(input.sourceKey),
            name: input.name ?? 'Dev server',
            command: normalizeSetting(input.command),
            url: normalizeSetting(input.url),
            workdir: normalizeSetting(input.workdir),
            host_port: await this.allocateDevServerHostPort(tx),
            container_port: normalizeSetting(input.containerPort),
            auto_start: input.autoStart ?? false,
            ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
          })
          .returning(this.devServerColumns)
          .executeTakeFirst();
        if (!row) {
          throw new Error('verity: createDevServer RETURNING yielded no row — dialect bug');
        }
        return this.devServerRowToRecord(row);
      }),
    );
  }

  async updateDevServer(id: string, patch: DevServerPatch): Promise<DevServerRecord | undefined> {
    const set: Record<string, unknown> = { updated_at: sql`now()` };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.command !== undefined) set.command = normalizeSetting(patch.command);
    if (patch.url !== undefined) set.url = normalizeSetting(patch.url);
    if (patch.workdir !== undefined) set.workdir = normalizeSetting(patch.workdir);
    // host_port is a global registry lease and cannot be changed by CRUD PATCH.
    if (patch.containerPort !== undefined)
      set.container_port = normalizeSetting(patch.containerPort);
    if (patch.previewSessionId !== undefined) set.preview_session_id = patch.previewSessionId;
    if (patch.autoStart !== undefined) set.auto_start = patch.autoStart;
    if (patch.sortOrder !== undefined) set.sort_order = patch.sortOrder;
    const row = await this.db
      .updateTable('dev_servers')
      .set(set)
      .where('id', '=', id)
      .returning(this.devServerColumns)
      .executeTakeFirst();
    return row ? this.devServerRowToRecord(row) : undefined;
  }

  async recordDevServerDetection(
    projectId: string,
    fingerprint: string,
  ): Promise<DevServerDetectionStateRecord> {
    const row = await this.db
      .insertInto('dev_server_detection_state')
      .values({ project_id: projectId, fingerprint })
      .onConflict((conflict) =>
        conflict.column('project_id').doUpdateSet({
          fingerprint,
          detected_at: sql`now()`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return {
      projectId: row.project_id,
      fingerprint: row.fingerprint,
      detectedAt: row.detected_at,
      reviewedFingerprint: row.reviewed_fingerprint,
      reviewedAt: row.reviewed_at,
    };
  }

  async getDevServerDetectionState(
    projectId: string,
  ): Promise<DevServerDetectionStateRecord | undefined> {
    const row = await this.db
      .selectFrom('dev_server_detection_state')
      .selectAll()
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return row
      ? {
          projectId: row.project_id,
          fingerprint: row.fingerprint,
          detectedAt: row.detected_at,
          reviewedFingerprint: row.reviewed_fingerprint,
          reviewedAt: row.reviewed_at,
        }
      : undefined;
  }

  /** Mark exactly the current detector result as reviewed. A stale client cannot
   * acknowledge a newer scan that arrived after its dialog was opened. */
  async reviewDevServerDetection(
    projectId: string,
    fingerprint: string,
  ): Promise<DevServerDetectionStateRecord | undefined> {
    const row = await this.db
      .updateTable('dev_server_detection_state')
      .set({ reviewed_fingerprint: fingerprint, reviewed_at: sql`now()` })
      .where('project_id', '=', projectId)
      .where('fingerprint', '=', fingerprint)
      .returningAll()
      .executeTakeFirst();
    return row
      ? {
          projectId: row.project_id,
          fingerprint: row.fingerprint,
          detectedAt: row.detected_at,
          reviewedFingerprint: row.reviewed_fingerprint,
          reviewedAt: row.reviewed_at,
        }
      : undefined;
  }

  /** Release a review claim when the corresponding setup mutation failed. */
  async unreviewDevServerDetection(projectId: string, fingerprint: string): Promise<void> {
    await this.db
      .updateTable('dev_server_detection_state')
      .set({ reviewed_fingerprint: null, reviewed_at: null })
      .where('project_id', '=', projectId)
      .where('fingerprint', '=', fingerprint)
      .where('reviewed_fingerprint', '=', fingerprint)
      .execute();
  }

  async deleteDevServer(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('dev_servers').where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  private publicPreviewShare(row: Selectable<PublicPreviewSharesTable>): PublicPreviewShareRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      devServerId: row.dev_server_id,
      containerGeneration: row.container_generation,
      targetPort: row.target_port,
      targetKind: row.target_kind,
      staticPath: row.static_path,
      state: row.state as PublicPreviewShareState,
      publicOrigin: row.public_origin,
      edgeUrl: row.edge_url,
      pinHash: this.decryptSecret(row.pin_hash_secret) ?? '',
      connectorToken: this.decryptSecret(row.connector_token_secret) ?? '',
      sessionSecret: this.decryptSecret(row.session_secret) ?? '',
      connectorContainerName: row.connector_container_name,
      connectorContainerId: row.connector_container_id,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      failure: row.failure,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async createPublicPreviewShare(
    input: PublicPreviewShareCreateInput,
  ): Promise<PublicPreviewShareRecord> {
    const row = await this.db
      .insertInto('public_preview_shares')
      .values({
        id: input.id,
        project_id: input.projectId,
        dev_server_id: input.devServerId,
        container_generation: input.containerGeneration,
        target_port: input.targetPort,
        target_kind: input.targetKind ?? 'dev-server',
        static_path: input.staticPath ?? null,
        state: 'creating',
        public_origin: input.publicOrigin,
        edge_url: input.edgeUrl,
        pin_hash_secret: this.encryptSecret(input.pinHash) ?? '',
        connector_token_secret: this.encryptSecret(input.connectorToken) ?? '',
        session_secret: this.encryptSecret(input.sessionSecret) ?? '',
        connector_container_name: input.connectorContainerName,
        expires_at: input.expiresAt.toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.publicPreviewShare(row);
  }

  async addPendingUplinkShareRemoval(shareId: string): Promise<void> {
    await this.db
      .insertInto('uplink_pending_share_removals')
      .values({ share_id: shareId })
      .onConflict((conflict) => conflict.column('share_id').doNothing())
      .execute();
  }

  async listPendingUplinkShareRemovals(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('uplink_pending_share_removals')
      .select('share_id')
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((row) => row.share_id);
  }

  async deletePendingUplinkShareRemoval(shareId: string): Promise<void> {
    await this.db
      .deleteFrom('uplink_pending_share_removals')
      .where('share_id', '=', shareId)
      .execute();
  }

  async getPublicPreviewShare(id: string): Promise<PublicPreviewShareRecord | undefined> {
    const row = await this.db
      .selectFrom('public_preview_shares')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : this.publicPreviewShare(row);
  }

  async listPublicPreviewShares(projectId?: string): Promise<PublicPreviewShareRecord[]> {
    let query = this.db.selectFrom('public_preview_shares').selectAll();
    if (projectId !== undefined) query = query.where('project_id', '=', projectId);
    const rows = await query.orderBy('created_at', 'desc').execute();
    return rows.map((row) => this.publicPreviewShare(row));
  }

  /** Compare-and-set is the lifecycle fence shared by create, stop, expiry and
   * restart reconciliation. A stale worker cannot resurrect a revoked share. */
  async transitionPublicPreviewShare(
    id: string,
    from: readonly PublicPreviewShareState[],
    to: PublicPreviewShareState,
    patch: {
      connectorContainerId?: string | null;
      failure?: string | null;
      revokedAt?: Date | null;
    } = {},
  ): Promise<PublicPreviewShareRecord | undefined> {
    if (from.length === 0) return undefined;
    const row = await this.db
      .updateTable('public_preview_shares')
      .set({
        state: to,
        updated_at: sql`now()`,
        ...(patch.connectorContainerId === undefined
          ? {}
          : { connector_container_id: patch.connectorContainerId }),
        ...(patch.failure === undefined ? {} : { failure: patch.failure }),
        ...(patch.revokedAt === undefined
          ? {}
          : { revoked_at: patch.revokedAt?.toISOString() ?? null }),
      })
      .where('id', '=', id)
      .where('state', 'in', [...from])
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : this.publicPreviewShare(row);
  }

  async listPublicPreviewSharesDue(now = new Date()): Promise<PublicPreviewShareRecord[]> {
    const rows = await this.db
      .selectFrom('public_preview_shares')
      .selectAll()
      .where('state', 'in', ['creating', 'active', 'revoking'])
      .where('expires_at', '<=', now)
      .execute();
    return rows.map((row) => this.publicPreviewShare(row));
  }

  /** Read the singleton Claude-egress CA + gateway identity, decrypting the CA +
   *  gateway private keys. Returns undefined before the first issuance. */
  async getClaudeEgressCa(): Promise<ClaudeEgressCaRecord | undefined> {
    const row = await this.db
      .selectFrom('claude_egress_ca')
      .selectAll()
      .where('id', '=', 'global')
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      caCertPem: row.ca_cert_pem,
      // A non-null secret column always decrypts; `?? ''` only satisfies the
      // `string | null` return of decryptSecret for a value we know is present.
      caKeyPem: this.decryptSecret(row.ca_key_pem) ?? '',
      gatewayServerName: row.gateway_server_name,
      gatewayCertPem: row.gateway_cert_pem,
      gatewayKeyPem: this.decryptSecret(row.gateway_key_pem) ?? '',
      caExpiresAt: new Date(row.ca_expires_at),
      gatewayExpiresAt: new Date(row.gateway_expires_at),
    };
  }

  /** Insert or replace the singleton CA + gateway identity, encrypting both
   *  private keys at rest. A re-issue (rotation) overwrites the single row. */
  async upsertClaudeEgressCa(record: ClaudeEgressCaRecord): Promise<void> {
    const values = this.claudeEgressCaValues(record);
    await this.db
      .insertInto('claude_egress_ca')
      .values({ id: 'global', ...values })
      .onConflict((oc) => oc.column('id').doUpdateSet({ ...values, updated_at: sql`now()` }))
      .execute();
  }

  /**
   * Atomically install a freshly minted CA (first issuance or rotation) AND wipe
   * every per-project client cert in ONE transaction. The old client certs were
   * signed by the superseded CA and no longer chain to it, so they must never
   * survive a CA rotation as stale, un-authenticatable peer bindings. Doing the
   * CA write and the wipe together makes a mid-rotation crash leave either the old
   * world or the new one, never a fresh CA alongside orphaned old-CA client certs.
   */
  async replaceClaudeEgressCa(record: ClaudeEgressCaRecord): Promise<void> {
    const values = this.claudeEgressCaValues(record);
    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('claude_egress_ca')
        .values({ id: 'global', ...values })
        .onConflict((oc) => oc.column('id').doUpdateSet({ ...values, updated_at: sql`now()` }))
        .execute();
      await tx.deleteFrom('claude_egress_client_certs').execute();
    });
  }

  /** Encrypt the two private-key columns at rest. Uses {@link cipher}.encrypt
   *  directly (not the null-aware {@link encryptSecret}) because every egress CA
   *  column is NOT NULL — a CA row without its keys is meaningless. */
  private claudeEgressCaValues(record: ClaudeEgressCaRecord): {
    ca_cert_pem: string;
    ca_key_pem: string;
    gateway_server_name: string;
    gateway_cert_pem: string;
    gateway_key_pem: string;
    ca_expires_at: string;
    gateway_expires_at: string;
  } {
    return {
      ca_cert_pem: record.caCertPem,
      ca_key_pem: this.cipher.encrypt(record.caKeyPem),
      gateway_server_name: record.gatewayServerName,
      gateway_cert_pem: record.gatewayCertPem,
      gateway_key_pem: this.cipher.encrypt(record.gatewayKeyPem),
      ca_expires_at: record.caExpiresAt.toISOString(),
      gateway_expires_at: record.gatewayExpiresAt.toISOString(),
    };
  }

  /** Read one project's client certificate, decrypting its private key. */
  async getClaudeEgressClientCert(
    projectId: string,
  ): Promise<ClaudeEgressClientCertRecord | undefined> {
    const row = await this.db
      .selectFrom('claude_egress_client_certs')
      .selectAll()
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return row ? this.claudeEgressClientCertRowToRecord(row) : undefined;
  }

  /** Every stored client certificate — the source of the gateway's
   *  fingerprint→project peer bindings. */
  async listClaudeEgressClientCerts(): Promise<ClaudeEgressClientCertRecord[]> {
    const rows = await this.db
      .selectFrom('claude_egress_client_certs')
      .selectAll()
      .orderBy('project_id', 'asc')
      .execute();
    return rows.map((row) => this.claudeEgressClientCertRowToRecord(row));
  }

  /** Insert or replace a project's client certificate, encrypting the key. A
   *  rotation upserts on the project_id PK, dropping the superseded fingerprint. */
  async upsertClaudeEgressClientCert(record: ClaudeEgressClientCertRecord): Promise<void> {
    const values = {
      cert_pem: record.certPem,
      key_pem: this.cipher.encrypt(record.keyPem),
      fingerprint256: record.fingerprint256,
      expires_at: record.expiresAt.toISOString(),
    };
    await this.db
      .insertInto('claude_egress_client_certs')
      .values({ project_id: record.projectId, ...values })
      .onConflict((oc) =>
        oc.column('project_id').doUpdateSet({ ...values, updated_at: sql`now()` }),
      )
      .execute();
  }

  /** Drop a project's client certificate (deprovision / revocation). */
  async deleteClaudeEgressClientCert(projectId: string): Promise<void> {
    await this.db
      .deleteFrom('claude_egress_client_certs')
      .where('project_id', '=', projectId)
      .execute();
  }

  private claudeEgressClientCertRowToRecord(row: {
    project_id: string;
    cert_pem: string;
    key_pem: string;
    fingerprint256: string;
    expires_at: Date | string;
  }): ClaudeEgressClientCertRecord {
    return {
      projectId: row.project_id,
      certPem: row.cert_pem,
      keyPem: this.decryptSecret(row.key_pem) ?? '',
      fingerprint256: row.fingerprint256,
      expiresAt: new Date(row.expires_at),
    };
  }

  async reconcileDevServerHostPorts(projectId?: string): Promise<void> {
    await this.devServerPortMutation(() =>
      this.db.transaction().execute(async (tx) => {
        await sql`lock table dev_servers in share row exclusive mode`.execute(tx);
        const rows = await tx
          .selectFrom('dev_servers')
          .innerJoin('projects', 'projects.id', 'dev_servers.project_id')
          .select([
            'dev_servers.id',
            'dev_servers.project_id',
            'dev_servers.host_port',
            'projects.state',
            'projects.hidden_at',
          ])
          .orderBy('dev_servers.created_at', 'asc')
          .orderBy('dev_servers.id', 'asc')
          .execute();
        const used = new Set<string>();
        const needsLease: string[] = [];
        for (const row of rows) {
          const target = projectId === undefined || row.project_id === projectId;
          // Visible paused projects keep their reservation: `absent` is the only
          // safe state in which callers may add or change published ports. Only
          // a soft delete releases every lease for the project.
          const eligible = row.hidden_at === null;
          if (!eligible) {
            if (target && row.host_port !== null) {
              await tx
                .updateTable('dev_servers')
                .set({ host_port: null, updated_at: sql`now()` })
                .where('id', '=', row.id)
                .execute();
            }
            continue;
          }
          if (isManagedDevServerHostPort(row.host_port) && !used.has(row.host_port)) {
            used.add(row.host_port);
          } else if (target) {
            needsLease.push(row.id);
          }
        }
        for (const id of needsLease) {
          const port = nextFreeDevServerHostPort(used);
          used.add(port);
          await tx
            .updateTable('dev_servers')
            .set({ host_port: port, updated_at: sql`now()` })
            .where('id', '=', id)
            .execute();
        }
      }),
    );
  }

  async releaseProjectDevServerHostPorts(projectId: string): Promise<void> {
    await this.devServerPortMutation(() =>
      this.db.transaction().execute(async (tx) => {
        await sql`lock table dev_servers in share row exclusive mode`.execute(tx);
        await tx
          .updateTable('dev_servers')
          .set({ host_port: null, updated_at: sql`now()` })
          .where('project_id', '=', projectId)
          .execute();
      }),
    );
  }

  async getProjectSettings(projectId: string): Promise<ProjectSettingsRecord | undefined> {
    const row = await this.db
      .selectFrom('project_settings')
      .select(this.projectSettingsColumns)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return row ? this.projectSettingsRowToRecord(row) : undefined;
  }

  /** Like {@link getProjectSettings} but WITHOUT decrypting `doppler_token` —
   *  sealed-safe, for public read paths that strip it. See getVeritySettingsRaw. */
  async getProjectSettingsRaw(projectId: string): Promise<ProjectSettingsRecord | undefined> {
    const row = await this.db
      .selectFrom('project_settings')
      .select(this.projectSettingsColumns)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return row ? this.projectSettingsRowToRecord(row, false) : undefined;
  }

  async updateProjectSettings(
    projectId: string,
    patch: ProjectSettingsPatch,
  ): Promise<ProjectSettingsRecord | undefined> {
    const project = await this.getProject(projectId);
    if (project === undefined) return undefined;

    // Cap the operator UI full-replace write here (the shared store layer) so it is
    // bounded exactly like the broker append path (ADR 0008). Reject rather than
    // truncate operator-authored text.
    const memory = normalizeSetting(patch.memory);
    if (memory !== null && memory.length > PROJECT_MEMORY_MAX_CHARS) {
      throw new ProjectMemoryTooLargeError(memory.length, PROJECT_MEMORY_MAX_CHARS);
    }

    const values = {
      project_id: projectId,
      doppler_token_ref: normalizeSetting(patch.dopplerTokenRef),
      doppler_token: this.encryptSecret(normalizeSetting(patch.dopplerToken)),
      doppler_project: normalizeSetting(patch.dopplerProject),
      doppler_config: normalizeSetting(patch.dopplerConfig),
      doppler_minted_token: this.encryptSecret(normalizeSetting(patch.dopplerMintedToken)),
      doppler_minted_token_slug: normalizeSetting(patch.dopplerMintedTokenSlug),
      default_branch: normalizeSetting(patch.defaultBranch),
      default_model: normalizeSetting(patch.defaultModel),
      memory,
    };
    return this.db.transaction().execute(async (tx) => {
      // Ensure and lock the per-project settings row before applying the patch.
      await tx
        .insertInto('project_settings')
        .values({ project_id: projectId })
        .onConflict((oc) => oc.column('project_id').doNothing())
        .execute();
      await tx
        .selectFrom('project_settings')
        .select('project_id')
        .where('project_id', '=', projectId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      const row = await tx
        .insertInto('project_settings')
        .values(values)
        .onConflict((oc) =>
          oc.column('project_id').doUpdateSet({
            ...(patch.dopplerTokenRef !== undefined
              ? { doppler_token_ref: normalizeSetting(patch.dopplerTokenRef) }
              : {}),
            ...(patch.dopplerToken !== undefined
              ? { doppler_token: this.encryptSecret(normalizeSetting(patch.dopplerToken)) }
              : {}),
            ...(patch.dopplerProject !== undefined
              ? { doppler_project: normalizeSetting(patch.dopplerProject) }
              : {}),
            ...(patch.dopplerConfig !== undefined
              ? { doppler_config: normalizeSetting(patch.dopplerConfig) }
              : {}),
            ...(patch.dopplerMintedToken !== undefined
              ? {
                  doppler_minted_token: this.encryptSecret(
                    normalizeSetting(patch.dopplerMintedToken),
                  ),
                }
              : {}),
            ...(patch.dopplerMintedTokenSlug !== undefined
              ? { doppler_minted_token_slug: normalizeSetting(patch.dopplerMintedTokenSlug) }
              : {}),
            ...(patch.defaultBranch !== undefined
              ? { default_branch: normalizeSetting(patch.defaultBranch) }
              : {}),
            ...(patch.defaultModel !== undefined
              ? { default_model: normalizeSetting(patch.defaultModel) }
              : {}),
            ...(patch.memory !== undefined ? { memory } : {}),
            updated_at: sql`now()`,
          }),
        )
        .returning(this.projectSettingsColumns)
        .executeTakeFirst();
      if (!row) {
        throw new Error('verity: updateProjectSettings RETURNING yielded no row — dialect bug');
      }
      return this.projectSettingsRowToRecord(row);
    });
  }

  /**
   * Append a note to a project's agent memory (ADR 0008), atomically. Used by the
   * memory broker when a session calls `verity-memory append`. Serializes concurrent
   * appends from sibling sessions of the same project (they share one per-project
   * capability) by locking the settings row FOR UPDATE inside a transaction, so a
   * naive read-modify-write cannot lose an append for a project that already has a
   * settings row. Returns the updated settings (sealed-safe, no decrypt), or
   * `undefined` when the project does not exist. Throws {@link ProjectMemoryTooLargeError}
   * when the append would exceed {@link PROJECT_MEMORY_MAX_CHARS} — the note is
   * rejected, not truncated.
   */
  async appendProjectMemory(
    projectId: string,
    text: string,
  ): Promise<ProjectSettingsRecord | undefined> {
    const project = await this.getProject(projectId);
    if (project === undefined) return undefined;
    const delta = text.trim();
    // A single note larger than the cap can be rejected before touching the DB.
    if (delta.length > PROJECT_MEMORY_MAX_CHARS) {
      throw new ProjectMemoryTooLargeError(delta.length, PROJECT_MEMORY_MAX_CHARS);
    }
    return this.db.transaction().execute(async (tx) => {
      // Ensure the settings row exists FIRST, in this transaction, so the
      // `FOR UPDATE` below always locks a committed row. `project_settings` rows
      // are created lazily, so without this two sibling sessions of a settings-less
      // project (they share one per-project capability) would both `SELECT … FOR
      // UPDATE` zero rows, lock nothing, and the second `INSERT … ON CONFLICT DO
      // UPDATE` would clobber the first append instead of concatenating. The
      // placeholder INSERT serializes them: the second blocks on the first's row
      // and then locks it. Also makes an empty-note no-op return the row (not
      // undefined) for an existing project.
      await tx
        .insertInto('project_settings')
        .values({ project_id: projectId })
        .onConflict((oc) => oc.column('project_id').doNothing())
        .execute();
      const existing = await tx
        .selectFrom('project_settings')
        .select(['memory'])
        .where('project_id', '=', projectId)
        .forUpdate()
        .executeTakeFirst();
      const current = existing?.memory ?? null;
      // Empty note → leave memory untouched (no-op append); otherwise concatenate.
      const next =
        delta.length === 0
          ? current
          : current !== null && current.length > 0
            ? `${current}\n${delta}`
            : delta;
      if (next !== null && next.length > PROJECT_MEMORY_MAX_CHARS) {
        throw new ProjectMemoryTooLargeError(next.length, PROJECT_MEMORY_MAX_CHARS);
      }
      const row = await tx
        .updateTable('project_settings')
        .set({ memory: next, updated_at: sql`now()` })
        .where('project_id', '=', projectId)
        .returning(this.projectSettingsColumns)
        .executeTakeFirst();
      if (!row) {
        throw new Error('verity: appendProjectMemory RETURNING yielded no row — dialect bug');
      }
      return this.projectSettingsRowToRecord(row, false);
    });
  }

  /**
   * Read the master-password key-derivation metadata (salt + verifier). Reads
   * NO encrypted column, so it works while the store is sealed — that's the
   * whole point: the unlock flow reads this to derive + verify the key.
   */
  async getSecretKeyMeta(): Promise<SecretKeyMetaRecord | undefined> {
    const row = await this.db
      .selectFrom('secret_key_meta')
      .select(['salt', 'verifier'])
      .where('id', '=', 'global')
      .executeTakeFirst();
    return row ? { salt: row.salt, verifier: row.verifier } : undefined;
  }

  /** Persist the salt + verifier when a master password is set (or changed). */
  async setSecretKeyMeta(meta: SecretKeyMetaRecord): Promise<void> {
    await this.db
      .insertInto('secret_key_meta')
      .values({ id: 'global', salt: meta.salt, verifier: meta.verifier })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          salt: meta.salt,
          verifier: meta.verifier,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }

  /**
   * Atomically persist the meta ONLY if none exists yet. Returns true when this
   * call inserted (won the first-run race), false when a row was already present.
   * Closes the TOCTOU in first-run `/secret/init`: concurrent inits derive under
   * different salts, but only the winner's meta lands and only it should unlock.
   */
  async insertSecretKeyMetaIfAbsent(meta: SecretKeyMetaRecord): Promise<boolean> {
    const res = await this.db
      .insertInto('secret_key_meta')
      .values({ id: 'global', salt: meta.salt, verifier: meta.verifier })
      .onConflict((oc) => oc.column('id').doNothing())
      .executeTakeFirst();
    return (res?.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  // ── Per-device API auth tokens (C1 auth gate) ─────────────────────────────
  // Stores only the SHA-256 hash of each token, no cipher envelope, so the auth
  // gate can validate a device while the store is still SEALED (same rationale
  // as secret_key_meta). The raw token is returned to the device exactly once.

  /** Persist a newly minted token (only its hash). */
  async insertAuthToken(record: {
    id: string;
    tokenHash: string;
    label?: string | null;
  }): Promise<void> {
    await this.db
      .insertInto('auth_tokens')
      .values({ id: record.id, token_hash: record.tokenHash, label: record.label ?? null })
      .execute();
  }

  /** Every token hash currently valid — loaded once to seed the gate's in-memory
   *  set (avoids a DB round-trip on the per-request hot path). */
  async listAuthTokenHashes(): Promise<string[]> {
    const rows = await this.db.selectFrom('auth_tokens').select('token_hash').execute();
    return rows.map((r) => r.token_hash);
  }

  /** Tokens as records (id + label + createdAt), newest first — for a future
   *  device-management view. Never exposes the token or its hash's usefulness. */
  async listAuthTokens(): Promise<AuthTokenRecord[]> {
    const rows = await this.db
      .selectFrom('auth_tokens')
      .select(['id', 'token_hash', 'label', 'created_at'])
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      tokenHash: r.token_hash,
      label: r.label,
      createdAt: new Date(r.created_at).getTime(),
    }));
  }

  /** Revoke a single device token by its public id. Returns true if a row went. */
  async deleteAuthToken(id: string): Promise<boolean> {
    const res = await this.db.deleteFrom('auth_tokens').where('id', '=', id).executeTakeFirst();
    return (res?.numDeletedRows ?? 0n) > 0n;
  }

  /** Revoke every device token (e.g. on GitHub disconnect / master-password
   *  change) — forces all devices to re-authenticate. */
  async deleteAllAuthTokens(): Promise<void> {
    await this.db.deleteFrom('auth_tokens').execute();
  }

  // ── Per-device Expo push tokens (ADR 0008, token registry) ────────────────

  /** Register or rotate the current Expo token for a paired device. An Expo
   * token can belong to only one pairing; moving it prunes the old binding. */
  async upsertDevicePushToken(record: {
    authTokenId: string;
    expoToken: string;
    platform: 'ios';
  }): Promise<void> {
    const mutation = this.pushTokenMutationTail.then(() =>
      this.db.transaction().execute(async (trx) => {
        // Registration is rare and this tiny table has two uniqueness axes
        // (device + Expo token). Serialize cross-process writers so two pairings
        // cannot both pass the DELETE then collide at INSERT. Reads/sends remain
        // unaffected by this lock mode.
        await sql`lock table device_push_tokens in share row exclusive mode`.execute(trx);
        await trx
          .deleteFrom('device_push_tokens')
          .where('expo_token', '=', record.expoToken)
          .where('auth_token_id', '!=', record.authTokenId)
          .execute();
        await trx
          .insertInto('device_push_tokens')
          .values({
            auth_token_id: record.authTokenId,
            expo_token: record.expoToken,
            platform: record.platform,
          })
          .onConflict((oc) =>
            oc.column('auth_token_id').doUpdateSet({
              expo_token: record.expoToken,
              platform: record.platform,
              updated_at: sql`now()`,
            }),
          )
          .execute();
      }),
    );
    // A failed write must not poison the queue for later registrations.
    this.pushTokenMutationTail = mutation.catch(() => undefined);
    await mutation;
  }

  async getDevicePushToken(authTokenId: string): Promise<DevicePushTokenRecord | undefined> {
    const row = await this.db
      .selectFrom('device_push_tokens')
      .selectAll()
      .where('auth_token_id', '=', authTokenId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          authTokenId: row.auth_token_id,
          expoToken: row.expo_token,
          platform: row.platform,
          createdAt: new Date(row.created_at).getTime(),
          updatedAt: new Date(row.updated_at).getTime(),
        };
  }

  async listDevicePushTokens(): Promise<DevicePushTokenRecord[]> {
    const rows = await this.db
      .selectFrom('device_push_tokens')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((row) => ({
      authTokenId: row.auth_token_id,
      expoToken: row.expo_token,
      platform: row.platform,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    }));
  }

  /** Remove a dead Expo token. Its pending receipt work cascades in the DB. */
  async deleteDevicePushToken(expoToken: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('device_push_tokens')
      .where('expo_token', '=', expoToken)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /** Persist a successful Expo ticket only while its token is still current.
   * The shared row lock closes a rotation race: a concurrent token delete waits
   * for this insert, then cascades the newly-created receipt row. */
  async enqueuePushReceipt(record: {
    receiptId: string;
    expoToken: string;
    availableAt: number;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const token = await trx
        .selectFrom('device_push_tokens')
        .select('expo_token')
        .where('expo_token', '=', record.expoToken)
        .forShare()
        .executeTakeFirst();
      if (token === undefined) return false;
      const result = await trx
        .insertInto('push_receipts')
        .values({
          receipt_id: record.receiptId,
          expo_token: record.expoToken,
          available_at: new Date(record.availableAt).toISOString(),
        })
        .onConflict((conflict) => conflict.column('receipt_id').doNothing())
        .executeTakeFirst();
      return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
    });
  }

  async listDuePushReceipts(now: number, limit = 1_000): Promise<PushReceiptRecord[]> {
    const rows = await this.db
      .selectFrom('push_receipts')
      .selectAll()
      .where('available_at', '<=', new Date(now))
      .orderBy('available_at', 'asc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      receiptId: row.receipt_id,
      expoToken: row.expo_token,
      availableAt: new Date(row.available_at).getTime(),
      attempts: row.attempts,
      createdAt: new Date(row.created_at).getTime(),
    }));
  }

  async reschedulePushReceipt(
    receiptId: string,
    availableAt: number,
    attempts: number,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('push_receipts')
      .set({ available_at: new Date(availableAt).toISOString(), attempts })
      .where('receipt_id', '=', receiptId)
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  async deletePushReceipt(receiptId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('push_receipts')
      .where('receipt_id', '=', receiptId)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }
}

function normalizeSetting(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
