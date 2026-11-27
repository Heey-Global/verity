import { SessionOrderStore } from './session-order.js';
import { PackageProtectionStore } from './package-protection.js';
import { AttendeeStateStore } from './attendee-state.js';
import { EventHistoryStore, type SequencedEvent } from './event-history.js';
export type { SequencedEvent } from './event-history.js';
import { EventSnapshotStore } from './event-snapshots.js';
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
export { DeletedProjectError } from './deleted-project-error.js';
import { ProjectAccessStore } from './project-access.js';
import { ProjectLifecycleStore } from './project-lifecycle.js';
import { ProjectChangeFeed } from './project-changes.js';
import {
  type ProjectState,
  type ProjectSetupState,
  type ProjectKind,
  type ProjectRecord,
  type ProjectReleaseStatus,
  type ProjectUpsertInput,
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
import type { SessionMockups } from './session-mockups.js';
import { PlanImplementationStore, type PlanningConsent } from './plan-implementation.js';
export type { PlanningConsent } from './plan-implementation.js';
import { SessionPlanningStore, type SessionPlanning } from './session-planning.js';
import type { SessionRecord } from './session-rows.js';
import { CapacityLeaseStore } from './capacity-leases.js';
import {
  SessionProjectionStore,
  type SessionEventStats,
  type SessionProjectionFacts,
} from './session-projection.js';
export type { SessionEventStats, SessionProjectionFacts } from './session-projection.js';
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
  GoogleWorkspaceStore,
  type GoogleWorkspaceFileKind,
  type SessionWorkspaceFileRecord,
  type SessionSlideDeckRecord,
  type GoogleSlideImageCleanupRecord,
} from './google-workspace.js';
export type {
  GoogleWorkspaceFileKind,
  SessionWorkspaceFileRecord,
  SessionSlideDeckRecord,
  GoogleSlideImageCleanupRecord,
} from './google-workspace.js';
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
import type { AgentEvent } from '@verity/events';
import type { Kysely } from 'kysely';
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
import { StarterProjectStore } from './starter-projects.js';
import {
  SessionAutomationStore,
  type SessionAutomationInput,
  type SessionAutomationOutcome,
  type SessionAutomationRecord,
  type SessionAutomationStatus,
} from './session-automations.js';
import { SessionPullRequestStore } from './session-pull-requests.js';
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

export type { SessionRecord } from './session-rows.js';

export type {
  SessionLinkRecord,
  SessionLinkReservation,
  PendingSessionLinkMessage,
} from './session-links.js';

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
export type { SessionPlanning } from './session-planning.js';

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
  /** Project writes, announced after they commit for live views (ADR 0033). */
  readonly projectChanges = new ProjectChangeFeed();
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

  private readonly planImplementation = new PlanImplementationStore(
    () => this.db,
    () => this.cipher,
    () => this.eventWrites,
    () => this.messageProjection,
  );
  private readonly sessionPlanning = new SessionPlanningStore(() => this.db);
  private readonly sessionPullRequests = new SessionPullRequestStore(() => this.db);
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

  private readonly attendeeState = new AttendeeStateStore(
    () => this.db,
    () => this.cipher,
  );

  async getAttendeeState<T>(id: string): Promise<T | undefined> {
    return this.attendeeState.getAttendeeState<T>(id);
  }

  async putAttendeeState(id: string, state: unknown): Promise<void> {
    return this.attendeeState.putAttendeeState(id, state);
  }

  async listAttendeeState<T>(): Promise<Array<{ id: string; state: T }>> {
    return this.attendeeState.listAttendeeState<T>();
  }

  async deleteAttendeeState(id: string): Promise<void> {
    return this.attendeeState.deleteAttendeeState(id);
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

  async getLastCreatedSessionModel(projectId: string | null): Promise<string | undefined> {
    return this.sessionLifecycle.getLastCreatedSessionModel(projectId);
  }

  getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.sessionLifecycle.getSession(sessionId);
  }

  /** The session owning a primary worktree, without loading every session. */
  getSessionByWorktree(worktree: string): Promise<SessionRecord | undefined> {
    return this.sessionLifecycle.getSessionByWorktree(worktree);
  }

  async getSessionWorkspaceFile(
    sessionId: string,
  ): Promise<SessionWorkspaceFileRecord | undefined> {
    return this.googleWorkspace.getSessionWorkspaceFile(sessionId);
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
    return this.googleWorkspace.setSessionWorkspaceFile(input);
  }

  async setSessionSlideDeck(
    input: Omit<Parameters<EventStore['setSessionWorkspaceFile']>[0], 'kind'>,
  ): Promise<SessionSlideDeckRecord> {
    return this.setSessionWorkspaceFile({ ...input, kind: 'slides' });
  }

  async clearSessionWorkspaceFile(sessionId: string): Promise<void> {
    return this.googleWorkspace.clearSessionWorkspaceFile(sessionId);
  }

  async clearSessionSlideDeck(sessionId: string): Promise<void> {
    return this.googleWorkspace.clearSessionSlideDeck(sessionId);
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

  private readonly googleWorkspace = new GoogleWorkspaceStore(
    () => this.db,
    () => this.googleAccounts,
  );
  readonly sessionProjections = new SessionProjectionStore(() => this.db);
  private readonly eventHistory = new EventHistoryStore(() => this.db);
  private readonly eventSnapshots = new EventSnapshotStore(() => this.db);
  private readonly starterProjects = new StarterProjectStore(() => this.db);
  private readonly projectLifecycle = new ProjectLifecycleStore(
    () => this.db,
    (id) => this.getProject(id),
    this.projectChanges,
  );

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
    return this.googleWorkspace.updateSessionWorkspaceRevision(sessionId, assignmentId, revisionId);
  }

  async updateSessionSlideDeckRevision(
    sessionId: string,
    assignmentId: string,
    revisionId: string,
  ): Promise<boolean> {
    return this.updateSessionWorkspaceRevision(sessionId, assignmentId, revisionId);
  }

  async listRecentGoogleWorkspaceFileIds(limit?: number, accountId?: string): Promise<string[]> {
    return this.googleWorkspace.listRecentGoogleWorkspaceFileIds(limit, accountId);
  }

  async listRecentGoogleSlideDeckFileIds(limit?: number, accountId?: string): Promise<string[]> {
    return this.googleWorkspace.listRecentGoogleSlideDeckFileIds(limit, accountId);
  }

  async createGoogleSlideImageCleanup(input: {
    accountId?: string | null;
    id: string;
    sessionId: string;
    fileId: string;
  }): Promise<void> {
    return this.googleWorkspace.createGoogleSlideImageCleanup(input);
  }

  async setGoogleSlideImageCleanupPermission(id: string, permissionId: string): Promise<void> {
    return this.googleWorkspace.setGoogleSlideImageCleanupPermission(id, permissionId);
  }

  async markGoogleSlideImageCleanupReady(id: string): Promise<void> {
    return this.googleWorkspace.markGoogleSlideImageCleanupReady(id);
  }

  async failGoogleSlideImageCleanup(id: string, error: string): Promise<void> {
    return this.googleWorkspace.failGoogleSlideImageCleanup(id, error);
  }

  async completeGoogleSlideImageCleanup(id: string): Promise<void> {
    return this.googleWorkspace.completeGoogleSlideImageCleanup(id);
  }

  async listGoogleSlideImageCleanups(limit?: number): Promise<GoogleSlideImageCleanupRecord[]> {
    return this.googleWorkspace.listGoogleSlideImageCleanups(limit);
  }

  async claimGoogleSlideInvocation(input: {
    invocationId: string;
    sessionId: string;
    turnId: string;
  }): Promise<{ status: 'claimed' | 'pending' } | { status: 'completed'; result: unknown }> {
    return this.googleWorkspace.claimGoogleSlideInvocation(input);
  }

  async completeGoogleSlideInvocation(invocationId: string, result: unknown): Promise<void> {
    return this.googleWorkspace.completeGoogleSlideInvocation(invocationId, result);
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
    return this.googleWorkspace.getCompletedGoogleWorkspaceInvocation(input);
  }

  async completeGoogleWorkspaceInvocation(invocationId: string, result: unknown): Promise<void> {
    await this.completeGoogleSlideInvocation(invocationId, result);
  }

  async pruneGoogleSlideInvocations(olderThan: Date): Promise<void> {
    return this.googleWorkspace.pruneGoogleSlideInvocations(olderThan);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.sessionLifecycle.listSessions();
  }

  /** Overview positions are separate from the chronological session registry. */
  private readonly sessionOrder = new SessionOrderStore(() => this.db);

  async sessionSortOrders(sessions: readonly SessionRecord[]): Promise<Map<string, number>> {
    return this.sessionOrder.sessionSortOrders(sessions);
  }

  async reorderSessions(projectId: string | null, ids: readonly string[]): Promise<string[]> {
    return this.sessionOrder.reorderSessions(projectId, ids);
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
    return this.sessionMoves.replaceLocalSessionWorkspace(
      sessionId,
      projectId,
      previous,
      next,
      note,
    );
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
    return this.sessionLifecycle.renameSession(sessionId, name);
  }

  /** Mark a session as a favorite; returns false when the session is unknown. */
  async setSessionFavorite(sessionId: string, favorite: boolean): Promise<boolean> {
    return this.sessionLifecycle.setSessionFavorite(sessionId, favorite);
  }

  /**
   * Guarded auto-title write: set the name ONLY if it is still null. Returns true
   * if it named the session, false if a name was already set — e.g. the operator
   * renamed it DURING the (up to ~45s) title generation. The `name IS NULL`
   * predicate is enforced atomically at write time, so auto-titling can never
   * clobber an operator's manual rename (the TOCTOU the unguarded rename had).
   */
  async renameSessionIfUnnamed(sessionId: string, name: string): Promise<boolean> {
    return this.sessionLifecycle.renameSessionIfUnnamed(sessionId, name);
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
    return this.sessionLifecycle.setSessionModel(sessionId, model);
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
    return this.sessionPlanning.setSessionPlanning(sessionId, planning, from, expectedRevision);
  }

  async startSessionPlanning(sessionId: string): Promise<boolean> {
    return this.sessionPlanning.startSessionPlanning(sessionId);
  }

  async presentSessionPlan(sessionId: string, plan: string): Promise<number | undefined> {
    return this.sessionPlanning.presentSessionPlan(sessionId, plan);
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
    return this.sessionPlanning.updateSessionMockups(sessionId, change, expectedPlanningRevision);
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
    return this.starterProjects.recordStarterProject(projectId);
  }

  /** Explicit tour replay restores only the recorded starter, never a name match. */
  async ensureReplayStarterProject(input: ProjectUpsertInput): Promise<ProjectRecord> {
    return this.starterProjects.ensureReplayStarterProject(input);
  }

  async getStarterWelcomeSessionId(): Promise<string | undefined> {
    return this.starterProjects.getStarterWelcomeSessionId();
  }

  async recordStarterWelcomeSession(sessionId: string): Promise<void> {
    return this.starterProjects.recordStarterWelcomeSession(sessionId);
  }

  async getStarterProjectId(): Promise<string | undefined> {
    return this.starterProjects.getStarterProjectId();
  }

  /**
   * Record that a server-authored automation already fired for this session. Returns
   * `true` only for the first caller that inserts the marker; concurrent/repeated
   * attempts for the same `(session, marker)` return `false`.
   */
  async markSessionAutomation(sessionId: string, marker: string): Promise<boolean> {
    return this.sessionAutomations.markSessionAutomation(sessionId, marker);
  }

  /** Keep a terminal PR hidden after the workspace first changes, across restarts. */
  async observeSessionPrVisibility(
    sessionId: string,
    worktree: string,
    url: string,
    fingerprint: string,
  ): Promise<boolean> {
    return this.sessionPullRequests.observeSessionPrVisibility(
      sessionId,
      worktree,
      url,
      fingerprint,
    );
  }

  async getSessionPrVisibility(
    sessionId: string,
    worktree: string,
    url: string,
  ): Promise<{ fingerprint: string; hidden: boolean } | undefined> {
    return this.sessionPullRequests.getSessionPrVisibility(sessionId, worktree, url);
  }

  /** Seed the final baseline after managed post-merge housekeeping has settled. */
  async clearSessionPrVisibility(sessionId: string, worktree: string, url: string): Promise<void> {
    return this.sessionPullRequests.clearSessionPrVisibility(sessionId, worktree, url);
  }

  async resetSessionPrVisibility(
    sessionId: string,
    worktree: string,
    url: string,
    fingerprint: string,
  ): Promise<void> {
    return this.sessionPullRequests.resetSessionPrVisibility(sessionId, worktree, url, fingerprint);
  }

  /** Reserve before transport: a crash spends a bounded attempt instead of resetting it. */
  async claimPrReadyDelivery(
    sessionId: string,
    marker: string,
    now: number,
  ): Promise<string | undefined> {
    return this.sessionPullRequests.claimPrReadyDelivery(sessionId, marker, now);
  }

  async finishPrReadyDelivery(
    sessionId: string,
    marker: string,
    claim: string,
    outcome: 'done' | 'failed' | 'unattempted',
    now: number,
  ): Promise<void> {
    return this.sessionPullRequests.finishPrReadyDelivery(sessionId, marker, claim, outcome, now);
  }

  async hasSessionAutomationMarker(sessionId: string, marker: string): Promise<boolean> {
    return this.sessionAutomations.hasSessionAutomationMarker(sessionId, marker);
  }

  async deleteSessionAutomationMarker(sessionId: string, marker: string): Promise<boolean> {
    return this.sessionAutomations.deleteSessionAutomationMarker(sessionId, marker);
  }

  /** Constant-size log marker; a never-written session has no stats row. */
  async getSessionEventStats(sessionId: string): Promise<SessionEventStats | undefined> {
    return this.eventHistory.getSessionEventStats(sessionId);
  }

  async latestEventSeq(sessionId: string): Promise<number> {
    return this.eventHistory.latestEventSeq(sessionId);
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
    return this.eventWrites.reserveBackgroundDispatch(id, sessionId);
  }

  async admitBackgroundDispatch(
    id: string,
    sessionId: string,
    event: AgentEvent,
  ): Promise<{ seq: number; ts: number; existing: boolean; markerId?: string } | undefined> {
    return this.eventWrites.admitBackgroundDispatch(id, sessionId, event);
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
   * tests cannot be overtaken by what it writes, and {@link EventWriteStore.withSessionEventAppend}
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
    return this.eventSnapshots.getLatestDevServersEvent(sessionId);
  }

  /** Fetch one app snapshot without hydrating the surrounding transcript. */
  async getMcpAppEvent(
    sessionId: string,
    appId: string,
  ): Promise<Extract<AgentEvent, { t: 'mcp_app' }> | undefined> {
    return this.eventSnapshots.getMcpAppEvent(sessionId, appId);
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
    return this.eventHistory.getEventsBeforeSeq(sessionId, limit, beforeSeq);
  }

  /** The user behind the session's most recent prompt that names one, or `undefined`
   *  when no prompt in the session has an initiator. */
  async latestPromptInitiator(sessionId: string): Promise<{ userId: string } | undefined> {
    return this.eventHistory.latestPromptInitiator(sessionId);
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
    return this.eventHistory.promptInitiatorAt(sessionId, seq);
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
    return this.eventHistory.getEventsAfter(sessionId, afterSeq, limit);
  }

  async listSessionProjectionFacts(
    sessionIds: readonly string[],
    tailLimit: number,
  ): Promise<Map<string, SessionProjectionFacts>> {
    return this.sessionProjections.listSessionProjectionFacts(sessionIds, tailLimit);
  }

  async listSessionProjectionEvents(
    sessionIds: readonly string[],
    throughSeq?: number,
  ): Promise<Map<string, SequencedEvent[]>> {
    return this.sessionProjections.listSessionProjectionEvents(sessionIds, throughSeq);
  }

  async visitSessionProjectionEvents(
    boundaries: ReadonlyMap<string, number>,
    visit: (sessionId: string, events: SequencedEvent[]) => Promise<void>,
  ): Promise<void> {
    return this.sessionProjections.visitSessionProjectionEvents(boundaries, visit);
  }

  async listRecentSessionProjectionEvents(
    sessionId: string,
    limit: number,
  ): Promise<SequencedEvent[]> {
    return this.sessionProjections.listRecentSessionProjectionEvents(sessionId, limit);
  }

  async latestSessionTurnControlEvent(
    sessionId: string,
    afterSeq: number,
  ): Promise<SequencedEvent | undefined> {
    return this.sessionProjections.latestSessionTurnControlEvent(sessionId, afterSeq);
  }

  async sessionHasTaskLifecycleEvent(sessionId: string): Promise<boolean> {
    return this.sessionProjections.sessionHasTaskLifecycleEvent(sessionId);
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
    return this.planImplementation.enqueuePlanImplementation(input, revision, onPersisted, consent);
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
    return this.eventWrites.drainQueuedTurn(id, sessionId, event);
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

  private readonly packageProtection = new PackageProtectionStore(() => this.db);

  /** Missing rows keep existing projects undecided until their first installation. */
  async getPackageProtectionDecision(
    projectId: string,
  ): Promise<'protected' | 'skipped' | 'undecided'> {
    return this.packageProtection.getPackageProtectionDecision(projectId);
  }

  async setPackageProtectionDecision(
    projectId: string,
    decision: 'protected' | 'skipped',
  ): Promise<void> {
    return this.packageProtection.setPackageProtectionDecision(projectId, decision);
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
