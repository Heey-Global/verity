import {
  SessionBackendStateStore,
  type SessionBackendStateRecord,
} from './session-backend-state.js';
import {
  TurnRecordStore,
  type QueuedTurnRecord,
  type QueuedTurnInput,
  type RunningTurnRecord,
  type RunnerTurnOwnershipRequest,
  type RunnerTurnOwnership,
} from './turn-records.js';
export type {
  QueuedTurnRecord,
  QueuedTurnInput,
  RunningTurnRecord,
  RunnerTurnOwnershipRequest,
  RunnerTurnOwnership,
} from './turn-records.js';
import { SecretKeyMetadataStore, type SecretKeyMetaRecord } from './secret-key-metadata.js';
export type { SecretKeyMetaRecord } from './secret-key-metadata.js';
import { AuthTokenStore, type AuthTokenRecord } from './auth-tokens.js';
export type { AuthTokenRecord } from './auth-tokens.js';
import {
  ClaudeEgressIdentityStore,
  type ClaudeEgressCaRecord,
  type ClaudeEgressClientCertRecord,
} from './claude-egress-identity.js';
export type {
  ClaudeEgressCaRecord,
  ClaudeEgressClientCertRecord,
} from './claude-egress-identity.js';
import {
  HttpMcpConnectionStore,
  type HttpMcpConnectionRecord,
  type ProjectMcpBindingRecord,
} from './http-mcp-connections.js';
export {
  httpMcpConnectionUsableBy,
  type HttpMcpConnectionRecord,
  type ProjectMcpBindingRecord,
} from './http-mcp-connections.js';
import {
  DevicePushTokenStore,
  type DevicePushTokenRecord,
  type PushReceiptRecord,
} from './device-push-tokens.js';
export type { DevicePushTokenRecord, PushReceiptRecord } from './device-push-tokens.js';
import {
  PreviewShareStore,
  type LocalPreviewShareRecord,
  type PublicPreviewShareState,
  type PublicPreviewShareRecord,
  type PublicPreviewShareCreateInput,
} from './preview-shares.js';
export type {
  LocalPreviewShareRecord,
  PublicPreviewShareState,
  PublicPreviewShareRecord,
  PublicPreviewShareCreateInput,
} from './preview-shares.js';
import { AttachmentStore, type AttachmentBlob } from './attachments.js';
export type { AttachmentBlob } from './attachments.js';
import {
  EventWriteStore,
  type RunnerFrameIngest,
  type RunnerFrameIngestResult,
} from './event-writes.js';
export {
  RUNNER_FRAME_PROTOCOL_VERSION,
  type RunnerFrameIngest,
  type RunnerFrameIngestResult,
} from './event-writes.js';
import { SessionLifecycleStore } from './session-lifecycle.js';
import { sessionEventAppendLock, sessionEventAppendLockKey } from './session-event-lock.js';
export { DeletedProjectError } from './deleted-project-error.js';
import { ProjectAccessStore } from './project-access.js';
import { ProjectLifecycleStore } from './project-lifecycle.js';
import {
  projectRowToRecord,
  type ProjectState,
  type ProjectSetupState,
  type ProjectKind,
  type ProjectRecord,
  type ProjectReleaseStatus,
  type ProjectUpsertInput,
  defaultProjectName,
} from './project-record.js';
export {
  type ProjectState,
  type ProjectSetupState,
  type ProjectKind,
  LOCAL_PROJECT_OWNER,
  ProjectIdentityClaimConflict,
  isLocalProject,
  type ProjectRecord,
  type ProjectReleaseStatus,
  type ProjectUpsertInput,
  PROJECT_NAME_MAX_CHARS,
  defaultProjectName,
  InvalidProjectNameError,
} from './project-record.js';
import {
  storedMockupScreens,
  type SessionMockupReview,
  type SessionMockups,
  storedMockupState,
  mockupReview,
} from './session-mockups.js';
import { CapacityLeaseStore } from './capacity-leases.js';
import { readSessionProjectionActivity } from './session-projection-activity.js';
import {
  SessionLinkStore,
  type SessionLinkRecord,
  type SessionLinkReservation,
  type PendingSessionLinkMessage,
} from './session-links.js';
import { ProjectTeamStore, type ProjectPermission } from './project-team.js';
import {
  MessageProjectionStore,
  type MessageSearchInput,
  type MessageSearchResult,
  waitForPendingMessageProjections,
  waitForMessageProjectionWork,
  idChunks,
} from './message-projection.js';
export { waitForMessageProjectionWork, waitForPendingMessageProjections };
export type { MessageSearchInput, MessageSearchResult } from './message-projection.js';
import { SessionCoordinationStore } from './session-coordination.js';
import { ProjectInquiryStore } from './project-inquiries.js';
import { SandboxUpdateStateStore } from './sandbox-update-state.js';
import { SandboxRepairIntentStore } from './sandbox-repair-intents.js';
import { WikiMaintenanceStore, WikiOccasionStore } from './wiki-occasions.js';
import {
  egressDestinationDb,
  withEgressDestinationTransaction,
  type EgressDestinationMutation,
  unguardedEgressDestinationMutation,
} from './egress-destination-mutation.js';
import { UserContextStore } from './user-context.js';
import { UserProfileStore } from './user-profile.js';
import { UserGitIdentityStore } from './user-git-identity.js';
import { UserGithubAuthorizationStore } from './user-github-authorization.js';
import { UserDopplerConnectionStore } from './user-doppler-connection.js';
import { DopplerConnectionStore } from './doppler-connections.js';
import { ProjectDopplerBindingStore } from './project-doppler-bindings.js';
import { ProjectSandboxStore } from './project-sandboxes.js';
import { SessionMoveStore } from './session-moves.js';
import { UserProviderConnectionStore } from './user-provider-connections.js';
import {
  ProjectRepositoryStore,
  type AddProjectRepositoryInput,
  type SessionRepositoryWorkspaceRecord,
} from './project-repositories.js';
import { ViewStateStore } from './view-state.js';
import { AssistantStore } from './assistant.js';
import { SchedulingStore } from './scheduling.js';
import { QAAssignmentStore } from './qa-assignments.js';
import { RepairSupervisionStore } from './repair-supervision.js';
import { ProjectEgressStore } from './project-egress.js';
import { VulnerabilityScanStore } from './vulnerability-scan.js';
import { SessionPeopleStore } from './session-people.js';
import { ChangeSubmissionStore } from './change-submissions.js';
import { GitHubRepositoryIdentityStore } from './github-repository-identity.js';
import { ForgeConnectionStore } from './forge-connections.js';
import { CalendarWatchStore } from './calendar-watch.js';
import { GoogleAccountStore } from './google-accounts.js';
import {
  GoogleConnectionStore,
  type SessionGmailConnection,
  type SessionCalendarConnection,
  type SessionContactsConnection,
} from './google-connections.js';
export type {
  SessionGmailConnection,
  SessionCalendarConnection,
  SessionContactsConnection,
} from './google-connections.js';
import {
  HISTORY_MAX_BYTES,
  HISTORY_MAX_EVENTS,
  type BoundedHistoryPage,
  type BoundedHistoryResult,
} from '@verity/events';
import { randomUUID } from 'node:crypto';
import {
  type AgentEvent,
  SESSION_PROJECTION_EVENT_TYPES,
  type Usage,
  type UsageTotals,
  parseAgentEvent,
  parsePlanningProposal,
} from '@verity/events';
import { type Kysely, sql, type Transaction } from 'kysely';
import { type SecretCipher, createPassthroughCipher } from './crypto.js';
import {
  DevServerConfigStore,
  type DevServerRecord,
  type DevServerCreateInput,
  type DevServerPatch,
  type DevServerDetectionStateRecord,
} from './dev-server-configs.js';
export type {
  DevServerRecord,
  DevServerCreateInput,
  DevServerPatch,
  DevServerDetectionStateRecord,
} from './dev-server-configs.js';
export {
  DEV_SERVER_HOST_PORT_RANGES,
  DevServerPortRangeExhaustedError,
} from './dev-server-ports.js';
import { KnowledgeStore } from './knowledge.js';
import { IntegrationStore } from './integrations.js';
import { LiveMeetingStore } from './live-meetings.js';
import { ensureProjectKnowledgeSpace } from './knowledge-spaces.js';
import { scrubNulEscapes } from './nul-scrub.js';
import { redactSecrets } from './redact.js';
import {
  SessionAutomationStore,
  type SessionAutomationInput,
  type SessionAutomationOutcome,
  type SessionAutomationRecord,
  type SessionAutomationStatus,
} from './session-automations.js';
import type { Database } from './schema.js';
import { ManagedDevServerStore } from './managed-dev-servers.js';
import {
  ProjectSettingsStore,
  type ProjectSettingsRecord,
  type ProjectSettingsPatch,
} from './project-settings.js';
import {
  VeritySettingsStore,
  type VeritySettingsPatch,
  type VeritySettingsRecord,
} from './verity-settings.js';
export type { VeritySettingsPatch, VeritySettingsRecord } from './verity-settings.js';
export {
  PROJECT_AGENTS,
  PROJECT_MEMORY_MAX_CHARS,
  ProjectDefaultModelNotAllowedError,
  ProjectMemoryTooLargeError,
  type ProjectSettingsRecord,
  type ProjectSettingsPatch,
  type ProjectDesignLevel,
  type ProjectAgent,
} from './project-settings.js';
import { TaskStore } from './tasks.js';

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
  /** "Last seen" mark for the overview unread dot (#387): the session's `eventCount`
   *  at the last open. `null` = never opened → not unread. The store fills in the
   *  legacy shared column; the server replaces it with the requesting person's mark
   *  from {@link ViewStateStore} before it reaches a client. */
  lastSeenEventCount: number | null;
  /** Planning mode. Optional so records built outside the store need not state it;
   *  absent and `null` both mean the session never planned. */
  planning?: SessionPlanning | null;
  planningRevision?: number;
  planningPlan?: string | null;
  /** Mockups the agent presented for review. Absent when it never presented any. */
  mockupReview?: SessionMockupReview;
  /** Operator-marked favorite, highlighted in the session list. Global like the
   *  unread mark, so it syncs across devices. Absent means not a favorite. */
  favorite?: boolean;
}

/** `active`: turns run without permission to change files until the operator
 *  ends planning. `implemented` / `discarded`: how the last planning round ended,
 *  which tells the app whether the newest plan was carried out. */
export type SessionPlanning = 'active' | 'implemented' | 'discarded';

export type {
  SessionLinkRecord,
  SessionLinkReservation,
  PendingSessionLinkMessage,
} from './session-links.js';
export type GoogleWorkspaceFileKind = 'slides' | 'docs' | 'sheets';

export interface SessionWorkspaceFileRecord {
  accountEmail?: string | null;
  accountName?: string | null;
  accountId?: string | null;
  folderLinkId?: string | null;
  credentialVersion?: number | null;
  sessionId: string;
  assignmentId: string;
  kind: GoogleWorkspaceFileKind;
  fileId: string;
  name: string;
  webViewLink: string;
  revisionId: string | null;
  assignedAt: Date;
}

/** @deprecated Use SessionWorkspaceFileRecord. */
export type SessionSlideDeckRecord = SessionWorkspaceFileRecord;

export interface GoogleSlideImageCleanupRecord {
  accountId?: string | null;
  id: string;
  sessionId: string;
  fileId: string;
  permissionId: string | null;
  readyAt: Date | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
}

/** Input to {@link EventStore.createSession}: a {@link SessionRecord} whose
 * `name` is optional (a fresh session starts nameless unless the operator named
 * it at spawn). */
export type SessionInput = Omit<
  SessionRecord,
  'name' | 'projectId' | 'lastSeenEventCount' | 'planning'
> & {
  name?: string | null;
  projectId?: string | null;
  /** The person starting the session; its requests are theirs (ADR 0023). */
  createdByUserId?: string | null;
};

export type { SessionBackendStateRecord } from './session-backend-state.js';

export { isInstallationPlaceholder } from './installation-placeholders.js';

/** How one scheduled automation run settled: `ok` (its check script found
 * nothing to do), `acted` (a turn was dispatched), `skipped` (the session was
 * busy or the project unavailable), or `error`. */
export {
  SESSION_AUTOMATION_MAX_CONSECUTIVE_ERRORS,
  SessionAutomationWorkspaceChangedError,
  type SessionAutomationOutcome,
  type SessionAutomationStatus,
  type SessionAutomationRecord,
  type SessionAutomationInput,
} from './session-automations.js';

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
 * One token field of a `result` payload, summed across a group — see
 * {@link EventStore.readUsageTotals}.
 *
 * The field name is emitted as a LITERAL rather than a bind parameter. `->>`
 * takes `text` on the right, and a parameter arrives untyped, so Postgres
 * resolves the operator against `jsonb ->> integer` as readily as the text form
 * and answers with an array-index error on an object. The names come from
 * {@link Usage}'s own keys, so there is no value here to smuggle anything in.
 */
function usageSum(field: keyof Usage) {
  return sql<string>`sum(coalesce((payload -> 'usage' ->> ${sql.lit(field)})::bigint, 0))`;
}

/**
 * One event row as the projections consume it.
 *
 * Same contract as {@link EventStore.getEventsAfter}: a payload that does not
 * parse is a corrupted log, not a row to skip past. Events are validated on the
 * way IN, so a row that fails on the way out means the database no longer holds
 * what the server wrote, and a badge quietly rendered from the surviving rows
 * would hide it.
 */
function sequencedEvent(
  sessionId: string,
  id: string | number,
  payload: unknown,
  createdAt: Date,
): SequencedEvent {
  const parsed = parseAgentEvent(payload);
  if (!parsed.success) {
    throw new Error(`corrupt event payload in session ${sessionId}: ${parsed.error.message}`);
  }
  return { seq: Number(id), ts: createdAt.getTime(), event: parsed.data };
}

/** What a session with no `result` events has spent. */
function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    turns: 0,
  };
}

/**
 * What the overview projections need from one session's log — see
 * {@link EventStore.listSessionProjectionFacts}.
 */
export interface SessionEventStats {
  /** Nonempty agent-text events; used for unread state. */
  eventCount: number;
  lastEventSeq: number;
  lastActivityAt: number | null;
  /** Changes on every log mutation, including deletions below the latest seq. */
  revision: string;
}

export interface SessionProjectionFacts {
  /** Nonempty agent-text events; the overview unread counter. */
  eventCount: number;
  /** Highest event seq visible in the snapshot; bounds a later fallback read. */
  lastEventSeq: number;
  /** `created_at` of the newest event in epoch ms; null for an empty log. */
  lastActivityAt: number | null;
  /** Newest user prompt or top-level agent text; excludes technical events. */
  lastMessageAt: number | null;
  /** Ascending by seq, filtered to {@link SESSION_PROJECTION_EVENT_TYPES} — and
   *  bounded to the NEWEST `tailLimit` of them. Whether that is far enough back
   *  is a fact about the derivation the caller is running, not about this read,
   *  so the caller decides, using {@link eventsTruncated} to find out whether
   *  there is anything older to miss. */
  events: SequencedEvent[];
  /** Whether {@link events} hit its limit, i.e. older projected events exist. A
   *  tail short of the limit IS the whole slice, and nothing asked about it can
   *  be wrong. */
  eventsTruncated: boolean;
  /** The newest `rate_limit` event per provider/window/scope over the WHOLE log,
   *  in no particular order — the quota states a session is currently under.
   *
   *  Separate from {@link events} because a quota state is the last word until
   *  the provider sends another one: one observed hours ago, thousands of events
   *  back, is still the truth about the session, and a tail cannot see it. Same
   *  shape of problem as {@link EventStore.sessionHasTaskLifecycleEvent}. */
  rateLimitEvents: SequencedEvent[];
  /** Token totals over every `result` event in the log — summed in SQL, not
   *  folded out of {@link events}, which is why the slice is free to be a tail. */
  usage: UsageTotals;
}

export interface PlanningConsent {
  turnId: string;
  promptSeq: number;
  runningPromptSeq: number;
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
  appendEvent(
    sessionId: string,
    event: AgentEvent,
  ): Promise<{ seq: number; ts: number; existing?: true }>;
  createSession(session: SessionInput): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
}

/**
 * The durable source of truth (concept §5a). Wraps the append-only Postgres
 * event log. Every event is validated against the canonical contract before it
 * is persisted and again when it is read back, so the log can never hold — or
 * hand out — an event that violates the schema.
 */
export class EventStore implements EventSink {
  listProjectRepositories(projectId: string, options: { includeRemoved?: boolean } = {}) {
    return new ProjectRepositoryStore(this.db, (id) => this.getProject(id)).list(
      projectId,
      options,
    );
  }

  getProjectRepository(projectId: string, repositoryId?: string) {
    return new ProjectRepositoryStore(this.db, (id) => this.getProject(id)).get(
      projectId,
      repositoryId,
    );
  }

  addProjectRepository(input: AddProjectRepositoryInput) {
    return new ProjectRepositoryStore(this.db, (id) => this.getProject(id)).add(input);
  }

  removeProjectRepository(projectId: string, repositoryId: string) {
    return new ProjectRepositoryStore(this.db, (id) => this.getProject(id)).remove(
      projectId,
      repositoryId,
    );
  }

  recordRepositoryPullRequest(...args: Parameters<ProjectRepositoryStore['recordPullRequest']>) {
    return new ProjectRepositoryStore(this.db, (id) => this.getProject(id)).recordPullRequest(
      ...args,
    );
  }

  sessionRepositoryWorkspaceSessionId(worktree: string) {
    return new ProjectRepositoryStore(this.db, (id) => this.getProject(id)).workspaceSessionId(
      worktree,
    );
  }

  listSessionRepositoryWorkspaces(sessionId: string) {
    return new ProjectRepositoryStore(this.db, (id) => this.getProject(id)).listWorkspaces(
      sessionId,
    );
  }

  upsertSessionRepositoryWorkspace(input: Omit<SessionRepositoryWorkspaceRecord, 'createdAt'>) {
    return new ProjectRepositoryStore(this.db, (id) => this.getProject(id)).upsertWorkspace(input);
  }

  private egressDestinationMutation: EgressDestinationMutation = unguardedEgressDestinationMutation;

  /** Installed before request handlers; every destination store shares this barrier. */
  setEgressDestinationMutation(barrier: EgressDestinationMutation): void {
    this.egressDestinationMutation = barrier;
  }

  /** Plain endpoint metadata only; usable while credentials are sealed. */
  async readEgressDestinationUrls(): Promise<string[]> {
    const [settings, mcp, forge, matrix, accounts] = await Promise.all([
      this.veritySettings.readEgressDestinations(),
      this.db
        .selectFrom('http_mcp_connections')
        .select(['url', 'oauth_authorization_endpoint', 'oauth_token_endpoint'])
        .execute(),
      this.db.selectFrom('forge_connections').select('base_url').execute(),
      this.db.selectFrom('matrix_connector_config').select('endpoint').execute(),
      this.db.selectFrom('integration_accounts').select('endpoint').execute(),
    ]);
    return [
      settings?.opencode_base_url,
      settings?.transcribe_base_url,
      ...mcp.flatMap((row) => [
        row.url,
        row.oauth_authorization_endpoint,
        row.oauth_token_endpoint,
      ]),
      ...forge.map((row) => row.base_url),
      ...matrix.map((row) => row.endpoint),
      ...accounts.map((row) => row.endpoint),
    ].filter((url): url is string => typeof url === 'string' && url.trim().length > 0);
  }

  private get db(): Kysely<Database> {
    return egressDestinationDb(this.rootDb);
  }

  withEgressDestinationTransaction<T>(action: () => Promise<T>): Promise<T> {
    return withEgressDestinationTransaction(this.rootDb, action);
  }

  private readonly backupRevocationListeners = new Set<() => Promise<void>>();

  /** Wake destination synchronization after commit; the DB outbox remains the durable authority. */
  subscribeBackupRevocations(listener: () => Promise<void>): () => void {
    this.backupRevocationListeners.add(listener);
    return () => {
      this.backupRevocationListeners.delete(listener);
    };
  }

  private async notifyBackupRevocations(): Promise<void> {
    // A destination outage must not undo or misreport an already committed token deletion.
    await Promise.allSettled(
      [...this.backupRevocationListeners].map((listener) => Promise.resolve().then(listener)),
    );
  }

  private readonly secretKeyMetadata = new SecretKeyMetadataStore(() => this.db);
  private readonly authTokens = new AuthTokenStore(
    () => this.db,
    () => this.notifyBackupRevocations(),
  );
  private readonly claudeEgressIdentity: ClaudeEgressIdentityStore;
  private readonly httpMcpConnections = new HttpMcpConnectionStore(
    () => this.db,
    (value) => this.encryptSecret(value),
    (value) => this.decryptSecret(value),
    (action) => this.egressDestinationMutation(action),
  );
  private readonly devicePushTokens = new DevicePushTokenStore(() => this.db);
  private readonly previewShares = new PreviewShareStore(
    () => this.db,
    (value) => this.encryptSecret(value),
    (value) => this.decryptSecret(value),
  );
  private readonly devServerConfigs = new DevServerConfigStore(() => this.db);
  private readonly sessionBackendState = new SessionBackendStateStore(() => this.db);
  private readonly turnRecords = new TurnRecordStore(
    () => this.db,
    (id) => this.isSessionDeleting(id),
  );
  private readonly messageProjection = new MessageProjectionStore(
    () => this.db,
    () => this.listSessions(),
    () => this.scheduleMessageProjection(),
  );
  private get attachments(): AttachmentStore {
    return new AttachmentStore(this.db);
  }

  private eventWriteStore: EventWriteStore | undefined;
  private get eventWrites(): EventWriteStore {
    return (this.eventWriteStore ??= new EventWriteStore({
      currentDb: () => this.db,
      isSessionDeleting: (id) => this.isSessionDeleting(id),
      externalizeToolResult: (event) => this.externalizeToolResult(event),
      enqueuePersistedMessageEvent: (id, seq, at, event) =>
        this.enqueuePersistedMessageEvent(id, seq, at, event),
      scheduleMessageProjection: () => this.scheduleMessageProjection(),
    }));
  }

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
    return this.eventWrites.withSessionEventAppend(sessionId, run);
  }

  private enqueuePersistedMessageEvent(
    sessionId: string,
    seq: number,
    createdAt: Date,
    event: AgentEvent,
  ): void {
    return this.messageProjection.enqueuePersistedMessageEvent(sessionId, seq, createdAt, event);
  }

  /** @param cipher Encrypts secret columns at the DB boundary (ADR 0002 D3).
   * Defaults to plaintext for tests and un-keyed deployments; production passes
   * a cipher whose key is derived from the master password. */
  constructor(
    private readonly rootDb: Kysely<Database>,
    private readonly cipher: SecretCipher = createPassthroughCipher(),
  ) {
    const db = rootDb;
    this.claudeEgressIdentity = new ClaudeEgressIdentityStore(() => this.db, cipher);
    this.veritySettings = new VeritySettingsStore(
      () => this.db,
      cipher,
      (action) => this.egressDestinationMutation(action),
      (token, transaction) => this.dopplerConnections.setLegacyToken(token, transaction),
    );
    this.sessionAutomations = new SessionAutomationStore(db);
    this.projectSettings = new ProjectSettingsStore(db, cipher, (id) => this.getProject(id));
    this.sessionLinks = new SessionLinkStore(db);
    this.capacityLeases = new CapacityLeaseStore(db);
    this.userContext = new UserContextStore(db);
    this.userProfiles = new UserProfileStore(db);
    this.viewState = new ViewStateStore(db);
    this.projectEgress = new ProjectEgressStore(db);
    this.knowledge = new KnowledgeStore(db);
    this.integrations = new IntegrationStore(db, cipher, (action, changesDestinations) =>
      this.egressDestinationMutation(action, changesDestinations),
    );
    this.liveMeetings = new LiveMeetingStore(db, cipher);
    this.managedDevServers = new ManagedDevServerStore(db);
    this.vulnerabilityScans = new VulnerabilityScanStore(db);
    this.tasks = new TaskStore(db, cipher);
    this.repairs = new RepairSupervisionStore(db);
    this.qaAssignments = new QAAssignmentStore(db);
    this.assistant = new AssistantStore(db);
    this.projectInquiries = new ProjectInquiryStore(db);
    this.sessionCoordination = new SessionCoordinationStore(db);
    this.wikiOccasions = new WikiOccasionStore(db);
    this.wikiMaintenance = new WikiMaintenanceStore(db);
    this.sandboxUpdateState = new SandboxUpdateStateStore(db);
    this.sandboxRepairIntents = new SandboxRepairIntentStore(db);
    this.scheduling = new SchedulingStore(db, cipher);
    this.sessionPeople = new SessionPeopleStore(db);
    this.changeSubmissions = new ChangeSubmissionStore(db);
    this.githubRepositories = new GitHubRepositoryIdentityStore(db);
  }

  private readonly sessionAutomations: SessionAutomationStore;
  private readonly veritySettings: VeritySettingsStore;
  private readonly projectSettings: ProjectSettingsStore;
  private readonly sessionLinks: SessionLinkStore;
  readonly capacityLeases: CapacityLeaseStore;
  readonly userContext: UserContextStore;
  readonly userProfiles: UserProfileStore;
  /** Per-person overview state: folded projects, read sessions, dismissed Home items. */
  readonly viewState: ViewStateStore;
  readonly projectEgress: ProjectEgressStore;
  readonly knowledge: KnowledgeStore;
  readonly integrations: IntegrationStore;
  readonly liveMeetings: LiveMeetingStore;
  readonly tasks: TaskStore;
  readonly repairs: RepairSupervisionStore;
  readonly qaAssignments: QAAssignmentStore;
  readonly assistant: AssistantStore;
  readonly projectInquiries: ProjectInquiryStore;
  readonly sessionCoordination: SessionCoordinationStore;
  /** What a project's Wiki may need to reflect, until a maintenance run read it. */
  readonly wikiOccasions: WikiOccasionStore;
  readonly wikiMaintenance: WikiMaintenanceStore;
  /** Automatic Sandbox repairs still owed after a failed recreate. */
  readonly sandboxUpdateState: SandboxUpdateStateStore;
  readonly sandboxRepairIntents: SandboxRepairIntentStore;
  readonly scheduling: SchedulingStore;
  readonly managedDevServers: ManagedDevServerStore;
  readonly vulnerabilityScans: VulnerabilityScanStore;
  /** Who started each session, for addressing its requests. */
  readonly sessionPeople: SessionPeopleStore;
  /** Session changes members without Code submitted for review. */
  readonly changeSubmissions: ChangeSubmissionStore;
  readonly githubRepositories: GitHubRepositoryIdentityStore;

  async getAttendeeState<T>(id: string): Promise<T | undefined> {
    const result = await sql<{
      state_secret: string;
    }>`select state_secret from attendee_state where id = ${id}`.execute(this.db);
    const row = result.rows[0];
    return row ? (JSON.parse(this.cipher.decrypt(row.state_secret)) as T) : undefined;
  }

  async putAttendeeState(id: string, state: unknown): Promise<void> {
    const encrypted = this.cipher.encrypt(JSON.stringify(state));
    await sql`insert into attendee_state (id, state_secret) values (${id}, ${encrypted}) on conflict (id) do update set state_secret = excluded.state_secret`.execute(
      this.db,
    );
  }

  async listAttendeeState<T>(): Promise<Array<{ id: string; state: T }>> {
    const result = await sql<{
      id: string;
      state_secret: string;
    }>`select id, state_secret from attendee_state where id <> 'config'`.execute(this.db);
    return result.rows.map((row) => ({
      id: row.id,
      state: JSON.parse(this.cipher.decrypt(row.state_secret)) as T,
    }));
  }

  async deleteAttendeeState(id: string): Promise<void> {
    await sql`delete from attendee_state where id = ${id}`.execute(this.db);
  }

  async createSessionLink(leftId: string, rightId: string, requestId?: string): Promise<boolean> {
    return this.sessionLinks.createSessionLink(leftId, rightId, requestId);
  }

  async deleteSessionLink(leftId: string, rightId: string): Promise<boolean> {
    return this.sessionLinks.deleteSessionLink(leftId, rightId);
  }

  async linkedSessionIds(): Promise<Set<string>> {
    return this.sessionLinks.linkedSessionIds();
  }

  async listSessionLinks(sessionId: string): Promise<SessionLinkRecord[]> {
    return this.sessionLinks.listSessionLinks(sessionId);
  }

  async sessionLinkHasAllowance(sourceId: string, targetId: string): Promise<boolean> {
    return this.sessionLinks.sessionLinkHasAllowance(sourceId, targetId);
  }

  async sessionLinkHasDelivery(
    sourceId: string,
    targetId: string,
    invocationId: string,
  ): Promise<boolean> {
    return this.sessionLinks.sessionLinkHasDelivery(sourceId, targetId, invocationId);
  }

  async createPendingSessionLinkMessage(input: {
    id: string;
    invocationId: string;
    sourceSessionId: string;
    targetSessionId: string;
    sourceProjectId: string;
    requestMac: string;
    macKeyId: string;
    message: string;
  }): Promise<boolean> {
    return this.sessionLinks.createPendingSessionLinkMessage(input);
  }

  async listPendingSessionLinkMessages(
    sourceSessionId: string,
  ): Promise<PendingSessionLinkMessage[]> {
    return this.sessionLinks.listPendingSessionLinkMessages(sourceSessionId);
  }

  async pendingSessionLinkMessageIds(
    sessionIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    return this.sessionLinks.pendingSessionLinkMessageIds(sessionIds);
  }

  async getPendingSessionLinkMessage(
    sourceSessionId: string,
    id: string,
  ): Promise<PendingSessionLinkMessage | undefined> {
    return this.sessionLinks.getPendingSessionLinkMessage(sourceSessionId, id);
  }

  async approvePendingSessionLinkMessage(sourceSessionId: string, id: string): Promise<boolean> {
    return this.sessionLinks.approvePendingSessionLinkMessage(sourceSessionId, id);
  }

  async deletePendingSessionLinkMessage(sourceSessionId: string, id: string): Promise<boolean> {
    return this.sessionLinks.deletePendingSessionLinkMessage(sourceSessionId, id);
  }

  async reserveSessionLinkMessage(
    sourceId: string,
    targetId: string,
    invocationId: string,
    approvedRenewal: boolean,
    deliver?: () => Promise<void>,
  ): Promise<SessionLinkReservation> {
    return this.sessionLinks.reserveSessionLinkMessage(
      sourceId,
      targetId,
      invocationId,
      approvedRenewal,
      deliver,
    );
  }

  /** Encrypt a normalized secret value for storage (null stays null). */
  private encryptSecret(value: string | null): string | null {
    return value === null ? null : this.cipher.encrypt(value);
  }

  /** Decrypt a stored secret value on read (null stays null; plaintext passes
   *  through untouched for rows written before encryption was enabled). */
  private decryptSecret(value: string | null): string | null {
    return value === null ? null : this.cipher.decrypt(value);
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
    return this.sessionLifecycle.createSession(session);
  }

  /** The immutable model choice of the newest ordinary session in a scope.
   * Legacy rows written before `initial_model` existed fall back to their current
   * model. Used only to seed a subsequent session; runtime model switches never
   * rewrite the remembered creation choice. */
  async getLastCreatedSessionModel(projectId: string | null): Promise<string | undefined> {
    let query = this.db.selectFrom('sessions').select(['initial_model', 'model']);
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
        'last_seen_event_count',
        'planning',
        'planning_revision',
        'planning_plan',
        'mockup_review',
        'mockup_revision',
        'mockup_screens',
        'favorite',
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
      lastSeenEventCount: row.last_seen_event_count,
      ...(row.planning !== null ? { planning: row.planning } : {}),
      planningRevision: row.planning_revision,
      planningPlan: row.planning_plan,
      ...mockupReview(row.mockup_review, row.mockup_revision, row.mockup_screens),
      ...(row.favorite ? { favorite: true } : {}),
    };
  }

  async getSessionWorkspaceFile(
    sessionId: string,
  ): Promise<SessionWorkspaceFileRecord | undefined> {
    const row = await this.db
      .selectFrom('session_slide_decks')
      .selectAll()
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const account = row.account_id ? await this.googleAccounts.get(row.account_id) : undefined;
    return {
      accountEmail: account?.email ?? null,
      accountName: account?.displayName ?? null,
      accountId: row.account_id,
      folderLinkId: row.folder_link_id,
      credentialVersion: account?.credentialVersion ?? null,
      sessionId: row.session_id,
      assignmentId: row.assignment_id,
      kind: row.kind,
      fileId: row.file_id,
      name: row.name,
      webViewLink: row.web_view_link,
      revisionId: row.revision_id,
      assignedAt: row.assigned_at,
    };
  }

  async getSessionSlideDeck(sessionId: string): Promise<SessionSlideDeckRecord | undefined> {
    const file = await this.getSessionWorkspaceFile(sessionId);
    return file?.kind === 'slides' ? file : undefined;
  }

  async setSessionWorkspaceFile(input: {
    accountId?: string | null;
    folderLinkId?: string | null;
    sessionId: string;
    kind: GoogleWorkspaceFileKind;
    fileId: string;
    name: string;
    webViewLink: string;
    revisionId?: string | null;
  }): Promise<SessionWorkspaceFileRecord> {
    const row = await this.db.transaction().execute(async (trx) => {
      const assigned = await trx
        .insertInto('session_slide_decks')
        .values({
          account_id: input.accountId ?? null,
          folder_link_id: input.folderLinkId ?? null,
          session_id: input.sessionId,
          assignment_id: randomUUID(),
          kind: input.kind,
          file_id: input.fileId,
          name: input.name,
          web_view_link: input.webViewLink,
          revision_id: input.revisionId ?? null,
        })
        .onConflict((conflict) =>
          conflict.column('session_id').doUpdateSet({
            account_id: input.accountId ?? null,
            folder_link_id: input.folderLinkId ?? null,
            assignment_id: randomUUID(),
            kind: input.kind,
            file_id: input.fileId,
            name: input.name,
            web_view_link: input.webViewLink,
            revision_id: input.revisionId ?? null,
            assigned_at: sql`now()`,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      if (input.accountId)
        await trx
          .insertInto('google_workspace_recents')
          .values({
            account_id: input.accountId,
            file_id: input.fileId,
            kind: input.kind,
          })
          .onConflict((conflict) =>
            conflict
              .columns(['account_id', 'file_id'])
              .doUpdateSet({ kind: input.kind, last_assigned_at: sql`now()` }),
          )
          .execute();
      await trx
        .insertInto('recent_google_slide_decks')
        .values({ file_id: input.fileId, kind: input.kind, account_id: input.accountId ?? null })
        .onConflict((conflict) =>
          conflict
            .column('file_id')
            .doUpdateSet({ kind: input.kind, last_assigned_at: sql`now()` }),
        )
        .execute();
      return assigned;
    });
    return {
      accountId: row.account_id,
      folderLinkId: row.folder_link_id,
      sessionId: row.session_id,
      assignmentId: row.assignment_id,
      kind: row.kind,
      fileId: row.file_id,
      name: row.name,
      webViewLink: row.web_view_link,
      revisionId: row.revision_id,
      assignedAt: row.assigned_at,
    };
  }

  async setSessionSlideDeck(
    input: Omit<Parameters<EventStore['setSessionWorkspaceFile']>[0], 'kind'>,
  ): Promise<SessionSlideDeckRecord> {
    return this.setSessionWorkspaceFile({ ...input, kind: 'slides' });
  }

  async clearSessionWorkspaceFile(sessionId: string): Promise<void> {
    await this.db.deleteFrom('session_slide_decks').where('session_id', '=', sessionId).execute();
  }

  async clearSessionSlideDeck(sessionId: string): Promise<void> {
    await this.db
      .deleteFrom('session_slide_decks')
      .where('session_id', '=', sessionId)
      .where('kind', '=', 'slides')
      .execute();
  }

  get forgeConnections(): ForgeConnectionStore {
    return new ForgeConnectionStore(this.db, this.cipher, (action) =>
      this.egressDestinationMutation(action),
    );
  }

  get userProviderConnections(): UserProviderConnectionStore {
    return new UserProviderConnectionStore(this.db, this.cipher);
  }

  private get projectAccess(): ProjectAccessStore {
    return new ProjectAccessStore(this.db);
  }

  get projectTeam(): ProjectTeamStore {
    return new ProjectTeamStore(this.db, this.cipher);
  }

  get projectSandboxes(): ProjectSandboxStore {
    return new ProjectSandboxStore(this.db);
  }

  get userDopplerConnections(): UserDopplerConnectionStore {
    return new UserDopplerConnectionStore(this.db, this.cipher);
  }

  get dopplerConnections(): DopplerConnectionStore {
    return new DopplerConnectionStore(this.db, this.cipher);
  }

  get projectDopplerBindings(): ProjectDopplerBindingStore {
    return new ProjectDopplerBindingStore(this.db);
  }

  get userGithubAuthorizations(): UserGithubAuthorizationStore {
    return new UserGithubAuthorizationStore(this.db, this.cipher);
  }

  get userGitIdentities(): UserGitIdentityStore {
    return new UserGitIdentityStore(this.db, this.cipher);
  }

  get googleAccounts(): GoogleAccountStore {
    return new GoogleAccountStore(this.db, this.cipher);
  }

  private get googleConnections(): GoogleConnectionStore {
    return new GoogleConnectionStore(
      () => this.db,
      () => this.googleAccounts,
      (sessionId) => this.getSession(sessionId),
      (projectId, service) => this.getProjectGoogleConnection(projectId, service),
    );
  }

  private get projectLifecycle(): ProjectLifecycleStore {
    return new ProjectLifecycleStore(
      () => this.db,
      (id) => this.getProject(id),
    );
  }

  get calendarWatch(): CalendarWatchStore {
    return new CalendarWatchStore(this.db, this.cipher);
  }

  /** Credentials for the Google account `userId` uses in this session; none for
   *  anyone else's account and none without a person (ADR 0023 §3). */
  async getGoogleServiceCredentials(
    sessionId: string,
    service: 'gmail' | 'calendar' | 'contacts',
    userId: string | undefined,
  ) {
    return this.googleConnections.getGoogleServiceCredentials(sessionId, service, userId);
  }

  async countLegacyProjectGoogleSessions(
    projectId: string,
    service: 'gmail' | 'calendar' | 'contacts',
  ): Promise<number> {
    return this.googleConnections.countLegacyProjectGoogleSessions(projectId, service);
  }

  async getProjectGoogleConnection(projectId: string, service: 'gmail' | 'calendar' | 'contacts') {
    return this.googleConnections.getProjectGoogleConnection(projectId, service);
  }

  async enableProjectGoogleConnection(
    projectId: string,
    service: 'gmail' | 'calendar' | 'contacts',
    accountEmail: string,
    userId: string,
  ): Promise<void> {
    return this.googleConnections.enableProjectGoogleConnection(
      projectId,
      service,
      accountEmail,
      userId,
    );
  }

  async disableProjectGoogleConnection(
    projectId: string,
    service: 'gmail' | 'calendar' | 'contacts',
    userId: string,
  ): Promise<void> {
    return this.googleConnections.disableProjectGoogleConnection(projectId, service, userId);
  }

  async getSessionGmailConnection(
    sessionId: string,
    userId: string | undefined,
  ): Promise<SessionGmailConnection | undefined> {
    return this.googleConnections.getSessionGmailConnection(sessionId, userId);
  }

  async enableSessionGmail(
    sessionId: string,
    accountEmail: string,
    userId: string,
  ): Promise<SessionGmailConnection> {
    return this.googleConnections.enableSessionGmail(sessionId, accountEmail, userId, (id, owner) =>
      this.getSessionGmailConnection(id, owner),
    );
  }

  async disableSessionGmail(sessionId: string): Promise<void> {
    return this.googleConnections.disableSessionGmail(sessionId);
  }

  async clearSessionGmailConnections(): Promise<void> {
    return this.googleConnections.clearSessionGmailConnections();
  }

  async getSessionCalendarConnection(
    sessionId: string,
    userId: string | undefined,
  ): Promise<SessionCalendarConnection | undefined> {
    return this.googleConnections.getSessionCalendarConnection(sessionId, userId);
  }

  async enableSessionCalendar(
    sessionId: string,
    accountEmail: string,
    userId: string,
  ): Promise<SessionCalendarConnection> {
    return this.googleConnections.enableSessionCalendar(
      sessionId,
      accountEmail,
      userId,
      (id, owner) => this.getSessionCalendarConnection(id, owner),
    );
  }

  async disableSessionCalendar(sessionId: string): Promise<void> {
    return this.googleConnections.disableSessionCalendar(sessionId);
  }

  async clearSessionCalendarConnections(): Promise<void> {
    return this.googleConnections.clearSessionCalendarConnections();
  }

  async getSessionContactsConnection(
    sessionId: string,
    userId: string | undefined,
  ): Promise<SessionContactsConnection | undefined> {
    return this.googleConnections.getSessionContactsConnection(sessionId, userId);
  }

  async enableSessionContacts(
    sessionId: string,
    accountEmail: string,
    userId: string,
  ): Promise<SessionContactsConnection> {
    return this.googleConnections.enableSessionContacts(
      sessionId,
      accountEmail,
      userId,
      (id, owner) => this.getSessionContactsConnection(id, owner),
    );
  }

  async disableSessionContacts(sessionId: string): Promise<void> {
    return this.googleConnections.disableSessionContacts(sessionId);
  }

  async clearSessionContactsConnections(): Promise<void> {
    return this.googleConnections.clearSessionContactsConnections();
  }

  /** Persist an observed revision only while the same deck is still assigned.
   * A clear or replacement racing an API call must never be undone by its stale response. */
  async updateSessionWorkspaceRevision(
    sessionId: string,
    assignmentId: string,
    revisionId: string,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('session_slide_decks')
      .set({ revision_id: revisionId })
      .where('session_id', '=', sessionId)
      .where('assignment_id', '=', assignmentId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async updateSessionSlideDeckRevision(
    sessionId: string,
    assignmentId: string,
    revisionId: string,
  ): Promise<boolean> {
    return this.updateSessionWorkspaceRevision(sessionId, assignmentId, revisionId);
  }

  async listRecentGoogleWorkspaceFileIds(limit = 8, accountId?: string): Promise<string[]> {
    if (accountId) {
      const rows = await this.db
        .selectFrom('google_workspace_recents')
        .select('file_id')
        .where('account_id', '=', accountId)
        .orderBy('last_assigned_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map((row) => row.file_id);
    }
    const rows = await this.db
      .selectFrom('recent_google_slide_decks')
      .select('file_id')
      .$if(accountId !== undefined, (query) => query.where('account_id', '=', accountId!))
      .orderBy('last_assigned_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => row.file_id);
  }

  async listRecentGoogleSlideDeckFileIds(limit = 8, accountId?: string): Promise<string[]> {
    if (accountId) {
      const rows = await this.db
        .selectFrom('google_workspace_recents')
        .select('file_id')
        .where('account_id', '=', accountId)
        .where('kind', '=', 'slides')
        .orderBy('last_assigned_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map((row) => row.file_id);
    }
    const rows = await this.db
      .selectFrom('recent_google_slide_decks')
      .select('file_id')
      .where('kind', '=', 'slides')
      .$if(accountId !== undefined, (query) => query.where('account_id', '=', accountId!))
      .orderBy('last_assigned_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => row.file_id);
  }

  async createGoogleSlideImageCleanup(input: {
    accountId?: string | null;
    id: string;
    sessionId: string;
    fileId: string;
  }): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      if (input.accountId != null) {
        // Keep account removal behind the cleanup record that retains its credentials.
        await tx
          .selectFrom('google_accounts')
          .select('id')
          .where('id', '=', input.accountId)
          .forUpdate()
          .executeTakeFirstOrThrow();
      }
      await tx
        .insertInto('google_slide_image_cleanup')
        .values({
          id: input.id,
          session_id: input.sessionId,
          file_id: input.fileId,
          account_id: input.accountId ?? null,
        })
        .execute();
    });
  }

  async setGoogleSlideImageCleanupPermission(id: string, permissionId: string): Promise<void> {
    await this.db
      .updateTable('google_slide_image_cleanup')
      .set({ permission_id: permissionId })
      .where('id', '=', id)
      .execute();
  }

  async markGoogleSlideImageCleanupReady(id: string): Promise<void> {
    await this.db
      .updateTable('google_slide_image_cleanup')
      .set({ ready_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  async failGoogleSlideImageCleanup(id: string, error: string): Promise<void> {
    await this.db
      .updateTable('google_slide_image_cleanup')
      .set({ attempts: sql`attempts + 1`, last_error: error.slice(0, 200) })
      .where('id', '=', id)
      .execute();
  }

  async completeGoogleSlideImageCleanup(id: string): Promise<void> {
    await this.db.deleteFrom('google_slide_image_cleanup').where('id', '=', id).execute();
  }

  async listGoogleSlideImageCleanups(limit = 100): Promise<GoogleSlideImageCleanupRecord[]> {
    const rows = await this.db
      .selectFrom('google_slide_image_cleanup')
      .selectAll()
      // A live insertion owns a fresh row. Explicitly finished rows are ready
      // immediately; an old unmarked row means the process died before finally.
      .where((eb) =>
        eb.or([
          eb('ready_at', 'is not', null),
          eb('created_at', '<', sql<Date>`now() - interval '10 minutes'`),
        ]),
      )
      .orderBy('created_at', 'asc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      accountId: row.account_id,
      id: row.id,
      sessionId: row.session_id,
      fileId: row.file_id,
      permissionId: row.permission_id,
      readyAt: row.ready_at,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
    }));
  }

  async claimGoogleSlideInvocation(input: {
    invocationId: string;
    sessionId: string;
    turnId: string;
  }): Promise<{ status: 'claimed' | 'pending' } | { status: 'completed'; result: unknown }> {
    const inserted = await this.db
      .insertInto('google_slide_invocations')
      .values({
        invocation_id: input.invocationId,
        session_id: input.sessionId,
        turn_id: input.turnId,
      })
      .onConflict((conflict) => conflict.column('invocation_id').doNothing())
      .returning('invocation_id')
      .executeTakeFirst();
    if (inserted !== undefined) return { status: 'claimed' };
    const existing = await this.db
      .selectFrom('google_slide_invocations')
      .select(['session_id', 'turn_id', 'result_json'])
      .where('invocation_id', '=', input.invocationId)
      .executeTakeFirstOrThrow();
    if (existing.session_id !== input.sessionId || existing.turn_id !== input.turnId) {
      throw new Error('Google Slides invocation id was reused across turns');
    }
    if (existing.result_json === null) return { status: 'pending' };
    return { status: 'completed', result: JSON.parse(existing.result_json) as unknown };
  }

  async completeGoogleSlideInvocation(invocationId: string, result: unknown): Promise<void> {
    const resultJson = JSON.stringify(result);
    if (resultJson === undefined) throw new Error('Google Slides invocation result is not JSON');
    await this.db
      .updateTable('google_slide_invocations')
      .set({ result_json: resultJson })
      .where('invocation_id', '=', invocationId)
      .execute();
  }

  async claimGoogleWorkspaceInvocation(
    input: Parameters<EventStore['claimGoogleSlideInvocation']>[0],
  ): ReturnType<EventStore['claimGoogleSlideInvocation']> {
    return this.claimGoogleSlideInvocation(input);
  }

  async getCompletedGoogleWorkspaceInvocation(input: {
    invocationId: string;
    sessionId: string;
    turnId: string;
  }): Promise<{ result: unknown } | undefined> {
    const row = await this.db
      .selectFrom('google_slide_invocations')
      .select(['session_id', 'turn_id', 'result_json'])
      .where('invocation_id', '=', input.invocationId)
      .executeTakeFirst();
    if (!row) return undefined;
    if (row.session_id !== input.sessionId || row.turn_id !== input.turnId)
      throw new Error('Google Workspace invocation id was reused across turns');
    return row.result_json === null
      ? undefined
      : { result: JSON.parse(row.result_json) as unknown };
  }

  async completeGoogleWorkspaceInvocation(invocationId: string, result: unknown): Promise<void> {
    await this.completeGoogleSlideInvocation(invocationId, result);
  }

  async pruneGoogleSlideInvocations(olderThan: Date): Promise<void> {
    await this.db
      .deleteFrom('google_slide_invocations')
      .where('created_at', '<', olderThan)
      // The bearer that can replay this id exists only while its turn marker
      // exists. Keep the result for that entire lifetime, however old it gets.
      .where(
        sql<boolean>`not exists (
          select 1 from running_turns
          where running_turns.session_id = google_slide_invocations.session_id
            and running_turns.turn_id = google_slide_invocations.turn_id
        )`,
      )
      .execute();
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
        'last_seen_event_count',
        'planning',
        'planning_revision',
        'planning_plan',
        'mockup_review',
        'mockup_revision',
        'mockup_screens',
        'favorite',
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
      lastSeenEventCount: r.last_seen_event_count,
      ...(r.planning !== null ? { planning: r.planning } : {}),
      planningRevision: r.planning_revision,
      planningPlan: r.planning_plan,
      ...mockupReview(r.mockup_review, r.mockup_revision, r.mockup_screens),
      ...(r.favorite ? { favorite: true } : {}),
    }));
  }

  /** Overview positions are separate from the chronological session registry. */
  async sessionSortOrders(sessions: readonly SessionRecord[]): Promise<Map<string, number>> {
    const groups = await this.db.selectFrom('session_overview_order').selectAll().execute();
    const result = new Map<string, number>();
    for (const group of groups) {
      const members = sessions.filter((session) => session.projectId === group.project_id);
      const live = new Set(members.map((session) => session.sessionId));
      const stored = new Set(group.ids);
      // Append new sessions so creating one does not shift the manual order.
      const ids = [
        ...group.ids.filter((id) => live.has(id)),
        ...members
          .filter((session) => !stored.has(session.sessionId))
          .map((session) => session.sessionId),
      ];
      ids.forEach((id, index) => result.set(id, index));
    }
    return result;
  }

  async reorderSessions(projectId: string | null, ids: readonly string[]): Promise<string[]> {
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate session IDs');
    return this.db.transaction().execute(async (tx) => {
      // Serialize reorders against membership changes, including moves and inserts.
      // Reordering is infrequent; a short registry lock avoids lost concurrent additions.
      await sql`lock table sessions in share row exclusive mode`.execute(tx);
      if (
        projectId !== null &&
        !(await tx
          .selectFrom('projects')
          .select('id')
          .where('id', '=', projectId)
          .executeTakeFirst())
      ) {
        throw new Error('Project not found');
      }
      const sessions = await tx
        .selectFrom('sessions')
        .select(['session_id', 'project_id'])
        .orderBy('created_at', 'asc')
        .orderBy('session_id', 'asc')
        .execute();
      const requested = new Set(ids);
      if (
        sessions.some(
          (session) => requested.has(session.session_id) && session.project_id !== projectId,
        )
      ) {
        throw new Error('Session belongs to another project');
      }
      const members = sessions.filter((session) => session.project_id === projectId);
      const live = new Set(members.map((session) => session.session_id));
      const canonical = [
        ...ids.filter((id) => live.has(id)),
        ...members
          .filter((session) => !requested.has(session.session_id))
          .map((session) => session.session_id),
      ];
      await tx
        .insertInto('session_overview_order')
        .values({
          group_key: JSON.stringify(projectId),
          project_id: projectId,
          ids: sql<string[]>`${JSON.stringify(canonical)}::jsonb`,
        })
        .onConflict((conflict) =>
          conflict
            .column('group_key')
            .doUpdateSet({ ids: sql<string[]>`${JSON.stringify(canonical)}::jsonb` }),
        )
        .execute();
      return canonical;
    });
  }

  async listPreparedSessionMoves() {
    return this.sessionMoves.listPreparedSessionMoves();
  }

  async listMovePreviewRestarts() {
    return this.sessionMoves.listMovePreviewRestarts();
  }

  async setMovePreviewRestart(
    sessionId: string,
    operationId: string,
    serverIds: string[] | null,
  ): Promise<void> {
    return this.sessionMoves.setMovePreviewRestart(sessionId, operationId, serverIds);
  }

  async getSessionMove(sessionId: string, operationId: string) {
    return this.sessionMoves.getSessionMove(sessionId, operationId);
  }

  async getSessionMoveNotice(sessionId: string): Promise<string | undefined> {
    return this.sessionMoves.getSessionMoveNotice(sessionId);
  }

  /** Reserve a destination before touching disk, so an interrupted preparation remains identifiable. */
  async prepareSessionMove(input: {
    sessionId: string;
    operationId: string;
    sourceProjectId: string;
    sourceWorktree: string;
    targetProjectId: string;
    targetWorktree: string;
    branch: string;
    onCommits: string;
  }): Promise<void> {
    return this.sessionMoves.prepareSessionMove(input, (sessionId) =>
      this.getSessionBackendStates(sessionId),
    );
  }

  async commitSessionMove(
    sessionId: string,
    operationId: string,
    notice: string,
    resultJson: string,
  ): Promise<void> {
    await this.sessionMoves.commit(sessionId, operationId, notice, resultJson);
  }

  private get sessionLifecycle(): SessionLifecycleStore {
    return new SessionLifecycleStore(() => this.db);
  }

  get sessionMoves(): SessionMoveStore {
    return new SessionMoveStore(this.db);
  }

  /** Replace a legacy local Git workspace after its verified filesystem migration. */
  async replaceLocalSessionWorkspace(
    sessionId: string,
    projectId: string,
    previous: string,
    next: string,
    note: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const project = await tx
        .selectFrom('projects')
        .select(['kind', 'hidden_at'])
        .where('id', '=', projectId)
        .forShare()
        .executeTakeFirstOrThrow();
      if (project.kind !== 'local' || project.hidden_at !== null)
        throw new Error('Local project is unavailable');
      const session = await tx
        .selectFrom('sessions')
        .select(['worktree', 'project_id'])
        .where('session_id', '=', sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!session) return;
      if (session.project_id !== projectId)
        throw new Error('Session changed project during migration');
      if (session.worktree === next) return;
      if (session.worktree !== previous)
        throw new Error('Session changed workspace during migration');
      await tx
        .updateTable('sessions')
        .set({ worktree: next })
        .where('session_id', '=', sessionId)
        .execute();
      await tx.deleteFrom('session_backend_state').where('session_id', '=', sessionId).execute();
      await tx.insertInto('session_pending_note').values({ session_id: sessionId, note }).execute();
    });
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
    return this.sessionMoves.setSessionProject(sessionId, projectId);
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

  /** Mark a session as a favorite; returns false when the session is unknown. */
  async setSessionFavorite(sessionId: string, favorite: boolean): Promise<boolean> {
    const result = await this.db
      .updateTable('sessions')
      .set({ favorite })
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

  /** Move a session into or out of planning mode. `from` makes the write
   *  conditional, so two racing decisions (a tap on "Implement plan" and the
   *  approval of an agent's request) cannot both win. Answers whether it changed. */
  async setSessionPlanning(
    sessionId: string,
    planning: SessionPlanning,
    from?: readonly (SessionPlanning | null)[],
    expectedRevision?: number,
  ): Promise<boolean> {
    let query = this.db
      .updateTable('sessions')
      .set({ planning })
      .where('session_id', '=', sessionId);
    if (from !== undefined) {
      const states = from.filter((state): state is SessionPlanning => state !== null);
      query = query.where((eb) =>
        eb.or([
          ...(states.length > 0 ? [eb('planning', 'in', states)] : []),
          ...(from.includes(null) ? [eb('planning', 'is', null)] : []),
        ]),
      );
    }
    // A device can approve an old card while another device is publishing its revision.
    // Checking in this UPDATE prevents the read-before-write race from accepting it.
    if (expectedRevision !== undefined) {
      query = query.where('planning_revision', '=', expectedRevision);
      if (planning !== 'discarded') query = query.where('planning_plan', 'is not', null);
    }
    const result = await query.executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async startSessionPlanning(sessionId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('sessions')
      .set({
        planning: 'active',
        // A new plan revokes reviews belonging to the previous accepted work.
        mockup_review: null,
        mockup_screens: '[]',
        mockup_revision: sql`mockup_revision + 1`,
        planning_plan: null,
        planning_revision: sql`planning_revision + 1`,
      })
      .where('session_id', '=', sessionId)
      .where((eb) => eb.or([eb('planning', 'is', null), eb('planning', '!=', 'active')]))
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async presentSessionPlan(sessionId: string, plan: string): Promise<number | undefined> {
    const row = await this.db
      .updateTable('sessions')
      .set({ planning_plan: plan, planning_revision: sql`planning_revision + 1` })
      .where('session_id', '=', sessionId)
      .where('planning', '=', 'active')
      .returning('planning_revision')
      .executeTakeFirst();
    return row?.planning_revision;
  }

  /**
   * Change a session's mockup review under a row lock. `change` sees the current
   * review and answers the next one, or `undefined` to leave it as is; two devices
   * deciding different screens at once therefore both keep their verdict. Answers
   * the stored review, or `undefined` when the session is missing or nothing changed.
   */
  async updateSessionMockups(
    sessionId: string,
    change: (current: SessionMockups) => SessionMockups | undefined,
    expectedPlanningRevision?: number,
  ): Promise<SessionMockups | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('sessions')
        .select(['mockup_review', 'mockup_revision', 'mockup_screens', 'planning_revision'])
        .where('session_id', '=', sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return undefined;
      if (
        expectedPlanningRevision !== undefined &&
        row.planning_revision !== expectedPlanningRevision
      )
        return undefined;
      const next = change({
        state: storedMockupState(row.mockup_review),
        revision: row.mockup_revision,
        screens: storedMockupScreens(row.mockup_screens),
      });
      if (next === undefined) return undefined;
      await tx
        .updateTable('sessions')
        .set({
          mockup_review: next.state,
          mockup_revision: next.revision,
          mockup_screens: JSON.stringify(next.screens),
        })
        .where('session_id', '=', sessionId)
        .execute();
      return next;
    });
  }

  async getSessionBackendState(
    sessionId: string,
    backend: string,
  ): Promise<SessionBackendStateRecord | undefined> {
    return this.sessionBackendState.getSessionBackendState(sessionId, backend);
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
    contextFingerprint?: string;
  }): Promise<SessionBackendStateRecord[]> {
    return this.sessionBackendState.upsertSessionBackendState(input);
  }

  async deleteSessionBackendState(sessionId: string, backend: string): Promise<boolean> {
    return this.sessionBackendState.deleteSessionBackendState(sessionId, backend);
  }

  async getSessionBackendStates(sessionId: string): Promise<SessionBackendStateRecord[]> {
    return this.sessionBackendState.getSessionBackendStates(sessionId);
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
    return this.sessionBackendState.listLiveBackendSessionIds();
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
    return this.sessionBackendState.listSessionWorktrees();
  }

  async deleteSessionBackendStates(sessionId: string): Promise<number> {
    return this.sessionBackendState.deleteSessionBackendStates(sessionId);
  }

  async deleteProjectSessionBackendStates(projectId: string): Promise<number> {
    return this.sessionBackendState.deleteProjectSessionBackendStates(projectId);
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
   * Record the starter project a fresh installation created for itself. Only the
   * first call wins; the record keeps pointing at that project after it is
   * deleted (projects are soft-deleted), so it is never recreated.
   */
  async recordStarterProject(projectId: string): Promise<boolean> {
    const result = await this.db
      .insertInto('starter_project')
      .values({ singleton: true, project_id: projectId })
      .onConflict((oc) => oc.column('singleton').doNothing())
      .executeTakeFirst();
    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  /** Explicit tour replay restores only the recorded starter, never a name match. */
  async ensureReplayStarterProject(input: ProjectUpsertInput): Promise<ProjectRecord> {
    const row = await this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
      const recorded = await tx
        .selectFrom('starter_project')
        .select('project_id')
        .executeTakeFirst();
      if (recorded) {
        const existing = await tx
          .selectFrom('projects')
          .selectAll()
          .where('id', '=', recorded.project_id)
          .forUpdate()
          .executeTakeFirst();
        if (existing) {
          if (existing.hidden_at === null) return existing;
          const restored = await tx
            .updateTable('projects')
            .set({
              hidden_at: null,
              archived: false,
              overview_visible: true,
              state: 'absent',
              provision_error: null,
              provision_warning: null,
              sleep_compatibility_fingerprint: null,
              sleeping_since: null,
              wake_started_at: null,
              state_changed_at: sql`now()`,
              updated_at: sql`now()`,
            })
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await ensureProjectKnowledgeSpace(tx, restored.id, restored.repo);
          return restored;
        }
      }
      // A unique replay identity cannot claim a user's similarly named project.
      await tx
        .insertInto('project_identity_claims')
        .values({ owner: input.owner, repo: input.repo, project_id: input.id })
        .execute();
      const created = await tx
        .insertInto('projects')
        .values({
          id: input.id,
          name: input.name ?? defaultProjectName(input),
          owner: input.owner,
          repo: input.repo,
          container_name: input.containerName,
          kind: 'local',
          clone_dir: input.cloneDir ?? null,
          state: 'absent',
          overview_visible: true,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('starter_project')
        .values({ singleton: true, project_id: created.id })
        .onConflict((oc) => oc.column('singleton').doUpdateSet({ project_id: created.id }))
        .execute();
      await ensureProjectKnowledgeSpace(tx, created.id, created.repo);
      return created;
    });
    return projectRowToRecord(row);
  }

  async getStarterWelcomeSessionId(): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('starter_project')
      .select('welcome_session_id')
      .executeTakeFirst();
    return row?.welcome_session_id ?? undefined;
  }

  async recordStarterWelcomeSession(sessionId: string): Promise<void> {
    await this.db
      .updateTable('starter_project')
      .set({ welcome_session_id: sessionId })
      .where('singleton', '=', true)
      .execute();
  }

  async getStarterProjectId(): Promise<string | undefined> {
    const row = await this.db.selectFrom('starter_project').select('project_id').executeTakeFirst();
    return row?.project_id;
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

  /** Keep a terminal PR hidden after the workspace first changes, across restarts. */
  async observeSessionPrVisibility(
    sessionId: string,
    worktree: string,
    url: string,
    fingerprint: string,
  ): Promise<boolean> {
    const result = await sql<{ hidden: boolean }>`
      insert into session_pr_visibility(session_id, worktree, pr_url, fingerprint, hidden)
      values (${sessionId}, ${worktree}, ${url}, ${fingerprint}, false)
      on conflict (session_id, worktree, pr_url) do update set
        hidden = session_pr_visibility.hidden or
          session_pr_visibility.fingerprint <> excluded.fingerprint
      returning hidden
    `.execute(this.db);
    return result.rows[0]!.hidden;
  }

  async getSessionPrVisibility(
    sessionId: string,
    worktree: string,
    url: string,
  ): Promise<{ fingerprint: string; hidden: boolean } | undefined> {
    return this.db
      .selectFrom('session_pr_visibility')
      .select(['fingerprint', 'hidden'])
      .where('session_id', '=', sessionId)
      .where('worktree', '=', worktree)
      .where('pr_url', '=', url)
      .executeTakeFirst();
  }

  /** Seed the final baseline after managed post-merge housekeeping has settled. */
  async clearSessionPrVisibility(sessionId: string, worktree: string, url: string): Promise<void> {
    await this.db
      .deleteFrom('session_pr_visibility')
      .where('session_id', '=', sessionId)
      .where('worktree', '=', worktree)
      .where('pr_url', '=', url)
      .execute();
  }

  async resetSessionPrVisibility(
    sessionId: string,
    worktree: string,
    url: string,
    fingerprint: string,
  ): Promise<void> {
    await this.db
      .insertInto('session_pr_visibility')
      .values({ session_id: sessionId, worktree, pr_url: url, fingerprint, hidden: false })
      .onConflict((oc) =>
        oc
          .columns(['session_id', 'worktree', 'pr_url'])
          .doUpdateSet({ fingerprint, hidden: false }),
      )
      .execute();
  }

  /** Reserve before transport: a crash spends a bounded attempt instead of resetting it. */
  async claimPrReadyDelivery(
    sessionId: string,
    marker: string,
    now: number,
  ): Promise<string | undefined> {
    const claim = randomUUID();
    const result = await sql<{ claim_id: string }>`
      insert into pr_ready_delivery(session_id, marker, attempts, next_attempt_at, claim_id, lease_until)
      values (${sessionId}, ${marker}, 1, ${now + 60_000}, ${claim}, ${now + 300_000})
      on conflict (session_id, marker) do update set
        attempts = pr_ready_delivery.attempts + 1,
        next_attempt_at = case when pr_ready_delivery.attempts = 0 then ${now + 60_000}::bigint else ${now + 300_000}::bigint end, claim_id = ${claim}, lease_until = ${now + 300_000}
      where not pr_ready_delivery.completed and pr_ready_delivery.attempts < 3
        and pr_ready_delivery.next_attempt_at <= ${now} and pr_ready_delivery.lease_until <= ${now}
      returning claim_id
    `.execute(this.db);
    return result.rows[0]?.claim_id;
  }

  async finishPrReadyDelivery(
    sessionId: string,
    marker: string,
    claim: string,
    outcome: 'done' | 'failed' | 'unattempted',
    now: number,
  ): Promise<void> {
    // Claim identity fences a slow former sender after its lease expired.
    await sql`update pr_ready_delivery set
      attempts = attempts - ${outcome === 'unattempted' ? 1 : 0},
      next_attempt_at = case when ${outcome === 'unattempted'} then ${now + 30_000} else next_attempt_at end,
      completed = ${outcome === 'done'}, claim_id = null, lease_until = 0
      where session_id = ${sessionId} and marker = ${marker} and claim_id = ${claim}`.execute(
      this.db,
    );
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

  /** Constant-size log marker; a never-written session has no stats row. */
  async getSessionEventStats(sessionId: string): Promise<SessionEventStats | undefined> {
    const row = await this.db
      .selectFrom('session_event_stats')
      .selectAll()
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      eventCount: Number(row.event_count),
      lastEventSeq: Number(row.last_event_seq),
      lastActivityAt: row.last_activity_at?.getTime() ?? null,
      revision: String(row.revision),
    };
  }

  async latestEventSeq(sessionId: string): Promise<number> {
    const row = await this.db
      .selectFrom('events')
      .select((eb) => eb.fn.max('id').as('seq'))
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return Number(row?.seq ?? 0);
  }

  scheduleMessageProjection(): void {
    return this.messageProjection.scheduleMessageProjection();
  }

  /** Wait until both ordered live projection and any recovery/search backfill are
   * idle. This is a lifecycle barrier, not an error-reporting seam: live failures
   * are intentionally contained so canonical event persistence stays successful.
   * The barrier waits for all resulting recovery attempts, but does not assert that
   * a deliberately unavailable projection became healthy. */
  async waitForMessageProjectionIdle(): Promise<void> {
    return this.messageProjection.waitForMessageProjectionIdle();
  }

  async searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]> {
    return this.messageProjection.searchMessages(input);
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
  /** Permanent admission tombstone; cleanup payload survives the session FK cascade. */
  async queueSessionDeletion(sessionId: string, payload: string): Promise<void> {
    return this.sessionLifecycle.queueSessionDeletion(sessionId, payload);
  }

  async isWorktreeBeingDeleted(path: string): Promise<boolean> {
    return this.sessionLifecycle.isWorktreeBeingDeleted(path);
  }

  async getSessionDeletion(
    sessionId: string,
  ): Promise<{ payload: string; cleanupPending: boolean } | undefined> {
    return this.sessionLifecycle.getSessionDeletion(sessionId);
  }

  async isSessionDeleting(sessionId: string): Promise<boolean> {
    return this.sessionLifecycle.isSessionDeleting(sessionId);
  }

  async listPendingSessionDeletions(): Promise<{ sessionId: string; payload: string }[]> {
    return this.sessionLifecycle.listPendingSessionDeletions();
  }

  async updateSessionDeletionPayload(sessionId: string, payload: string): Promise<void> {
    return this.sessionLifecycle.updateSessionDeletionPayload(sessionId, payload);
  }

  async finishSessionDeletionCleanup(sessionId: string): Promise<void> {
    await this.withSessionDeletionCleanup(sessionId, () => Promise.resolve(true));
  }

  /** Hold cross-Server cleanup ownership without a transaction around host I/O.
   * Callback queries need their own pool connections; an open transaction here
   * deadlocks the single-connection test driver and can exhaust a production pool. */
  async withSessionDeletionCleanup(
    sessionId: string,
    work: (payload: string) => Promise<boolean>,
  ): Promise<boolean> {
    return this.sessionLifecycle.withSessionDeletionCleanup(sessionId, work);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.sessionLifecycle.deleteSession(sessionId);
  }

  /** Accept a background dispatch, its prompt and recovery marker in one commit.
   * Cancellation races on the same receipt row; only the winner can run the backend. */
  /** Reserve a server-authored dispatch for atomic prompt admission and replay. */
  async reserveBackgroundDispatch(id: string, sessionId: string): Promise<void> {
    await this.db
      .insertInto('qa_dispatches')
      .values({
        id,
        session_id: sessionId,
        state: 'reserved',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }

  async admitBackgroundDispatch(
    id: string,
    sessionId: string,
    event: AgentEvent,
  ): Promise<{ seq: number; ts: number; existing: boolean; markerId?: string } | undefined> {
    const eventRow = await this.prepareEventRow(event);
    const result = await this.db.transaction().execute(async (trx) => {
      const receipt = await trx
        .selectFrom('qa_dispatches')
        .selectAll()
        .where('id', '=', id)
        .where('session_id', '=', sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!receipt || receipt.state === 'cancelled' || receipt.state === 'legacy') return undefined;
      if (receipt.state === 'admitted')
        return {
          seq: Number(receipt.prompt_seq),
          ts: receipt.created_at.getTime(),
          existing: true,
        };
      await sql`select pg_advisory_xact_lock(hashtext(${sessionEventAppendLockKey(sessionId)}))`.execute(
        trx,
      );
      const predecessor = await trx
        .selectFrom('running_turns')
        .selectAll()
        .where('session_id', '=', sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (predecessor) {
        // Transcript terminal events may be late, unrelated or merely announce
        // cancellation. Only a server-confirmed completion or the exact
        // Runner's durable terminal/fence claim establishes relinquished ownership.
        const runnerClosed =
          predecessor.turn_id === null
            ? undefined
            : await trx
                .selectFrom('runner_frames')
                .select('turn_id')
                .where('session_id', '=', sessionId)
                .where('turn_id', '=', predecessor.turn_id)
                .where('terminal', '=', true)
                .executeTakeFirst();
        if (!predecessor.settled && !runnerClosed) return undefined;
        await trx
          .deleteFrom('running_turns')
          .where('session_id', '=', sessionId)
          .where('prompt_seq', '=', predecessor.prompt_seq)
          .execute();
      }
      const markerId = randomUUID();
      const row = await trx
        .insertInto('events')
        .values({ session_id: sessionId, type: eventRow.type, payload: eventRow.payload })
        .returning(['id', 'created_at'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('running_turns')
        .values({ session_id: sessionId, prompt_seq: row.id, marker_id: markerId })
        .execute();
      await trx
        .updateTable('qa_dispatches')
        .set({ state: 'admitted', prompt_seq: row.id })
        .where('id', '=', id)
        .execute();
      return { seq: Number(row.id), ts: row.created_at.getTime(), existing: false, markerId };
    });
    if (result && !result.existing)
      this.enqueuePersistedMessageEvent(
        sessionId,
        result.seq,
        new Date(result.ts),
        JSON.parse(eventRow.payload) as AgentEvent,
      );
    return result;
  }

  /**
   * Append one canonical event to the session's log. Validates against the
   * canonical schema first and refuses to persist anything invalid — the store
   * is the last line of defense behind the adapter's own guarantee. Returns the
   * assigned `seq` (bigserial id) and the row's `created_at` as epoch
   * milliseconds (`ts`), so the live fan-out can broadcast the real persist time
   * alongside `seq` (#32) — matching what the read paths surface.
   */
  async appendEvent(
    sessionId: string,
    event: AgentEvent,
  ): Promise<{ seq: number; ts: number; existing?: true }> {
    return this.eventWrites.appendEvent(sessionId, event);
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
    return this.eventWrites.appendEventForRunningTurn(sessionId, anchor, event);
  }

  /** Validate, externalize, and redact an event into the exact `(type, payload)`
   * an `events` row stores. Shared by {@link appendEvent} and the Runner-frame
   * ingest path so both persist byte-identical rows. Runs the content-addressed
   * externalization (which writes to `attachments`) — that is idempotent and safe
   * to perform BEFORE the ingest transaction, so the transaction stays a tight
   * `events` + `runner_frames` claim. */
  private async prepareEventRow(event: AgentEvent): Promise<{ type: string; payload: string }> {
    return this.eventWrites.prepareEventRow(event);
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
    return this.eventWrites.ingestRunnerFrame(sessionId, frame);
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
  /** An abandoned stream fence closes the log, but never proves worker exit. */
  async hasAbandonedRunnerTurns(sessionId: string): Promise<boolean> {
    return this.eventWrites.hasAbandonedRunnerTurns(sessionId);
  }

  async fenceAbandonedTurn(sessionId: string, turnId: string): Promise<void> {
    return this.eventWrites.fenceAbandonedTurn(sessionId, turnId);
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
    return this.eventWrites.fenceRunningTurnIfSilent(anchor, latestSeq, event);
  }

  /** Undo a stalled-turn fence when shutdown won immediately after it committed. */
  async releaseRunningTurnFence(
    anchor: RunningTurnRecord,
    noticeSeq: number | null,
    fenceSeq: number,
  ): Promise<void> {
    return this.eventWrites.releaseRunningTurnFence(anchor, noticeSeq, fenceSeq);
  }

  /** Rewrite a `tool_result`'s heavy inline payloads to content-addressed refs:
   * inline images → `id` refs (#115), and a large text output → a truncated preview
   * plus an `outputRef` to the full body. A no-op (returns the same event) when it
   * carries neither. Images are externalized first so the stored full-text body
   * already references images by id rather than re-embedding their base64. */
  private async externalizeToolResult(
    event: Extract<AgentEvent, { t: 'tool_result' }>,
  ): Promise<AgentEvent> {
    return this.attachments.externalizeToolResult(
      event,
      (mediaType, data) => this.putAttachment(mediaType, data),
      (jsonText) => this.putTextBlob(jsonText),
    );
  }

  /**
   * Store a UTF-8 text blob content-addressed by the SHA-256 of its bytes, reusing
   * the `attachments` table (a generic content-addressed blob store). Idempotent —
   * identical text dedupes to one row. Returns the hash — the `id` a `tool_result`'s
   * `outputRef` references and a consumer fetches by. Stored as `application/json`
   * because the externalized body is the JSON serialization of the tool output.
   */
  async putTextBlob(jsonText: string): Promise<string> {
    return this.attachments.putTextBlob(jsonText);
  }

  async putAttachment(
    mediaType: string,
    base64Data: string,
    mockupSessionId?: string,
  ): Promise<string> {
    return this.attachments.putAttachment(mediaType, base64Data, mockupSessionId);
  }

  /** Read a stored blob; an optional byte ceiling filters it before transfer. */
  async getAttachment(hash: string, maxBytes?: number): Promise<AttachmentBlob | undefined> {
    return this.attachments.getAttachment(hash, maxBytes);
  }

  /** Whether a prompt in this session references the content-addressed attachment. */
  async sessionHasAttachment(sessionId: string, hash: string): Promise<boolean> {
    return this.attachments.sessionHasAttachment(sessionId, hash);
  }

  /** Restore listener discovery's baseline without reading the session's transcript. */
  async getLatestDevServersEvent(
    sessionId: string,
  ): Promise<Extract<AgentEvent, { t: 'dev_servers_changed' }> | undefined> {
    const row = await this.db
      .selectFrom('events')
      .select('payload')
      .where('session_id', '=', sessionId)
      .where('type', '=', 'dev_servers_changed')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const parsed = parseAgentEvent(row.payload);
    if (!parsed.success || parsed.data.t !== 'dev_servers_changed') {
      throw new Error(`corrupt listener snapshot in session ${sessionId}`);
    }
    return parsed.data;
  }

  /** Fetch one app snapshot without hydrating the surrounding transcript. */
  async getMcpAppEvent(
    sessionId: string,
    appId: string,
  ): Promise<Extract<AgentEvent, { t: 'mcp_app' }> | undefined> {
    const row = await this.db
      .selectFrom('events')
      .select('payload')
      .where('session_id', '=', sessionId)
      .where('type', '=', 'mcp_app')
      .where(sql<string>`payload->>'appId'`, '=', appId)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const parsed = parseAgentEvent(row.payload);
    if (!parsed.success || parsed.data.t !== 'mcp_app') throw new Error('Corrupt MCP app snapshot');
    return parsed.data;
  }

  /** Read a session's full event log in append order. Validates each payload. */
  async getEvents(sessionId: string): Promise<AgentEvent[]> {
    const sequenced = await this.getEventsAfter(sessionId, 0);
    return sequenced.map((s) => s.event);
  }

  /** Return a contiguous suffix of complete events within the negotiated wire
   * budget. An oversized boundary event remains the next event to request. */
  async getBoundedHistory(
    sessionId: string,
    beforeSeq?: number,
    snapshotSeq?: number,
    eventOffset?: number,
  ): Promise<BoundedHistoryResult> {
    // One query establishes the initial snapshot, including the empty-log case.
    const source = await this.getEventsBeforeSeq(
      sessionId,
      eventOffset === undefined ? HISTORY_MAX_EVENTS : 1,
      snapshotSeq === undefined ? beforeSeq : Math.min(beforeSeq ?? Infinity, snapshotSeq + 1),
    );
    const snapshot = snapshotSeq ?? source.events.at(-1)?.seq ?? 0;
    const page: BoundedHistoryPage = {
      contract: 'bounded-history-v1',
      kind: 'page',
      events: [],
      snapshotSeq: snapshot,
      beforeSeq: null,
      hasMore: false,
    };
    for (let i = source.events.length - 1; i >= 0; i -= 1) {
      const event = source.events[i]!;
      const candidate: BoundedHistoryPage = {
        ...page,
        events: [event, ...page.events],
        beforeSeq: event.seq,
        hasMore: i > 0 || source.hasMore,
      };
      const requiredBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
      if (requiredBytes > HISTORY_MAX_BYTES) {
        if (page.events.length === 0) {
          if (eventOffset !== undefined) {
            const serialized = JSON.stringify(candidate);
            // A JSON string needs at most six UTF-8 bytes per UTF-16 code unit.
            // Leave room for the chunk envelope, including all numeric cursors.
            const chunkChars = Math.floor((HISTORY_MAX_BYTES - 1024) / 6);
            if (eventOffset >= serialized.length) throw new RangeError('invalid history offset');
            return {
              contract: 'bounded-history-v1',
              kind: 'event-chunk',
              seq: event.seq,
              snapshotSeq: snapshot,
              offset: eventOffset,
              totalChars: serialized.length,
              data: serialized.slice(eventOffset, eventOffset + chunkChars),
            };
          }
          return {
            contract: 'bounded-history-v1',
            kind: 'oversized-event',
            seq: event.seq,
            requiredBytes,
            maxBytes: HISTORY_MAX_BYTES,
            snapshotSeq: snapshot,
          };
        }
        return page;
      }
      Object.assign(page, candidate);
    }
    return page;
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

  /** The user behind the session's most recent prompt that names one, or `undefined`
   *  when no prompt in the session has an initiator. */
  async latestPromptInitiator(sessionId: string): Promise<{ userId: string } | undefined> {
    const row = await this.db
      .selectFrom('events')
      .select(sql<string>`payload->'initiatedBy'->>'userId'`.as('userId'))
      .where('session_id', '=', sessionId)
      .where(sql<boolean>`payload->>'t' = 'prompt'`)
      .where(sql<boolean>`payload->'initiatedBy'->>'userId' is not null`)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.userId ? { userId: row.userId } : undefined;
  }

  /** The user a turn runs for while it is the session's running turn, or
   *  `undefined` when `turnId` is not running there or names no initiator. Tools
   *  resolve personal credentials through this, never through the session alone. */
  async runningTurnInitiator(
    sessionId: string,
    turnId: string,
  ): Promise<{ userId: string } | undefined> {
    const running = (await this.listRunningTurns()).find((turn) => turn.sessionId === sessionId);
    if (running === undefined || running.turnId !== turnId) return undefined;
    return this.promptInitiatorAt(sessionId, running.promptSeq);
  }

  /** The user a specific prompt event was sent by, or `undefined` when that
   *  event is not a prompt or names no initiator. Recovery uses it to resume a
   *  turn under the identity it started with rather than the latest one. */
  async promptInitiatorAt(sessionId: string, seq: number): Promise<{ userId: string } | undefined> {
    const row = await this.db
      .selectFrom('events')
      .select(sql<string>`payload->'initiatedBy'->>'userId'`.as('userId'))
      .where('session_id', '=', sessionId)
      .where('id', '=', seq)
      .where(sql<boolean>`payload->>'t' = 'prompt'`)
      .executeTakeFirst();
    return row?.userId ? { userId: row.userId } : undefined;
  }

  /**
   * Read events with `seq > afterSeq` (the bigserial id) in order, each tagged
   * with its `seq`. `afterSeq = 0` returns the full log. The cursor lets a WS
   * client page a backlog and resume after a reconnect without re-sending it.
   */
  async getEventsAfter(
    sessionId: string,
    afterSeq: number,
    limit?: number,
  ): Promise<SequencedEvent[]> {
    let query = this.db
      .selectFrom('events')
      .select(['id', 'payload', 'created_at'])
      .where('session_id', '=', sessionId)
      .where('id', '>', afterSeq)
      .orderBy('id', 'asc');
    // Paged readers (the live replay) bound each read; recovery reads stay whole.
    if (limit !== undefined) query = query.limit(limit);
    const rows = await query.execute();
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
   * WHAT THE SLICE NO LONGER IS: the whole log's worth of projected events. Even
   * narrowed to eight discriminants it still grew with history — ~1.6 KB per
   * event on a seeded log — on a route polled every ~2 s per device, and V8 does
   * not hand a peak like that back to the OS, so the churn settles in as resident
   * memory. Each of the three now reads only what it can prove it needs:
   *
   * - usage sums in SQL over the whole log ({@link readUsageTotals}), so it never
   *   needed the slice in the first place;
   * - the rate-limit states come from a per-key `distinct on`
   *   ({@link readLatestRateLimits}), because the newest quota state for a window
   *   can be arbitrarily far back and a tail would silently drop it;
   * - what is left — the status badge and the permission question — reads a
   *   `tailLimit`-event TAIL, and both stop at the most recent non-steered
   *   `prompt`, so a tail reaching past one answers identically to the full
   *   slice. That is the caller's proof to make (`projectionTailIsSelfContained`
   *   in the server), which is why `eventsTruncated` comes back with it.
   *
   * Exact counters and the newest event timestamp come from the trigger-maintained
   * `session_event_stats` row. Every event mutation updates it transactionally,
   * including writes from older server generations and provisional fence removal.
   * The counters therefore stay constant-size reads as text history grows.
   *
   * BATCHED ON PURPOSE: `GET /sessions` needs every session at once, so this
   * answers all of them in four queries (tails, rate-limit states, sums,
   * counters) rather than four per session — four per `PROJECTION_ID_CHUNK` (message-projection.ts)
   * sessions, precisely, since the bind-parameter ceiling forces a chunk loop
   * above that many ids. Sessions with an empty log are present in the map with
   * `eventCount: 0` — absent from the map means the session id was not asked for.
   *
   * `tailLimit` is how many projected events the caller wants at the end of each
   * log. It is a parameter and not a constant here because "far enough back" is a
   * property of what the caller derives, and this read cannot check it — see
   * {@link listRecentSessionProjectionEvents}, which takes it for the same reason.
   */
  async listSessionProjectionFacts(
    sessionIds: readonly string[],
    tailLimit: number,
  ): Promise<Map<string, SessionProjectionFacts>> {
    const facts = new Map<string, SessionProjectionFacts>(
      sessionIds.map((sessionId) => [
        sessionId,
        {
          eventCount: 0,
          lastEventSeq: 0,
          lastActivityAt: null,
          lastMessageAt: null,
          events: [],
          eventsTruncated: false,
          rateLimitEvents: [],
          usage: emptyUsageTotals(),
        },
      ]),
    );
    if (facts.size === 0) return facts;
    const chunks = idChunks([...facts.keys()]);

    // Every part of this must describe the SAME log prefix. Under Postgres'
    // default READ COMMITTED isolation each statement gets a new snapshot, so a
    // result or rate-limit event appended between them could appear in only one
    // half and briefly produce a status/usage combination that never existed.
    // REPEATABLE READ fixes the snapshot for the complete batched read, including
    // every chunk on installs large enough to cross the bind-parameter ceiling.
    //
    // That matters more now than it did when the slice answered three of these
    // questions by itself: the tail, the quota states and the token sums are
    // three separate reads of one log, and nothing else would keep "this turn
    // finished", "this is what it cost" and "this is the quota it ran under"
    // describing the same moment.
    await this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (tx) => {
        await this.readProjectionTails(chunks, facts, tailLimit, tx);
        await this.readLatestRateLimits(chunks, facts, tx);
        await this.readUsageTotals(chunks, facts, tx);

        // Triggers keep exact counters in the same transaction as every event
        // mutation, so this read shares the tail/usage snapshot without scanning
        // one index entry per streamed delta on every overview poll.
        for (const ids of chunks) {
          await readSessionProjectionActivity(tx, ids, facts);
        }
      });
    return facts;
  }

  /**
   * The newest `limit` projected events of each listed session, ascending by
   * `seq` — the batched counterpart of {@link listRecentSessionProjectionEvents},
   * and the reason {@link listSessionProjectionFacts} no longer grows with
   * history.
   *
   * One statement per chunk, not one per session: a `cross join lateral` runs the
   * same descending index range per id, so Postgres stops at `limit` rows for
   * EACH session instead of fetching every projected row and discarding all but
   * the end of it. A window function over the whole set would be the same query
   * to read and a full scan to run.
   *
   * The ids ride in as ONE array parameter, so this statement binds two
   * parameters whatever the chunk size. The chunk loop stays anyway: the other
   * reads in this transaction still bind one parameter per id, and a tail read
   * that silently diverged from them on chunk boundaries would be a trap for
   * whoever changes this next.
   *
   * Each session's rows arrive newest-first, because that is the only way a
   * `limit` lands on the end of a log; they are sorted back into `seq` order
   * here, which is what every derivation over them assumes.
   */
  private async readProjectionTails(
    chunks: readonly (readonly string[])[],
    into: ReadonlyMap<string, { events: SequencedEvent[]; eventsTruncated: boolean }>,
    limit: number,
    db: Transaction<Database>,
  ): Promise<void> {
    for (const ids of chunks) {
      const rows = await sql<{
        session_id: string;
        id: string | number;
        payload: unknown;
        created_at: Date;
      }>`
        select s.session_id, tail.id, tail.payload, tail.created_at
        from unnest(${[...ids]}::text[]) as s(session_id)
        cross join lateral (
          select e.id, e.payload, e.created_at
          from events e
          where e.session_id = s.session_id
            and e.type = any(${[...SESSION_PROJECTION_EVENT_TYPES]}::text[])
          order by e.id desc
          limit ${limit}
        ) as tail
      `.execute(db);
      for (const row of rows.rows) {
        const entry = into.get(row.session_id);
        if (entry === undefined) continue;
        entry.events.push(sequencedEvent(row.session_id, row.id, row.payload, row.created_at));
      }
      for (const id of ids) {
        const entry = into.get(id);
        if (entry === undefined) continue;
        entry.events.sort((a, b) => a.seq - b.seq);
        // At the limit means the scan stopped on budget rather than on rows, so
        // older projected events exist and this tail is not the whole slice.
        entry.eventsTruncated = entry.events.length === limit;
      }
    }
  }

  /**
   * The newest `rate_limit` event per provider/window/scope of each listed
   * session, over the WHOLE log.
   *
   * A quota state stands until the provider replaces it, so the one that matters
   * can sit thousands of events back — a tail that missed it would not report a
   * degraded state, it would report none, which reads as "no limit in force".
   * `distinct on` answers it per key in one statement per chunk, walking each
   * session's `rate_limit` rows newest-first and keeping the first of each key.
   *
   * The key expressions repeat `latestRateLimits`' defaults (`Claude`,
   * `all_models`) rather than grouping on the raw fields. An older event that
   * omits `providerLabel` and a newer one that spells it out are ONE quota state
   * to the caller, and grouping them apart here would hand it two — and let the
   * older of them survive as the newest of its group.
   *
   * Returned unsorted: the caller keys them itself and sorts the result by
   * severity, and any order this imposed would be discarded there.
   */
  private async readLatestRateLimits(
    chunks: readonly (readonly string[])[],
    into: ReadonlyMap<string, { rateLimitEvents: SequencedEvent[] }>,
    db: Transaction<Database>,
  ): Promise<void> {
    const providerLabel = sql`coalesce(e.payload ->> 'providerLabel', 'Claude')`;
    const window = sql`coalesce(e.payload ->> 'window', '')`;
    const scope = sql`coalesce(e.payload ->> 'scope', 'all_models')`;
    for (const ids of chunks) {
      const rows = await sql<{
        session_id: string;
        id: string | number;
        payload: unknown;
        created_at: Date;
      }>`
        select distinct on (e.session_id, ${providerLabel}, ${window}, ${scope})
          e.session_id, e.id, e.payload, e.created_at
        from events e
        where e.session_id = any(${[...ids]}::text[])
          and e.type = 'rate_limit'
        order by e.session_id, ${providerLabel}, ${window}, ${scope}, e.id desc
      `.execute(db);
      for (const row of rows.rows) {
        const entry = into.get(row.session_id);
        if (entry === undefined) continue;
        entry.rateLimitEvents.push(
          sequencedEvent(row.session_id, row.id, row.payload, row.created_at),
        );
      }
    }
  }

  /**
   * Cumulative token usage per session, summed in the DATABASE — the totals half
   * of {@link listSessionProjectionFacts}.
   *
   * `aggregateUsage` answers the same question by folding every `result` event of
   * every listed session in the server process, which is why the overview has to
   * hydrate whole logs it otherwise only reads the end of. It is the one consumer
   * of the slice whose answer genuinely depends on the entire log, so it has to
   * move before the slice can be bounded — see the note on `aggregateUsage`,
   * which named a store-side SUM as the eventual path.
   *
   * Sums are taken as `bigint`: a busy session's `cacheReadTokens` runs to
   * billions, and `int` would overflow long before the total stops being
   * interesting. They come back as strings and are narrowed here, which is exact
   * up to 2^53 — past that the process could not hold the number anyway.
   *
   * A session with no `result` events produces no row at all, which is why the
   * caller seeds a zeroed total rather than letting an absent one read as missing.
   *
   * `events_session_id_type_id_idx` leads with `(session_id, type)`, so the scan
   * reaches only the `result` rows — one per completed turn — rather than every
   * event of every listed session. The payload still comes from the heap, which
   * is the cost this read pays and the reason it sums four fields in one pass.
   *
   * Takes the transaction rather than defaulting to {@link EventStore.db}: these
   * sums are only comparable to the slice and the counters when all three read
   * the same snapshot, so there is no correct way to call this outside one.
   */
  private async readUsageTotals(
    chunks: readonly (readonly string[])[],
    into: ReadonlyMap<string, { usage: UsageTotals }>,
    db: Transaction<Database>,
  ): Promise<void> {
    for (const ids of chunks) {
      const rows = await db
        .selectFrom('events')
        .select((eb) => [
          'session_id',
          // `coalesce` INSIDE the sum, not around it: a single NULL addend turns
          // the whole group's sum NULL, so one unreadable row would zero a total
          // over rows that are fine. It should be unreachable — `usage` is
          // required on a `result` event, events are validated on the way in, and
          // {@link readProjectionSlices} refuses a payload that no longer parses
          // earlier in this very transaction — which is exactly why it is worth a
          // keyword rather than a branch.
          //
          // `turns` counts the `result` rows unconditionally, which is what
          // `aggregateUsage` does with the same log: it adds a turn for every
          // `result` event it sees, without consulting the payload.
          usageSum('inputTokens').as('input_tokens'),
          usageSum('outputTokens').as('output_tokens'),
          usageSum('cacheReadTokens').as('cache_read_tokens'),
          usageSum('cacheCreationTokens').as('cache_creation_tokens'),
          eb.fn.countAll<string | number | bigint>().as('turns'),
        ])
        .where('session_id', 'in', ids)
        .where('type', '=', 'result')
        .groupBy('session_id')
        .execute();
      for (const row of rows) {
        const entry = into.get(row.session_id);
        if (entry === undefined) continue;
        entry.usage = {
          inputTokens: Number(row.input_tokens),
          outputTokens: Number(row.output_tokens),
          cacheReadTokens: Number(row.cache_read_tokens),
          cacheCreationTokens: Number(row.cache_creation_tokens),
          turns: Number(row.turns),
        };
      }
    }
  }

  /**
   * The projection slice ALONE, for callers that need the events and not the
   * counters.
   *
   * `GET /sessions/:id/activity` is the whole reason this exists. It polls every
   * 1.5 s per open session, and it reads the log for exactly one question: is a
   * background task still open behind a turn that already reported its result. It
   * never returns counters, usage, or quota states, so fetching the other
   * projection facts would add work whose result this caller discards.
   *
   * A separate method rather than a flag on the other one, because the flag would
   * have to leave `eventCount: 0` behind — and a zero count is not an absence,
   * it is what {@link deriveSessionStatusFromProjection} reads as `idle`.
   */
  async listSessionProjectionEvents(
    sessionIds: readonly string[],
    throughSeq?: number,
  ): Promise<Map<string, SequencedEvent[]>> {
    const slices = new Map<string, SequencedEvent[]>(
      sessionIds.map((sessionId) => [sessionId, []]),
    );
    if (slices.size === 0) return slices;
    await this.readProjectionSlices(idChunks([...slices.keys()]), slices, this.db, throughSeq);
    return slices;
  }

  /** Batched fallback with one connection and at most one hydrated history plus a page.
   * Keyset pages bound decoding bursts without a connection checkout per session. */
  async visitSessionProjectionEvents(
    boundaries: ReadonlyMap<string, number>,
    visit: (sessionId: string, events: SequencedEvent[]) => Promise<void>,
  ): Promise<void> {
    if (boundaries.size === 0) return;
    const input = JSON.stringify([...boundaries].map(([session_id, seq]) => ({ session_id, seq })));
    await this.db.connection().execute(async (db) => {
      let afterSession = '';
      let afterSeq = 0;
      let currentId: string | undefined;
      let current: SequencedEvent[] = [];
      for (;;) {
        const page = await sql<{
          session_id: string;
          id: string | number;
          payload: unknown;
          created_at: Date;
        }>`
          select e.session_id, e.id, e.payload, e.created_at
          from jsonb_to_recordset(${input}::jsonb) as boundary(session_id text, seq bigint)
          join events e on e.session_id = boundary.session_id and e.id <= boundary.seq
          where e.type = any(${[...SESSION_PROJECTION_EVENT_TYPES]}::text[])
            and (e.session_id, e.id) > (${afterSession}, ${afterSeq}::bigint)
          order by e.session_id, e.id limit 500
        `.execute(db);
        for (const row of page.rows) {
          if (currentId !== undefined && currentId !== row.session_id) {
            await visit(currentId, current);
            current = [];
          }
          currentId = row.session_id;
          current.push(sequencedEvent(row.session_id, row.id, row.payload, row.created_at));
          afterSession = row.session_id;
          afterSeq = Number(row.id);
        }
        if (page.rows.length < 500) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (currentId !== undefined) await visit(currentId, current);
    });
  }

  /**
   * The TAIL of one session's projection slice — its newest `limit` events, still
   * ascending by `seq`.
   *
   * {@link listSessionProjectionEvents} is linear in log length, and the activity
   * poll that calls it runs every 1.5 s for every idle session. Measured against a
   * seeded log, that slice costs ~1.6 KB per event: a session with 800 prompts
   * spends ~50 MB a minute being asked a question whose answer is at the end of
   * its log. Nothing retains it, so this is churn rather than a leak — but V8 does
   * not return the peak to the OS, so the process wears it for good.
   *
   * WHY A TAIL IS ENOUGH is a fact about the status derivation, not about this
   * query, so the caller checks it: see `projectionTailIsSelfContained`. In short,
   * both passes of `deriveSessionStatusFromProjection` stop at the most recent
   * non-steered `prompt`, so a tail reaching back past one answers identically to
   * the whole slice. A tail that does NOT reach one proves nothing, and the caller
   * falls back to the full read.
   *
   * Ordering note: the LIMIT has to apply to a DESCENDING scan or it would return
   * the OLDEST `limit` events — the same cost, and the wrong half of the log. The
   * rows are reversed here so callers still see ascending `seq`, which is what
   * both passes of the derivation assume.
   */
  async listRecentSessionProjectionEvents(
    sessionId: string,
    limit: number,
  ): Promise<SequencedEvent[]> {
    const rows = await this.db
      .selectFrom('events')
      .select(['id', 'payload', 'created_at'])
      .where('session_id', '=', sessionId)
      .where('type', 'in', [...SESSION_PROJECTION_EVENT_TYPES])
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    const events: SequencedEvent[] = [];
    for (const row of rows.reverse()) {
      const parsed = parseAgentEvent(row.payload);
      // Same contract as the batched slice read below: a payload that does not
      // parse is a corrupted log, not a row to skip past.
      if (!parsed.success) {
        throw new Error(`corrupt event payload in session ${sessionId}: ${parsed.error.message}`);
      }
      events.push({ seq: Number(row.id), ts: row.created_at.getTime(), event: parsed.data });
    }
    return events;
  }

  /** Task updates must not hide the completion that releases a repair claim. */
  async latestSessionTurnControlEvent(
    sessionId: string,
    afterSeq: number,
  ): Promise<SequencedEvent | undefined> {
    const row = await this.db
      .selectFrom('events')
      .select(['id', 'payload', 'created_at'])
      .where('session_id', '=', sessionId)
      .where('id', '>', afterSeq)
      .where('type', 'in', ['status', 'prompt', 'interrupted'])
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return undefined;
    const parsed = parseAgentEvent(row.payload);
    if (!parsed.success)
      throw new Error(`corrupt event payload in session ${sessionId}: ${parsed.error.message}`);
    return { seq: Number(row.id), ts: row.created_at.getTime(), event: parsed.data };
  }

  /**
   * Whether this session's log holds a `task` event ANYWHERE.
   *
   * The companion to {@link listRecentSessionProjectionEvents}, and the one
   * question a tail cannot answer for itself. The activity poll gates its
   * log-derived busy state on a task lifecycle existing at all — over the whole
   * log, not the current turn — so a tail that reaches back far enough for the
   * status derivation may still be short of this. Asking directly costs one
   * lookup in `events_session_id_type_id_idx` and fetches no payload, which is
   * the entire reason the tail is worth reading in the first place.
   *
   * `limit(1)` is the point: this is an existence question, and counting the
   * matching rows instead would restore exactly the full-log scan being avoided.
   */
  async sessionHasTaskLifecycleEvent(sessionId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('events')
      .select('id')
      .where('session_id', '=', sessionId)
      .where('type', '=', 'task')
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The slice read shared by {@link listSessionProjectionFacts} and
   *  {@link listSessionProjectionEvents}: appends each session's projected events,
   *  in `seq` order, to the array already sitting under its id. */
  private async readProjectionSlices(
    chunks: readonly (readonly string[])[],
    into: ReadonlyMap<string, SequencedEvent[]>,
    db: Kysely<Database> | Transaction<Database> = this.db,
    throughSeq?: number,
  ): Promise<void> {
    for (const ids of chunks) {
      let query = db
        .selectFrom('events')
        .select(['session_id', 'id', 'payload', 'created_at'])
        .where('session_id', 'in', ids)
        .where('type', 'in', [...SESSION_PROJECTION_EVENT_TYPES]);
      if (throughSeq !== undefined) query = query.where('id', '<=', throughSeq);
      const rows = await query.orderBy('session_id', 'asc').orderBy('id', 'asc').execute();
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
    return this.turnRecords.enqueueTurn(input);
  }

  /** Accept a plan and its implementation backlog entry together. A restart
   * between acceptance and the live queue update must still recover the work. */
  async enqueuePlanImplementation(
    input: QueuedTurnInput,
    revision: number,
    onPersisted?: (event: SequencedEvent) => void,
    consent?: PlanningConsent,
  ): Promise<boolean> {
    const persisted: { seq: number; createdAt: Date; event: AgentEvent }[] = [];
    const accepted = await this.db.transaction().execute(async (tx) => {
      // A newer user prompt revokes chat consent before any tasks or work commit.
      await sql`select pg_advisory_xact_lock(hashtext(${sessionEventAppendLockKey(input.sessionId)}))`.execute(
        tx,
      );
      if (consent !== undefined) {
        const running = await tx
          .selectFrom('running_turns')
          .select(['turn_id', 'prompt_seq'])
          .where('session_id', '=', input.sessionId)
          .forUpdate()
          .executeTakeFirst();
        const queuedPrompt = await tx
          .selectFrom('queued_turns')
          .select('id')
          .where('session_id', '=', input.sessionId)
          .limit(1)
          .executeTakeFirst();
        if (queuedPrompt !== undefined) return false;
        const latest = await tx
          .selectFrom('events')
          .select('id')
          .where('session_id', '=', input.sessionId)
          .where('type', '=', 'prompt')
          .orderBy('id', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (
          running?.turn_id !== consent.turnId ||
          Number(running.prompt_seq) !== consent.runningPromptSeq ||
          Number(latest?.id) !== consent.promptSeq
        )
          return false;
      }

      const result = await tx
        .updateTable('sessions')
        .set({ planning: 'implemented' })
        .where('session_id', '=', input.sessionId)
        .where('planning', '=', 'active')
        .where('planning_revision', '=', revision)
        .where('planning_plan', 'is not', null)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) return false;
      const session = await tx
        .selectFrom('sessions')
        .select(['project_id', 'planning_plan'])
        .where('session_id', '=', input.sessionId)
        .executeTakeFirstOrThrow();
      const tasks = new TaskStore(tx, this.cipher);
      const ownerUserId = await tasks.agentTaskOwner(input.sessionId, session.project_id);
      if (ownerUserId !== undefined) {
        const steps = parsePlanningProposal(session.planning_plan!).steps;
        const taskIds: string[] = [];
        for (const [index, step] of steps.entries()) {
          const id = randomUUID();
          const title = step
            .replace(/\*\*/g, '')
            .split(/\s+[—–]\s+|\n/)[0]!
            .slice(0, 2_000);
          await tasks.upsert({
            id,
            ownerUserId,
            projectId: session.project_id,
            sessionId: input.sessionId,
            sourceSessionId: input.sessionId,
            origin: 'agent',
            title,
            detail: step.slice(0, 20_000),
            sort: index,
          });
          taskIds.push(id);
        }
        // The event and tasks commit with acceptance: recovery never loses the link
        // to the accepted steps, and concurrent decisions cannot duplicate them.
        for (let offset = 0; offset < taskIds.length; offset += 100) {
          const event: AgentEvent = {
            t: 'tasks_updated',
            origin: 'agent',
            change: 'added',
            taskIds: taskIds.slice(offset, offset + 100),
          };
          const eventRow = await this.prepareEventRow(event);
          await sql`select pg_advisory_xact_lock(hashtext(${sessionEventAppendLockKey(input.sessionId)}))`.execute(
            tx,
          );
          const row = await tx
            .insertInto('events')
            .values({ session_id: input.sessionId, type: eventRow.type, payload: eventRow.payload })
            .returning(['id', 'created_at'])
            .executeTakeFirstOrThrow();
          persisted.push({ seq: Number(row.id), createdAt: row.created_at, event });
        }
      }
      await tx
        .insertInto('queued_turns')
        .values({
          id: input.id,
          session_id: input.sessionId,
          prompt: input.prompt,
          opts: JSON.stringify(input.opts),
        })
        .execute();
      return true;
    });
    for (const row of persisted) {
      this.enqueuePersistedMessageEvent(input.sessionId, row.seq, row.createdAt, row.event);
      onPersisted?.({ seq: row.seq, ts: row.createdAt.getTime(), event: row.event });
    }
    return accepted;
  }

  /**
   * Remove one queued turn from the durable backlog by its `id` — called when the
   * turn dispatches (drained as the session goes idle) or the operator retracts it
   * (issue #80). Returns `true` if a row matched, `false` if it was already gone (a
   * harmless no-op: e.g. a retract racing the drain that just dispatched it).
   */
  async deleteQueuedTurn(id: string): Promise<boolean> {
    return this.turnRecords.deleteQueuedTurn(id);
  }

  /** Remove a backlog snapshot atomically: either every queued row is deleted or
   * none is. Stop uses this so a storage failure cannot leave a partially deleted
   * backlog split between live memory and durable recovery. */
  async deleteQueuedTurns(ids: readonly string[]): Promise<void> {
    return this.turnRecords.deleteQueuedTurns(ids);
  }

  /**
   * Read the entire durable backlog across all sessions in FIFO order, for the
   * conductor to rebuild its in-memory queues on startup (issue #80). Ordered by
   * `seq` so each session's turns recover in the order they were enqueued.
   */
  async listQueuedTurns(): Promise<QueuedTurnRecord[]> {
    return this.turnRecords.listQueuedTurns();
  }

  /** Mark a turn in flight for `sessionId` (upsert — only one turn runs at a time).
   * Recovery reads these at startup: a marker still present means the turn was
   * abandoned by a crash/restart and must be settled rather than re-inferred. */
  async markTurnRunning(input: {
    sessionId: string;
    promptSeq: number;
    markerId?: string;
  }): Promise<void> {
    return this.turnRecords.markTurnRunning(input);
  }

  /** Record backend-confirmed completion, independently of best-effort cleanup.
   * A unique marker identity prevents late completion from settling a resumed
   * attempt even when that attempt reuses the same prompt sequence. The Runner identity must match too; alternatively admission can use
   * its durable terminal/fence claim. */
  async confirmTurnSettled(
    sessionId: string,
    promptSeq: number,
    markerId: string,
    turnId: string | null = null,
  ): Promise<void> {
    return this.turnRecords.confirmTurnSettled(sessionId, promptSeq, markerId, turnId);
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
    return this.turnRecords.bindTurnIdentity(sessionId, identity);
  }

  /** Clear the in-flight marker for `sessionId` once its turn reaches a terminal
   * event. Idempotent — a no-op if no marker is present. When `promptSeq` is given,
   * the delete is SCOPED to that anchor (`prompt_seq = ?`), so a settling turn's
   * late clear can only remove ITS OWN marker, never a newer turn's marker that
   * already replaced the row (the settle-vs-next-turn race). `markerId` additionally
   * distinguishes attempts reusing a prompt anchor; snapshots of legacy markers
   * pass null. Omitting both scopes is reserved for deliberate unconditional cleanup. */
  async clearRunningTurn(
    sessionId: string,
    promptSeq?: number,
    markerId?: string | null,
  ): Promise<void> {
    return this.turnRecords.clearRunningTurn(sessionId, promptSeq, markerId);
  }

  /** Resolve a bounded maintenance page against Server-owned execution records.
   * The caller derives sessionIds from the runtime's authoritative routing, including
   * dedicated control-plane routing. Query all owners before applying that scope:
   * filtering first would hide a conflicting binding in another runtime. */
  async resolveRunnerTurnOwnership(input: {
    sessionIds: string[];
    turns: RunnerTurnOwnershipRequest[];
  }): Promise<RunnerTurnOwnership[]> {
    return this.turnRecords.resolveRunnerTurnOwnership(input);
  }

  /** All in-flight markers. At startup a non-empty result flags sessions whose
   * turn was abandoned by a crash/restart. */
  async listRunningTurns(): Promise<RunningTurnRecord[]> {
    return this.turnRecords.listRunningTurns();
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
        await sessionEventAppendLock(tx, sessionId);
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
    return this.projectLifecycle.upsertProject(input);
  }

  /**
   * Add a repository-backed project the operator chose. While the repository's
   * first project (instance 1) is only an installation placeholder, it is
   * adopted; when the operator had removed it, it is restored — both exactly as
   * {@link upsertProject} does. Once that repository already backs a visible
   * project (or a link is reserving it), a separate project is created as the
   * next instance, with its own ID, clone directory and container. An existing
   * project is never returned or reset for another project's request.
   */
  async createRepositoryProject(input: ProjectUpsertInput): Promise<ProjectRecord> {
    return this.projectLifecycle.createRepositoryProject(input);
  }

  /** Insert a project without adopting an existing `(owner, repo)` row. Used for
   * operator-named local projects, where returning another concurrent request's
   * clone would cross an ownership boundary. A conflict is surfaced atomically
   * as the database's unique violation. */
  async createProject(input: ProjectUpsertInput): Promise<ProjectRecord> {
    return this.projectLifecycle.createProject(input);
  }

  /**
   * Gives a project a new name. Only the name changes: owner, repo, container,
   * clone directory and every repository link stay as they are. Duplicate names
   * across projects are allowed — the ID identifies a project, not its name.
   *
   * @throws {InvalidProjectNameError} when the trimmed name is empty or longer
   *         than {@link PROJECT_NAME_MAX_CHARS}.
   * @returns the renamed project, or `undefined` when it does not exist.
   */
  async renameProject(id: string, name: string): Promise<ProjectRecord | undefined> {
    return this.projectLifecycle.renameProject(id, name);
  }

  async getProject(id: string): Promise<ProjectRecord | undefined> {
    return this.projectLifecycle.getProject(id);
  }

  /** Whether `userId` created the project (ADR 0023). */
  async isProjectCreator(userId: string, projectId: string): Promise<boolean> {
    return this.projectAccess.isProjectCreator(userId, projectId);
  }

  async hasProjectPermission(
    userId: string,
    projectId: string,
    permission: ProjectPermission,
  ): Promise<boolean> {
    return this.projectAccess.hasProjectPermission(userId, projectId, permission);
  }

  async isActiveAdministrator(userId: string): Promise<boolean> {
    return this.projectAccess.isActiveAdministrator(userId);
  }

  async isActiveLocalUser(userId: string): Promise<boolean> {
    return this.projectAccess.isActiveLocalUser(userId);
  }

  /** Keep collection reads consistent with hasProjectPermission's control-plane rule. */
  async listReadableProjectIds(userId: string): Promise<string[]> {
    return this.projectAccess.listReadableProjectIds(userId);
  }

  /** Delete every standing grant a person gave in a project (ADR 0023 §6). */
  async deleteUserProjectGrants(projectId: string, userId: string): Promise<number> {
    return this.projectAccess.deleteUserProjectGrants(projectId, userId);
  }

  /** The names people chose to be shown under in shared projects (ADR 0023). */
  async userDisplayNames(userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('users')
      .select(['id', 'display_name'])
      .where('id', 'in', [...userIds])
      .execute();
    return new Map(
      rows
        .filter((row) => row.display_name !== null && row.display_name.trim() !== '')
        .map((row) => [row.id, row.display_name!.trim()]),
    );
  }

  /** Active users holding a project permission — the notification audience
   * for project work that has no individual initiator. Same control-plane rule
   * as {@link hasProjectPermission}. */
  async listProjectUserIds(
    projectId: string,
    permission: 'read' | 'execute' | 'manage',
  ): Promise<string[]> {
    return this.projectAccess.listProjectUserIds(projectId, permission);
  }

  async listActiveAdministratorIds(): Promise<string[]> {
    return this.projectAccess.listActiveAdministratorIds();
  }

  async getProjectByOwnerRepo(
    owner: string,
    repo: string,
    forgeConnectionId?: string | null,
  ): Promise<ProjectRecord | undefined> {
    // Lookup-form mirrors the persistence-form (lowercase, §19.0/§19.2): a row
    // persisted from `'heey-global'/'VERITY'` lives as `'verity'` on disk, so the
    // caller can pass the raw GitHub-display form without having to know about
    // our persistence normalisation.
    // Several projects may share a repository; this answers its first one.
    // Callers that must not guess use listProjectsByOwnerRepo.
    return (await this.listProjectsByOwnerRepo(owner, repo, forgeConnectionId))[0];
  }

  /** Every project of one repository, hidden ones included, first instance first. */
  async listProjectsByOwnerRepo(
    owner: string,
    repo: string,
    forgeConnectionId?: string | null,
  ): Promise<ProjectRecord[]> {
    return this.projectLifecycle.listProjectsByOwnerRepo(owner, repo, forgeConnectionId);
  }

  /**
   * Move a `local` project onto a GitHub repository: rewrite `(owner, repo)` and
   * flip `kind` to `github`, by ID rather than through the `(owner, repo)` upsert
   * (whose ON CONFLICT branch would target the WRONG row — the GitHub-side
   * identity we are moving TO).
   *
   * `container_name` stays (renaming would recreate the container); `clone_dir` is
   * pinned to the clone's current directory, as sessions persist absolute worktree
   * paths under it. Any GitHub repository ID is cleared; the new one is learned.
   *
   * Returns `undefined` when the project no longer exists. Throws the driver's
   * unique-violation when `(owner, repo)` is already registered — the caller maps
   * that to a conflict rather than silently merging two projects.
   */
  async linkProjectToGitHub(
    id: string,
    target: { owner: string; repo: string; forgeConnectionId?: string | null; kind?: ProjectKind },
  ): Promise<ProjectRecord | undefined> {
    return this.projectLifecycle.linkProjectToGitHub(id, target);
  }

  /** Disconnect by stable ID; pin the existing clone and preserve all dependent records. */
  async disconnectProjectFromGitHub(id: string): Promise<ProjectRecord | undefined> {
    return this.projectLifecycle.disconnectProjectFromGitHub(id);
  }

  async reserveProjectIdentity(
    id: string,
    target: { owner: string; repo: string; forgeConnectionId?: string | null; kind?: ProjectKind },
  ): Promise<boolean> {
    return this.projectLifecycle.reserveProjectIdentity(id, target);
  }

  async releaseProjectIdentity(
    id: string,
    target: { owner: string; repo: string; forgeConnectionId?: string | null; kind?: ProjectKind },
  ): Promise<void> {
    return this.projectLifecycle.releaseProjectIdentity(id, target);
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
    return this.projectLifecycle.listProjects(opts);
  }

  async reorderProjects(ids: string[]): Promise<ProjectRecord[]> {
    return this.projectLifecycle.reorderProjects(ids, () => this.listProjects());
  }

  /**
   * Soft-delete: mark a project hidden (`hidden_at = now()`) instead of dropping
   * the row. Keeps the row — and its stable id/settings — so the
   * GitHub-installation sync's re-upsert can't resurrect it (the sync leaves
   * `hidden_at` untouched; only an explicit restore clears it). Idempotent: a
   * second hide just refreshes the timestamp. Returns whether a row matched.
   */
  async hideProject(id: string): Promise<boolean> {
    return this.projectLifecycle.hideProject(id);
  }

  async deleteProject(id: string): Promise<boolean> {
    return this.projectLifecycle.deleteProject(id);
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
    return this.projectLifecycle.updateProjectState(id, state, provisionError, provisionWarning);
  }

  /** Persist a sleep/wake lifecycle transition and its recovery metadata in one
   * statement. Callers explicitly supply every nullable field so a new state
   * cannot silently inherit timestamps or a compatibility verdict from an old
   * transition. */
  async updateProjectSleepState(
    id: string,
    state: Extract<ProjectState, 'sleeping_starting' | 'sleeping' | 'waking' | 'active'>,
    metadata: {
      sleepCompatibilityFingerprint: string | null;
      sleepingSince: Date | null;
      wakeStartedAt: Date | null;
    },
  ): Promise<ProjectRecord | undefined> {
    return this.projectLifecycle.updateProjectSleepState(id, state, metadata);
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
    return this.projectLifecycle.recordProjectImageRef(id, imageRef, toolkitIdentity);
  }

  async setProjectSetupStatus(
    id: string,
    status: ProjectSetupState,
  ): Promise<ProjectRecord | undefined> {
    return this.projectLifecycle.setProjectSetupStatus(id, status);
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
    return this.projectLifecycle.updateProjectReleaseStatus(id, status);
  }

  async setSessionAutomation(
    input: SessionAutomationInput,
    now: Date = new Date(),
    checkedWorkspace?: Pick<SessionRecord, 'projectId' | 'worktree'>,
  ): Promise<SessionAutomationRecord> {
    return this.sessionAutomations.setSessionAutomation(input, now, checkedWorkspace);
  }

  async getSessionAutomation(sessionId: string): Promise<SessionAutomationRecord | undefined> {
    return this.sessionAutomations.getSessionAutomation(sessionId);
  }

  async setSessionAutomationStatus(
    sessionId: string,
    status: SessionAutomationStatus,
    now: Date = new Date(),
  ): Promise<SessionAutomationRecord | undefined> {
    return this.sessionAutomations.setSessionAutomationStatus(sessionId, status, now);
  }

  async deleteSessionAutomation(sessionId: string): Promise<boolean> {
    return this.sessionAutomations.deleteSessionAutomation(sessionId);
  }

  async listSessionAutomationStatuses(
    sessionIds: readonly string[],
  ): Promise<Map<string, SessionAutomationStatus>> {
    return this.sessionAutomations.listSessionAutomationStatuses(sessionIds);
  }

  async listDueSessionAutomations(now: Date): Promise<SessionAutomationRecord[]> {
    return this.sessionAutomations.listDueSessionAutomations(now);
  }

  async nextSessionAutomationDueAt(): Promise<Date | null> {
    return this.sessionAutomations.nextSessionAutomationDueAt();
  }

  async claimSessionAutomationRun(id: string, ranAt: Date, nextRunAt: Date): Promise<boolean> {
    return this.sessionAutomations.claimSessionAutomationRun(id, ranAt, nextRunAt);
  }

  async recordSessionAutomationOutcome(
    id: string,
    result: { outcome: SessionAutomationOutcome; detail: string | null },
  ): Promise<void> {
    return this.sessionAutomations.recordSessionAutomationOutcome(id, result);
  }

  async getVeritySettings(): Promise<VeritySettingsRecord | undefined> {
    return this.veritySettings.getVeritySettings();
  }

  /**
   * Read settings WITHOUT decrypting the secret columns — for public read paths
   * (GET /settings, first-run seeding) that only strip or `configured`-check
   * secrets. Works while the store is sealed; the returned record's secret
   * fields hold the STORED (possibly encrypted) form, so they must NOT be used
   * as plaintext.
   */
  async getVeritySettingsRaw(): Promise<VeritySettingsRecord | undefined> {
    return this.veritySettings.getVeritySettingsRaw();
  }

  async updateVeritySettings(patch: VeritySettingsPatch): Promise<VeritySettingsRecord> {
    return this.veritySettings.updateVeritySettings(patch);
  }

  async updateTranscribeBackendMode(mode: 'local' | 'external'): Promise<void> {
    return this.veritySettings.updateTranscribeBackendMode(mode);
  }

  /** Dev servers for one project, in their configured display order. */
  async listDevServers(projectId: string): Promise<DevServerRecord[]> {
    return this.devServerConfigs.listDevServers(projectId);
  }

  async getDevServer(id: string): Promise<DevServerRecord | undefined> {
    return this.devServerConfigs.getDevServer(id);
  }

  async createDevServer(input: DevServerCreateInput): Promise<DevServerRecord> {
    return this.devServerConfigs.createDevServer(input);
  }

  async updateDevServer(id: string, patch: DevServerPatch): Promise<DevServerRecord | undefined> {
    return this.devServerConfigs.updateDevServer(id, patch);
  }

  async recordDevServerDetection(
    projectId: string,
    fingerprint: string,
  ): Promise<DevServerDetectionStateRecord> {
    return this.devServerConfigs.recordDevServerDetection(projectId, fingerprint);
  }

  async getDevServerDetectionState(
    projectId: string,
  ): Promise<DevServerDetectionStateRecord | undefined> {
    return this.devServerConfigs.getDevServerDetectionState(projectId);
  }

  /** Mark exactly the current detector result as reviewed. A stale client cannot
   * acknowledge a newer scan that arrived after its dialog was opened. */
  async reviewDevServerDetection(
    projectId: string,
    fingerprint: string,
  ): Promise<DevServerDetectionStateRecord | undefined> {
    return this.devServerConfigs.reviewDevServerDetection(projectId, fingerprint);
  }

  /** Release a review claim when the corresponding setup mutation failed. */
  async unreviewDevServerDetection(projectId: string, fingerprint: string): Promise<void> {
    return this.devServerConfigs.unreviewDevServerDetection(projectId, fingerprint);
  }

  async deleteDevServer(id: string): Promise<boolean> {
    return this.devServerConfigs.deleteDevServer(id);
  }

  async createLocalPreviewShare(input: Omit<LocalPreviewShareRecord, 'state'>): Promise<void> {
    return this.previewShares.createLocalPreviewShare(input);
  }

  async listLocalPreviewShares(): Promise<LocalPreviewShareRecord[]> {
    return this.previewShares.listLocalPreviewShares();
  }

  /** Follow a managed listener without changing its public binding. */
  async updateLocalPreviewShareTarget(id: string, targetPort: number): Promise<void> {
    return this.previewShares.updateLocalPreviewShareTarget(id, targetPort);
  }

  /** Persist stop intent before removing sockets or containers. */
  async revokeLocalPreviewShare(id: string): Promise<void> {
    return this.previewShares.revokeLocalPreviewShare(id);
  }

  async deleteLocalPreviewShare(id: string): Promise<void> {
    return this.previewShares.deleteLocalPreviewShare(id);
  }

  async createPublicPreviewShare(
    input: PublicPreviewShareCreateInput,
  ): Promise<PublicPreviewShareRecord> {
    return this.previewShares.createPublicPreviewShare(input, (id) =>
      this.getPublicPreviewShare(id),
    );
  }

  /** PIN lockout blocks new authentication, never the active connector or cookies. */
  async lockPublicPreviewSharePin(id: string): Promise<void> {
    return this.previewShares.lockPublicPreviewSharePin(id);
  }

  async addPendingUplinkShareRemoval(shareId: string): Promise<void> {
    return this.previewShares.addPendingUplinkShareRemoval(shareId);
  }

  async listPendingUplinkShareRemovals(): Promise<string[]> {
    return this.previewShares.listPendingUplinkShareRemovals();
  }

  async deletePendingUplinkShareRemoval(shareId: string): Promise<void> {
    return this.previewShares.deletePendingUplinkShareRemoval(shareId);
  }

  async getPublicPreviewShare(id: string): Promise<PublicPreviewShareRecord | undefined> {
    return this.previewShares.getPublicPreviewShare(id);
  }

  async listPublicPreviewShares(projectId?: string): Promise<PublicPreviewShareRecord[]> {
    return this.previewShares.listPublicPreviewShares(projectId);
  }

  /** Compare-and-set is the lifecycle fence shared by create, stop, expiry and
   * restart reconciliation. A stale worker cannot resurrect a revoked share. */
  async transitionPublicPreviewShare(
    id: string,
    from: readonly PublicPreviewShareState[],
    to: PublicPreviewShareState,
    patch: {
      connectorContainerId?: string | null;
      targetPort?: number;
      containerGeneration?: string;
      failure?: string | null;
      revokedAt?: Date | null;
    } = {},
  ): Promise<PublicPreviewShareRecord | undefined> {
    return this.previewShares.transitionPublicPreviewShare(id, from, to, patch);
  }

  async listPublicPreviewSharesDue(now = new Date()): Promise<PublicPreviewShareRecord[]> {
    return this.previewShares.listPublicPreviewSharesDue(now);
  }

  /** Read the singleton Claude-egress CA + gateway identity, decrypting the CA +
   *  gateway private keys. Returns undefined before the first issuance. */
  async getClaudeEgressCa(): Promise<ClaudeEgressCaRecord | undefined> {
    return this.claudeEgressIdentity.getClaudeEgressCa();
  }

  /** Insert or replace the singleton CA + gateway identity, encrypting both
   *  private keys at rest. A re-issue (rotation) overwrites the single row. */
  async upsertClaudeEgressCa(record: ClaudeEgressCaRecord): Promise<void> {
    return this.claudeEgressIdentity.upsertClaudeEgressCa(record);
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
    return this.claudeEgressIdentity.replaceClaudeEgressCa(record);
  }

  async getClaudeEgressClientCert(
    projectId: string,
    userId: string,
  ): Promise<ClaudeEgressClientCertRecord | undefined> {
    return this.claudeEgressIdentity.getClaudeEgressClientCert(projectId, userId);
  }

  /** Every stored client certificate — the source of the gateway's
   *  fingerprint→sandbox peer bindings. */
  async listClaudeEgressClientCerts(): Promise<ClaudeEgressClientCertRecord[]> {
    return this.claudeEgressIdentity.listClaudeEgressClientCerts();
  }

  /** Insert or replace a sandbox's client certificate, encrypting the key. A
   *  rotation upserts on the (project, person) key, dropping the superseded fingerprint. */
  async upsertClaudeEgressClientCert(record: ClaudeEgressClientCertRecord): Promise<void> {
    return this.claudeEgressIdentity.upsertClaudeEgressClientCert(record);
  }

  /** Drop one sandbox's client certificate, or every one of the project when no
   *  person is named (deprovision / revocation). */
  async deleteClaudeEgressClientCert(projectId: string, userId?: string): Promise<void> {
    return this.claudeEgressIdentity.deleteClaudeEgressClientCert(projectId, userId);
  }

  async reconcileDevServerHostPorts(projectId?: string): Promise<void> {
    return this.devServerConfigs.reconcileDevServerHostPorts(projectId);
  }

  async releaseProjectDevServerHostPorts(projectId: string): Promise<void> {
    return this.devServerConfigs.releaseProjectDevServerHostPorts(projectId);
  }

  async getProjectSettings(projectId: string): Promise<ProjectSettingsRecord | undefined> {
    return this.projectSettings.getProjectSettings(projectId);
  }

  /** Missing rows keep existing projects undecided until their first installation. */
  async getPackageProtectionDecision(
    projectId: string,
  ): Promise<'protected' | 'skipped' | 'undecided'> {
    const row = await this.db
      .selectFrom('project_package_protection')
      .select('decision')
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return row?.decision ?? 'undecided';
  }

  async setPackageProtectionDecision(
    projectId: string,
    decision: 'protected' | 'skipped',
  ): Promise<void> {
    await this.db
      .insertInto('project_package_protection')
      .values({ project_id: projectId, decision })
      .onConflict((conflict) => conflict.column('project_id').doUpdateSet({ decision }))
      .execute();
  }

  async getProjectSettingsRaw(projectId: string): Promise<ProjectSettingsRecord | undefined> {
    return this.projectSettings.getProjectSettingsRaw(projectId);
  }

  async updateProjectSettings(
    projectId: string,
    patch: ProjectSettingsPatch,
  ): Promise<ProjectSettingsRecord | undefined> {
    return this.projectSettings.updateProjectSettings(projectId, patch);
  }

  async appendProjectMemory(
    projectId: string,
    text: string,
  ): Promise<ProjectSettingsRecord | undefined> {
    return this.projectSettings.appendProjectMemory(projectId, text);
  }

  /** Read the master-password key-derivation metadata. */
  async getSecretKeyMeta(): Promise<SecretKeyMetaRecord | undefined> {
    return this.secretKeyMetadata.getSecretKeyMeta();
  }

  /** Persist the salt and verifier when a master password is set or changed. */
  async setSecretKeyMeta(meta: SecretKeyMetaRecord): Promise<void> {
    return this.secretKeyMetadata.setSecretKeyMeta(meta);
  }

  /** Return true only when this call initializes the key metadata. */
  async insertSecretKeyMetaIfAbsent(meta: SecretKeyMetaRecord): Promise<boolean> {
    return this.secretKeyMetadata.insertSecretKeyMetaIfAbsent(meta);
  }

  // ── Per-device API auth tokens (C1 auth gate) ─────────────────────────────
  // Stores only the SHA-256 hash of each token, no cipher envelope, so the auth
  // gate can validate a device while the store is still SEALED (same rationale
  // as secret_key_meta). The raw token is returned to the device exactly once.

  /** Persist a newly minted token (only its hash). */
  async insertAuthToken(record: {
    expiresAt?: number | null;
    id: string;
    tokenHash: string;
    label?: string | null;
    /** The person the device belongs to; absent → the column default (the administrator). */
    userId?: string;
  }): Promise<string> {
    return this.authTokens.insertAuthToken(record);
  }

  /** Every token hash currently valid — loaded once to seed the gate's in-memory
   *  set (avoids a DB round-trip on the per-request hot path). */
  async listAuthTokenHashes(): Promise<string[]> {
    return this.authTokens.listAuthTokenHashes();
  }

  /** Tokens as records (id + label + createdAt + lastSeenAt), newest first — the
   *  device-management view. Never exposes the token or its hash's usefulness. */
  async listAuthTokens(): Promise<AuthTokenRecord[]> {
    return this.authTokens.listAuthTokens();
  }

  /** Rename a paired device. Returns false when the id matches no row — a device
   *  revoked from another phone while this one had the rename field open. */
  async renameAuthToken(id: string, label: string): Promise<boolean> {
    return this.authTokens.renameAuthToken(id, label);
  }

  /** Stamp a device's last authenticated request. Called off the request's
   *  critical path and throttled by the registry, never per request. */
  async touchAuthToken(id: string, expiresAt?: number): Promise<void> {
    return this.authTokens.touchAuthToken(id, expiresAt);
  }

  /** Revoke a single device token by its public id. Returns true if a row went. */
  async deleteAuthToken(id: string): Promise<boolean> {
    return this.authTokens.deleteAuthToken(id);
  }

  /** Revoke every device token (e.g. on GitHub disconnect / master-password
   *  change) — forces all devices to re-authenticate. */
  async deleteAllAuthTokens(): Promise<void> {
    return this.authTokens.deleteAllAuthTokens();
  }

  /** Runtime backup policy is disabled explicitly by restore before any token cleanup. */
  async setBackupJournaling(enabled: boolean): Promise<void> {
    return this.authTokens.setBackupJournaling(enabled);
  }

  async listBackupRevocations(): Promise<{ id: string; deviceId: string; revokedAt: string }[]> {
    return this.authTokens.listBackupRevocations();
  }

  async acknowledgeBackupRevocation(id: string): Promise<void> {
    return this.authTokens.acknowledgeBackupRevocation(id);
  }

  /** Stable server-owned bookkeeping; identities never come from sandbox-written markers. */
  async backupGitRepositoryKey(projectId: string | null, path: string): Promise<string> {
    if (
      !path ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('Invalid backup Git bookkeeping path');
    const key = randomUUID();
    if (projectId === null) {
      await this.db
        .insertInto('backup_unassigned_git_repositories')
        .values({ path, repo_key: key })
        .onConflict((conflict) => conflict.column('path').doNothing())
        .execute();
      return (
        await this.db
          .selectFrom('backup_unassigned_git_repositories')
          .select('repo_key')
          .where('path', '=', path)
          .executeTakeFirstOrThrow()
      ).repo_key;
    }
    await this.db
      .insertInto('backup_git_repositories')
      .values({ project_id: projectId, path, repo_key: key })
      .onConflict((conflict) => conflict.columns(['project_id', 'path']).doNothing())
      .execute();
    const row = await this.db
      .selectFrom('backup_git_repositories')
      .select('repo_key')
      .where('project_id', '=', projectId)
      .where('path', '=', path)
      .executeTakeFirstOrThrow();
    return row.repo_key;
  }

  // ── Per-device Expo push tokens (ADR 0008, token registry) ────────────────

  /** Register or rotate the current Expo token for a paired device. An Expo
   * token can belong to only one pairing; moving it prunes the old binding. */
  async upsertDevicePushToken(record: {
    authTokenId: string;
    expoToken: string;
    platform: 'ios';
  }): Promise<void> {
    return this.devicePushTokens.upsertDevicePushToken(record);
  }

  async getDevicePushToken(authTokenId: string): Promise<DevicePushTokenRecord | undefined> {
    return this.devicePushTokens.getDevicePushToken(authTokenId);
  }

  /** The push tokens of the given users' devices, with the user each belongs to. */
  async listDevicePushTokensForUsers(
    userIds: readonly string[],
  ): Promise<(DevicePushTokenRecord & { userId: string })[]> {
    return this.devicePushTokens.listDevicePushTokensForUsers(userIds);
  }

  async listDevicePushTokens(): Promise<DevicePushTokenRecord[]> {
    return this.devicePushTokens.listDevicePushTokens();
  }

  /** Remove a dead Expo token. Its pending receipt work cascades in the DB. */
  async deleteDevicePushToken(expoToken: string): Promise<boolean> {
    return this.devicePushTokens.deleteDevicePushToken(expoToken);
  }

  /** Persist a successful Expo ticket only while its token is still current.
   * The shared row lock closes a rotation race: a concurrent token delete waits
   * for this insert, then cascades the newly-created receipt row. */
  async enqueuePushReceipt(record: {
    receiptId: string;
    expoToken: string;
    availableAt: number;
  }): Promise<boolean> {
    return this.devicePushTokens.enqueuePushReceipt(record);
  }

  async listDuePushReceipts(now: number, limit = 1_000): Promise<PushReceiptRecord[]> {
    return this.devicePushTokens.listDuePushReceipts(now, limit);
  }

  async reschedulePushReceipt(
    receiptId: string,
    availableAt: number,
    attempts: number,
  ): Promise<boolean> {
    return this.devicePushTokens.reschedulePushReceipt(receiptId, availableAt, attempts);
  }

  async deletePushReceipt(receiptId: string): Promise<boolean> {
    return this.devicePushTokens.deletePushReceipt(receiptId);
  }

  async upsertHttpMcpConnection(record: HttpMcpConnectionRecord): Promise<void> {
    return this.httpMcpConnections.upsertHttpMcpConnection(record);
  }

  async listHttpMcpConnections(ownerUserId?: string): Promise<HttpMcpConnectionRecord[]> {
    return this.httpMcpConnections.listHttpMcpConnections(ownerUserId);
  }

  /** Persist freshly issued OAuth tokens without resurrecting a connection that
   * was deleted while the provider request was in flight. */
  async updateHttpMcpOAuthTokens(
    id: string,
    tokens: { accessToken: string; refreshToken: string | null; expiresAt: Date | null },
  ): Promise<boolean> {
    return this.httpMcpConnections.updateHttpMcpOAuthTokens(id, tokens);
  }

  async deleteHttpMcpConnection(id: string): Promise<boolean> {
    return this.httpMcpConnections.deleteHttpMcpConnection(id);
  }

  async upsertProjectMcpBinding(binding: ProjectMcpBindingRecord): Promise<void> {
    return this.httpMcpConnections.upsertProjectMcpBinding(binding);
  }

  async listProjectMcpBindings(projectId: string): Promise<ProjectMcpBindingRecord[]> {
    return this.httpMcpConnections.listProjectMcpBindings(projectId);
  }

  async deleteProjectMcpBinding(projectId: string, connectionId: string): Promise<boolean> {
    return this.httpMcpConnections.deleteProjectMcpBinding(projectId, connectionId);
  }
}
