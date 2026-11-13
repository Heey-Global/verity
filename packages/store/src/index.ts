export {
  ProjectEgressStore,
  ProjectEgressError,
  canonicalEgressTarget,
  egressTargetKey,
  egressGrantCovers,
  type EgressTarget,
  type EgressPolicy,
  type EgressRequest,
  type EgressGrant,
} from './project-egress.js';
export {
  ForgeConnectionStore,
  type ForgeConnection,
  type ForgeConnectionProvider,
  type ForgeConnectionCredentials,
  type ForgeConnectionInput,
} from './forge-connections.js';
export {
  MatrixOutboundStore,
  type MatrixSendSnapshot,
  type MatrixDelivery,
  type MatrixDispatch,
} from './matrix-outbound.js';
export {
  createRequestLatencyTrace,
  withRequestLatencyTrace,
  measureLatencyPhase,
  recordRequestQuery,
  type RequestLatencyTrace,
} from './request-latency.js';
export {
  createPostgresDb,
  withUnpairedDeviceFence,
  migrateToLatest,
  holdPostgresControlPlaneLock,
  isPostgresConnectionClassError,
  CONTROL_PLANE_RECONNECT_BUDGET_MS,
  CONTROL_PLANE_RECONNECT_INTERVAL_MS,
  PostgresAdvisoryLockHeldError,
  PostgresControlPlaneGenerationTakenError,
  PostgresControlPlaneUnreachableError,
  SchemaGenerationAheadError,
  type ControlPlaneGenerationProof,
  type MigrateOptions,
  type PostgresAdvisoryLock,
  type PostgresControlPlaneFence,
  type PostgresControlPlaneLockOptions,
} from './db.js';
export {
  IntegrationStore,
  integrationImportCodes,
  type IntegrationImportDiagnostic,
  type IntegrationAccount,
  type IntegrationSource,
  type IntegrationEvent,
  type IntegrationEventKind,
  type IntegrationSourceStatus,
} from './integrations.js';
// NOTE: `createEmbeddedDb` (pglite) is deliberately NOT exported here. pglite is
// a devDependency and must stay out of every production import graph; the test
// harness reaches it through `@verity/store/testing`.
export {
  EventStore,
  defaultProjectName,
  InvalidProjectNameError,
  PROJECT_NAME_MAX_CHARS,
  SESSION_AUTOMATION_MAX_CONSECUTIVE_ERRORS,
  type EventSink,
  type PlanningConsent,
  RUNNER_FRAME_PROTOCOL_VERSION,
  type RunnerFrameIngest,
  type RunnerFrameIngestResult,
  type AttachmentBlob,
  type SequencedEvent,
  type SessionProjectionFacts,
  type SessionEventStats,
  type SessionRecord,
  type SessionPlanning,
  type SessionMockupState,
  type ProjectDesignLevel,
  type SessionMockupReview,
  type SessionMockups,
  type MockupScreenRecord,
  type MockupVerdict,
  storedMockupScreens,
  storedMockupState,
  type SessionSlideDeckRecord,
  type SessionWorkspaceFileRecord,
  type SessionGmailConnection,
  type SessionCalendarConnection,
  type SessionContactsConnection,
  type GoogleWorkspaceFileKind,
  type GoogleSlideImageCleanupRecord,
  type SessionInput,
  type RunningTurnRecord,
  type RunnerTurnOwnership,
  type RunnerTurnOwnershipRequest,
  type QueuedTurnRecord,
  type QueuedTurnInput,
  type ProjectRecord,
  type VeritySettingsPatch,
  type VeritySettingsRecord,
  type ProjectSettingsPatch,
  type ProjectAgent,
  PROJECT_AGENTS,
  ProjectDefaultModelNotAllowedError,
  type ProjectSettingsRecord,
  type HttpMcpConnectionRecord,
  httpMcpConnectionUsableBy,
  type ProjectMcpBindingRecord,
  type DevServerRecord,
  type DevServerCreateInput,
  type DevServerPatch,
  type DevServerDetectionStateRecord,
  type PublicPreviewShareRecord,
  type LocalPreviewShareRecord,
  type PublicPreviewShareCreateInput,
  type PublicPreviewShareState,
  type ClaudeEgressCaRecord,
  type ClaudeEgressClientCertRecord,
  DEV_SERVER_HOST_PORT_RANGES,
  DeletedProjectError,
  DevServerPortRangeExhaustedError,
  PROJECT_MEMORY_MAX_CHARS,
  ProjectMemoryTooLargeError,
  type ProjectUpsertInput,
  type ProjectReleaseStatus,
  type ProjectState,
  type ProjectKind,
  LOCAL_PROJECT_OWNER,
  isLocalProject,
  isSessionLinkProject,
  isInstallationPlaceholder,
  ProjectIdentityClaimConflict,
  type SessionAutomationRecord,
  type SessionAutomationStatus,
  type SessionAutomationInput,
  SessionAutomationWorkspaceChangedError,
  type SessionAutomationOutcome,
  type SecretKeyMetaRecord,
  type AuthTokenRecord,
  type DevicePushTokenRecord,
  type PushReceiptRecord,
} from './store.js';
export { TranscriptStore } from './transcript.js';
export {
  ManagedDevServerStore,
  ManagedDevServerConflictError,
  ManagedDevServerInputError,
  ManagedDevServerPortsFullError,
  managedDevServerNameKey,
  normalizeManagedDevServerWorkdir,
  normalizeManagedDevServerSecretBindings,
  managedDevServerBindingsEqual,
  type ManagedDevServerSecretBinding,
  type ManagedDevServerRecord,
  type ManagedDevServerInstanceRecord,
  type ManagedDevServerDesired,
  type ManagedDevServerState,
  type ManagedDevServerInstancePatch,
} from './managed-dev-servers.js';
export {
  TaskStore,
  TaskNotFoundError,
  TaskRevisionConflictError,
  TaskInputError,
  TASK_STATUSES,
  OPEN_TASK_STATUSES,
  TASK_TITLE_MAX,
  TASK_DETAIL_MAX,
  TASK_RESULT_MAX,
  TASK_ATTACHMENTS_MAX,
  type TaskRecord,
  type TaskInput,
  type TaskPatch,
  type TaskListFilter,
  type TaskAttachment,
  type TaskOrigin,
  type TaskStatus,
} from './tasks.js';
export {
  LiveMeetingStore,
  type LiveMeetingSyncRecord,
  type LiveMeetingNoteSyncRecord,
  type LiveMeetingInsight,
} from './live-meetings.js';
export {
  migrationProvider,
  latestMigrationKey,
  earliestMigrationKey,
  schemaCompatibilityWindow,
  type SchemaCompatibilityWindow,
  getExecutedMigrations,
  executedSchemaGeneration,
} from './migrations.js';
export { computeNextRun, validateSchedule, MIN_INTERVAL_MINUTES } from './schedule.js';
export {
  type SecretCipher,
  type SealableSecretCipher,
  createSecretCipher,
  createPassthroughCipher,
  createSealableSecretCipher,
  isEncrypted,
  SealedError,
} from './crypto.js';
export {
  deriveKeyFromPassword,
  generateSalt,
  createKeyVerifier,
  keyMatchesVerifier,
} from './secret-key.js';
export type {
  Database,
  EventsTable,
  SessionsTable,
  TranscriptLinesTable,
  QueuedTurnsTable,
  QueuedTurnOpts,
  VeritySettingsTable,
  ProjectSettingsTable,
  HttpMcpConnectionsTable,
  ProjectMcpBindingsTable,
  SecretKeyMetaTable,
  AuthTokenTable,
  DevicePushTokensTable,
  ProjectsTable,
  SessionBackendStateTable,
  SessionAutomationsTable,
  SecretRunGrantsTable,
  SecretApprovalsTable,
  SecretRevocationsTable,
  DevServerDetectionStateTable,
  PublicPreviewSharesTable,
  UplinkPendingShareRemovalsTable,
  ScheduleConfig,
} from './schema.js';

export * from './knowledge.js';

export * from './knowledge-sources.js';

export { redactSecrets, redactProcessStderr } from './redact.js';

export * from './google-accounts.js';
export * from './calendar-watch.js';

export * from './vulnerability-scan.js';

export type {
  LiveMeetingResult,
  LiveMeetingResultItem,
  LiveMeetingResultTask,
} from './live-meetings.js';

export {
  AssistantStore,
  type AssistantGrant,
  type AssistantMode,
  type AssistantRequest,
  type AssistantRequestClaim,
  type AssistantRequestKind,
  type AssistantSettings,
} from './assistant.js';

export {
  CLOSED_SCHEDULING_STATES,
  SchedulingStore,
  type CreateSchedulingDraft,
  type SchedulingColleague,
  type SchedulingHold,
  type SchedulingHoldState,
  type SchedulingRequest,
  type SchedulingDraftContent,
  type SchedulingRequestPatch,
  type SchedulingRequestState,
  type SchedulingShareBinding,
} from './scheduling.js';

export {
  RepairSupervisionStore,
  type RepairMandate,
  type ManualRepairProposal,
  type RepairIncident,
  type RepairMode,
} from './repair-supervision.js';

export { QAAssignmentStore, type QAAssignment, type QAAssignmentState } from './qa-assignments.js';

export {
  UserContextStore,
  ContextConflictError,
  INSTRUCTIONS_MAX_CHARS,
  USER_MEMORY_MAX_CHARS,
  validateContext,
  type UserContext,
} from './user-context.js';
export {
  UserProfileStore,
  DISPLAY_NAME_MAX_CHARS,
  normalizeDisplayName,
  type UserProfile,
} from './user-profile.js';
export { UserGitIdentityStore, type UserGitIdentity } from './user-git-identity.js';
export { UserDopplerConnectionStore } from './user-doppler-connection.js';
export {
  UserProviderConnectionStore,
  type ProviderConnectionKind,
  type UserProviderConnection,
  type UserProviderConnectionStatus,
} from './user-provider-connections.js';
export {
  ProjectSandboxStore,
  type ProjectSandboxRecord,
  type ProjectSandboxState,
} from './project-sandboxes.js';
export {
  UserGithubAuthorizationStore,
  type UserGithubAuthorization,
} from './user-github-authorization.js';

export {
  ViewStateStore,
  INBOX_DISMISSED_MAX,
  INBOX_KEY_MAX_CHARS,
  nextInboxDismissed,
  type ProjectViewState,
  type SessionViewState,
  type ViewSubject,
} from './view-state.js';

export {
  ProjectRepositoryStore,
  defaultProjectRepository,
  projectForRepository,
  type ProjectRepositoryRecord,
  type AddProjectRepositoryInput,
  type SessionRepositoryWorkspaceRecord,
} from './project-repositories.js';

export {
  WIKI_OCCASION_BODY_LIMIT,
  WikiMaintenanceStore,
  WikiOccasionStore,
  type WikiMaintenanceRecord,
  type RecordWikiOccasion,
  type WikiOccasion,
  type WikiOccasionKind,
} from './wiki-occasions.js';

export {
  ProjectInquiryStore,
  type ProjectInquiry,
  type ProjectInquiryGrant,
} from './project-inquiries.js';
