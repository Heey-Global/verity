export { splitLines } from './lines.js';
export {
  NoSessionInitError,
  SessionWriter,
  isNoSessionInitFailure,
  type IngestHooks,
} from './ingest.js';
// Re-export the permission decision/request types so server/app consumers of the
// conductor's permission API (#27) don't reach into @verity/adapter-claude.
export type { PermissionDecision, PermissionRequest } from '@verity/adapter-claude';
export { InMemoryEventBus, type EventBus, type EventListener, type EventObserver } from './bus.js';
export {
  type QueryInput,
  type RunResult,
  type RunTurnOptions,
  type SpawnedProcess,
  type SpawnOptions,
  type Spawner,
} from './backend-contract.js';
export { createBrokerSpawner } from './broker-spawner.js';
export {
  brokeredGrantChannel,
  isRunnerSupervisorBackend,
  RUNNER_SUPERVISOR_BACKENDS,
  type Backend,
  type BrokeredGrantChannel,
  type RunnerSupervisorBackend,
} from './backend.js';
export { AcpClaudeBackend } from './acp-claude-backend.js';
export { AcpCodexBackend } from './acp-codex-backend.js';
export { AcpOpenCodeBackend, openCodeMode } from './acp-opencode-backend.js';
export { AcpEventAdapter, AcpTextStream, finalAcpTextEvents } from './acp-adapter.js';
export {
  CODEX_DEFAULT_MODEL,
  CODEX_MODEL_PREFIX,
  isCodexModel,
  parseCodexModel,
} from './codex-model.js';
export {
  BackendTerminationUnconfirmedError,
  Conductor,
  PermissionDecisionInProgressError,
  QueueFullError,
  SessionBusyError,
  UnknownSessionError,
  WorktreeMissingError,
  brokeredGrantTarget,
  brokeredGrantToolName,
  type BrokeredGrantToolName,
  worktreeExists,
  type ConductorDeps,
  type ExternalPermissionAnswer,
  type PermissionDecisionSource,
  type StartOptions,
  type TurnOptions,
  type TurnPreparationContext,
} from './conductor.js';
export { ALLOWED_PERMISSION_MODES, assertSafeArgs, nodeSpawner } from './runner.js';
export {
  PROCESS_TREE_KILL_GRACE_MS,
  collectEscapedProcessTree,
  collectProcessTree,
  signalProcessTree,
} from './process-tree.js';
export {
  LoopbackRunnerClient,
  type RunnerClient,
  type RunnerClientFactory,
  type RunnerAttachTarget,
  type RunnerServer as RunnerServerContract,
  type RunnerTurn,
  type StartTurnHooks,
} from './runner-contract.js';
export {
  tailFrames,
  writeFrame,
  stampFrame,
  frameBodyHash,
  type FrameSink,
  type RunnerFrame,
  type RunnerFrameBody,
  type RunnerFrameEnvelope,
} from './runner-transport.js';
export {
  readRunnerState,
  writeRunnerState,
  initialRunnerTurnState,
  type RunnerTurnState,
  type RunnerTurnStatus,
} from './runner-state.js';
export {
  RunnerServer,
  type RunnerServerRunOptions,
  type RunnerServerTurn,
} from './runner-server.js';
export {
  MAX_SUPERVISOR_REQUEST_BYTES,
  DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS,
  START_TURN_ACCEPT_TIMEOUT_MS,
  START_TURN_RESULT_TIMEOUT_MS,
  START_TURN_RECONCILE_TIMEOUT_MS,
  START_TURN_ARTIFACT_TIMEOUT_MS,
  START_TURN_MISSING_STATE_MIN_MS,
  TrustedCliDispatchError,
  RunnerWorkerStartFailure,
  SupervisorStartRequestError,
  requestRunnerSupervisor,
  requestRunnerSupervisorStart,
  runSupervisorTrustedCli,
  trustedCliDispatchMessage,
  SupervisorRunnerClient,
  SupervisorRunnerRecovery,
  type SupervisorRunnerClientOptions,
  type SupervisorRunnerRecoveryOptions,
  type SupervisorStartTelemetry,
  type RunnerWorkerFailureReason,
  type TrustedCliExecutionInput,
  type TrustedCliExecutionResult,
  type TrustedCliDispatchStage,
  type TrustedCliBrokerFailurePhase,
} from './runner-supervisor-client.js';
export {
  FileTailRunnerClient,
  runnerFrameIngestEnvelope,
  type FileTailRunnerClientDeps,
} from './file-tail-runner-client.js';
export type { RunnerTranscriptSink } from './runner-transcript-sink.js';
export {
  serveControl,
  connectControl,
  inspectControl,
  ControlCommandRejectedError,
  ControlDeliveryUnknownError,
  type ControlHandlers,
  type ControlAck,
  type ControlCommandOptions,
  type ControlEnvelope,
  type ControlRejectReason,
  type ControlReply,
  type ControlRequest,
  type ControlSocketClient,
  type ControlSocketServer,
} from './runner-control.js';
export { buildTitlePrompt, sanitizeTitle } from './session-title.js';
export {
  lifecycleSignalsFromMeta,
  StructuredLifecycleMapper,
  type StructuredLifecycleSignal,
} from './structured-lifecycle.js';
export {
  CLAUDE_PROJECTS_DIRNAME,
  encodeCwd,
  initialTailState,
  materializeToDisk,
  readAppended,
  restoreIfMissing,
  syncOnce,
  syncTranscript,
  transcriptPath,
  type TailState,
} from './transcript-sync.js';
