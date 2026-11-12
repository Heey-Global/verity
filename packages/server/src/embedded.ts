import { MaintenanceImages, MaintenanceImageError } from './maintenance-image.js';
import { ProjectEgressInventoryError } from './project-egress-inventory-error.js';
import {
  resolveInstallationListToken,
  resolveRepoWorktreeFetchAuthHeader,
  isProjectSettingsReader,
  materializeControlPlaneAgentEnv,
  startClaudeCredentialSync,
  withControlPlaneAgentCredentials,
  prepareControlPlaneRunnerForTurn,
  isUntaggedImageRepository,
  startRunnerSupervisorReconciler,
  CONTROL_PLANE_RUNNER_PROJECT_ID,
  SWEEP_SHUTDOWN_WAIT_MS,
  candidateRunnerProjectIds,
  acpSupervisorWiringRefusal,
  rejectLatestImageRef,
  publishedDevcontainerFeatureRef,
  toolkitFeatureRefIsConfigured,
  resolveToolkitFeatureRef,
  devcontainerProvisionerOptionsForDockerBaseUrl,
  branchRenameAppliesToSession,
  createProjectTurnPreparationSerializer,
  syncProjectsFromInstallation,
  readBundledDevcontainerFeature,
  refreshProjectGitHubToken,
  createProjectWorktreeFactory,
} from './embedded-support.js';
export {
  resolveInstallationListToken,
  resolveRepoWorktreeFetchAuthHeader,
  materializeControlPlaneAgentEnv,
  startClaudeCredentialSync,
  withControlPlaneAgentCredentials,
  prepareControlPlaneRunnerForTurn,
  startRunnerSupervisorReconciler,
  candidateRunnerProjectIds,
  parseNonNegativeInt,
  parseDefaultOnFlag,
  parsePushEnabled,
  acpSupervisorWiringRefusal,
  parseByteSize,
  parseSwapSize,
  parseCpuCores,
  devcontainerBuildOptionsForDockerBaseUrl,
  normalizeFeatureTag,
  publishedDevcontainerFeatureRef,
  toolkitFeatureRefIsConfigured,
  resolveToolkitFeatureRef,
  devcontainerProvisionerOptionsForDockerBaseUrl,
  branchRenameAppliesToSession,
  createProjectTurnPreparationSerializer,
  syncProjectsFromInstallation,
  readBundledDevcontainerFeature,
  refreshProjectGitHubToken,
  createProjectWorktreeFactory,
} from './embedded-support.js';
import type { EmbeddedServerConfig, EmbeddedServer, EmbeddedSecretJobs } from './embedded-types.js';
export type { EmbeddedServerConfig, EmbeddedServer } from './embedded-types.js';
import {
  buildRunnerConductorWiring,
  runnerSandboxPath,
  RUNNER_CONTAINER_PROJECT_ROOT,
} from './embedded-runner-wiring.js';
export {
  buildRunnerConductorWiring,
  runnerSandboxPath,
  runnerAuthorizationProjectId,
  RUNNER_CONTAINER_PROJECT_ROOT,
} from './embedded-runner-wiring.js';
import { resolveForgeRepositoryBinding } from './forge-repository-binding.js';
import { createProjectEgressInventorySynchronizer } from './project-egress-system-inventory.js';
import { AGENT_SKILL_MANIFEST_HASH } from '@verity/events';
import { resolveAgentContext } from './agent-context.js';
import { createGitHubQAAnalysis } from './github-qa-analysis.js';
import { projectDecisionDirectory } from './knowledge-decisions.js';
import {
  StorageReclamation,
  requestNativeReclamation,
  readNativeReclamation,
} from './storage-reclamation.js';
import { registerStorageReclamationRoutes } from './storage-reclamation-routes.js';
import { startNativeRetirementEvidence } from './native-buildkit.js';
import type { GitOutput } from './branches.js';
import { SessionStorage, storageHold } from './session-storage.js';
import { RunnerCacheStorage } from './runner-cache-storage.js';
import {
  RunnerCacheMaintenance,
  reclaimSleepingRunnerCaches,
  cacheMaintenanceFailure,
} from './runner-cache-maintenance.js';
import {
  retireStoppedContainers,
  retireCompletedUpdateContainers,
} from './stopped-container-gc.js';
import type { DockerGcReport } from './docker-gc.js';
import { createServerLogSource } from './server-log-source.js';
import {
  selectBranchStatus,
  createForgeStatusCache,
  type ForgeStatusIdentity,
} from './forge-status-cache.js';
import type { ForgeDiscoveryPage, PullRequestStatus } from './forge-provider.js';
import type { ProjectPullRequestBackend } from './project-pull-requests.js';
import { createBuildDiagnosticStore } from './build-diagnostics.js';
import { brokeredDopplerBindingId } from './brokered-doppler-binding.js';
import { BuildStorage } from './build-storage.js';
import { createProjectImageReferences } from './derived-image-references.js';
import { pinToolkitFeature, releaseToolkitFeature } from './devcontainer-feature-pin.js';
import { createGoogleAccountAccessToken } from './google-account-token.js';
import { createMatrixTool } from './matrix-tool.js';
import { createManagedDevServerSecretResolver } from './managed-dev-server-secrets.js';
import { CoordinatedRecordingManager } from './coordinated-recording.js';
import { ReturnPathActivation } from './remote-return-path-activation.js';
import { returnPathSelection } from './remote-return-path-diagnostics.js';
import { ensureStarterProject } from './welcome-session.js';
import { createGhcrForgeAdapter } from './brokered-forge-ghcr.js';
import { loadForgePackageMap } from './brokered-forge-package-map.js';
import { createBrokeredForgeProxy } from './brokered-http-tool.js';
import { createForgejoForgeAdapter } from './brokered-forge-forgejo.js';
import { ForgejoTransport } from './forgejo-transport.js';
import { createGitHubForgeAdapter } from './brokered-forge-github.js';
import { brokeredHttpStreamTransport } from './brokered-http-stream.js';
import { issueGatewayServerCertificate } from './claude-egress-ca.js';
import { loadForgeProxyIdentity } from './brokered-forge-identity.js';
import { MANAGED_CONTROL_PLANE_RUNNER_NAME } from './self-update/managed-control-plane-runner.js';
import { previewSharingCapability } from './preview-capability.js';
import { LocalPreviewManager } from './local-preview-manager.js';
import { localPreviewPorts } from './local-preview-ports.js';
import { ManagedDevServerManager } from './managed-dev-server-manager.js';
import { ListenerDiscovery } from './listener-discovery.js';
import { getDockerExecDiagnostics } from './docker-exec-diagnostics.js';
export { parsePort } from './deployment-port.js';
import { sandboxNotReadyError } from '@verity/events';
import {
  classifyProbeError,
  parseEgressReadiness,
  waitForSandboxTurnReadiness,
  type SandboxEgressProbe,
} from './sandbox-turn-readiness.js';
import {
  ALLOWED_PERMISSION_MODES,
  AcpClaudeBackend,
  AcpCodexBackend,
  AcpOpenCodeBackend,
  CODEX_DEFAULT_MODEL,
  InMemoryEventBus,
  isCodexModel,
  isRunnerSupervisorBackend,
  requestRunnerSupervisor,
  brokeredGrantTarget,
  brokeredGrantToolName,
  encodeCwd,
  runnerSupervisorBackendLabel,
  type Backend,
  type RunnerSupervisorBackend,
  type TurnPreparationContext,
} from '@verity/session';
import {
  createPostgresDb,
  createSealableSecretCipher,
  EventStore,
  keyMatchesVerifier,
  migrateToLatest,
  migrationProvider,
  SealedError,
  TranscriptStore,
  type Database,
  type ProjectRecord,
  httpMcpConnectionUsableBy,
} from '@verity/store';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Kysely } from 'kysely';

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { chmod, chown, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchCodexBundledModels, startCodexModelCatalog } from './codex-model-catalog.js';

import { buildControlPlane } from './app.js';
import { createRuntimeDiagnostics } from './runtime-diagnostics.js';
import { createProjectListCache } from './project-list-cache.js';

import { createAuthTokenRegistry } from './auth.js';
import { CONTROL_PLANE_PROJECT_ID, ensureControlPlaneProject } from './control-plane-project.js';
import { createTrustedCliOutputStore } from './trusted-cli-output.js';
import { createMcpGatewayToolExecutor, createTrustedCliPreflight } from './mcp-gateway-tools.js';
import { createGoogleSlidesTool } from './google-slides-tool.js';
import { createGoogleDocsTool } from './google-docs-tool.js';
import { createGoogleContactsTool } from './google-contacts-tool.js';
import { createGoogleCalendarTool } from './google-calendar-tool.js';
import { createGmailTool } from './gmail-tool.js';
import { createGoogleSheetsTool } from './google-sheets-tool.js';
import { createGoogleDriveAgentTool } from './google-drive-agent-tool.js';
import { createExpoPushTransport, createPushSender } from './push-sender.js';
import {
  createGitWorktreeProvisioner,
  repairAdminGitdirs,
  repairProjectAdminGitdirs,
} from './worktree.js';
import { createGitBranchService } from './branches.js';
import { type GitHubInstallationService } from './github.js';
import { projectForgeProvider } from './project-forge-provider.js';
import { createGitHubForgeProvider } from './github-forge-provider.js';
import { DockerError, createDockerClient, parseUnixBaseUrl, type DockerClient } from './docker.js';
import {
  describeBuildCapacityReclamation,
  startDockerGcScheduler,
  runDockerGc,
} from './docker-gc.js';
import { sweepOrphanedLocalPreviews } from './local-preview-orphans.js';
import {
  PreviewShareConflictError,
  PreviewShareManager,
  sweepOrphanedPreviewShares,
} from './preview-share-manager.js';
import { UplinkControlClient, premiumFeatureSwitches } from './uplink-control-client.js';
import { applyPremiumFeatureSwitches } from './premium-feature-switches.js';
import { createRemoteConnectorPool, remoteDataUrlForControl } from './remote-control-connector.js';
import { createDeferredLogger } from './deferred-logger.js';
import { createDockerGvisorRuntimeVerifier } from './docker-gvisor-runtime-verifier.js';
import {
  PINNED_PROJECT_RUNSC_ARGS,
  PINNED_RUNSC_ARGS,
  PINNED_RUNSC_PATH,
  PROJECT_RUNSC_RUNTIME,
} from './gvisor-runtime-config.js';
import { createBrokeredSecretJobExecutor } from './brokered-secret-job-executor.js';
import { createSecretAuditRecorder } from './secret-audit-recorder.js';
import { createPostgresSecretAuditLog } from './secret-audit-log.js';
import { createPostgresAuditLog, type AuditServerIdentity } from './audit-log.js';
import { createAuditRecorder } from './audit-recorder.js';
import { runtimeServerVersion } from './runtime-version.js';
import { createGatewayRequestMacKeyring, gatewayRequestMac } from './gateway-request-mac.js';
import { createTurnCredentials } from './turn-credentials.js';
import { createMcpGatewayTokens } from './mcp-gateway-tokens.js';
import type { McpGatewayDeps } from './mcp-gateway.js';
import { createSecretEnvelopeSealer } from './secret-envelope-crypto.js';
import { createPostgresSecretGrantStore, createSecretGrantBroker } from './secret-grant-broker.js';
import {
  createDopplerSecretNameLister,
  createDopplerSecretResolver,
  DopplerSecretResolutionError,
  listDopplerProjectSecretNames,
  resolveDopplerProjectSecret,
} from './doppler-secret-resolver.js';

import { createPostgresSecretJobFrameSpool } from './secret-job-frame-spool.js';
import { createSecretJobService } from './secret-job-service.js';
import { registerSecretJobRoutes } from './secret-job-routes.js';
import { createPostgresSecretJobStore } from './secret-job-store.js';
import { createPostgresSecretProviderCatalog } from './secret-provider-catalog.js';
import { registerSecretProviderRoutes } from './secret-provider-routes.js';
import { createPostgresSecretRevocationStore } from './secret-revocation.js';
import { createSecretWorkerRecipientKeyRegistry } from './secret-worker-recipient-key-registry.js';
import type { RunGrantClaims } from '@verity/secret-contracts';
import {
  createRuntimeReadinessGate,
  validateRuntimeReadinessTtl,
} from './runtime-readiness-gate.js';
import {
  queueSessionCleanup,
  pendingSessionCleanups,
  createSessionCleanupProcessor,
  deleteRunnerSessionHome,
  createSessionCleanupWorker,
} from './pending-session-cleanup.js';

import { sweepOrphanArtifacts, type SweepResult } from './session-artifact-sweep.js';
import { removeRetiredSessionSandboxes } from './retired-session-sandboxes.js';
import {
  purgeSessionArtifacts as purgeSessionArtifactFiles,
  type SessionArtifactScope,
} from './session-artifacts.js';
import {
  createGitHubAppInstallationTokenMint,
  createGitHubAppProjectTokenMint,
  createCachedProjectTokenMint,
  PROJECT_GITHUB_TOKEN_PERMISSIONS,
  REGISTRY_GITHUB_TOKEN_PERMISSIONS,
  validateGitHubAppCreds,
  resolveGitHubAppIdentity,
  type GitHubAppCreds,
  type GitHubAppIdentityResult,
} from './github-app-token.js';
import { defaultManifestConvert } from './github-manifest.js';
import { createGhTokenCapabilityRegistry } from './github-token-broker.js';
import { createSigningCapabilityRegistry } from './signing-capability.js';
import { readOrMigrateProjectOverview } from './project-overview-file.js';
import { validateDopplerToken, listDopplerProjects, listDopplerConfigs } from './doppler-token.js';
import {
  ProvisionerImpl,
  DeprovisionerImpl,
  projectClonePath,
  gitAuthHeader,
  devcontainerBuilderIdle,
  projectNetworkName,
  ensureOpenCodeSettingsMaterialized,
  materializeOpenCodeSettings,
  type ProjectRelayControl,
  type ProjectImageRefSource,
  type DevcontainerFeatureSource,
} from './provisioner.js';
import { ProjectSandboxLifecycleTelemetry } from './project-lifecycle-telemetry.js';
import { trustedToolkitIdentity } from './runner-boundary-attestation.js';
import { selectedOpenCodeModels } from './opencode-model-selection.js';
import { reportToolkitDrift } from './toolkit-drift.js';
import { defaultSshKeygenSpawner } from './signing-key.js';
import { requestArrivedInternally } from './internal-listener.js';

import { containerPathFor, DockerExecBackend, dockerHostFor } from './project-backend.js';
import {
  createSleepingSessionGit,
  sandboxIsRunning,
  createSandboxGit,
  withSleepingSessionGit,
} from './sandbox-git.js';
import { projectSettingsEnv } from './project-settings-env.js';
import { createNodeRestrictedHttpJsonTransport } from './restricted-http-json-connector.js';
import { createBrokeredHttpConsumptionStore } from './brokered-http-consumption.js';
import { createBrokeredHttpGrantStore } from './brokered-http-grants.js';
import { createBrokeredHttpTool } from './brokered-http-tool.js';
import { createTrustedCliTool } from './trusted-cli-tool.js';
import { reconcileProjectContainerStates } from './project-state.js';
import { ClaudeOAuthResolutionError } from './claudeUsage.js';
import type { CodexUsageCredentialProvider } from './codexUsage.js';
import {
  createClaudeEgressIdentityService,
  type ClaudeEgressIdentityService,
} from './claude-egress-identity.js';
import type { ClaudeEgressMtlsMaterial, ClaudeEgressPeerBinding } from './claude-egress-mtls.js';
import { projectedAgentGatewayFingerprint } from './agent-gateway-projection.js';
import {
  agentGatewayUnavailableMessage,
  type AgentGatewayRepairFailure,
  claudeEgressAgentEnv,
  claudeEgressRelayHealthy,
  claudeEgressRouteEnabled,
  claudeProjectEgressRefusal,
  claudeTransportRefusal,
} from './claude-egress-agent-env.js';
import { CONTAINER_GENERATION_LABEL } from './project-relay-migration.js';
import { ensureProjectSandboxReadyForTurn } from './project-auto-wake.js';
import { projectRelayContainerName } from './project-relay-docker.js';
import { createProjectRelayRuntime } from './project-relay-runtime.js';
import type { ProjectRelayLifecycle } from './project-relay-lifecycle.js';
import { ProjectEgressLifecycle } from './project-egress-lifecycle.js';
import { projectEgressAvailability } from './project-egress-health.js';
import { createProtectedDevcontainerBuilder } from './protected-devcontainer-builder.js';
import { createProtectedBuildClient } from './project-egress-build-client.js';
import { createProjectEgressHostClient } from './project-egress-host-client.js';
import { readCodexAccessToken, type AgentGatewayConfiguration } from './agent-gateway-control.js';
import {
  startAgentGatewaySynchronizer,
  type AgentGatewaySynchronizer,
} from './agent-gateway-sync.js';
import { validateAgentGatewayRoutingConfig } from './agent-gateway-url.js';
import { DockerProjectRuntime } from './project-runtime.js';
import { DEFAULT_SANDBOX_IMAGE_FALLBACK } from './sandbox-artifacts.js';
import { createSandboxUpdateChecker } from './sandbox-updates.js';
import { adoptHandedOffSecretKey } from './self-update/secret-key-adopter.js';
import { notifyManagedMatrixConfigured } from './self-update/server-update-controller.js';
import { SERVER_COMPAT } from './self-update/compat.js';
import { openBackupRuntime } from './backup/runtime.js';

import type { VeritySettingsRecord } from '@verity/store';

/**
 * Compose the control-plane server for a single-host deployment: a real Postgres
 * store via `databaseUrl` (the production entrypoint always sets it), the
 * in-memory event bus, and the conductor over the runner's local `claude`. A
 * store is mandatory — the hermetic test harness supplies its TEST-ONLY pglite
 * through {@link EmbeddedServerConfig.openDatabase} rather than through an
 * implicit fallback, so production can only ever open Postgres. The caller
 * `listen()`s and calls {@link EmbeddedServer.close} on shutdown. This is the
 * testable wiring behind the `main.ts` entrypoint.
 */
export async function buildEmbeddedServer(
  config: EmbeddedServerConfig = {},
): Promise<EmbeddedServer> {
  const untypedConfig = config as EmbeddedServerConfig & Record<string, unknown>;
  for (const removed of [
    'signingBrokerUrl',
    'sandboxNetwork',
    'perProjectNetwork',
    'selfContainerName',
  ]) {
    if (untypedConfig[removed] !== undefined) {
      throw new Error(`${removed} was removed; project relay wiring is mandatory`);
    }
  }
  if (
    config.permissionMode !== undefined &&
    !(ALLOWED_PERMISSION_MODES as readonly string[]).includes(config.permissionMode)
  ) {
    throw new Error(
      `invalid permissionMode "${config.permissionMode}": expected one of ${ALLOWED_PERMISSION_MODES.join(', ')}`,
    );
  }
  if (
    config.secretJobRuntimeRequired === true &&
    config.secretJobRuntimeReadiness === undefined &&
    config.dockerBaseUrl === undefined
  ) {
    throw new Error('dockerBaseUrl is required when the Secret Job runtime is required');
  }
  validateRuntimeReadinessTtl(config.secretJobRuntimeReadinessTtlMs);
  if (config.secretJobs !== undefined) {
    if (
      (config.secretJobs.resolveSecrets === undefined) ===
      (config.secretJobs.doppler === undefined)
    ) {
      throw new Error('Secret Jobs require exactly one of resolveSecrets or doppler');
    }
    if (
      config.secretJobs.doppler !== undefined &&
      config.secretJobs.authorizeProviderAdministration === undefined
    ) {
      throw new Error('Doppler Secret Jobs require provider administration authorization');
    }
    if (config.dockerBaseUrl === undefined) {
      throw new Error('dockerBaseUrl is required when Secret Jobs are configured');
    }
    if (!config.dockerBaseUrl.startsWith('unix://')) {
      throw new Error('Secret Jobs require a unix Docker socket for authenticated attach');
    }
    const { socketPath } = parseUnixBaseUrl(config.dockerBaseUrl);
    if (!socketPath.startsWith('/') || socketPath === '/') {
      throw new Error('Secret Jobs require an absolute, non-empty unix Docker socket path');
    }
    if (!isUntaggedImageRepository(config.secretJobs.executorImageRepository)) {
      throw new Error('Secret Job executor image repository must be an untagged repository');
    }
  }

  // Fail closed rather than silently opening an ephemeral store: a deployment
  // that lost its DATABASE_URL must not come up looking healthy on an empty
  // database. main.ts checks this earlier and with a friendlier message; this is
  // the guard for every other caller of the wiring.
  let db: Kysely<Database>;
  if (config.openDatabase !== undefined) {
    db = config.openDatabase(config);
  } else if (config.databaseUrl !== undefined) {
    db = createPostgresDb(config.databaseUrl, config.controlPlaneFence);
  } else {
    throw new Error('buildEmbeddedServer: databaseUrl is required (Verity runs on PostgreSQL)');
  }
  // The same release-controlled promise `main.ts` gives the control-plane
  // migration, and it has to be given here too: a Server start runs both, so a
  // bridge build tolerated at the first call and refused at this one is not
  // tolerated at all — it is the identical crash one stack frame later.
  await migrateToLatest(db, migrationProvider, { forwardMax: SERVER_COMPAT.schema.max });
  // At-rest secret encryption (ADR 0002 D3). A sealable cipher holds the key in
  // memory only; secret columns are AES-256-GCM encrypted before they touch the
  // DB. The key normally arrives ONE way: the operator sets/enters a master
  // password via POST /secret/init | /secret/unlock (onboarding through the app),
  // which derives the key (scrypt). There is no headless/env-key auto-unlock —
  // the one other way in is `adoptedSecretKeyMaterial`, the key the Server this
  // process replaces held in memory and sealed to it during a self-update
  // (ADR 0008 D8). That path never touches disk or the environment and still
  // checks the stored verifier, so it carries an already-entered password across
  // an update rather than adding a second way to obtain one. While sealed,
  // non-secret settings still work; writing/reading a secret fails with a clear
  // 503 until unlock.
  const secretCipher = createSealableSecretCipher();
  const eventStore = new EventStore(db, secretCipher);
  const systemInventorySync =
    config.projectEgressSocketPath && config.projectEgressKeyPath
      ? createProjectEgressInventorySynchronizer({
          enabled: config.projectEgressInventoryRequired ?? (() => false),
          command: createProjectEgressHostClient({
            socketPath: config.projectEgressSocketPath,
            token: () => readFileSync(config.projectEgressKeyPath!, 'utf8').trim(),
          }),
          readUrls: () => eventStore.readEgressDestinationUrls(),
          transaction: (action) => eventStore.withEgressDestinationTransaction(action),
        })
      : undefined;
  if (systemInventorySync) eventStore.setEgressDestinationMutation(systemInventorySync.mutate);
  // A controller restart starts incomplete; periodic re-synchronization repairs
  // that state. Configuration writes always use the synchronous prechange barrier.
  const synchronizeSystemInventory = () =>
    systemInventorySync?.refresh().catch((error: unknown) => {
      console.warn('verity: system destination inventory synchronization unavailable', {
        operation: 'inventory-refresh',
        reason: error instanceof ProjectEgressInventoryError ? error.reason : 'host_not_ready',
        ...(error instanceof ProjectEgressInventoryError && error.correlationId
          ? { correlationId: error.correlationId }
          : {}),
      });
    });
  await synchronizeSystemInventory();
  const systemInventoryTimer = systemInventorySync
    ? setInterval(() => void synchronizeSystemInventory(), 10_000)
    : undefined;
  systemInventoryTimer?.unref();

  if (config.controlPlaneRunner === true) {
    await ensureControlPlaneProject(eventStore);
  }
  const googleAccessToken = createGoogleAccountAccessToken(eventStore, {
    isSealed: () => secretCipher.isSealed(),
  });
  const googleSlidesTool = createGoogleSlidesTool({ eventStore, googleAccessToken });
  const invokeGoogleSlides = googleSlidesTool.invoke;
  const googleDocsTool = createGoogleDocsTool({ eventStore, googleAccessToken });
  const invokeGoogleDocs: typeof googleDocsTool.invoke = (input) => googleDocsTool.invoke(input);
  const googleSheetsTool = createGoogleSheetsTool({ eventStore, googleAccessToken });
  const invokeGoogleSheets: typeof googleSheetsTool.invoke = (input) =>
    googleSheetsTool.invoke(input);
  const googleContactsTool = createGoogleContactsTool({ eventStore, googleAccessToken });
  const invokeGoogleContacts: typeof googleContactsTool.invoke = (input) =>
    googleContactsTool.invoke(input);
  const googleCalendarTool = createGoogleCalendarTool({ eventStore, googleAccessToken });
  const invokeGoogleCalendar: typeof googleCalendarTool.invoke = (input) =>
    googleCalendarTool.invoke(input);
  const matrixTool = createMatrixTool({ eventStore });
  const gmailTool = createGmailTool({ eventStore, googleAccessToken });
  const invokeGmail: typeof gmailTool.invoke = (input) => gmailTool.invoke(input);
  const googleDriveTool = createGoogleDriveAgentTool({ eventStore, googleAccessToken });
  const invokeGoogleDrive: typeof googleDriveTool.invoke = (input) => googleDriveTool.invoke(input);
  const readBrokerDopplerCredential = (): Promise<Buffer | undefined> =>
    eventStore.getDopplerServiceTokenBytes();
  const brokeredHttpConsumptions = createBrokeredHttpConsumptionStore(db);
  const brokeredHttpGrants = createBrokeredHttpGrantStore(db);
  const restrictedHttpTransport = createNodeRestrictedHttpJsonTransport();
  const getBrokeredProjectBinding = async (projectId: string) => {
    const settings = await eventStore.getProjectSettings(projectId);
    const dopplerProject = settings?.dopplerProject?.trim();
    const dopplerConfig = settings?.dopplerConfig?.trim();
    return !dopplerProject || !dopplerConfig ? undefined : { dopplerProject, dopplerConfig };
  };
  const resolveBrokerDopplerSecret = async (
    input: Omit<Parameters<typeof resolveDopplerProjectSecret>[0], 'token'>,
  ): Promise<Uint8Array> => {
    const token = await readBrokerDopplerCredential();
    if (token === undefined) {
      throw new DopplerSecretResolutionError(
        'Secret resolution failed during Doppler authentication. No secret value was exposed.',
        'Doppler authentication',
      );
    }
    try {
      return await resolveDopplerProjectSecret({ ...input, token });
    } finally {
      token.fill(0);
    }
  };
  const brokeredHttpTool = createBrokeredHttpTool({
    requireApprovalBinding: true,
    getProjectBinding: getBrokeredProjectBinding,
    resolveSecret: resolveBrokerDopplerSecret,
    consumeApproval: (input) => brokeredHttpConsumptions.consume(input),
    transport: restrictedHttpTransport,
  });
  const trustedCliOutput = createTrustedCliOutputStore(db, secretCipher);
  const trustedCliTool = createTrustedCliTool({
    requireApprovalBinding: true,
    outputStore: trustedCliOutput,
    getProjectBinding: getBrokeredProjectBinding,
    resolveSecret: resolveBrokerDopplerSecret,
    consumeApproval: (input) => brokeredHttpConsumptions.consume(input),
  });
  // ── Loopback MCP gateway (ADR 0014) ───────────────────────────────────────
  // An ACP session has no model-specific tool relay, so the brokered tools reach it as an MCP
  // server on the project's own internal socket. Everything here is the half that lives
  // outside the Sandbox: the per-turn bearer, the keyed request MAC, the audit append and
  // the tool invocation. The approval seam is bound in `buildServer`, to the conductor that
  // owns the session's permission cards — see `ServerDeps.mcpGateway`.
  const secretAuditLog = createPostgresSecretAuditLog(db);
  const gatewayRequestMacKeys = createGatewayRequestMacKeyring(db, secretCipher);
  // The turn's badge: names the person a supervised turn runs for to sandbox routes.
  const turnCredentials = createTurnCredentials();
  const mcpGatewayTokens = createMcpGatewayTokens({
    onResolveRejected: (input) => {
      // Keep the bearer and its digest out of logs. The reason and the two already-known
      // project identities are enough to distinguish a stale turn from a relay binding bug.
      console.warn(`verity: MCP gateway bearer rejected ${JSON.stringify(input)}`);
    },
  });
  const mcpProxyTokens = createMcpGatewayTokens();
  const mcpGateway: Omit<McpGatewayDeps, 'requestApproval'> = {
    // Trusted CLI needs the project supervisor: it is the authority that proves this bearer
    // still names a live turn whose start request enabled execution. Deployments without the
    // supervisor omit the tool completely rather than advertising a permanently failing call.
    servedTools:
      config.runnerSupervisor === true && config.dataVolumeRoot !== undefined
        ? [
            'verity_http_request',
            'verity_secret_run',
            'verity_secret_output',
            'verity_publish_session_progress',
            'verity_send_session_message',
            'verity_project_inquiry',
            'verity_list_linked_sessions',
            'verity_start_planning',
            'verity_present_plan',
            'verity_end_planning',
            'verity_present_mockups',
            'verity_complete_mockups',
            'verity_tasks',
            'verity_repairs',
            'verity_qa_analysis',
            'verity_app_help',
            'verity_vulnerabilities',
            'verity_google_slides',
            'verity_google_docs',
            'verity_knowledge',
            'verity_memory_append',
            'verity_google_sheets',
            'verity_gmail',
            'verity_matrix',
            'verity_google_calendar',
            'verity_scheduling',
            'verity_google_contacts',
            'verity_google_drive',
          ]
        : [
            'verity_http_request',
            'verity_publish_session_progress',
            'verity_send_session_message',
            'verity_project_inquiry',
            'verity_list_linked_sessions',
            'verity_start_planning',
            'verity_present_plan',
            'verity_end_planning',
            'verity_present_mockups',
            'verity_complete_mockups',
            'verity_tasks',
            'verity_repairs',
            'verity_qa_analysis',
            'verity_app_help',
            'verity_vulnerabilities',
            'verity_google_slides',
            'verity_google_docs',
            'verity_knowledge',
            'verity_memory_append',
            'verity_google_sheets',
            'verity_gmail',
            'verity_matrix',
            'verity_google_calendar',
            'verity_scheduling',
            'verity_google_contacts',
            'verity_google_drive',
          ],
    // Control-plane session tools are handled in `buildServer`, which owns session
    // creation and dispatch. Keep their advertisement scoped to the control project.
    extraToolsForProject: (projectId) =>
      projectId === CONTROL_PLANE_RUNNER_PROJECT_ID
        ? [
            'verity_diagnostics',
            'verity_list_sessions',
            'verity_session_handoff',
            'verity_session_progress',
            'verity_recent_session_messages',
            // Advertised to every Control session; only the assistant session may call it.
            'verity_assistant',
          ]
        : [],
    authorizationSnapshot: async ({ projectId, toolName }) => {
      if (toolName !== 'verity_http_request' && toolName !== 'verity_secret_run') return undefined;
      const binding = await getBrokeredProjectBinding(projectId);
      if (binding === undefined) throw new Error('project Doppler binding is unavailable');
      return JSON.stringify(binding);
    },
    resolveCaller: (input) => Promise.resolve(mcpGatewayTokens.resolve(input)),
    ...(config.runnerSupervisor === true && config.dataVolumeRoot !== undefined
      ? {
          authorizeCall: createTrustedCliPreflight({
            runnerRoot: join(config.dataVolumeRoot, 'runners'),
          }),
        }
      : {}),
    // Both tools reuse the brokered execution implementations, including their at-most-once
    // approval fence. The gateway bearer supplies the project/session/turn identity; its
    // fresh call id makes consumption exact for this approved invocation.
    invokeTool: createMcpGatewayToolExecutor({
      brokeredHttpTool: brokeredHttpTool,
      trustedCliTool,
      trustedCliOutput,
      ...(config.runnerSupervisor === true && config.dataVolumeRoot !== undefined
        ? { runnerRoot: join(config.dataVolumeRoot, 'runners') }
        : {}),
      googleSlides: invokeGoogleSlides,
      googleDocs: invokeGoogleDocs,
      googleSheets: invokeGoogleSheets,
      gmail: invokeGmail,
      matrix: (input) => matrixTool.invoke(input),
      googleCalendar: invokeGoogleCalendar,
      googleContacts: invokeGoogleContacts,
      googleDrive: invokeGoogleDrive,
    }),
    recordCall: async ({ projectId, kind, ...gateway }) => {
      await secretAuditLog.append({
        projectId,
        kind,
        aliases: [],
        providerBindings: [],
        gateway,
        recordedAt: new Date().toISOString(),
      });
    },
    requestMac: async ({ projectId, request }) => {
      const key = await gatewayRequestMacKeys.active();
      try {
        return { requestMac: gatewayRequestMac(key, projectId, request), macKeyId: key.keyId };
      } finally {
        key.material.fill(0);
      }
    },
  };

  const brokeredGrantBindingId = async (projectId: string): Promise<string | undefined> => {
    const binding = await getBrokeredProjectBinding(projectId);
    if (binding === undefined) return undefined;
    return brokeredDopplerBindingId(binding);
  };
  // ADR 0011 D3: secret NAMES (never values) for the turn context, so the agent
  // stops guessing aliases. Briefly cached; every failure degrades to "no list".
  const brokeredAliasCache = new Map<string, { names: readonly string[]; expiresAt: number }>();
  const brokeredSecretAliases = async (projectId: string): Promise<readonly string[]> => {
    const cached = brokeredAliasCache.get(projectId);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.names;
    if (cached !== undefined) brokeredAliasCache.delete(projectId);
    const binding = await getBrokeredProjectBinding(projectId);
    if (binding === undefined) return [];
    let names: readonly string[];
    let ttlMs = 60_000;
    let token: Uint8Array | undefined;
    try {
      token = await readBrokerDopplerCredential();
      if (token === undefined) throw new Error('broker Doppler identity is unavailable');
      names = await listDopplerProjectSecretNames({
        dopplerProject: binding.dopplerProject,
        dopplerConfig: binding.dopplerConfig,
        token,
      });
    } catch {
      // Keep provider outages best-effort without paying the same network timeout
      // at the start of every turn. Retry soon enough to recover automatically.
      names = [];
      ttlMs = 10_000;
    } finally {
      token?.fill(0);
    }
    if (brokeredAliasCache.size >= 256) {
      const oldestProjectId = brokeredAliasCache.keys().next().value;
      if (oldestProjectId !== undefined) brokeredAliasCache.delete(oldestProjectId);
    }
    brokeredAliasCache.set(projectId, { names, expiresAt: Date.now() + ttlMs });
    return names;
  };
  const secretKeyMeta = await eventStore.getSecretKeyMeta();
  const hasMasterPassword = secretKeyMeta !== undefined;
  // The one non-interactive way in (ADR 0008 D8): a Server promoted by a
  // self-update carries the key its predecessor already held in memory, so an
  // update the operator asked for once does not end at a password prompt. It is
  // only checked here — a key that does not match the stored verifier would
  // encrypt new secrets under a divergent one, so it is dropped rather than
  // used. Applying it is deliberately left until the build is finished: see the
  // adoption below.
  let handedOffKeyMaterial: string | undefined;
  if (config.adoptedSecretKeyMaterial !== undefined) {
    if (
      secretKeyMeta !== undefined &&
      keyMatchesVerifier(config.adoptedSecretKeyMaterial, secretKeyMeta.verifier)
    ) {
      handedOffKeyMaterial = config.adoptedSecretKeyMaterial;
    } else {
      console.warn(
        'verity: the key handed over by the previous Server does not match this store — staying sealed',
      );
    }
  }
  // A usable handed-off key says nothing here, because the store is still sealed
  // at this point by design and about to be unlocked below. Either outcome of
  // that adoption is reported when it is known, so this must not first announce
  // a store it is neither describing nor going to leave alone.
  if (secretCipher.isSealed() && handedOffKeyMaterial === undefined) {
    console.warn(
      hasMasterPassword
        ? 'verity: secret store is SEALED — a master password is set but not entered. ' +
            'Unlock via POST /secret/unlock before secrets (GitHub App key, signing key, Doppler) are available.'
        : 'verity: secret store is UNINITIALIZED and SEALED — set a master password via ' +
            'POST /secret/init before storing secrets.',
    );
  }
  // Control-plane API auth gate (audit C1). Master-password only: it flips on the
  // moment /secret/init sets the first password. Before that the store is
  // uninitialized and the gate is open so onboarding can reach /secret/init — the
  // deployment must sit behind a trusted network/firewall until then (documented
  // first-run behaviour).
  const authRegistry = await createAuthTokenRegistry(eventStore, {
    enabled: hasMasterPassword,
  });
  // Git committer identity and all onboarding state (GitHub App credentials,
  // signing key, Doppler) come exclusively from DB/secret-store writes made
  // through the app — never from deployment env or mounted files. The identity in
  // particular is derived from the GitHub App installation during signing-key
  // onboarding (resolveGitHubAppIdentity), so there is nothing to seed here.
  // One-time heal: worktrees whose admin `gitdir` git cannot follow — left
  // relative by an earlier version, or absolute with a container-side `/work`
  // prefix — are `prunable`, so a `prune`/gc silently deregisters a still-live
  // session. Rewrite those to the path git expects at startup. Best-effort: a
  // heal failure must never block server boot.
  //
  // The multi-project runner deliberately leaves `repoDir` EMPTY (see the branch
  // switcher below) and keeps one clone per project under `hostCloneRoot`, so
  // gating the heal on `repoDir` alone silently disabled it for every project on
  // exactly the deployment that spawns the most sessions. Heal per project clone
  // there too — deliberately a second `if`, not an `else`: a deployment that
  // configures both a server repo AND project clones must heal both.
  if (config.repoDir) {
    try {
      repairAdminGitdirs(config.repoDir);
    } catch {
      // ignore — new spawns are unaffected; only pre-existing landmines stay
    }
  }
  if (config.hostCloneRoot) {
    try {
      repairProjectAdminGitdirs(config.hostCloneRoot);
    } catch {
      // ignore — new spawns are unaffected; only pre-existing landmines stay
    }
  }
  // Branch switcher for each session's worktree (#91). A dev checkout may provide
  // one global repo root; the multi-project runner deliberately sets VERITY_REPO_DIR=''
  // and instead resolves repo-wide git operations through each session worktree.
  const branches =
    config.repoDir || config.hostCloneRoot
      ? createGitBranchService({
          ...(config.repoDir ? { repoDir: config.repoDir } : {}),
          baseBranch: 'main',
          ...(config.dockerBaseUrl && config.hostCloneRoot
            ? {
                withGit: async (worktree, operation) => {
                  const docker = projectDocker;
                  if (!docker) throw new Error('Project Docker runtime is unavailable');
                  const session = (await eventStore.listSessions()).find(
                    (s) => s.worktree === worktree,
                  );
                  if (!session) throw new Error('Git requires persistent session context');
                  const project = await eventStore.getProject(
                    session.projectId ?? CONTROL_PLANE_PROJECT_ID,
                  );
                  if (!project) throw new Error('Project is unavailable');
                  const containerName =
                    project.kind === 'control_plane' && config.controlPlaneRunner === true
                      ? MANAGED_CONTROL_PLANE_RUNNER_NAME
                      : project.containerName;
                  const hostRoot = projectClonePath(config.hostCloneRoot!, project);
                  if (!(await sandboxIsRunning(() => docker.inspectContainer(containerName)))) {
                    if (config.dataVolume && !dataVolumeRoot)
                      throw new Error('Data volume root is unavailable');
                    return withSleepingSessionGit(
                      {
                        docker,
                        templateContainer: containerName,
                        fallback: {
                          imageId:
                            typeof defaultProjectImage === 'function'
                              ? await defaultProjectImage()
                              : defaultProjectImage,
                          runtime: PROJECT_RUNSC_RUNTIME,
                          memoryBytes: 512 * 1024 ** 2,
                          nanoCpus: 1_000_000_000,
                          pidsLimit: 128,
                        },
                        projectId: project.id,
                        hostRoot,
                        dockerBaseUrl: config.dockerBaseUrl,
                        ...(config.dataVolume
                          ? { dataVolume: { name: config.dataVolume, root: dataVolumeRoot! } }
                          : {}),
                      },
                      operation,
                    );
                  }
                  return operation(
                    createSandboxGit({
                      containerName,
                      hostRoot,
                      dockerBaseUrl: config.dockerBaseUrl,
                      inspect: () => docker.inspectContainer(containerName),
                      timeoutMs: 10_000,
                    }),
                  );
                },
                git: async (args: readonly string[]) => {
                  // Repository helpers must run with the same privileges as the agent.
                  const index = args.indexOf('-C');
                  const path = index < 0 ? undefined : args[index + 1];
                  const session = (await eventStore.listSessions()).find(
                    (row) => row.worktree === path,
                  );
                  if (!session || !projectDocker)
                    throw new Error('Git operation has no project session context');
                  const project = await eventStore.getProject(
                    session.projectId ?? CONTROL_PLANE_PROJECT_ID,
                  );
                  if (!project) throw new Error('Project is unavailable');
                  const containerName =
                    project.kind === 'control_plane' && config.controlPlaneRunner === true
                      ? MANAGED_CONTROL_PLANE_RUNNER_NAME
                      : project.containerName;
                  const readOnly =
                    [
                      'rev-parse',
                      'for-each-ref',
                      'symbolic-ref',
                      'reflog',
                      'status',
                      'diff',
                      'log',
                      'show',
                      'merge-base',
                      'show-ref',
                    ].includes(args[index + 2] ?? '') ||
                    (args[index + 2] === 'worktree' && args[index + 3] === 'list');
                  if (
                    readOnly &&
                    !(await sandboxIsRunning(() => projectDocker.inspectContainer(containerName)))
                  ) {
                    if (config.dataVolume && !dataVolumeRoot)
                      throw new Error('Data volume root is unavailable');
                    return createSleepingSessionGit({
                      docker: projectDocker,
                      templateContainer: containerName,
                      fallback: {
                        imageId:
                          typeof defaultProjectImage === 'function'
                            ? await defaultProjectImage()
                            : defaultProjectImage,
                        runtime: PROJECT_RUNSC_RUNTIME,
                        memoryBytes: 512 * 1024 ** 2,
                        nanoCpus: 1_000_000_000,
                        pidsLimit: 128,
                      },
                      projectId: project.id,
                      hostRoot: projectClonePath(config.hostCloneRoot!, project),
                      ...(config.dataVolume
                        ? {
                            dataVolume: { name: config.dataVolume, root: dataVolumeRoot! },
                          }
                        : {}),
                      dockerBaseUrl: config.dockerBaseUrl,
                    })(args);
                  }
                  return createSandboxGit({
                    containerName: containerName,
                    hostRoot: projectClonePath(config.hostCloneRoot!, project),
                    dockerBaseUrl: config.dockerBaseUrl,
                    inspect: () => projectDocker.inspectContainer(containerName),
                  })(args);
                },
              }
            : {}),
        })
      : undefined;
  // GitHub App creds resolve from Verity settings only. The App private key lives
  // encrypted in the DB/secret store; deployment env must not pre-configure or
  // override onboarding state.
  const resolveGithubAppCreds = async (): Promise<GitHubAppCreds | undefined> => {
    const s = await eventStore.getVeritySettings();
    if (s?.githubAppId && s.githubAppPrivateKey && s.githubAppInstallationId) {
      return {
        appId: s.githubAppId,
        privateKey: s.githubAppPrivateKey,
        installationId: s.githubAppInstallationId,
      };
    }
    return undefined;
  };
  const baseMintOpts = { resolveCreds: resolveGithubAppCreds };
  const githubAppAuthorityKey = async (): Promise<string | undefined> => {
    const credentials = await resolveGithubAppCreds();
    if (credentials === undefined) return undefined;
    return createHash('sha256')
      .update(credentials.appId)
      .update('\0')
      .update(credentials.installationId)
      .update('\0')
      .update(credentials.privateKey)
      .digest('hex');
  };
  // The per-project sandbox token — scoped to a LEAST-PRIVILEGE subset (audit M2)
  // instead of inheriting the full installation grant. The subset lives in
  // PROJECT_GITHUB_TOKEN_PERMISSIONS (push branches incl. `.github/workflows/*`,
  // open PRs, manage issues, and inspect/administer Actions runs).
  // Repo scope is still `[project.repo]`.
  // Minting fails closed until the installation has approved this complete set;
  // silently dropping a denied permission would give the sandbox a misleading token.
  const projectTokenMint =
    config.githubProjectTokenMint ??
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: PROJECT_GITHUB_TOKEN_PERMISSIONS,
    });

  const discoveryTokenMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: {
        metadata: 'read',
        actions: 'read',
      },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const discoveryPrTokenMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: { metadata: 'read', pull_requests: 'read' },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const repositoryStatusTokenMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      // Optional legacy statuses must not prevent minting the shared PR reader.
      // QA analysis uses a separate statuses token and reports missing access.
      permissions: { metadata: 'read', pull_requests: 'read', checks: 'read', actions: 'read' },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const analysisChecksMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: { metadata: 'read', checks: 'read' },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const analysisStatusesMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: { metadata: 'read', statuses: 'read' },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const analysisContentsMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: { metadata: 'read', contents: 'read', actions: 'read' },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const analysisReleaseMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: { metadata: 'read', contents: 'read' },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const analysisDeploymentMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: { metadata: 'read', deployments: 'read' },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const githubQAAnalysis = createGitHubQAAnalysis((ref, action) => {
    const mint =
      config.githubProjectTokenMint ??
      (action === 'checks'
        ? analysisChecksMint
        : action === 'statuses'
          ? analysisStatusesMint
          : action === 'pulls' || action === 'pull_status'
            ? discoveryPrTokenMint
            : action === 'releases'
              ? analysisReleaseMint
              : action === 'deployments' || action === 'deployment_statuses'
                ? analysisDeploymentMint
                : action === 'workflow'
                  ? analysisContentsMint
                  : discoveryTokenMint);
    return mint(ref);
  });
  const issuesTokenMint = createGitHubAppProjectTokenMint({
    ...baseMintOpts,
    permissions: { metadata: 'read', issues: 'read' },
  });
  const cachedProjectTokenMint = createCachedProjectTokenMint(projectTokenMint, {
    authorityKey:
      config.githubProjectTokenMint === undefined
        ? githubAppAuthorityKey
        : () => Promise.resolve('test-github-project-token-mint'),
  });
  const installationListTokenMint = createGitHubAppInstallationTokenMint({
    ...baseMintOpts,
    permissions: { metadata: 'read' },
  });
  // The forge behind project sessions, the repository list and the release badge
  // (#1034). Open-PR lookups are built per SESSION WORKTREE, not globally from
  // config.repoDir: project sessions live in their own repos (#125). The per-worktree
  // services keep a short TTL so the visible PR bar updates quickly while repeated
  // app polls still coalesce; the token mint is re-read per lookup.
  //
  // The repository list (concept §19, #174) is the live source of the `projects`
  // cache and mints a dedicated metadata-only installation token. A sealed DB store
  // must propagate as 503 so mobile can prompt for unlock instead of showing an
  // empty repository list.
  //
  // The latest-release lookup for the project overview is non-blocking: `GET
  // /projects` reads it synchronously and it refreshes in the background on a TTL.
  const githubForge = createGitHubForgeProvider({
    discoveryTokenMint: config.githubProjectTokenMint ?? discoveryTokenMint,
    discoveryPrTokenMint: config.githubProjectTokenMint ?? discoveryPrTokenMint,
    repositoryStatusTokenMint: config.githubProjectTokenMint ?? repositoryStatusTokenMint,
    projectTokenMint: cachedProjectTokenMint,
    issuesTokenMint,
    installationToken: async () => {
      try {
        return await resolveInstallationListToken(installationListTokenMint);
      } catch (err) {
        if (err instanceof SealedError) throw err;
        return undefined;
      }
    },
    prStatusTtlMs: 2_000,
  });
  const forgeRepositoryAccess = async (target: {
    owner: string;
    repo: string;
    forgeConnectionId?: string | null;
  }) => {
    if (!target.forgeConnectionId || target.forgeConnectionId === 'legacy-github') return undefined;
    const connection = await eventStore.forgeConnections.get(target.forgeConnectionId);
    if (!connection || connection.provider !== 'forgejo')
      throw new Error('Forgejo connection unavailable');
    const token = (await eventStore.forgeConnections.credentials(connection.id))?.personalToken;
    if (!token) throw new Error('Forgejo credentials unavailable');
    const transport = new ForgejoTransport(
      connection.baseUrl,
      () => Promise.resolve(token),
      connection.customCaPem,
    );
    return {
      url: `${transport.baseUrl}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}.git`,
      token,
      authorization: `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`,
      customCaPem: connection.customCaPem ?? null,
    };
  };
  const forgeForWorktree = async (worktree: string) => {
    if (config.hostCloneRoot) {
      for (const project of await eventStore.listProjects({ includeHidden: true })) {
        const suffix = relative(projectClonePath(config.hostCloneRoot, project), worktree);
        if (
          suffix === '' ||
          (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !suffix.startsWith(sep))
        ) {
          return projectForgeProvider(eventStore, githubForge, project);
        }
      }
    }
    return githubForge;
  };
  const sharedForgeStatus = createForgeStatusCache();
  const statusScopes = new Map<string, ForgeStatusIdentity>();
  const statusIdentity = async (
    project: ProjectRecord,
    provider: NonNullable<Awaited<ReturnType<typeof projectForgeProvider>>>,
  ): Promise<ForgeStatusIdentity> => {
    const token = await provider.mintProjectToken(project);
    if (!token) throw new Error('Forge credentials unavailable');
    const authority = `${project.forgeConnectionId ?? 'github'}:${createHash('sha256').update(token).digest('hex')}`;
    return { authority, owner: project.owner, repo: project.repo };
  };
  /** `remember` records the identity as the project's status scope; a project's
   *  additional repositories share its id, so only its default repository does. */
  const readProjectStatus = async (project: ProjectRecord, branch: string, remember = true) => {
    if (project.kind === 'local' || project.kind === 'control_plane') return null;
    const provider = await projectForgeProvider(eventStore, githubForge, project);
    if (!provider?.repositoryPrService) return null;
    const identity = await statusIdentity(project, provider);
    if (remember) statusScopes.set(project.id, identity);
    return sharedForgeStatus.read(identity, branch, () =>
      provider.repositoryPrService!(project).prStatusForBranch(branch),
    );
  };
  const isDefaultRepository = async (project: ProjectRecord) => {
    const stored = await eventStore.getProject(project.id);
    return (
      stored !== undefined &&
      stored.kind === project.kind &&
      stored.owner === project.owner &&
      stored.repo === project.repo
    );
  };
  const projectPullRequests: ProjectPullRequestBackend = {
    list: async (project) => {
      const provider = await projectForgeProvider(eventStore, githubForge, project);
      if (!provider?.discover) throw new Error('Pull request listing unsupported');
      const pulls = new Map<number, ForgeDiscoveryPage['pulls'][number]>();
      // Three pages cover any open list a person scans on a phone; the host's
      // pages are newest first, so a cut drops the oldest pull requests.
      for (let page = 1; page <= 3; page += 1) {
        const result = await provider.discover(project, page);
        if (result.errors?.some((error) => error.step === 'pulls'))
          throw new Error('Pull requests unavailable');
        for (const pull of result.pulls) pulls.set(pull.number, pull);
        if (result.pulls.length < 30) break;
      }
      const remember = await isDefaultRepository(project);
      const deadline = Date.now() + 12_000;
      const rows = [...pulls.values()];
      const statuses = new Array<PullRequestStatus | null>(rows.length).fill(null);
      let next = 0;
      // Statuses are read a few at a time against one budget: a cold cache over
      // many pull requests leaves the slow ones without status instead of
      // turning the whole repository unavailable.
      const worker = async () => {
        while (next < rows.length && Date.now() < deadline) {
          const index = next++;
          const pull = rows[index]!;
          if (pull.fork) continue;
          let timer: NodeJS.Timeout | undefined;
          const status = await Promise.race([
            readProjectStatus(project, pull.branch, remember).catch(() => null),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
            }),
          ]).finally(() => clearTimeout(timer));
          statuses[index] =
            status && status.number === pull.number && status.phase === 'open' ? status : null;
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, rows.length) }, worker));
      return {
        webUrl: provider.cloneUrl(project).replace(/\.git$/u, ''),
        pulls: rows.map((pull, index) => ({ ...pull, status: statuses[index] ?? null })),
      };
    },
    status: async (project, branch) =>
      readProjectStatus(project, branch, await isDefaultRepository(project)),
    merge: async (project, number, expectedHeadSha) => {
      const provider = await projectForgeProvider(eventStore, githubForge, project);
      if (!provider?.repositoryPrService) return false;
      try {
        return await provider.repositoryPrService(project).mergePr(number, expectedHeadSha);
      } finally {
        // A failed cache invalidation must not turn a completed merge into an error.
        await statusIdentity(project, provider)
          .then((identity) => sharedForgeStatus.invalidate(identity))
          .catch(() => undefined);
      }
    },
  };
  const readWorktreeStatus = async (branch: string, worktree: string) => {
    const session = (await eventStore.listSessions()).find((row) => row.worktree === worktree);
    const project = session?.projectId ? await eventStore.getProject(session.projectId) : undefined;
    return project
      ? readProjectStatus(project, branch)
      : ((await forgeForWorktree(worktree))?.prServiceFor(worktree).prStatusForBranch(branch) ??
          null);
  };
  const installationService: GitHubInstallationService = {
    listInstallationRepos: () => githubForge.listRepositories(),
  };
  // GitHub-token broker (security review): the sandbox holds an opaque per-project
  // capability and redeems it at POST /internal/github/token instead of carrying a
  // gh-token file. The provisioner issues capabilities into this SAME registry; the
  // endpoint resolves them and mints a repo-scoped token via the cached mint (so a
  // frequently-called credential helper doesn't hammer GitHub).
  const ghTokenCapabilities = createGhTokenCapabilityRegistry(db);
  const signingCapabilities = createSigningCapabilityRegistry(db);
  // Real git worktrees only when a project repo is configured; else the server's
  // scratch-dir default (spawned agents start on an empty dir, no repo).
  // Verity Control/default Verity sessions branch from `/work`, so their refresh fetch
  // must authenticate through the DB-backed GitHub App too. DB-only onboarding
  // deployments intentionally do not carry a broad `.gh-token`; without this header
  // `git fetch origin main` fails before the Verity Control session can be created.
  const worktrees = config.repoDir
    ? createGitWorktreeProvisioner({
        repoDir: config.repoDir,
        worktreeRoot: config.workspacesDir ?? join(tmpdir(), 'verity-sessions'),
        baseBranch: 'main',
        // Fetch `main` from origin before branching so each spawn starts from
        // the latest integration tip, not the clone's last-synced `main`.
        refreshBase: true,
        fetchAuthHeader: () =>
          resolveRepoWorktreeFetchAuthHeader(
            githubForge.identityFor(config.repoDir as string),
            cachedProjectTokenMint,
          ),
      })
    : undefined;

  const secretRoot =
    config.secretMaterializationRoot ??
    join(config.dataDir ?? config.workspacesDir ?? join(tmpdir(), 'verity'), 'secrets');
  // `<secretRoot>/opencode/opencode.json` is the file both control-plane Runner
  // specs mount and `OPENCODE_CONFIG` names. Until now only an operator saving
  // settings wrote it (`onOpenCodeSettingsChanged` below), which was enough while
  // the only reader was a Sandbox — the provisioner materializes it as it composes
  // the container. The Runner is not composed per turn: it is created once with the
  // mount already in its spec, so a deployment that never saved OpenCode settings
  // would hand OpenCode a config path with no file in it.
  //
  // At boot the write withholds only the credential-free fallback, and only when a
  // file is already there: a sealed boot cannot tell "no provider configured" from
  // "the settings are encrypted", and answering the second with the fallback would
  // disable OpenCode until someone re-saved the settings.
  // `ensureOpenCodeSettingsMaterialized` holds that rule and is tested on it. Unlock
  // is unconditional — the settings are authoritative by then, including a provider
  // that was removed. Reading settings can itself fail on a sealed store, so neither
  // path may take the Server down with it.
  const materializeOpenCodeConfig = async (reason: 'boot' | 'secret unlock'): Promise<void> => {
    try {
      const settings = await eventStore.getVeritySettings();
      if (reason === 'boot') {
        ensureOpenCodeSettingsMaterialized(settings, secretRoot, config.claudeConnectorPort);
        return;
      }
      materializeOpenCodeSettings(settings, secretRoot, config.claudeConnectorPort);
    } catch (error) {
      console.warn(`verity: OpenCode configuration not materialized (${reason})`, error);
    }
  };
  await materializeOpenCodeConfig('boot');
  const configuredCodexModels =
    config.codexEnabled === true ? (config.codexModels ?? [CODEX_DEFAULT_MODEL]) : [];
  const codexModelCatalog =
    config.codexEnabled === true && config.codexModels === undefined
      ? startCodexModelCatalog({
          fallback: configuredCodexModels,
          // The Server has no project mTLS identity and must never materialize the
          // subscription login merely to enumerate models. The binary's bundled
          // catalog is credential-free and is refreshed after upgrades.
          load: () => (config.codexBundledModelLoader ?? fetchCodexBundledModels)(),
          onError: (error) =>
            console.warn(
              'verity: Codex model catalog refresh failed; keeping cached models',
              error,
            ),
        })
      : undefined;
  if (codexModelCatalog !== undefined) await codexModelCatalog.refresh();
  const openCodeModels = async (): Promise<string[]> => {
    const settings = await eventStore.getVeritySettingsRaw();
    if (
      !settings?.opencodeBaseUrl?.trim() ||
      !settings.opencodeApiKey?.trim() ||
      !settings.opencodeModels?.trim()
    ) {
      return [];
    }
    return selectedOpenCodeModels(settings).map((model) => `verity/${model}`);
  };

  // Multi-repo fleet-registry provisioning (concept §19.3/#19.8, #174):
  // Docker client + ProvisionerImpl + DeprovisionerImpl — wired when a
  // dockerBaseUrl and hostCloneRoot are configured. Git auth comes exclusively from
  // the DB-backed GitHub App mint.
  // Long image pulls (sandbox, toolkit, relay and preview images) report their
  // progress here, rate-limited by the client.
  const logDockerPull = (message: string): void => {
    console.info(`verity: ${message}`);
  };
  const projectDocker =
    config.dockerBaseUrl && config.hostCloneRoot
      ? createDockerClient({
          baseUrl: config.dockerBaseUrl,
          ...(config.registryAuth !== undefined ? { registryAuth: config.registryAuth } : {}),
          pullLog: logDockerPull,
        })
      : undefined;
  if (projectDocker !== undefined) {
    // Per-session sandboxes from a Server that ran sessions in private containers
    // have no owner here; see removeRetiredSessionSandboxes.
    void removeRetiredSessionSandboxes(projectDocker)
      .then((result) => {
        if (result.containers + result.volumes + result.failed > 0) {
          console.info(`verity: removed retired session sandboxes ${JSON.stringify(result)}`);
        }
      })
      .catch((error: unknown) => {
        console.warn('verity: could not remove retired session sandboxes', error);
      });
  }
  const runtimeDocker = config.dockerBaseUrl
    ? (projectDocker ??
      createDockerClient({
        baseUrl: config.dockerBaseUrl,
        ...(config.registryAuth !== undefined ? { registryAuth: config.registryAuth } : {}),
        pullLog: logDockerPull,
      }))
    : undefined;
  const resolvePreviewUser = async (project: ProjectRecord): Promise<string | undefined> => {
    const sandbox = await projectDocker?.inspectContainer(project.containerName);
    const env = Object.fromEntries(
      (sandbox?.env ?? []).map((entry) => {
        const index = entry.indexOf('=');
        return [entry.slice(0, index), entry.slice(index + 1)];
      }),
    );
    if (env.VERITY_RUNNER_RUNTIME) {
      const uid = env.VERITY_AGENT_UID,
        gid = env.VERITY_AGENT_GID;
      if (!uid || !gid || !/^\d+$/.test(uid) || !/^\d+$/.test(gid))
        throw new Error('sandbox agent identity is unavailable');
      return `${uid}:${gid}`;
    }
    return sandbox?.user || undefined;
  };
  // Filled once the managed dev server manager exists, further down.
  const managedLinkEnded: { current?: (instanceId: string, shareId: string) => void } = {};
  const listenerRuntime = new DockerProjectRuntime({
    resolveUser: resolvePreviewUser,
    dockerBaseUrl: config.dockerBaseUrl,
  });
  const listListeningProcesses = (project: ProjectRecord, options?: { fresh?: boolean }) =>
    listenerDiscovery?.listListeningProcesses(project, options) ??
    listenerRuntime.listListeningProcesses(project);
  let previewShareManager: PreviewShareManager | undefined;
  const withPreviewProjectMutation = async <T>(
    projectId: string,
    mutation: () => Promise<T>,
  ): Promise<T> => {
    const runPublic = () =>
      previewShareManager
        ? previewShareManager.withProjectMutation(projectId, mutation)
        : mutation();
    return localPreviewManager
      ? localPreviewManager.withProjectMutation(projectId, runPublic)
      : runPublic();
  };
  const withStorageProjectMutation = async <T>(
    projectId: string,
    mutation: () => Promise<T>,
  ): Promise<T> => {
    const runPublic = () =>
      previewShareManager
        ? previewShareManager.withProjectStorageMutation(projectId, mutation)
        : mutation();
    return localPreviewManager
      ? localPreviewManager.withProjectStorageMutation(projectId, runPublic)
      : runPublic();
  };
  // Every line the Uplink client writes is conditional on this option being
  // present. Without it the handshake record, the close code and the refusal
  // reason are all no-ops, and a control channel that is being refused is
  // indistinguishable from one nobody configured - which is how an outage ran
  // for 13 days with no server-side trace of its cause. It cannot simply be
  // `app.log`: that does not exist yet here, and will not for another thousand
  // lines. Allocated whether or not a client is built, so the binding below
  // needs no second copy of the conditions that decide it.
  const uplinkLog = createDeferredLogger();
  const returnPath: ReturnPathActivation = new ReturnPathActivation(
    () => uplinkControl?.remoteControlDescriptor() ?? { enabled: false },
    returnPathSelection(process.env),
  );
  let coordinatedRecording: CoordinatedRecordingManager | undefined;
  const remoteConnector = config.publicPreviews?.remoteControl
    ? createRemoteConnectorPool({
        dataUrl: remoteDataUrlForControl(config.publicPreviews.uplinkUrl),
        ...config.publicPreviews.remoteControl,
        onReturnPathSnapshot: (snapshot) => coordinatedRecording?.observe(snapshot),
        returnPathExpiry: (sessionHash, connectorId): number | undefined =>
          returnPath.expiry(sessionHash, connectorId),
        returnPathInstallation: (): string | undefined => {
          const descriptor = uplinkControl?.remoteControlDescriptor();
          return descriptor?.enabled ? descriptor.installationId : undefined;
        },
        returnPathBeforeStopSubscribe: (listener) => returnPath.beforeStop(listener),
        returnPathSubscribe: (listener) => returnPath.subscribe(listener),
        log: uplinkLog,
      })
    : undefined;
  const uplinkControl =
    config.publicPreviews !== undefined && projectDocker !== undefined
      ? new UplinkControlClient({
          url: config.publicPreviews.uplinkUrl,
          ...(config.publicPreviews.expectedInstallationId === undefined
            ? {}
            : { expectedInstallationId: config.publicPreviews.expectedInstallationId }),
          store: eventStore,
          serverVersion: config.publicPreviews.serverVersion,
          restoreShareIds: async () => {
            const previews = (await eventStore.listPublicPreviewShares())
              .filter((share) => share.state === 'active' && share.expiresAt.getTime() > Date.now())
              .map((share) => share.id);
            const meetings = await eventStore.listAttendeeState<{
              phase: string;
              binding?: { shareId: string; expiresAt: string };
            }>();
            return [
              ...previews,
              ...meetings
                .filter(
                  (row) =>
                    row.id.startsWith('meeting:') &&
                    row.state.phase !== 'ended' &&
                    row.state.binding &&
                    Date.parse(row.state.binding.expiresAt) > Date.now(),
                )
                .map((row) => row.state.binding!.shareId),
            ];
          },
          ...(remoteConnector === undefined
            ? {}
            : { offerRemoteControl: true, reserveRemoteConnector: remoteConnector.reserve }),
          log: uplinkLog,
          onFeaturesDisabled: (reason) =>
            previewShareManager?.disableAll(reason) ?? Promise.resolve(),
          onSharePinLocked: (shareId) => eventStore.lockPublicPreviewSharePin(shareId),
          onShareExpired: (shareId) =>
            previewShareManager?.finishExpiredByUplink(shareId) ?? Promise.resolve(),
        })
      : undefined;
  if (uplinkControl && remoteConnector) {
    coordinatedRecording = new CoordinatedRecordingManager(returnPath, {
      selectedConnectorId: (targetSessionId) =>
        uplinkControl.selectedRecordingConnectorId(targetSessionId),
      start: (runId, durationMs, version, targetSessionId) =>
        uplinkControl.startRecording(runId, durationMs, version, targetSessionId),
      status: (runId) => uplinkControl.recordingStatus(runId),
      stop: (runId) => uplinkControl.stopRecording(runId),
      export: (runId) => uplinkControl.exportRecording(runId),
    });
  }
  if (
    uplinkControl !== undefined &&
    projectDocker !== undefined &&
    config.publicPreviews !== undefined
  ) {
    previewShareManager = new PreviewShareManager({
      store: eventStore,
      onShareEnded: (share) => {
        if (share.managedInstanceId) managedLinkEnded.current?.(share.managedInstanceId, share.id);
      },
      docker: projectDocker,
      resolveConnectorImage: config.publicPreviews.resolveConnectorImage,
      ...(config.dataVolume ? { dataVolume: config.dataVolume } : {}),
      ...(config.dataVolumeRoot ? { dataVolumeRoot: config.dataVolumeRoot } : {}),
      ...(config.hostCloneRoot ? { hostCloneRoot: config.hostCloneRoot } : {}),
      ...(config.agentSeedHostPath !== undefined
        ? { agentSeedHostPath: config.agentSeedHostPath }
        : {}),
      isDevServerRunning: async ({ project, devServer }) => {
        const status = await new DockerProjectRuntime({
          resolveUser: resolvePreviewUser,
          dockerBaseUrl: config.dockerBaseUrl,
        }).devServerStatus(project, {
          defaultBranch: null,
          defaultModel: null,
          devServerId: devServer.id,
          devServerCommand: devServer.command,
          devServerUrl: devServer.url,
          devServerWorkdir: devServer.workdir,
          devServerHostPort: devServer.hostPort,
          devServerContainerPort: devServer.containerPort,
        });
        return status.running;
      },
      prepareTargetPort: (project, port) =>
        new DockerProjectRuntime({
          resolveUser: resolvePreviewUser,
          dockerBaseUrl: config.dockerBaseUrl,
          listListeningProcesses,
        }).ensurePreviewTarget(project, port),
      listSessionServers: (sessionId) =>
        listenerDiscovery?.listSessionDevServers(sessionId) ?? Promise.resolve([]),
      listListeningProcesses,
      edge: uplinkControl,
      // The same deferred logger as the client's: this manager is built just as
      // far ahead of `app`, and its timing lines belong next to the Uplink's.
      log: uplinkLog,
    });
    // Dialled from below, once the logger it reports through is the real one.
    // Nothing between here and there asks the client for anything: every share
    // path goes through `isAvailable()`, which is false until a `welcome`
    // lands, so a client dialling a thousand lines earlier is not a client that
    // can serve a request any sooner.
  }
  let secretJobRuntimeReadiness = config.secretJobRuntimeReadiness;
  if (config.secretJobRuntimeRequired === true && secretJobRuntimeReadiness === undefined) {
    // Validated before opening the DB above; retain the local narrowing for TypeScript.
    const dockerBaseUrl = config.dockerBaseUrl;
    if (dockerBaseUrl === undefined) throw new Error('unreachable: missing dockerBaseUrl');
    if (runtimeDocker === undefined) throw new Error('unreachable: missing runtime Docker client');
    const verifier = createDockerGvisorRuntimeVerifier({
      docker: runtimeDocker,
      expectedPath: PINNED_RUNSC_PATH,
      expectedArgs: PINNED_RUNSC_ARGS,
    });
    secretJobRuntimeReadiness = createRuntimeReadinessGate(() => verifier.verify('runsc'), {
      ...(config.secretJobRuntimeReadinessTtlMs !== undefined
        ? { ttlMs: config.secretJobRuntimeReadinessTtlMs }
        : {}),
    });
  }
  let embeddedSecretJobs: EmbeddedSecretJobs | undefined;
  const secretProviderCatalog =
    config.secretJobs?.doppler !== undefined ? createPostgresSecretProviderCatalog(db) : undefined;
  if (config.secretJobs !== undefined) {
    const secretJobsConfig = config.secretJobs;
    if (runtimeDocker === undefined || config.dockerBaseUrl === undefined) {
      throw new Error('unreachable: missing Secret Job Docker configuration');
    }
    const audit = createSecretAuditRecorder(secretAuditLog, {
      failureMode: 'fail-closed',
    });
    const revocations = createPostgresSecretRevocationStore(db);
    const recipientKeys = createSecretWorkerRecipientKeyRegistry();
    const sealEnvelope = createSecretEnvelopeSealer({
      resolveRecipientPublicKey: (publicKeyId, jobId) => recipientKeys.resolve(publicKeyId, jobId),
    });
    const broker = createSecretGrantBroker({
      store: createPostgresSecretGrantStore(db),
      resolveSecrets:
        secretJobsConfig.doppler !== undefined
          ? createDopplerSecretResolver({
              ...secretJobsConfig.doppler,
              catalog: secretProviderCatalog!,
              readCredential: readBrokerDopplerCredential,
            })
          : secretJobsConfig.resolveSecrets!,
      sealEnvelope,
      authorizeWorkload: secretJobsConfig.authorizeWorkload,
      authorizeCurrentClaims: async (claims) => {
        if (
          !(await revocations.isClaimsActive(claims)) ||
          !(await secretJobsConfig.authorizeCurrentClaims(claims))
        ) {
          return false;
        }
        if (secretJobsConfig.doppler === undefined) return true;
        return secretProviderCatalog!.checkClaimsPermissions(claims);
      },
      ...(secretJobsConfig.doppler === undefined
        ? {}
        : {
            authorizeResolvedClaims: (claims: RunGrantClaims) =>
              secretProviderCatalog!.authorizeClaimsPermissions(claims),
          }),
      recorder: audit,
    });
    const frames = createPostgresSecretJobFrameSpool(db, secretCipher);
    const executor = createBrokeredSecretJobExecutor({
      broker,
      docker: runtimeDocker,
      dockerBaseUrl: config.dockerBaseUrl,
      frames,
      redactorProfile: secretJobsConfig.redactorProfile,
      recipientKeys,
      expectedRuntimePath: PINNED_RUNSC_PATH,
      expectedRuntimeArgs: PINNED_RUNSC_ARGS,
      executorImageRepository: secretJobsConfig.executorImageRepository,
    });
    const service = createSecretJobService({
      authorization: secretJobsConfig.createAuthorization(broker),
      executor,
      frames,
      store: createPostgresSecretJobStore(db),
      authorizeInvocation: secretJobsConfig.authorizeInvocation,
      onExecutorError: (jobId, error) =>
        console.error(`verity: Secret Job ${jobId} executor failed`, error),
    });
    // Container cleanup and output retention are deliberately independent. Completed frames remain
    // replayable until an explicit retention/acknowledgement reaper calls frames.deleteJob/purge.
    embeddedSecretJobs = {
      broker,
      executor,
      frames,
      service,
    };
  }
  let docker: DockerClient | undefined;
  let projectEgress: ProjectEgressLifecycle | undefined = config.projectEgress;
  const projectEgressHealth = projectEgressAvailability(
    () => projectEgress,
    () => {
      if (!config.projectEgressSocketPath) return undefined;
      return JSON.parse(
        readFileSync(join(dirname(config.projectEgressSocketPath), 'status.json'), 'utf8'),
      ) as unknown;
    },
    () => config.projectEgressProvisioningPending === true,
  );
  let provisioner: ProvisionerImpl | undefined;
  let stopNativeEvidence: (() => void) | undefined;
  let buildStorage: BuildStorage | undefined;
  const projectSandboxLifecycleTelemetry = new ProjectSandboxLifecycleTelemetry();
  let deprovisioner: DeprovisionerImpl | undefined;
  // Claude-egress identity material is wired into the provisioner/deprovisioner
  // and projected exclusively into the standalone Agent Gateway.
  let claudeEgressIdentity: ClaudeEgressIdentityService | undefined;
  let refreshControlPlaneRunnerIdentity: (() => Promise<void>) | undefined;
  let awaitControlPlaneRunnerIdentity: (() => Promise<void>) | undefined;
  let controlPlaneIdentityRefreshTail: Promise<void> = Promise.resolve();
  /**
   * Publish the control-plane Runner identity where a failure must cost at most a
   * turn. Three callers qualify, and each one learned it the hard way: at boot a
   * throw costs the listener — and with it the `/secret/unlock` needed to repair
   * anything; in the unlock callback it costs the unlock; in the handed-off-key
   * activation it costs the key handover, which is how a promoted Server came up
   * sealed after the 13.2.4 cutover because the identity volume was still missing
   * its setgid bit. None of that is worth a certificate the next turn re-publishes
   * anyway. The two turn paths deliberately do NOT use this: there the caller is a
   * single turn that must fail closed rather than run without egress identity.
   */
  const publishRunnerIdentity = async (occasion: string): Promise<boolean> => {
    try {
      await refreshControlPlaneRunnerIdentity?.();
      return true;
    } catch (error) {
      console.warn(
        error instanceof SealedError
          ? `verity: control-plane Runner identity deferred until unlock (${occasion})`
          : `verity: control-plane Runner identity deferred (${occasion}): ${String(error)}`,
      );
      return false;
    }
  };
  let agentGatewayTls: ClaudeEgressMtlsMaterial | undefined;
  let agentGatewayBindings: readonly ClaudeEgressPeerBinding[] = [];
  let agentGatewayBindingGeneration = 0;
  let agentGatewayBindingProjection: Promise<void> = Promise.resolve();
  let agentGatewayAccessToken: string | null | undefined;
  let agentGatewayCodexAuthJson: string | null | undefined;
  let agentGatewayOpenCode: { baseUrl: string; apiKey: string | null } | undefined;
  const { url: agentGatewayUrl } = validateAgentGatewayRoutingConfig({
    url: config.agentGatewayUrl,
    controlSocket: config.agentGatewayControlSocket,
    unsealKey: config.agentGatewayUnsealKey,
    legacyGatewayUrl: config.claudeEgressGatewayUrl,
    connectorPort: config.claudeConnectorPort,
    listenerPort: config.agentGatewayClaudePort,
  });
  const agentGatewaySynchronizer: AgentGatewaySynchronizer | undefined =
    config.agentGatewayControlSocket === undefined
      ? undefined
      : startAgentGatewaySynchronizer({
          socketPath: config.agentGatewayControlSocket,
          onError(error): void {
            app.log.warn({ err: error }, 'Standalone agent gateway reconciliation failed');
          },
          persistCodexCredentialUpdate: (update) =>
            claudeCredentialSync.persistCodexCredentialUpdate(update),
        });
  const codexGatewayControlSocket = config.agentGatewayControlSocket;
  // Passed straight through: `readCodexAccessToken` already throws a
  // `CodexSignInUnusableError` subclass when the gateway says the sign-in is what
  // failed, which is exactly the distinction the usage probe acts on. Anything
  // else it throws stays an ordinary failure, because signing in again would not
  // fix a socket that did not answer.
  const codexGatewayCredentialProvider: CodexUsageCredentialProvider | undefined =
    codexGatewayControlSocket === undefined
      ? undefined
      : () => readCodexAccessToken(codexGatewayControlSocket);
  const agentGatewayConfiguration = (): AgentGatewayConfiguration | undefined => {
    if (config.agentGatewayControlSocket === undefined || agentGatewayTls === undefined) {
      return undefined;
    }
    const { ca, cert, key } = agentGatewayTls;
    if (typeof ca !== 'string' || typeof cert !== 'string' || typeof key !== 'string') {
      throw new Error('Agent gateway requires PEM-string TLS material');
    }
    // Every project is routed, so every binding belongs on the gateway.
    const routedBindings = agentGatewayBindings;
    const revision = createHash('sha256')
      .update(cert)
      .update(
        agentGatewayAccessToken === undefined
          ? '\0credential-pending'
          : agentGatewayAccessToken === null
            ? '\0credential-revoked'
            : `\0credential:${agentGatewayAccessToken}`,
      )
      .update(
        agentGatewayCodexAuthJson === undefined
          ? '\0codex-pending'
          : agentGatewayCodexAuthJson === null
            ? '\0codex-revoked'
            : `\0codex:${agentGatewayCodexAuthJson}`,
      )
      .update(
        agentGatewayOpenCode === undefined
          ? '\0opencode-pending'
          : `\0opencode:${agentGatewayOpenCode.baseUrl}:${agentGatewayOpenCode.apiKey ?? '\0revoked'}`,
      )
      .update(
        routedBindings
          .map((binding) => `${binding.projectId}:${binding.fingerprint256}`)
          .sort()
          .join('\n'),
      )
      .digest('hex');
    return {
      revision,
      claude: {
        tls: { ca, cert, key },
        peerBindings: routedBindings,
        ...(config.agentGatewayUnsealKey === undefined
          ? {}
          : {
              credential: {
                unsealKey: config.agentGatewayUnsealKey,
                // An unresolved token must recover spill rather than revoke it
                // when another provider's credential update is projected.
                ...(agentGatewayAccessToken === undefined
                  ? {}
                  : { accessToken: agentGatewayAccessToken }),
              },
            }),
      },
      ...(config.agentGatewayUnsealKey === undefined || agentGatewayCodexAuthJson === undefined
        ? {}
        : {
            codex: {
              credential: {
                unsealKey: config.agentGatewayUnsealKey,
                sourceRevision: createHash('sha256')
                  .update(agentGatewayCodexAuthJson ?? '\0revoked')
                  .digest('hex'),
                authJson: agentGatewayCodexAuthJson,
              },
            },
          }),
      ...(agentGatewayOpenCode === undefined ? {} : { opencode: agentGatewayOpenCode }),
    };
  };
  const syncAgentGateway = (): void => {
    const configuration = agentGatewayConfiguration();
    if (configuration === undefined) return;
    agentGatewaySynchronizer?.update(configuration);
  };
  const synchronizeAgentGatewayForTurn = async (): Promise<void> => {
    if (config.agentGatewayControlSocket === undefined) {
      throw new Error('Agent Gateway control socket is not configured');
    }
    for (;;) {
      const bindingGeneration = agentGatewayBindingGeneration;
      await agentGatewayBindingProjection;
      // Identity/container work and token refreshes are asynchronous. Accept the
      // snapshot only if no issuance or revocation began while we waited.
      const accessToken = await claudeCredentialSync.getAccessToken();
      if (bindingGeneration !== agentGatewayBindingGeneration) continue;
      agentGatewayAccessToken = accessToken ?? null;
      const configuration = agentGatewayConfiguration();
      if (configuration === undefined) {
        throw new Error('Agent Gateway identity material is unavailable');
      }
      if (agentGatewaySynchronizer === undefined) {
        throw new Error('Agent Gateway synchronizer is unavailable');
      }
      await agentGatewaySynchronizer.updateAndWait(configuration);
      return;
    }
  };
  /** Ask the project's runner supervisor whether its agent connections accept
   *  connects yet. A toolkit without the request keeps its previous behaviour. */
  const probeSandboxEgressReadiness = async (
    runnersVolumeRoot: string,
    projectId: string,
  ): Promise<SandboxEgressProbe> => {
    try {
      return parseEgressReadiness(
        await requestRunnerSupervisor(
          join(runnersVolumeRoot, 'runners', projectId, 'supervisor.sock'),
          { kind: 'egress-readiness' },
          3_000,
        ),
      );
    } catch (error) {
      return classifyProbeError(error);
    }
  };
  const projectRelayControlRef: { current: ProjectRelayControl | undefined } = {
    current: undefined,
  };
  const healthyRelayGeneration = async (
    projectId: string,
    inspected: Awaited<ReturnType<DockerClient['inspectContainer']>>,
  ): Promise<boolean> =>
    claudeEgressRelayHealthy(
      inspected,
      CONTAINER_GENERATION_LABEL,
      async (containerGeneration) =>
        (await projectRelayControlRef.current?.isHealthy?.({
          projectId,
          containerGeneration,
        })) === true,
    );
  const hasProjectedAgentGatewayBinding = (
    projectId: string,
    inspected: Awaited<ReturnType<DockerClient['inspectContainer']>>,
  ): boolean => {
    // A woken Sandbox holds a certificate re-issued after its creation-time label
    // was written; the provisioner vouches for that one per container generation.
    const fingerprint = projectedAgentGatewayFingerprint(secretRoot, projectId, inspected);
    return (
      fingerprint !== undefined &&
      agentGatewayBindings.some(
        (binding) => binding.projectId === projectId && binding.fingerprint256 === fingerprint,
      )
    );
  };
  const agentGatewayReady = async (
    projectId: string,
    inspected: Awaited<ReturnType<DockerClient['inspectContainer']>>,
  ): Promise<boolean> => {
    await agentGatewayBindingProjection;
    return (
      (await healthyRelayGeneration(projectId, inspected)) &&
      hasProjectedAgentGatewayBinding(projectId, inspected)
    );
  };
  /**
   * Last-resort repair for a Claude turn whose Sandbox cannot reach the relay:
   * recreate the Sandbox and report whether the turn may proceed on it.
   *
   * Only for turns that can afford the wait ({@link TurnPreparationContext.canWait});
   * the conductor's background backend resolutions must never trigger a rebuild.
   * The operator sees a transcript note and a `Waiting` badge for the duration, and
   * the turn resumes by itself — the alternative was a terminal error on a state
   * that repairs itself in a minute. Failures are returned rather than thrown so
   * the caller raises the one operator-facing message, naming the repair's own
   * cause when there is one.
   */
  const repairSandboxForAgentTurn = async (
    project: ProjectRecord,
    preparation: TurnPreparationContext,
    queuedSessionIds: ReadonlySet<string>,
  ): Promise<{ ready: true } | { ready: false; failure?: AgentGatewayRepairFailure }> => {
    if (!preparation.canWait || docker === undefined) return { ready: false };
    if (provisioner?.repairSandboxForTurn === undefined) return { ready: false };
    preparation.waitingOn(
      'The project Sandbox has to be rebuilt before this message can run. Keeping the turn queued while Verity attempts the rebuild; it continues automatically if the Sandbox becomes ready.',
    );
    try {
      if (
        !(await provisioner.repairSandboxForTurn(
          project.id,
          preparation.sessionId,
          queuedSessionIds,
          { requireFreshAgentGatewayIdentity: true },
        ))
      )
        return { ready: false };
    } catch (error) {
      app.log.warn({ err: error, projectId: project.id }, 'turn-time sandbox repair failed');
      return { ready: false, failure: { stage: 'rebuild', cause: error } };
    }
    // Trust the recreate only as far as the same check that rejected the Sandbox in
    // the first place: a repair that reports success but leaves the relay unhealthy
    // must not let the turn through to fail deeper in.
    try {
      const inspected = await docker.inspectContainer(project.containerName);
      await synchronizeAgentGatewayForTurn();
      return (await agentGatewayReady(project.id, inspected))
        ? { ready: true }
        : { ready: false, failure: { stage: 'still_unready' } };
    } catch (error) {
      app.log.warn(
        { err: error, projectId: project.id },
        'could not verify the Agent Gateway identity after a turn-time sandbox repair',
      );
      return { ready: false, failure: { stage: 'verify', cause: error } };
    }
  };

  const withProjectSandboxActivity = (projectId: string, backend: Backend): Backend => {
    const use = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (provisioner?.tryBeginProjectSandboxActivity?.(projectId) === false) {
        // Same transient class as the serializer above — this wrapper is only ever
        // applied to a background resolution's backend, and a repair holding the
        // activity lock resolves itself.
        throw sandboxNotReadyError('project Sandbox repair is already in progress');
      }
      try {
        return await operation();
      } finally {
        provisioner?.endProjectSandboxActivity?.(projectId);
      }
    };
    return {
      ...(backend.runnerSupervisorBackend !== undefined
        ? { runnerSupervisorBackend: backend.runnerSupervisorBackend }
        : {}),
      run: (opts) => use(() => backend.run(opts)),
      ...(backend.query !== undefined
        ? { query: (input) => use(() => backend.query!(input)) }
        : {}),
      ...(backend.closeSession !== undefined
        ? { closeSession: (sessionId) => backend.closeSession!(sessionId) }
        : {}),
    };
  };
  const serializeProjectTurnPreparation = createProjectTurnPreparationSerializer({
    waitForRepair: (projectId, sessionId) =>
      provisioner?.waitForTurnSandboxRepair?.(projectId, sessionId) ?? Promise.resolve(),
    repairInFlight: (projectId) => provisioner?.turnSandboxRepairInFlight?.(projectId) === true,
    wrapBackground: withProjectSandboxActivity,
  });
  const routedAgentGatewayBindings = async (
    bindings: readonly ClaudeEgressPeerBinding[],
  ): Promise<readonly ClaudeEgressPeerBinding[]> => {
    if (docker === undefined || agentGatewayUrl === undefined) return [];
    const routed: ClaudeEgressPeerBinding[] = [];
    for (const binding of bindings) {
      // The dedicated control-plane runner is a fixed Compose peer on the private
      // control network, not a project container with a generation relay. Its
      // certificate is projected through a private named volume below, so Docker
      // relay inspection is neither applicable nor a substitute trust check.
      if (
        binding.projectId === CONTROL_PLANE_RUNNER_PROJECT_ID &&
        config.controlPlaneRunner === true
      ) {
        routed.push(binding);
        continue;
      }
      const project = await eventStore.getProject(binding.projectId);
      if (project === undefined || project.kind === 'control_plane') continue;
      try {
        const inspected = await docker.inspectContainer(project.containerName);
        if (await healthyRelayGeneration(project.id, inspected)) {
          routed.push(binding);
        }
      } catch (error) {
        // A transient Docker failure must not permanently deauthorize an already
        // verified certificate. Preserve only the exact cached binding; a new or
        // rotated certificate still fails closed until its container is inspected.
        // Definitive absence and unknown errors are also fail-closed.
        const transient =
          error instanceof DockerError &&
          (error.kind === 'network' || (error.kind === 'other' && (error.status ?? 0) >= 500));
        const previouslyRouted = agentGatewayBindings.some(
          (routed) =>
            routed.projectId === binding.projectId &&
            routed.fingerprint256 === binding.fingerprint256,
        );
        if (transient && previouslyRouted) routed.push(binding);
      }
    }
    return routed;
  };
  let projectRelayLifecycle: ProjectRelayLifecycle | undefined;
  const projectRelayEnabled = (config.projectRelayImage ?? '').trim().length > 0;
  const forgeIdentity = projectRelayEnabled ? await loadForgeProxyIdentity(secretRoot) : undefined;
  // Under the project fence, Git and gh reach forges only through this brokered route;
  // direct grants for forge hosts are refused as broker-only destinations.
  const forgeProxyEnabled = (): boolean => projectRelayEnabled;
  const forgeCertificates = new Map<
    string,
    { expires: number; certificate: ReturnType<typeof issueGatewayServerCertificate> }
  >();
  const forgePackageMap = projectRelayEnabled
    ? await loadForgePackageMap(secretRoot)
    : new Map<string, readonly string[]>();
  // Separate caches prevent optional diagnostic permissions from breaking Git access.
  const diagnosticMints = Object.fromEntries(
    (['statuses', 'administration', 'contents'] as const).map((permission) => [
      permission,
      createCachedProjectTokenMint(
        createGitHubAppProjectTokenMint({ ...baseMintOpts, permissions: { [permission]: 'read' } }),
        { authorityKey: githubAppAuthorityKey },
      ),
    ]),
  );
  const githubForgeAdapter = createGitHubForgeAdapter({
    mint: cachedProjectTokenMint,
    mintDiagnostic: (binding, permission) => diagnosticMints[permission]!(binding),
    transport: brokeredHttpStreamTransport,
  });
  const ghcrForgeAdapter = createGhcrForgeAdapter({
    packages: (projectId) => Promise.resolve(forgePackageMap.get(projectId) ?? []),
    mint: createGitHubAppInstallationTokenMint({
      ...baseMintOpts,
      permissions: REGISTRY_GITHUB_TOKEN_PERMISSIONS,
    }),
    transport: brokeredHttpStreamTransport,
  });
  const forgeProxy =
    forgeIdentity === undefined
      ? undefined
      : createBrokeredForgeProxy({
          certificate: forgeIdentity.certificate,
          capabilities: ghTokenCapabilities,
          resolveRepository: (binding, hostname, path) =>
            resolveForgeRepositoryBinding(eventStore, binding, hostname, path),
          allowsHost: async (authority) =>
            githubForgeAdapter.hosts.has(authority) ||
            ghcrForgeAdapter.hosts.has(authority) ||
            (await eventStore.forgeConnections.list()).some(
              (connection) =>
                connection.provider === 'forgejo' && new URL(connection.baseUrl).host === authority,
            ),
          certificateFor: async (authority) => {
            if (githubForgeAdapter.hosts.has(authority) || ghcrForgeAdapter.hosts.has(authority))
              return forgeIdentity.certificate;
            const hostname = new URL(`https://${authority}`).hostname.replace(/^\[|\]$/gu, '');
            const cached = forgeCertificates.get(hostname);
            if (cached && cached.expires > Date.now()) return cached.certificate;
            const certificate = issueGatewayServerCertificate(forgeIdentity.ca, {
              serverName: hostname,
            }).catch((error) => {
              forgeCertificates.delete(hostname);
              throw error;
            });
            forgeCertificates.set(hostname, {
              expires: Date.now() + 24 * 60 * 60_000,
              certificate,
            });
            return certificate;
          },
          adapter: {
            hosts: new Set([...githubForgeAdapter.hosts, ...ghcrForgeAdapter.hosts]),
            streams: (request) =>
              githubForgeAdapter.hosts.has(request.hostname) ||
              ghcrForgeAdapter.hosts.has(request.hostname)
                ? githubForgeAdapter.streams(request)
                : !request.path.includes('/api/v1/'),
            authorize: async (request, binding, actions, signal) => {
              const project = (await eventStore.listProjectRepositories(binding.projectId)).find(
                (repository) =>
                  repository.removedAt === null &&
                  repository.owner === binding.owner &&
                  repository.repo === binding.repo &&
                  (repository.forgeConnectionId ?? 'legacy-github') ===
                    (binding.forgeConnectionId ?? 'legacy-github'),
              );
              if (!project) throw new Error('forge binding changed');
              if (project.kind !== 'forgejo')
                return (
                  request.hostname === 'ghcr.io' ? ghcrForgeAdapter : githubForgeAdapter
                ).authorize(request, binding, actions, signal);
              if (!binding.forgeConnectionId) throw new Error('forge binding missing');
              const connection = await eventStore.forgeConnections.get(binding.forgeConnectionId);
              if (!connection || connection.provider !== 'forgejo')
                throw new Error('forge connection unavailable');
              return createForgejoForgeAdapter({
                connectionId: connection.id,
                baseUrl: connection.baseUrl,
                customCaPem: connection.customCaPem ?? null,
                credentials: async () => {
                  const token = (await eventStore.forgeConnections.credentials(connection.id))
                    ?.personalToken;
                  if (!token) return undefined;
                  return { token, login: 'oauth2' };
                },
              }).authorize(request, binding, actions, signal);
            },
          },
          enabled: forgeProxyEnabled,
        });
  if (
    config.dockerBaseUrl !== undefined &&
    config.hostCloneRoot !== undefined &&
    !projectRelayEnabled
  ) {
    throw new Error('Project Docker provisioning requires a digest-pinned project relay image');
  }
  // Claude traffic has exactly one route. A Docker-backed server without the
  // gateway would have to fall back to injecting the real OAuth token into
  // sandboxes, which this release removes as a possibility.
  if (
    config.dockerBaseUrl !== undefined &&
    config.hostCloneRoot !== undefined &&
    agentGatewayUrl === undefined
  ) {
    throw new Error('Project Docker provisioning requires the Agent Gateway');
  }
  if (projectRelayEnabled) {
    const missing = [
      (config.dockerBaseUrl ?? '').trim() === '' ? 'dockerBaseUrl' : undefined,
      (config.hostCloneRoot ?? '').trim() === '' ? 'hostCloneRoot' : undefined,
      (config.dataVolume ?? '').trim() === '' ? 'dataVolume' : undefined,
      (config.dataVolumeRoot ?? '').trim() === '' ? 'dataVolumeRoot' : undefined,
      (config.claudeEgressGatewayUrl ?? '').trim() === '' ? 'claudeEgressGatewayUrl' : undefined,
      (config.codexEgressGatewayUrl ?? '').trim() === '' ? 'codexEgressGatewayUrl' : undefined,
      config.claudeConnectorPort === undefined ||
      !Number.isInteger(config.claudeConnectorPort) ||
      config.claudeConnectorPort < 1 ||
      config.claudeConnectorPort > 65_535
        ? 'claudeConnectorPort'
        : undefined,
    ].filter((value): value is string => value !== undefined);
    if (missing.length > 0) {
      throw new Error(`project relay requires: ${missing.join(', ')}`);
    }
    if (!/@sha256:[a-f0-9]{64}$/i.test(config.projectRelayImage!)) {
      throw new Error('project relay image must be digest-pinned');
    }
  }
  const projectRelayControl: ProjectRelayControl | undefined = projectRelayEnabled
    ? {
        start: (binding) => {
          if (projectRelayLifecycle === undefined)
            throw new Error('project relay runtime is not initialized');
          return projectRelayLifecycle.start(binding);
        },
        resume: async (binding) => {
          if (projectRelayLifecycle === undefined)
            throw new Error('project relay runtime is not initialized');
          try {
            await projectRelayLifecycle.resume(binding);
            return true;
          } catch (error) {
            // Absence is an authoritative orphan verdict; daemon/listener failures
            // remain unknown so a transient cannot trigger a destructive rebuild.
            if (error instanceof DockerError && error.kind === 'container_not_found') return false;
            throw error;
          }
        },
        sleep: (projectId) => {
          if (projectRelayLifecycle === undefined)
            throw new Error('project relay runtime is not initialized');
          return projectRelayLifecycle.sleep(projectId);
        },
        reactivate: (binding) => {
          if (projectRelayLifecycle === undefined)
            throw new Error('project relay runtime is not initialized');
          return projectRelayLifecycle.reactivate(binding);
        },
        stop: (projectId) => projectRelayLifecycle?.stop(projectId) ?? Promise.resolve(),
        brokerUrl: (activation) => `http://${projectRelayContainerName(activation.identity)}:8080`,
        claudeGatewayUrl: (activation) =>
          `https://${projectRelayContainerName(activation.identity)}:8443`,
        codexGatewayUrl: (activation) =>
          `https://${projectRelayContainerName(activation.identity)}:8444`,
        // Both halves must hold for a sandbox of this generation to reach the
        // broker at all: this process still owning the listeners + capabilities
        // behind the relay, and the generation's relay container still running.
        // A restart empties the first, a relay exit empties the second, and either
        // way the sandbox's baked-in broker hostname or on-disk capability is dead.
        isHealthy: async ({ projectId, containerGeneration }) => {
          if (projectRelayLifecycle?.isActive(projectId, containerGeneration) !== true)
            return false;
          // No project Docker client → we cannot check the container half; the
          // in-memory half already said yes, so report healthy rather than
          // condemning the sandbox on a check we could not run.
          if (projectDocker === undefined) return true;
          try {
            const relay = await projectDocker.inspectContainer(
              projectRelayContainerName({ projectId, containerGeneration }),
            );
            return relay.running;
          } catch (error) {
            // A gone container is the failure this repairs; anything else (daemon
            // hiccup, timeout) rethrows so the caller records health as UNKNOWN
            // and leaves the sandbox alone.
            if (error instanceof DockerError && error.kind === 'container_not_found') return false;
            throw error;
          }
        },
      }
    : undefined;
  projectRelayControlRef.current = projectRelayControl;
  // Gateway TLS server name (CN/SAN) + the SNI the connector pins — derived once
  // from the gateway URL so the identity service and the sandbox projection agree.
  let claudeEgressServerName: string | undefined;
  let stopRunnerSupervisorReconciler = (): Promise<void> => Promise.resolve();
  let refreshProjectToken: ((project: ProjectRecord) => Promise<void>) | undefined;
  let projectTurnReconciler: ((projectId: string) => Promise<void>) | undefined;
  let projectWorktrees: ReturnType<typeof createProjectWorktreeFactory> | undefined;
  // `main.ts` always passes a resolver, so this is what an embedder that omits
  // one gets. Shared with the last-resort fallback there rather than repeated:
  // the two must name the same artifact, and the pair they replace drifted onto
  // a sandbox image that no longer exists. Note this path is the ref VERBATIM —
  // no resolver sits behind it to prefer a digest it resolved earlier, so an
  // embedder that wants the stronger pin passes its own digest.
  const defaultProjectImageSource = config.defaultProjectImage ?? DEFAULT_SANDBOX_IMAGE_FALLBACK;
  const defaultProjectImage: ProjectImageRefSource =
    typeof defaultProjectImageSource === 'function'
      ? // Forward `forceRefresh` so the provision/recreate path can pin the CURRENT
        // digest instead of the poll cache's; the zero-arg update poll passes none.
        async (forceRefresh?: boolean) =>
          rejectLatestImageRef(
            await defaultProjectImageSource(forceRefresh),
            'VERITY_DEFAULT_PROJECT_IMAGE',
          )
      : rejectLatestImageRef(defaultProjectImageSource, 'VERITY_DEFAULT_PROJECT_IMAGE');
  // Pin the toolkit Feature to the version BAKED into this server image, resolved
  // from GHCR under its BARE semver tag (never the `v`-prefixed visible-version
  // tag, which is not a resolvable Feature manifest — that was the `…:v1.11.6`
  // build failure). Off-server (dev/test) the bundle is absent → published ref.
  const configuredDevcontainerFeatureRef = config.devcontainerFeatureRef;
  // A ref handed over as a plain STRING is configuration by construction —
  // nothing resolved it, a caller wrote it. Only the resolver-function form is
  // ambiguous (`main.ts` uses it for both the operator's value and its own
  // lookup), and only that form has to fall back to reading the environment.
  const devcontainerFeatureRefConfigured =
    config.devcontainerFeatureRefConfigured ??
    (typeof configuredDevcontainerFeatureRef === 'string'
      ? configuredDevcontainerFeatureRef.trim().length > 0
      : toolkitFeatureRefIsConfigured());
  const imageReferences = createProjectImageReferences(db);
  const maintenanceImages = projectDocker
    ? new MaintenanceImages(projectDocker, imageReferences)
    : undefined;
  const preparedWorktreeImages = new Map<string, string>();
  // Durable audit trail for project image builds (ADR 0028). The Server generation is
  // read from this container's own label once; outside a managed deployment it is null.
  let auditServer: AuditServerIdentity | undefined;
  const buildDiagnostics = createBuildDiagnosticStore(
    join(
      config.dataDir ?? config.dataVolumeRoot ?? config.workspacesDir ?? join(tmpdir(), 'verity'),
      'build-diagnostics',
    ),
  );
  const auditLog = createPostgresAuditLog(db);
  const auditRecorder = createAuditRecorder(auditLog, {
    server: async () => {
      if (auditServer !== undefined) return auditServer;
      let generation: number | null = null;
      let settled = true;
      try {
        const label = (await projectDocker?.inspectContainer(hostname()))?.labels?.[
          'verity.generation'
        ];
        const parsed = label === undefined ? Number.NaN : Number(label);
        generation = Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
      } catch {
        // Recorded as unknown this time, and asked again next time: a transient
        // failure must neither block a build nor stick for the life of the process.
        settled = false;
      }
      const identity = { release: runtimeServerVersion(), generation };
      if (settled) auditServer = identity;
      return identity;
    },
    onError: (error, kind) => {
      console.warn(`verity: audit event ${kind} could not be recorded`, error);
    },
  });
  const selectedDevcontainerFeature: DevcontainerFeatureSource | undefined =
    typeof configuredDevcontainerFeatureRef === 'function'
      ? async () =>
          resolveToolkitFeatureRef(
            readBundledDevcontainerFeature(),
            publishedDevcontainerFeatureRef(await configuredDevcontainerFeatureRef()),
            devcontainerFeatureRefConfigured,
          )
      : resolveToolkitFeatureRef(
          readBundledDevcontainerFeature(),
          publishedDevcontainerFeatureRef(configuredDevcontainerFeatureRef),
          devcontainerFeatureRefConfigured,
        );
  const devcontainerFeature: DevcontainerFeatureSource | undefined =
    selectedDevcontainerFeature === undefined
      ? undefined
      : async () =>
          pinToolkitFeature(
            releaseToolkitFeature(
              typeof selectedDevcontainerFeature === 'function'
                ? await selectedDevcontainerFeature()
                : selectedDevcontainerFeature,
              process.env.VERITY_BUNDLED_PROTECTED_TOOLKIT_FEATURE,
              devcontainerFeatureRefConfigured,
            ),
          );
  if (projectDocker !== undefined && config.hostCloneRoot) {
    if (config.dockerBaseUrl === undefined) {
      throw new Error('dockerBaseUrl is required when project Docker provisioning is configured');
    }
    const dockerBaseUrl = config.dockerBaseUrl;
    docker = projectDocker;
    if (
      projectEgress === undefined &&
      config.projectEgressSocketPath !== undefined &&
      config.projectEgressKeyPath !== undefined
    ) {
      try {
        projectEgress = new ProjectEgressLifecycle(
          createProjectEgressHostClient({
            socketPath: config.projectEgressSocketPath,
            token: () => readFileSync(config.projectEgressKeyPath!, 'utf8').trim(),
          }),
          projectDocker,
        );
      } catch {
        // Unavailable protection is reported, never a reason to refuse the Server start.
        console.warn('verity: host egress service configuration is invalid');
      }
    }
    // Turn preparation calls this before every message. Reuse the same ~50-minute
    // token as the sandbox broker so a chat does not mint once per turn; authority
    // changes still invalidate the cache immediately.
    refreshProjectToken = (project: ProjectRecord): Promise<void> =>
      refreshProjectGitHubToken(project, cachedProjectTokenMint.strict);
    // Session worktrees use their project's provider: GitHub App tokens or the
    // current Forgejo connection token and CA. Neither credential is persisted
    // in the clone or worktree.
    projectWorktrees = createProjectWorktreeFactory(projectTokenMint, async (project) => {
      const access = await forgeRepositoryAccess(project);
      if (!access) throw new Error('Forgejo connection unavailable');
      let caPath: string | undefined;
      if (access.customCaPem) {
        const directory = join(secretRoot, 'git');
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        caPath = join(directory, `forge_ca.${project.forgeConnectionId ?? project.id}`);
        const temporary = `${caPath}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, access.customCaPem, { mode: 0o600 });
          await rename(temporary, caPath);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      return {
        url: access.url,
        authorization: access.authorization,
        ...(caPath ? { caPath } : {}),
      };
    });
    // Claude-egress identity material is refreshed on every issue/revoke and
    // projected to the standalone gateway. The provisioner uses the same service
    // to issue per-project client certificates and the deprovisioner revokes them.
    if (
      (config.claudeEgressGatewayUrl !== undefined) !==
      (config.claudeConnectorPort !== undefined)
    ) {
      // Partial config activates nothing (the projection gate needs both). Warn so
      // an operator who set only one gets a diagnostic instead of silent dormancy.
      console.warn(
        'verity: Claude egress needs BOTH the gateway URL and the connector port — set only one, so egress stays off',
      );
    }
    if (config.claudeEgressGatewayUrl !== undefined && config.claudeConnectorPort !== undefined) {
      claudeEgressServerName =
        config.claudeEgressServerName ?? new URL(config.claudeEgressGatewayUrl).hostname;
      claudeEgressIdentity = createClaudeEgressIdentityService({
        store: eventStore,
        serverName: claudeEgressServerName,
        ...(agentGatewayUrl === undefined
          ? {}
          : { additionalServerNames: [agentGatewayUrl.hostname] }),
        async onBindingsChanged(bindings): Promise<void> {
          agentGatewayBindingGeneration += 1;
          const bindingGeneration = agentGatewayBindingGeneration;
          const currentFingerprints = new Set(
            bindings.map((binding) => `${binding.projectId}\0${binding.fingerprint256}`),
          );
          // Denials are synchronous and never depend on Docker: remove revoked
          // fingerprints from the projected cache before inspecting containers
          // to decide whether newly issued bindings may be authorized.
          agentGatewayBindings = agentGatewayBindings.filter((binding) =>
            currentFingerprints.has(`${binding.projectId}\0${binding.fingerprint256}`),
          );
          const denialConfiguration = agentGatewayConfiguration();
          if (denialConfiguration !== undefined && agentGatewaySynchronizer !== undefined) {
            await agentGatewaySynchronizer.updateAndWait(denialConfiguration);
          }
          if (bindingGeneration !== agentGatewayBindingGeneration) return;
          const projection = (async (): Promise<void> => {
            const routedBindings = await routedAgentGatewayBindings(bindings);
            if (bindingGeneration !== agentGatewayBindingGeneration) return;
            agentGatewayBindings = routedBindings;
            syncAgentGateway();
          })();
          agentGatewayBindingProjection = projection;
          await projection;
        },
        onGatewayLeafChanged(material): void {
          agentGatewayTls = material;
          syncAgentGateway();
        },
      });
      if (config.controlPlaneRunner === true) {
        const identityDir = config.controlPlaneRunnerIdentityDir;
        const runnerRuntimeGid = config.runnerRuntimeGid ?? 1101;
        if (identityDir === undefined || identityDir.trim() === '') {
          throw new Error('VERITY_CONTROL_PLANE_RUNNER requires its private identity volume.');
        }
        const identityStats = await lstat(identityDir);
        if (
          !identityStats.isDirectory() ||
          identityStats.isSymbolicLink() ||
          identityStats.uid !== 0 ||
          identityStats.gid !== runnerRuntimeGid ||
          (identityStats.mode & 0o777) !== 0o770
        ) {
          throw new Error('control-plane Runner identity volume has unsafe ownership');
        }
        // Publishing hands each file to the Runner through the volume's setgid bit,
        // because chown() cannot (see `publish` below). Say so at boot, where an
        // operator can still act on it — but deliberately do NOT make it fatal. This
        // Server is created by the Updater from the sealed spec while the bit is set
        // by control-runner-init through compose, so the two are not ordered, and a
        // Server that refuses to boot over state its own init container repairs a
        // moment later is precisely the outage this path just came out of. A missing
        // bit surfaces again, non-fatally and with the same wording, at publish time.
        if ((identityStats.mode & 0o2000) === 0) {
          console.warn(
            'verity: control-plane Runner identity volume is missing the setgid bit (chmod 2770) — published identity will not reach the Runner group',
          );
        }
        const publish = async (name: string, value: string, mode: number): Promise<void> => {
          const target = join(identityDir, name);
          const temporary = `${target}.${randomUUID()}.tmp`;
          await writeFile(temporary, value, { mode });
          await chmod(temporary, mode);
          // The Runner reads this material as the configured Runner runtime GID,
          // and it gets that group from the identity volume's setgid bit (`chmod 2770`, control-runner-init): a
          // file created here inherits the directory's group, so no ownership change
          // is needed. Handing it over with chown() only works for a Server running
          // as root — `capAdd: ['CHOWN']` cannot grant it otherwise, because Docker
          // puts an added capability in the BOUNDING set only and a non-root process
          // never receives it into permitted/effective. Attempt it for the root case,
          // tolerate the EPERM, then assert what actually matters: that the Runner's
          // group can read the file. Failing here beats publishing material the
          // Runner cannot open, which surfaces only as its start-up timeout.
          await chown(temporary, 1101, runnerRuntimeGid).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
          });
          const handedOver = await lstat(temporary);
          if (handedOver.gid !== runnerRuntimeGid) {
            await rm(temporary, { force: true });
            throw new Error(
              `control-plane Runner identity volume does not hand ${name} to the Runner group — it needs the setgid bit (chmod 2770)`,
            );
          }
          await rename(temporary, target);
        };
        const refreshIdentityOnce = async (): Promise<void> => {
          const material = await claudeEgressIdentity!.sandboxMaterial(
            CONTROL_PLANE_RUNNER_PROJECT_ID,
          );
          // The private key is deliberately NOT read back. It goes out group-readable
          // only (see below), so this process — which owns it — cannot open it, and a
          // read that always fails would make the comparison always stale and
          // republish on every turn, bumping the generation the Runner acknowledges.
          // Currency is decided on the two public files, which is sound because the
          // certificate and the key are issued as one pair: the key never changes
          // without the certificate changing with it.
          const desired = [material.caCertPem, material.clientCertPem];
          const current = await Promise.all(
            ['ca.crt', 'client.crt'].map((name) =>
              readFile(join(identityDir, name), 'utf8').catch(() => undefined),
            ),
          );
          const generation = await readFile(join(identityDir, 'generation'), 'utf8').catch(
            () => undefined,
          );
          // Metadata, not contents — the point is that this process cannot read the
          // key. An installation upgraded from the previous 0640 carries a key that is
          // CURRENT in content but still owner-readable, and the Runner refuses it. On
          // content alone nothing would ever rewrite that file, so the deployment would
          // stay broken until the certificate happened to rotate. A missing key lands
          // here too, and is republished for the same reason.
          const keyMode = await lstat(join(identityDir, 'client.key'))
            .then((stats) => stats.mode & 0o777)
            .catch(() => undefined);
          // The key's own contents can no longer be compared, so its fingerprint is
          // published beside it — AFTER the key, so an interruption between the two
          // leaves a stale fingerprint and the next pass republishes. Without it a
          // crash between `client.crt` and `client.key` would leave a mismatched pair
          // that looks current forever: the certificates agree, the mode is right, and
          // the generation from the previous pass is merely non-empty.
          const keyFingerprint = createHash('sha256').update(material.clientKeyPem).digest('hex');
          const publishedFingerprint = await readFile(
            join(identityDir, 'client.key.sha256'),
            'utf8',
          ).catch(() => undefined);
          const keyCurrent = keyMode === 0o040 && publishedFingerprint?.trim() === keyFingerprint;
          const pemCurrent = desired.every((value, index) => value === current[index]);
          if (pemCurrent && keyCurrent && generation !== undefined && generation.trim() !== '')
            return;
          if (!pemCurrent || !keyCurrent) {
            await publish('ca.crt', material.caCertPem, 0o640);
            await publish('client.crt', material.clientCertPem, 0o640);
            // Group read ONLY. The Runner refuses a private key whose owner can
            // still read it ("must not be owner-readable unless owned by Runner or
            // root") — and it is right to: handing the key over by ownership is
            // impossible here, because chown() to the Runner needs a capability an
            // unprivileged process cannot hold. Clearing the owner bits is what makes
            // the file private to the Runner group despite being owned by the Server.
            await publish('client.key', material.clientKeyPem, 0o040);
            await publish('client.key.sha256', keyFingerprint, 0o640);
          }
          // Published last: the sidecar reconciler never observes a half-rotated
          // certificate/key pair merely because the three PEM renames are separate.
          await publish('generation', randomUUID(), 0o640);
        };
        refreshControlPlaneRunnerIdentity = (): Promise<void> => {
          const refresh = controlPlaneIdentityRefreshTail.then(
            refreshIdentityOnce,
            refreshIdentityOnce,
          );
          controlPlaneIdentityRefreshTail = refresh.catch(() => undefined);
          return refresh;
        };
        awaitControlPlaneRunnerIdentity = async (): Promise<void> => {
          if (config.dataVolumeRoot === undefined) {
            throw new Error('control-plane Runner runtime is unavailable');
          }
          const expected = (await readFile(join(identityDir, 'generation'), 'utf8')).trim();
          const acknowledgment = join(
            config.dataVolumeRoot,
            'runners',
            CONTROL_PLANE_RUNNER_PROJECT_ID,
            'claude-egress-generation',
          );
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const actual = await readFile(acknowledgment, 'utf8').catch(() => undefined);
            if (actual?.trim() === expected) return;
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
          throw new Error('Claude control-plane Runner did not acknowledge its egress identity.');
        };
        // The identity material is encrypted at rest, so publishing it needs an
        // OPEN store — and an interactive deployment always boots sealed. Failing
        // the boot here is unrecoverable in a way no other sealed-boot path is:
        // the Server dies before it binds a listener, so `/secret/unlock` is
        // unreachable and the operator cannot unseal it from the app. A plain
        // host restart is enough to trigger it, and the only way back out is to
        // disable the Runner. Defer to the unlock callback instead, exactly like
        // the Agent Gateway identity projection below.
        await publishRunnerIdentity('startup');
      }
    }
    if (config.controlPlaneRunner === true && refreshControlPlaneRunnerIdentity === undefined) {
      throw new Error('Claude control-plane Runner requires complete egress identity wiring.');
    }
    buildStorage = new BuildStorage(
      join(
        config.dataVolumeRoot ?? config.dataDir ?? config.workspacesDir ?? join(tmpdir(), 'verity'),
        'build-storage',
      ),
      undefined,
      undefined,
      undefined,
      '/run/verity-buildkit',
    );
    const nativeEvidence = startNativeRetirementEvidence(
      () => buildStorage?.retirementInventoryEmpty() === true,
    );
    // Registered after app construction below.
    stopNativeEvidence = () => nativeEvidence.stop();
    provisioner = new ProvisionerImpl({
      beforeRunnerAdmission: async (project) => {
        await runPendingCleanup?.(project.id);
      },
      ...(projectEgress === undefined ? {} : { projectEgress }),
      projectEgressEnabled: async () =>
        (await eventStore.getVeritySettingsRaw())?.projectEgressEnabled === true,
      buildStorage,
      ...(config.projectEgressSocketPath && config.projectEgressKeyPath
        ? {
            protectedDevcontainerBuild: createProtectedDevcontainerBuilder({
              root: buildStorage.root,
              socketPath: config.projectEgressSocketPath,
              keyPath: config.projectEgressKeyPath,
            }),
          }
        : {}),
      buildFailureLogDirectory: join(
        config.dataVolumeRoot ?? config.dataDir ?? config.workspacesDir ?? join(tmpdir(), 'verity'),
        'build-failures',
      ),
      imageReferences,
      audit: auditRecorder,
      buildDiagnostics,
      store: eventStore,
      db,
      docker,
      defaultImageRef: defaultProjectImage,
      projectTokenMint,
      forgeRepositoryAccess,
      veritySettings: () => eventStore.getVeritySettings(),
      // Linking a local project to a repository that already has history publishes an
      // import branch and opens the pull request that carries it onto the default
      // branch — the token is the one-shot, target-scoped mint the link route made.
      openPullRequest: async (target, token, pr) => {
        const provider = await projectForgeProvider(eventStore, githubForge, {
          ...target,
          kind:
            target.forgeConnectionId && target.forgeConnectionId !== 'legacy-github'
              ? 'forgejo'
              : 'github',
        });
        if (!provider) throw new Error('Forge provider unavailable');
        return provider.openPullRequest(target, token, pr);
      },
      gitSecretRoot: secretRoot,
      // GitHub-token broker: the SAME registry the /internal/github/token endpoint
      // resolves against. The provisioner issues a per-container capability into it
      // instead of writing a gh-token file, so the sandbox mints tokens on demand.
      ghTokenCapabilities,
      forgeProxy:
        forgeIdentity === undefined
          ? undefined
          : {
              caCertPem: forgeIdentity.ca.caCertPem,
              enabled: forgeProxyEnabled,
              urlFor: async (project: ProjectRecord) =>
                project.forgeConnectionId
                  ? (await eventStore.forgeConnections.get(project.forgeConnectionId))?.baseUrl
                  : undefined,
            },
      projectRelay: projectRelayControl!,
      claudeEgressGatewayUrl: config.claudeEgressGatewayUrl!,
      codexEgressGatewayUrl: config.codexEgressGatewayUrl!,
      claudeEgressGatewayConnectHost:
        config.claudeEgressGatewayHost === undefined ||
        config.claudeEgressGatewayHost === '0.0.0.0' ||
        config.claudeEgressGatewayHost === '::'
          ? '127.0.0.1'
          : config.claudeEgressGatewayHost,
      // Claude-egress projection (opt-in): when the identity service is wired, the
      // provisioner issues this project's client cert and projects the public CA +
      // client cert/key + the connector's coordinates into the sandbox. All four
      // must be present together for the connector's all-or-nothing gate.
      ...(claudeEgressIdentity !== undefined &&
      config.claudeEgressGatewayUrl !== undefined &&
      config.claudeConnectorPort !== undefined
        ? {
            claudeEgressIdentity,
            claudeConnectorPort: config.claudeConnectorPort,
            ...(claudeEgressServerName !== undefined ? { claudeEgressServerName } : {}),
            ...(agentGatewayUrl === undefined
              ? {}
              : {
                  claudeEgressGatewayForProject: () => ({
                    url: agentGatewayUrl.href,
                    serverName: agentGatewayUrl.hostname,
                  }),
                }),
          }
        : {}),
      recreateEnvDriftedSandboxes: config.recreateEnvDriftedSandboxes ?? true,
      onRunnerReady: async (project) => {
        await projectTurnReconciler?.(project.id);
      },
      onContainerStarted: async (project) => {
        listenerDiscovery?.invalidateProject(project.id);
        await projectAgentGatewayIdentity(true);
      },
      onSandboxLifecycle: (event) => {
        projectSandboxLifecycleTelemetry.record(event);
        // One line per transition, so a turn that failed right after a wake can be
        // placed against it; the aggregate above cannot say which project woke.
        app.log[event.outcome === 'failed' ? 'warn' : 'info'](
          event,
          'verity: project Sandbox lifecycle transition',
        );
      },
      onSandboxRecreate: ({ initiator, ...event }) => {
        // The cause without the person: which trigger or session asked, never a user id.
        const cause =
          initiator.kind === 'system'
            ? { initiator: initiator.kind, trigger: initiator.trigger }
            : initiator.kind === 'session'
              ? { initiator: initiator.kind, sessionId: initiator.sessionId }
              : { initiator: initiator.kind };
        app.log[event.outcome === 'failed' ? 'warn' : 'info'](
          { ...event, ...cause },
          'verity: project Sandbox recreated',
        );
      },
      onSandboxWakeFallback: (event) => {
        app.log.warn(event, 'verity: sleeping Sandbox requires cold wake fallback');
      },
      withContainerReplace: <T>(project: ProjectRecord, mutation: () => Promise<T>) =>
        withPreviewProjectMutation(project.id, mutation),
      // Named data volume (M16): per-project mounts become volume subpaths instead
      // of host binds, so sibling sandboxes need no host-path knowledge.
      ...(config.dataVolume !== undefined ? { dataVolume: config.dataVolume } : {}),
      ...(config.dataVolumeRoot !== undefined ? { dataVolumeRoot: config.dataVolumeRoot } : {}),
      ...(config.runnerSupervisor !== undefined
        ? { runnerSupervisor: config.runnerSupervisor }
        : {}),
      ...(config.runnerRuntimeGid !== undefined
        ? { runnerRuntimeGid: config.runnerRuntimeGid }
        : {}),
      ...(config.runnerSupervisorTrustedDefaultImage !== undefined
        ? { runnerSupervisorTrustedDefaultImage: config.runnerSupervisorTrustedDefaultImage }
        : {}),
      // Sandbox runtime hardening (security review C1). Pass-through of the tunables;
      // the provisioner applies the hardened defaults (CapDrop ALL, no-new-privileges,
      // PidsLimit) whether or not these are set.
      ...(config.sandboxPidsLimit !== undefined
        ? { sandboxPidsLimit: config.sandboxPidsLimit }
        : {}),
      ...(config.sandboxMemoryBytes !== undefined
        ? { sandboxMemoryBytes: config.sandboxMemoryBytes }
        : {}),
      ...(config.sandboxMemoryReservationBytes !== undefined
        ? { sandboxMemoryReservationBytes: config.sandboxMemoryReservationBytes }
        : {}),
      ...(config.sandboxHostReserveBytes !== undefined
        ? { sandboxHostReserveBytes: config.sandboxHostReserveBytes }
        : {}),
      ...(config.sandboxOomScoreAdj !== undefined
        ? { sandboxOomScoreAdj: config.sandboxOomScoreAdj }
        : {}),
      ...(config.sandboxSwapBytes !== undefined
        ? { sandboxSwapBytes: config.sandboxSwapBytes }
        : {}),
      ...(config.sandboxNanoCpus !== undefined ? { sandboxNanoCpus: config.sandboxNanoCpus } : {}),
      ...(config.sandboxCpuShares !== undefined
        ? { sandboxCpuShares: config.sandboxCpuShares }
        : {}),
      ...(config.sandboxCapAdd !== undefined ? { sandboxCapAdd: config.sandboxCapAdd } : {}),
      ...(projectEgress !== undefined ||
      config.publicPreviews !== undefined ||
      config.resolvePreviewConnectorImage !== undefined
        ? (() => {
            const verifier = createDockerGvisorRuntimeVerifier({
              docker,
              runtimeName: PROJECT_RUNSC_RUNTIME,
              expectedPath: PINNED_RUNSC_PATH,
              expectedArgs: PINNED_PROJECT_RUNSC_ARGS,
            });
            return {
              ...(config.publicPreviews !== undefined ||
              config.resolvePreviewConnectorImage !== undefined
                ? { sandboxRuntime: PROJECT_RUNSC_RUNTIME }
                : {}),
              verifySandboxRuntime: (runtime: string) => verifier.verify(runtime),
              ...(config.sandboxDnsServers !== undefined
                ? { sandboxDnsServers: config.sandboxDnsServers }
                : {}),
            };
          })()
        : {}),
      ...(config.sandboxAllowPrivilegeEscalation !== undefined
        ? { sandboxAllowPrivilegeEscalation: config.sandboxAllowPrivilegeEscalation }
        : {}),
      hostCloneRoot: config.hostCloneRoot,
      ...(config.agentSeedHostPath !== undefined
        ? { agentSeedHostPath: config.agentSeedHostPath }
        : {}),
      claudeConfigVolume: config.claudeConfigVolume ?? 'claude-config-verity',
      codexConfigVolume: config.codexConfigVolume ?? 'codex-config-verity',
      // ghcr auth for devcontainer builds: mint a `packages:read` installation token
      // so the build resolves the PRIVATE verity-sandbox-toolkit Feature + pulls the
      // base image AS THE APP — no operator PAT or persistent docker login needed.
      registryTokenMint: createGitHubAppInstallationTokenMint({
        ...baseMintOpts,
        permissions: REGISTRY_GITHUB_TOKEN_PERMISSIONS,
      }),
      // Live devcontainer support (R3.1/#299): when a cloned repo has
      // `.devcontainer/`, build a derived image on the same Docker daemon and
      // inject the published Verity toolkit Feature on top. Repos without a
      // devcontainer keep using the default sandbox image.
      ...devcontainerProvisionerOptionsForDockerBaseUrl(dockerBaseUrl, devcontainerFeature),
    });
    deprovisioner = new DeprovisionerImpl(
      eventStore,
      db,
      docker,
      config.hostCloneRoot,
      // Defaults for the isDir / removeDir seams; the registry is the real addition
      // so teardown revokes the project's token-broker capability.
      undefined,
      undefined,
      ghTokenCapabilities,
      config.dataVolumeRoot === undefined ? undefined : join(config.dataVolumeRoot, 'runners'),
      // Revoke the project's Claude-egress client cert on teardown (opt-in).
      claudeEgressIdentity,
      projectRelayControl,
      (project: ProjectRecord, mutation: () => Promise<ProjectRecord>) =>
        withPreviewProjectMutation(project.id, mutation),
      // Resource cleanup never blocks the deprovision, so the log is where a
      // leftover container, clone directory, or relay socket becomes visible.
      (project: ProjectRecord, step: string, cause: unknown) =>
        app.log.warn(
          { projectId: project.id, step, err: cause },
          'verity: project teardown step failed — deprovision continued',
        ),
      // Revoked fail-closed on teardown: `relay.stop` above is best-effort, so
      // its capability revocation is repeated here where a failure is fatal.
      signingCapabilities,
    );
  }

  // Hoisted so the runner-transport factory (ADR 0006 Stage 2.2-prep) can close
  // over the SAME bus instance the control plane's WS subscribers/Conductor use —
  // events the FileTailRunnerClient republishes off the tailed event file must
  // reach the exact bus the live stream reads from, not a second instance.
  const bus = new InMemoryEventBus();
  // Declared before discovery, whose scans feed its orphan sweep.
  let managedDevServerManager: ManagedDevServerManager | undefined;
  const listenerDiscovery =
    config.dockerBaseUrl && config.hostCloneRoot
      ? new ListenerDiscovery({
          eventStore,
          bus,
          hostCloneRoot: config.hostCloneRoot,
          dockerBaseUrl: config.dockerBaseUrl,
          resolveUser: resolvePreviewUser,
          onScan: (project, processes) => {
            void managedDevServerManager?.sweepOrphans(project, processes);
          },
          scan: (project) => listenerRuntime.listListeningProcesses(project),
        })
      : undefined;

  const localConnectorImage =
    config.resolvePreviewConnectorImage ?? config.publicPreviews?.resolveConnectorImage;
  // `app.log` exists only once the control plane is built further down.
  const managedDevServerLog: {
    current?: (message: string, detail?: Record<string, unknown>) => void;
  } = {};
  const localPreviewManager =
    projectDocker && localConnectorImage && config.hostCloneRoot
      ? new LocalPreviewManager({
          store: eventStore,
          docker: projectDocker,
          resolveConnectorImage: localConnectorImage,
          hostCloneRoot: config.hostCloneRoot,
          ...(config.dataVolume ? { dataVolume: config.dataVolume } : {}),
          ...(config.dataVolumeRoot ? { dataVolumeRoot: config.dataVolumeRoot } : {}),
          ...(config.agentSeedHostPath ? { agentSeedHostPath: config.agentSeedHostPath } : {}),
          isDevServerRunning: () => Promise.resolve(false),
          listListeningProcesses,
          listSessionServers: (sessionId) =>
            listenerDiscovery?.listSessionDevServers(sessionId) ?? Promise.resolve([]),
          prepareTargetPort: (project, port) =>
            new DockerProjectRuntime({
              resolveUser: resolvePreviewUser,
              dockerBaseUrl: config.dockerBaseUrl,
              listListeningProcesses,
            }).ensurePreviewTarget(project, port),
          publicHost: process.env.VERITY_LOCAL_PREVIEW_HOST ?? 'localhost',
          connectorHost: hostname(),
          resolveConnectorHost: async () => {
            const server = await projectDocker.inspectContainer(hostname());
            const address = server.networks?.['verity-net']?.ipAddress;
            if (!address)
              throw new PreviewShareConflictError('local preview server network is unavailable');
            return address;
          },
          connectorNetwork: 'verity-net',
          ...(process.env.VERITY_LOCAL_PREVIEW_PORT_RANGE
            ? { portRange: process.env.VERITY_LOCAL_PREVIEW_PORT_RANGE }
            : {}),
          reservedNetworkPorts: () =>
            managedDevServerManager?.reservedNetworkPorts() ?? new Set<number>(),
        })
      : undefined;
  // Dev servers the agent sets up and Verity runs (concept 2.6).
  let previewRecoveryReady = false;
  if (projectDocker && config.hostCloneRoot) {
    const hostCloneRoot = config.hostCloneRoot;
    managedDevServerManager = new ManagedDevServerManager({
      store: eventStore,
      canSupervise: () => previewRecoveryReady && !secretCipher.isSealed(),
      providerAuthority: async (projectId) => {
        const binding = await getBrokeredProjectBinding(projectId);
        return binding
          ? JSON.stringify([binding.dopplerProject, binding.dopplerConfig])
          : undefined;
      },
      resolveSecrets: createManagedDevServerSecretResolver({
        getProjectBinding: getBrokeredProjectBinding,
        resolveSecret: resolveBrokerDopplerSecret,
      }),
      runtime: new DockerProjectRuntime({
        listListeningProcesses,
        isSecretManagedServer: async (id) =>
          ((await eventStore.managedDevServers.getInstance(id))?.lastRunSecretBindings.length ??
            0) > 0,
        resolveUser: resolvePreviewUser,
        dockerBaseUrl: config.dockerBaseUrl,
      }),
      ...(localPreviewManager ? { localShares: localPreviewManager } : {}),
      networkPorts: localPreviewPorts(process.env.VERITY_LOCAL_PREVIEW_PORT_RANGE),
      sandboxWorktree: (project, worktree) =>
        containerPathFor(worktree, projectClonePath(hostCloneRoot, project)),
      refreshListeners: (project) => listenerDiscovery?.refreshProject(project),
      wakeSandbox: (projectId, sessionId) =>
        provisioner?.ensureProjectSandboxAwake(projectId, new Set([sessionId])) ??
        Promise.reject(new Error('sandbox wake is unavailable')),
      log: (message, detail) => managedDevServerLog.current?.(message, detail),
    });
    const managed = managedDevServerManager;
    // Fired from a share's teardown; a store error here must not become an
    // unhandled rejection in the Core.
    managedLinkEnded.current = (instanceId, shareId) =>
      void managed.publicLinkEnded(instanceId, shareId).catch(() => undefined);
  }

  // Per-turn transport path allocators (ADR 0006 Stage 2.2-prep). Only exercised
  // when `config.runnerTransport` is on; cheap to build unconditionally.
  //
  // CRITICAL: a unix-domain socket path has a ~108-char OS limit, so the socket
  // dir MUST be short — `<tmpdir>/verity-runner` with a bare `<uuid>.sock` name
  // (NOT a deep workspaces/worktree path, which would overrun the limit and fail
  // the bind with EINVAL/ENAMETOOLONG). The event file has no such limit but reuses
  // the same short base for locality. Each allocator returns a fresh unique path.
  const runnerTransportDir = join(tmpdir(), 'verity-runner');
  if (config.runnerTransport === true) {
    // Create the base dir once (idempotent) so the per-turn allocators don't each
    // race a mkdir; the RunnerServer still mkdir's the event file's own parent.
    mkdirSync(runnerTransportDir, { recursive: true });
  }
  const allocateEventFile = (): string => join(runnerTransportDir, `${randomUUID()}.events.jsonl`);
  const allocateControlSocket = (): string => join(runnerTransportDir, `${randomUUID()}.sock`);

  // One verbatim transcript store shared by the Conductor (restore-before-resume +
  // in-process tail) and, on the runner-supervisor path, the server-side {@link
  // ServerTranscript} sink — both are stateless handles over the same `db`.
  const transcriptStore = new TranscriptStore(db);

  const claudeCredentialSync = startClaudeCredentialSync(eventStore, secretRoot, (error) => {
    if (error instanceof SealedError) return;
    // Never include credential contents in this diagnostic.
    console.warn(`verity: failed to synchronize rotated Claude credentials: ${String(error)}`);
  });
  let stopAgentGatewayCredentialProjection = (): Promise<void> => Promise.resolve();
  // Resolve the Claude credential on demand. A sealed boot cannot read it, and
  // the identity projection below has no configuration to send without it, so
  // whoever unlocks the store has to ask for it again rather than wait out the
  // 60s reconciler. Assigned only when credential projection is wired up at all.
  let refreshAgentGatewayCredential = (): Promise<void> => Promise.resolve();
  if (
    config.agentGatewayControlSocket !== undefined &&
    config.agentGatewayUnsealKey !== undefined
  ) {
    const projectCredential = async (): Promise<void> => {
      // Only a missing or unusable login revokes the credential. A transient
      // refresh failure must retain the last projection for the next retry.
      let projected = agentGatewayAccessToken;
      let credentialError: Error | undefined;
      try {
        projected = (await claudeCredentialSync.getAccessToken()) ?? null;
      } catch (error) {
        if (error instanceof ClaudeOAuthResolutionError && error.state === 'relogin_required') {
          projected = null;
        } else {
          credentialError =
            error instanceof Error ? error : new Error('Claude credential resolution failed');
        }
      }
      const settings = await eventStore.getVeritySettings();
      const codexAuth = settings?.codexAuthJson;
      const projectedCodex =
        typeof codexAuth === 'string' && codexAuth.trim().length > 0 ? codexAuth : null;
      const openCodeBaseUrl = settings?.opencodeBaseUrl?.trim();
      const openCodeApiKey = settings?.opencodeApiKey?.trim();
      const projectedOpenCode =
        openCodeBaseUrl === undefined ||
        openCodeBaseUrl.length === 0 ||
        openCodeApiKey === undefined ||
        openCodeApiKey.length === 0
          ? undefined
          : { baseUrl: openCodeBaseUrl, apiKey: openCodeApiKey };
      if (
        projected !== agentGatewayAccessToken ||
        projectedCodex !== agentGatewayCodexAuthJson ||
        JSON.stringify(projectedOpenCode) !== JSON.stringify(agentGatewayOpenCode)
      ) {
        agentGatewayAccessToken = projected;
        agentGatewayCodexAuthJson = projectedCodex;
        agentGatewayOpenCode = projectedOpenCode;
        syncAgentGateway();
      }
      // Claude refresh must not hold another provider's logout hostage. Report
      // the failure only after projecting the independently readable settings.
      if (credentialError !== undefined) throw credentialError;
    };
    let projection: Promise<void> | undefined;
    let projectionRequested = false;
    let projectionClosed = false;
    const projectCredentialSafely = (): void => {
      if (projectionClosed) return;
      projectionRequested = true;
      if (projection !== undefined) return;
      projection = (async () => {
        while (!projectionClosed && projectionRequested) {
          projectionRequested = false;
          await projectCredential().catch((error) => {
            // Runs during control-plane construction, before `app` exists, so it
            // must not reference the Fastify logger (doing so threw a TDZ
            // ReferenceError that crash-looped the server on every sealed boot).
            // A sealed store is the expected boot state — stay quiet and let the
            // periodic reconciler retry once the store is unlocked.
            if (error instanceof SealedError) return;
            console.warn(`verity: agent gateway credential projection failed: ${String(error)}`);
          });
        }
      })().finally(() => {
        projection = undefined;
        if (!projectionClosed && projectionRequested) projectCredentialSafely();
      });
    };
    // Awaiting the in-flight cycle lets the unlock path establish the credential
    // before it returns, so a caller that unlocks and then inspects the gateway
    // sees a projected configuration rather than a race.
    refreshAgentGatewayCredential = async (): Promise<void> => {
      projectCredentialSafely();
      await projection;
    };
    projectCredentialSafely();
    const unsubscribe = claudeCredentialSync.onCredentialsChanged(projectCredentialSafely);
    const timer = setInterval(projectCredentialSafely, 60_000);
    timer.unref();
    stopAgentGatewayCredentialProjection = async (): Promise<void> => {
      clearInterval(timer);
      unsubscribe();
      projectionClosed = true;
      await projection;
    };
  }

  const projectAgentGatewayIdentity = async (confirm = false): Promise<void> => {
    if (claudeEgressIdentity === undefined) return;
    // A sealed boot cannot read the Claude credential, so it stays `undefined`
    // and the projection below sends nothing at all — the synchronizer has no
    // snapshot, and its reconciler is a no-op until the 60s credential timer.
    // That hole is wide enough for a self-update to replace the gateway with an
    // empty container and give up waiting for a health it cannot reach yet, so
    // resolve the credential here, before the generation-guarded loop. Once it
    // is resolved this is skipped, which keeps the per-container-start path free.
    if (agentGatewayAccessToken === undefined) await refreshAgentGatewayCredential();
    for (;;) {
      const bindingGeneration = agentGatewayBindingGeneration;
      const material = await claudeEgressIdentity.gatewayMaterial();
      const routedBindings = await routedAgentGatewayBindings(material.peerBindings);
      // Issuance/revocation callbacks advance the generation before doing their
      // own asynchronous Docker inspection. Never let an older snapshot overtake
      // one of those mutations and re-authorize a revoked certificate.
      if (bindingGeneration !== agentGatewayBindingGeneration) continue;
      agentGatewayTls = material.tls;
      agentGatewayBindings = routedBindings;
      // A sealed store must not revoke recovery spill. Once another provider's
      // settings are readable, its updates may proceed with Claude in recovery
      // mode even while Claude's token resolution remains unavailable.
      if (
        agentGatewayAccessToken !== undefined ||
        agentGatewayCodexAuthJson !== undefined ||
        agentGatewayOpenCode !== undefined
      ) {
        const configuration = agentGatewayConfiguration();
        if (configuration !== undefined && agentGatewaySynchronizer !== undefined && confirm) {
          await agentGatewaySynchronizer.updateAndWait(configuration);
        } else {
          syncAgentGateway();
        }
      }
      return;
    }
  };
  try {
    await projectAgentGatewayIdentity();
  } catch (error) {
    // Interactive deployments boot sealed. The successful init/unlock callback
    // below retries the standalone-gateway projection.
    if (error instanceof SealedError) {
      console.warn('verity: Agent Gateway identity projection deferred until unlock');
    } else throw error;
  }

  // Deploy-time toolkit drift (see `toolkit-drift.ts`). The runner-boundary
  // attestation already catches a stale Sandbox image — but per project, only at
  // its next provision, and as a denial that silently removes the native tool
  // channel. The moment the fleet goes stale is a Server deploy, and until now
  // nothing said so at that moment.
  await reportToolkitDrift({
    listProjects: () => eventStore.listProjects(),
    trustedIdentity: () => trustedToolkitIdentity(),
    warn: (line) => {
      console.warn(line);
    },
  });

  /**
   * Remove the transcript files these bindings name on the runner runtime.
   *
   * A backend transcript is reachable only through a `session_backend_state` row, so it
   * has to be deleted at the moment such a row does — whether that is the session being
   * deleted (`purgeSessionArtifacts` below) or the session switching to another backend
   * (`purgeBackendArtifacts` on the Conductor, where the displaced rows are the last
   * thing that can still name the files). Both routes land here so the two cannot drift.
   *
   * Lossless in either case: the files are derivatives of the durable store (see
   * `session-artifacts.ts`) and are materialized back out of it on resume. Leaving them
   * — which is what Verity did until now — meant every session ever deleted was still
   * readable on disk, verbatim prompts and replies included.
   *
   * Undefined without `dataVolumeRoot`: there is no runner runtime then, and a backend
   * without one (OpenCode) keeps its state inside the Sandbox container's own overlay,
   * which dies with the container.
   */
  const dataVolumeRoot = config.dataVolumeRoot;
  /**
   * A session's cwd as the SANDBOX saw it, which is what claude encodes into its
   * `projects/` directory name.
   *
   * One definition on purpose. The purge resolves a session's transcript through it, and
   * the startup sweep derives from it the set of directories a live session still owns —
   * the guard that keeps a switched-away session's unreproducible `subagents/` tree from
   * being collected. If the two derived that name differently the sweep's guard would
   * match nothing and silently degrade to deleting those trees, so they may not be two
   * expressions that merely happen to agree — hence the shared function and the shared
   * {@link RUNNER_CONTAINER_PROJECT_ROOT}, rather than a second `'/work'` here.
   *
   * A worktree the mapping does not rewrite — outside the clone root, or a deployment
   * with no clone root at all — keeps its host path, and the runner's own call gets that
   * same answer from the same function. The two still agree; they just agree on the
   * unmapped path.
   */
  const sessionSandboxCwd = (worktree: string): string =>
    runnerSandboxPath(worktree, config.hostCloneRoot, RUNNER_CONTAINER_PROJECT_ROOT);
  const purgeRunnerArtifacts =
    dataVolumeRoot === undefined
      ? undefined
      : async (
          sessionId: string,
          bindings: readonly { backend: string; backendSessionId: string }[],
          scope: SessionArtifactScope,
        ): Promise<void> => {
          try {
            // A delete runs even with no bindings at all: a cold-started claude thread
            // writes `<veritySessionId>.jsonl` before the binding row naming it lands, so
            // a session deleted in that window has a transcript nothing points at. A
            // switch, by contrast, is only ever called with the rows it displaced.
            if (bindings.length === 0 && scope !== 'session-delete') return;
            const session = await eventStore.getSession(sessionId);
            if (session === undefined) {
              // The row is what names the worktree, and without it there is no directory
              // to look in. Reachable rather than defensive: a delete that gave up on a
              // slow purge (`SESSION_ARTIFACT_PURGE_TIMEOUT_MS`) removes the row while
              // this call is still in flight, and the files it was going to take are then
              // left for the startup sweep. Logged because a leak nobody hears about is
              // how the whole class of bug this module fixes went unnoticed for months.
              app.log.warn(
                { sessionId, scope },
                'verity: transcript purge found no session row — leaving its files to the startup sweep',
              );
              return;
            }
            const controlPlaneRunner = config.controlPlaneRunner === true;
            // Only asked when it can change the answer — this runs once per session in the
            // project-delete loop, and the lookup is pure overhead in every deployment
            // without the dedicated control-plane runner.
            const isControlPlaneProject =
              controlPlaneRunner && session.projectId !== null
                ? (await eventStore.getProject(session.projectId))?.kind === 'control_plane'
                : false;
            const runnerProjectIds = new Set(
              candidateRunnerProjectIds({
                projectId: session.projectId,
                isControlPlaneProject,
                controlPlaneRunner,
              }),
            );
            if (runnerProjectIds.size === 0) return;

            const sandboxCwd = sessionSandboxCwd(session.worktree);
            const cleanupRoot = join(dataVolumeRoot, 'pending-session-cleanup');
            if (scope === 'session-delete') {
              await queueSessionCleanup(cleanupRoot, {
                sessionId,
                sandboxCwd,
                runnerProjectIds: [...runnerProjectIds],
                bindings: [...bindings],
              });
              return;
            }

            const removed: string[] = [];
            const absent: string[] = [];
            const absentBound: string[] = [];
            const failed: string[] = [];
            const outsideRuntime: string[] = [];
            const unresolved: string[] = [];
            const unknownBackends = new Set<string>();
            let runtimeSeen = false;
            for (const runnerProjectId of runnerProjectIds) {
              const runtimeDir = join(dataVolumeRoot, 'runners', runnerProjectId);
              // Control sessions may name a historical project with no runner runtime.
              if (!existsSync(runtimeDir)) continue;
              try {
                const purge = await purgeSessionArtifactFiles({
                  runtimeDir,
                  sandboxCwd,
                  bindings,
                  sessionId,
                  scope,
                });
                removed.push(...purge.removed);
                absent.push(...purge.absent);
                absentBound.push(...purge.absentBound);
                failed.push(...purge.failed);
                outsideRuntime.push(...purge.outsideRuntime);
                if (!purge.runtimeMissing) runtimeSeen = true;
                if (purge.unresolved) unresolved.push(runtimeDir);
                for (const backend of purge.unknownBackends) unknownBackends.add(backend);
              } catch (error) {
                unresolved.push(runtimeDir);
                app.log.warn(
                  { err: error, sessionId, runnerProjectId },
                  'verity: runner session cleanup remains pending',
                );
              }
            }
            // A path that resolved OUT of the runtime means something planted a symlink in
            // a directory the Sandbox can write. Nothing was deleted — but this is not a
            // cleanup problem, so it gets its own message rather than being read as one.
            if (outsideRuntime.length > 0) {
              app.log.error(
                { sessionId, scope, outsideRuntime },
                'verity: refused a transcript path that resolved outside the runner runtime',
              );
            }
            // All three mean a transcript outlived the row naming it, which is the exact
            // failure this code was written to end — so say so rather than counting a
            // partial purge as a clean one. `unresolved` is the runtime whose file list
            // could not even be built, which returns the same empty result as a session
            // that had nothing there. `absent` rides along for context and does not gate:
            // a session that never ran a claude subagent legitimately produces one, and
            // searching a second candidate runtime produces a full set. It is only worth
            // reading when NOTHING was removed, which is what a wrong `sandboxCwd` or a
            // wrong runtime looks like.
            if (failed.length > 0 || unknownBackends.size > 0 || unresolved.length > 0) {
              app.log.warn(
                {
                  sessionId,
                  scope,
                  runnerProjectIds: [...runnerProjectIds],
                  removed: removed.length,
                  absent: absent.length,
                  failed,
                  unresolved,
                  unknownBackends: [...unknownBackends],
                },
                'verity: backend transcripts outlived the session state naming them',
              );
            }
            // Nothing removed, nothing failed, and every path a BINDING named came back
            // absent — from a runtime that is actually there. That is the shape of a
            // `sandboxCwd` or a runtime directory derived wrongly: it deletes nothing,
            // reports no error, and would otherwise be indistinguishable from a clean
            // purge. It is also the shape of a session whose files an earlier sweep already
            // collected, which is why it warns rather than errors — but without it the most
            // likely systemic failure in this path is silent.
            //
            // `absentBound`, not `absent`, and only with a runtime present: a delete always
            // resolves the two speculative claude paths, and a project delete tears the
            // runtime down before purging its sessions. Gating on the wider signal would put
            // this line on every OpenCode session delete and every session in a project
            // delete — routine events, both — and a warning that fires on the routine case
            // is not read when the real one arrives.
            if (
              runtimeSeen &&
              absentBound.length > 0 &&
              removed.length === 0 &&
              failed.length === 0
            ) {
              app.log.warn(
                {
                  sessionId,
                  scope,
                  runnerProjectIds: [...runnerProjectIds],
                  sandboxCwd,
                  absent: absentBound.length,
                },
                'verity: found none of a session’s backend transcripts where they should be',
              );
            }
          } catch (error) {
            // Backend switches remain best effort. Deletion must retain the session
            // if its durable cleanup ownership could not be recorded.
            app.log.error(
              { err: error, sessionId, scope },
              'verity: could not purge the backend transcripts of a session',
            );
            if (scope === 'session-delete') throw error;
          }
        };

  const usesClaudeBackend = (model: string | undefined): boolean =>
    !isCodexModel(model) && !model?.includes('/');
  // Memoised fleet listing. The routes that write an operator-owned project
  // field (fold state, order, setup status) invalidate it through
  // `invalidateProjectList`, or the write would stay invisible to the overview
  // for the whole window.
  const projectList =
    installationService === undefined
      ? undefined
      : createProjectListCache(
          async () => {
            const projects = await syncProjectsFromInstallation(eventStore, installationService);
            const reconciled =
              docker !== undefined
                ? reconcileProjectContainerStates(
                    projects,
                    docker,
                    (id, state, provisionError, provisionWarning) =>
                      eventStore.updateProjectState(id, state, provisionError, provisionWarning),
                    (id) => provisioner?.isProjectProvisioning(id) === true,
                    // A list poll can land after wake persisted `waking` but before
                    // Docker starts the retained container. Give reconciliation the
                    // same recovery hooks as the detail route: an in-process wake
                    // owns the mutation barrier, so recovery declines and the
                    // reconciler preserves `waking` instead of publishing a
                    // momentary, operator-actionable `failed` state.
                    provisioner?.recoverInterruptedSleep?.bind(provisioner),
                    provisioner?.recoverInterruptedWake?.bind(provisioner),
                  )
                : projects;
            const result = await reconciled;
            return result;
          },
          { ttlMs: 3_000 },
        );

  const managedMatrixControl = existsSync('/run/verity-updater/control');
  let matrixActivationDone = false;
  const activateMatrixIfConfigured = async (): Promise<void> => {
    if (!managedMatrixControl || matrixActivationDone) return;
    if ((await eventStore.integrations.matrixConfigSummary()) === null) return;
    matrixActivationDone = await notifyManagedMatrixConfigured();
  };

  const backupArchitecture =
    process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined;
  const backup =
    config.databaseUrl && config.dataVolumeRoot && projectDocker && backupArchitecture
      ? await openBackupRuntime({
          probe: {
            docker: projectDocker,
            network: 'verity-net',
            tufCachePath: join(config.dataVolumeRoot, 'backup-state', 'tuf-cache'),
          },
          root: config.dataVolumeRoot,
          databaseUrl: config.databaseUrl,
          currentImage: async () => (await projectDocker.inspectContainer(hostname())).image,
          architecture: backupArchitecture,
          release: SERVER_COMPAT.serverVersion,
          schema: SERVER_COMPAT.schema.current,
          store: eventStore,
          onError: () => {
            console.warn('verity: backup operation unavailable; queued revocations remain durable');
          },
        })
      : undefined;
  let lastDockerGcReport: DockerGcReport | undefined;
  const sessionStorage =
    config.hostCloneRoot && projectDocker && provisioner?.withProjectExclusiveMutation
      ? new SessionStorage({
          gitRoot: '/work',
          log: (summary) => app.log.info(summary, 'session storage pass complete'),
          listProjects: () => eventStore.listProjects(),
          listSessions: () => eventStore.listSessions(),
          activity: async (id) =>
            (await eventStore.listSessionProjectionFacts([id], 0)).get(id)?.lastActivityAt ?? null,
          root: (project) => projectClonePath(config.hostCloneRoot!, project),
          mutate: async (projectId, sessionId, operation, signal) => {
            const run = (imageId?: string, recheck?: () => Promise<void>) =>
              // Wait for the project owner before taking preview locks: that owner
              // may itself need preview teardown in order to finish.
              provisioner.withProjectExclusiveMutation(
                projectId,
                () =>
                  withStorageProjectMutation(projectId, async () => {
                    const hold = storageHold({
                      projectId,
                      sessionId,
                      devServers: managedDevServerManager,
                      localPreviews: localPreviewManager,
                      publicShares: await eventStore.listPublicPreviewShares(projectId),
                    });
                    if (hold) throw new Error(hold);
                    await recheck?.();
                    if (imageId) preparedWorktreeImages.set(projectId, imageId);
                    try {
                      await operation();
                    } finally {
                      preparedWorktreeImages.delete(projectId);
                    }
                  }),
                sessionId ? new Set([sessionId]) : undefined,
                signal,
              );
            const project = await eventStore.getProject(projectId);
            if (project?.state === 'sleeping') {
              const parent = await projectDocker
                .inspectContainer(project.containerName)
                .catch((error: unknown) => {
                  if (error instanceof DockerError && error.kind === 'container_not_found')
                    return undefined;
                  throw error;
                });
              if (!parent) {
                const selected =
                  typeof defaultProjectImage === 'function'
                    ? await defaultProjectImage()
                    : defaultProjectImage;
                if (!selected || !maintenanceImages)
                  throw new MaintenanceImageError('image-unavailable');
                return maintenanceImages.withImage(
                  selected,
                  (image, recheck) => run(image.id, recheck),
                  signal,
                );
              }
            }
            return run();
          },
          withGit: async (project, operation) => {
            if (config.dataVolume && !dataVolumeRoot)
              throw new Error('Data volume root is unavailable');
            const containerName = project.containerName;
            const hostRoot = projectClonePath(config.hostCloneRoot!, project);
            const inspect = await projectDocker
              .inspectContainer(containerName)
              .catch((error: unknown) => {
                if (error instanceof DockerError && error.kind === 'container_not_found')
                  return null;
                throw error;
              });
            const authenticated = async (git: GitOutput) =>
              operation(async (args) => {
                if (!args.includes('fetch')) return git(args);
                // Keep provider credentials out of persistent Git config and cleanup reports.
                if (project.kind === 'forgejo')
                  throw new Error('Forgejo retirement fetch is unavailable; worktree retained');
                const token =
                  project.kind === 'local' ? undefined : await cachedProjectTokenMint(project);
                try {
                  return await git([
                    ...(token
                      ? ['-c', `http.https://github.com/.extraHeader=${gitAuthHeader(token)}`]
                      : []),
                    ...args,
                  ]);
                } catch {
                  throw new Error('Retirement remote verification failed; worktree retained');
                }
              });
            if (!inspect?.running)
              return withSleepingSessionGit(
                {
                  docker: projectDocker,
                  templateContainer: containerName,
                  projectId: project.id,
                  hostRoot,
                  dockerBaseUrl: config.dockerBaseUrl!,
                  maintenance: {
                    ...(preparedWorktreeImages.has(project.id)
                      ? {
                          fallback: {
                            imageId: preparedWorktreeImages.get(project.id)!,
                            runtime: PROJECT_RUNSC_RUNTIME,
                            memoryBytes: 512 * 1024 ** 2,
                            nanoCpus: 1_000_000_000,
                            pidsLimit: 128,
                          },
                        }
                      : {}),
                  },
                  ...(config.dataVolume && dataVolumeRoot
                    ? { dataVolume: { name: config.dataVolume, root: dataVolumeRoot } }
                    : {}),
                },
                authenticated,
              );
            return authenticated(
              createSandboxGit({
                containerName,
                hostRoot,
                dockerBaseUrl: config.dockerBaseUrl!,
                inspect: () => projectDocker.inspectContainer(containerName),
                timeoutMs: 15_000,
              }),
            );
          },
          wake: async (project, sessionId) => {
            if (project.state === 'sleeping')
              await provisioner.ensureProjectSandboxAwake?.(project.id, new Set([sessionId]));
          },
          pr: (project, branch) => readProjectStatus(project, branch),
        })
      : undefined;
  const runnerCacheMaintenance = new RunnerCacheMaintenance({
    request: (projectId, request) =>
      requestRunnerSupervisor(
        join(dataVolumeRoot!, 'runners', projectId, 'supervisor.sock'),
        request,
        30_000,
      ),
    resolveOwners: (input) => eventStore.resolveRunnerTurnOwnership(input),
    offline: async (projectId, sessionIds, maxBytes) => {
      if (
        !projectDocker ||
        !dataVolumeRoot ||
        !provisioner?.withProjectExclusiveMutation ||
        config.runnerSupervisor !== true ||
        config.runnerSupervisorTrustedDefaultImage !== true ||
        projectId === CONTROL_PLANE_RUNNER_PROJECT_ID
      )
        throw cacheMaintenanceFailure('runtime-not-idle');
      const project = await eventStore.getProject(projectId);
      if (project?.state !== 'sleeping' || project.imageOverrideRef)
        throw cacheMaintenanceFailure('runtime-not-idle');
      const selected =
        typeof defaultProjectImage === 'function'
          ? await defaultProjectImage()
          : defaultProjectImage;
      if (!selected || !maintenanceImages) throw new MaintenanceImageError('image-unavailable');
      return maintenanceImages.withImage(selected, (image, recheck) =>
        provisioner.withProjectExclusiveMutation(projectId, () =>
          withStorageProjectMutation(projectId, async () => {
            const assertIdle = async () => {
              const project = await eventStore.getProject(projectId);
              if (
                project?.state !== 'sleeping' ||
                project.imageOverrideRef ||
                managedDevServerManager?.hasRunningServers(projectId) ||
                (localPreviewManager?.listProject(projectId).length ?? 0) > 0 ||
                (await eventStore.listPublicPreviewShares(projectId)).some((share) =>
                  ['creating', 'active', 'revoking'].includes(share.state),
                )
              )
                throw cacheMaintenanceFailure('runtime-not-idle');
              const sessions = new Set(
                (await eventStore.listSessions())
                  .filter((session) => session.projectId === projectId)
                  .map((session) => session.sessionId),
              );
              if (sessions.size !== sessionIds.length || sessionIds.some((id) => !sessions.has(id)))
                throw cacheMaintenanceFailure('runtime-not-idle');
              if (
                (await eventStore.listRunningTurns()).some((turn) => sessions.has(turn.sessionId))
              )
                throw cacheMaintenanceFailure('runtime-not-idle');
            };
            await assertIdle();
            await recheck();
            const self = await projectDocker.inspectContainer(hostname());
            return reclaimSleepingRunnerCaches({
              docker: projectDocker,
              projectId,
              runtimeRoot: join(dataVolumeRoot, 'runners', projectId),
              image: image.id,
              runtime: PROJECT_RUNSC_RUNTIME,
              serverContainerId: self.id,
              runtimeGid: config.runnerRuntimeGid ?? 1101,
              ...(config.dataVolume
                ? { dataVolume: { name: config.dataVolume, root: dataVolumeRoot } }
                : {}),
              sessionIds,
              maxBytes,
              assertIdle,
            });
          }),
        ),
      );
    },
  });
  const runnerCacheStorage =
    dataVolumeRoot === undefined
      ? undefined
      : new RunnerCacheStorage({
          onFailure: (failure) =>
            app.log.warn(failure, 'Runner cache maintenance failed; unverified caches retained'),
          ...(config.runnerCacheMaxBytes !== undefined
            ? { maxBytes: config.runnerCacheMaxBytes }
            : {}),
          listRuntimes: async () => {
            const projects = await eventStore.listProjects();
            const sessions = await eventStore.listSessions();
            const runtimes = new Map<string, Set<string>>();
            for (const project of projects) runtimes.set(project.id, new Set());
            if (config.controlPlaneRunner) runtimes.set(CONTROL_PLANE_RUNNER_PROJECT_ID, new Set());
            for (const session of sessions) {
              for (const id of candidateRunnerProjectIds({
                projectId: session.projectId,
                isControlPlaneProject: projects.some(
                  (p) => p.id === session.projectId && p.kind === 'control_plane',
                ),
                controlPlaneRunner: config.controlPlaneRunner === true,
              }))
                runtimes.get(id)?.add(session.sessionId);
            }
            // Do not wake sleeping sandboxes or infer deleted sessions from directory names.
            return [...runtimes]
              .filter(([id]) => existsSync(join(dataVolumeRoot, 'runners', id)))
              .map(([projectId, ids]) => ({ projectId, sessionIds: [...ids] }));
          },
          request: (projectId, sessionIds, maxBytes) =>
            runnerCacheMaintenance.request(projectId, sessionIds, maxBytes),
        });
  const cleanupAbort = new AbortController();
  const cleanupProcessor =
    dataVolumeRoot === undefined
      ? undefined
      : createSessionCleanupProcessor({
          root: join(dataVolumeRoot, 'pending-session-cleanup'),
          sessionExists: async (sessionId) =>
            (await eventStore.getSession(sessionId)) !== undefined,
          refreshBindings: async (sessionId) => {
            const deletion = await eventStore.getSessionDeletion(sessionId);
            return deletion
              ? ((
                  JSON.parse(deletion.payload) as {
                    artifactBindings?: { backend: string; backendSessionId: string }[];
                  }
                ).artifactBindings ?? [])
              : [];
          },
          runtimeState: async (projectId) => {
            const runtimeExists = existsSync(join(dataVolumeRoot, 'runners', projectId));
            if (projectId === CONTROL_PLANE_RUNNER_PROJECT_ID && config.controlPlaneRunner)
              return runtimeExists ? 'ready' : 'unavailable';
            const project = await eventStore.getProject(projectId);
            if (!runtimeExists)
              return project === undefined
                ? 'absent'
                : project.state === 'sleeping'
                  ? 'sleeping'
                  : 'unavailable';
            if (project?.state === 'active') return 'ready';
            if (project?.state === 'sleeping') return 'sleeping';
            return 'unavailable';
          },
          deleteHome: (projectId, pending) =>
            deleteRunnerSessionHome(
              join(dataVolumeRoot, 'runners', projectId, 'supervisor.sock'),
              pending.sessionId,
              config.sessionHomeDeleteTimeoutMs,
            ),
          purgeArtifacts: async (projectId, pending) => {
            const result = await purgeSessionArtifactFiles({
              runtimeDir: join(dataVolumeRoot, 'runners', projectId),
              sandboxCwd: pending.sandboxCwd,
              sessionId: pending.sessionId,
              bindings: pending.bindings,
              scope: 'session-delete',
            });
            if (result.outsideRuntime.length > 0 || result.unknownBackends.length > 0)
              return 'unsafe';
            return result.failed.length === 0 && !result.unresolved ? 'clean' : 'retry';
          },
          report: (projectId, pending, reason, error) =>
            app.log.warn(
              { err: error, sessionId: pending.sessionId, projectId, reason },
              reason === 'unsafe'
                ? 'verity: session artifact cleanup requires attention'
                : 'verity: runner session cleanup deferred with backoff',
            ),
          stopped: () => cleanupAbort.signal.aborted,
        });
  const runPendingCleanup =
    cleanupProcessor === undefined
      ? undefined
      : (projectId: string) => cleanupProcessor.run(projectId);
  const sessionCleanupWorker =
    cleanupProcessor === undefined
      ? undefined
      : createSessionCleanupWorker(
          () => cleanupProcessor.run(),
          (error) => app.log.warn({ err: error }, 'verity: pending cleanup scan failed'),
        );
  const app = buildControlPlane({
    onConductorReady: (conductor) => {
      projectTurnReconciler = (projectId) => conductor.reconcileProjectTurns(projectId);
    },
    ...(sessionStorage ? { sessionStorage } : {}),
    eventStore,
    ...(backup ? { backup } : {}),
    ...(managedMatrixControl ? { onMatrixConfigured: activateMatrixIfConfigured } : {}),
    matrixConnectorToken: async () => {
      try {
        return (
          await readFile('/run/verity-updater/control/matrix/connector-token', 'utf8')
        ).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return process.env.VERITY_MATRIX_CONNECTOR_TOKEN;
        throw error;
      }
    },
    // The same root the provisioner mounts from, so the explorer and the sandbox
    // are looking at one directory rather than two copies of an idea (ADR 0022).
    ...(config.dataVolumeRoot !== undefined ? { dataRoot: config.dataVolumeRoot } : {}),
    ...(config.webAppDir !== undefined ? { webAppDir: config.webAppDir } : {}),
    ...(config.browserRequestOrigin !== undefined
      ? { browserRequestOrigin: config.browserRequestOrigin }
      : {}),
    ...(config.unlockClientIdentity !== undefined
      ? { unlockClientIdentity: config.unlockClientIdentity }
      : {}),
    bus,
    ...(purgeRunnerArtifacts === undefined
      ? {}
      : {
          scheduleSessionCleanup: () => sessionCleanupWorker?.run(),
          cleanupDeletedSessionRuntime: async (sessionId: string, projectId: string | null) => {
            if (
              config.runnerSupervisor !== true ||
              (projectId === null && !config.controlPlaneRunner)
            )
              return 'not-applicable' as const;
            const cleanupRoot = join(dataVolumeRoot!, 'pending-session-cleanup');
            const before = (await pendingSessionCleanups(cleanupRoot)).find(
              (record) => record.sessionId === sessionId,
            );
            const deletion = await eventStore.getSessionDeletion(sessionId);
            const retained = deletion
              ? (JSON.parse(deletion.payload) as {
                  session?: { worktree?: string };
                  artifactBindings?: { backend: string; backendSessionId: string }[];
                })
              : undefined;
            const captured =
              retained?.session?.worktree === undefined
                ? undefined
                : {
                    sessionId,
                    sandboxCwd: sessionSandboxCwd(retained.session.worktree),
                    runnerProjectIds:
                      before?.runnerProjectIds ??
                      candidateRunnerProjectIds({
                        projectId,
                        isControlPlaneProject:
                          projectId !== null &&
                          (await eventStore.getProject(projectId))?.kind === 'control_plane',
                        controlPlaneRunner: config.controlPlaneRunner === true,
                      }),
                    bindings: retained.artifactBindings ?? [],
                  };
            await cleanupProcessor?.runSession(sessionId, captured);
            const pending = await pendingSessionCleanups(cleanupRoot);
            if (pending.some((record) => record.sessionId === sessionId))
              return 'deferred' as const;
            if (
              projectId !== null &&
              (await eventStore.getProject(projectId)) === undefined &&
              !(before?.runnerProjectIds ?? [projectId]).some((id) =>
                existsSync(join(dataVolumeRoot!, 'runners', id)),
              )
            )
              return 'absent' as const;
            return 'clean' as const;
          },
          queueSessionArtifacts: async (sessionId: string): Promise<void> => {
            // Read the bindings HERE rather than in the helper: this is the delete path,
            // and the rows are about to go with the FK cascade.
            await purgeRunnerArtifacts(
              sessionId,
              await eventStore.getSessionBackendStates(sessionId),
              'session-delete',
            );
          },
        }),
    ...(config.serverUpdateResolver !== undefined
      ? { serverUpdateResolver: config.serverUpdateResolver }
      : {}),
    ...(config.serverUpdateController !== undefined
      ? { serverUpdateController: config.serverUpdateController }
      : {}),
    ...(config.serverUpdateNotifierStatePath !== undefined
      ? { serverUpdateNotifierStatePath: config.serverUpdateNotifierStatePath }
      : {}),
    ...(listenerDiscovery ? { listenerDiscovery } : {}),
    ...(localPreviewManager ? { localPreviewManager } : {}),
    ...(managedDevServerManager ? { managedDevServerManager } : {}),
    ...(projectEgress
      ? {
          projectEgressResolve: (
            identity: import('./internal-listener.js').InternalConnectionIdentity,
            name: string,
          ) => projectEgress.resolveDirect(identity, name),
        }
      : {}),
    projectEgressAvailable: async (fresh) => (await projectEgressHealth(fresh)).available,
    projectEgressStatus: projectEgressHealth,
    previewSharingCapability: async () => {
      const settings = await eventStore.getVeritySettings();
      return previewSharingCapability(
        uplinkControl?.canStartSharing() === true,
        Boolean(settings?.uplinkSubscriptionKey?.trim()),
        uplinkControl?.diagnostics(),
        settings === undefined || premiumFeatureSwitches(settings).sharing,
      );
    },
    ...(previewShareManager !== undefined ? { previewShareManager } : {}),
    returnPathActivation: returnPath,
    ...(coordinatedRecording ? { coordinatedRecording } : {}),
    returnPathConnectorCount: () => remoteConnector?.diagnosticConnectorCount() ?? 0,
    ...(uplinkControl !== undefined
      ? { remoteControlDescriptor: () => uplinkControl.remoteControlDescriptor() }
      : {}),
    ...(uplinkControl !== undefined
      ? {
          uplinkDiagnostics: () => ({
            ...uplinkControl.diagnostics(),
            ...(remoteConnector === undefined
              ? {}
              : { remoteStreams: remoteConnector.recentStreams() }),
          }),
        }
      : {}),
    ...(uplinkControl !== undefined
      ? {
          onUplinkCredentialsChanged: () => uplinkControl.refreshCredentials(),
          recheckUplink: () => uplinkControl.checkEntitlements(),
        }
      : {}),
    ...(uplinkControl !== undefined
      ? {
          onPremiumFeatureSwitchesChanged: (settings: VeritySettingsRecord) =>
            applyPremiumFeatureSwitches(settings, uplinkControl, previewShareManager),
        }
      : {}),
    ...(uplinkControl ? { attendeeEdge: uplinkControl } : {}),
    googleAccessToken,
    onOpenCodeSettingsChanged: async (settings) => {
      materializeOpenCodeSettings(settings, secretRoot, config.claudeConnectorPort);
      await refreshAgentGatewayCredential();
    },
    ...(config.stagingGoogleClientId !== undefined
      ? { stagingGoogleClientId: config.stagingGoogleClientId }
      : {}),
    ...(config.googleDriveClientId !== undefined
      ? { googleDriveClientId: config.googleDriveClientId }
      : {}),
    googleDriveDocumentIsWithinProject: (
      input: Parameters<typeof googleDriveTool.canReadDocumentWithoutApproval>[0],
    ) => googleDriveTool.canReadDocumentWithoutApproval(input),
    onGoogleCredentialsChanged: () => googleAccessToken.invalidate(),
    secretCipher,
    persistAgentCredentials: async (patch, persist) => {
      await claudeCredentialSync.persistCredentials(patch, persist);
      if (patch.codexAuthJson !== undefined) await codexModelCatalog?.refresh();
    },
    claudeOAuthTokenProvider: claudeCredentialSync.getAccessToken,
    // The Codex quota probe reads its token from the gateway, the single refresh
    // authority for the rotating Codex login (ADR 0010) — deliberately not from the
    // stored `codexAuthJson`, which would make the Server a second writer. Without a
    // gateway the probe stays inert and the meter keeps its per-session signal.
    ...(codexGatewayCredentialProvider === undefined ? {} : { codexGatewayCredentialProvider }),
    onSecretUnlocked: async () => {
      // Restore process-local relay listeners before filtering persisted gateway
      // certificates. A new Server owns none yet; treating that as identity drift
      // would recreate a valid retained Sandbox while checking its unlock state.
      for (const project of await eventStore.listProjects()) {
        if (project.kind === 'control_plane' || project.state !== 'active') continue;
        try {
          await provisioner?.resumeProjectRelay?.(project.id);
        } catch (error) {
          app.log.warn(
            { err: error, projectId: project.id },
            'Retained relay resume deferred until project recovery',
          );
        }
      }
      await projectAgentGatewayIdentity();
      let inspected = 0;
      let repaired = 0;
      let deferred = 0;
      if (docker !== undefined && provisioner?.repairSandboxForTurn !== undefined) {
        for (const project of await eventStore.listProjects()) {
          if (project.kind === 'control_plane' || project.state !== 'active') continue;
          try {
            const container = await docker.inspectContainer(project.containerName);
            if (!container.running) continue;
            inspected += 1;
            if (await agentGatewayReady(project.id, container)) continue;
            const didRepair = await provisioner.repairSandboxForTurn(
              project.id,
              `secret-unlock:${project.id}`,
              undefined,
              { requireFreshAgentGatewayIdentity: true },
            );
            if (didRepair) repaired += 1;
            else deferred += 1;
          } catch (error) {
            deferred += 1;
            app.log.warn(
              { err: error, projectId: project.id },
              'Agent Gateway identity reconciliation deferred for project',
            );
          }
        }
      }
      await projectAgentGatewayIdentity(inspected > 0);
      app.log.info(
        { inspected, repaired, deferred, projectedBindings: agentGatewayBindings.length },
        'Agent Gateway identity reconciliation completed after secret unlock',
      );
      // Publishes what the sealed boot had to skip. Ordered after the gateway
      // projection because both mint from the same CA and the gateway is what a
      // Sandbox needs first; the Runner picks its material up by generation file.
      const runnerIdentityPublished = await publishRunnerIdentity('secret unlock');
      app.log.info(
        { published: runnerIdentityPublished },
        'control-plane Runner identity resume completed after secret unlock',
      );
      // The provider settings are readable now. A sealed boot can only have written
      // the credential-free fallback, and the Runner reads the file through a
      // directory mount, so replacing it here reaches containers already running.
      await materializeOpenCodeConfig('secret unlock');
      await codexModelCatalog?.refresh();
      uplinkControl?.start();
    },
    authRegistry,
    ...(config.https !== undefined ? { https: config.https } : {}),
    ...(config.devicePairing !== undefined ? { devicePairing: config.devicePairing } : {}),
    pushEnabled: config.pushEnabled === true,
    // ADR 0011 D2: the operator's review-and-revoke surface for standing grants. The
    // current binding is passed so each grant can be flagged with whether it would
    // auto-approve anything today — but grants against a superseded binding are still
    // listed, because binding ids are derived deterministically and a restored binding
    // would put such a grant back in force. Unlistable is unrevokable.
    listBrokeredGrants: async (projectId) =>
      brokeredHttpGrants.list(projectId, (await brokeredGrantBindingId(projectId)) ?? null),
    revokeBrokeredGrant: (projectId, grantId) => brokeredHttpGrants.revoke(projectId, grantId),
    runtimeDiagnostics: createRuntimeDiagnostics({
      dockerBaseUrl: config.dockerBaseUrl,
      dataRoot: config.dataVolumeRoot,
      serverContainerId: config.diagnosticServerContainerId?.trim() || hostname(),
      hostSnapshotPath: config.hostDiagnosticSnapshotPath,
      builderMigrationPath: '/run/verity-buildkit/migration-status.json',
      builderAdmissionDirectory: '/run/verity-buildkit',
      buildStorageReportPath: '/run/verity-host-diagnostics/storage.json',
      buildStorageReservations: () => buildStorage?.unresolvedAttempts() ?? [],
      buildQueue: () => buildStorage?.queueState() ?? { waiting: 0 },
      storageReclamation: async () => {
        const report = sessionStorage?.lastReport;
        let databaseBytes: number | null = null;
        try {
          const row = await sql<{
            bytes: string;
          }>`select pg_database_size(current_database())::text as bytes`.execute(db);
          const value = Number(row.rows[0]?.bytes);
          if (Number.isSafeInteger(value) && value >= 0) databaseBytes = value;
        } catch {
          /* Database usage is unknown, not zero. */
        }
        const nativeBuildkit = await readNativeReclamation();
        return {
          accounting:
            'Image and dependency sizes are estimates with shared layers/reflinks; do not sum categories. Unknown measurements are null. No freed-byte claim is inferred from apparent sizes.',
          lastGc: lastDockerGcReport
            ? {
                observedAt: lastDockerGcReport.observedAt,
                containersRemoved: lastDockerGcReport.containersRemoved.slice(0, 100),
                imagesRemoved: lastDockerGcReport.imagesRemoved.length,
                lowDisk: lastDockerGcReport.lowDisk,
                errors: lastDockerGcReport.errors.length,
                stoppedContainerPins: lastDockerGcReport.stoppedContainerPins,
                keptImageReasons: lastDockerGcReport.keptImageReasons,
                retainedContainers: lastDockerGcReport.retainedContainers,
              }
            : null,
          worktrees: report
            ? {
                observedAt: report.observedAt,
                dependenciesRemoved: report.dependenciesRemoved.length,
                worktreesRetired: report.worktreesRetired.length,
                comparedDependencyBytes: report.comparedDependencyBytes,
                worktreeSampledBytes: report.worktreeSampledBytes,
                dependencySampledBytes: report.dependencySampledBytes,
                usageComplete: report.usageComplete,
                dryRun: report.dryRun,
                blockers: report.blockers
                  .slice(0, 100)
                  .map((b) => ({ path: b.path, reason: b.reason.slice(0, 500) })),
              }
            : null,
          runnerCaches: runnerCacheStorage?.lastReport ?? null,
          databaseBytes,
          nativeBuildkit,
          activeBuildkitBytes:
            typeof nativeBuildkit?.overlayAllocatedBytes === 'number'
              ? nativeBuildkit.overlayAllocatedBytes
              : null,
        };
      },
      projectBuildFailure: (projectId) => provisioner?.lastBuildFailure(projectId),
    }),
    ...(secretJobRuntimeReadiness !== undefined ? { secretJobRuntimeReadiness } : {}),
    ...(config.pushEnabled === true
      ? {
          pushSender: (logger: FastifyBaseLogger) =>
            createPushSender({
              store: eventStore,
              transport: createExpoPushTransport(config.expoAccessToken),
              logger,
            }),
        }
      : {}),
    ...(config.wsAllowedOrigins !== undefined ? { wsAllowedOrigins: config.wsAllowedOrigins } : {}),
    signingCapabilities,
    turnCredentials,
    // When a dedicated internal listener is configured, gate `/internal/*` to it
    // (the public listener 404s those paths). main.ts starts that listener and
    // tags its sockets; this predicate reads the tag. Omit → no gate.
    ...(config.internalPort !== undefined ? { internalPathGuard: requestArrivedInternally } : {}),
    // `configuredCodexModels` stands in for the catalogue as well as for itself: the
    // refresh timer only runs when `codexModels` was left unset, and that is precisely
    // the case where this list falls back to `[CODEX_DEFAULT_MODEL]`. So a populated
    // catalogue always has a non-empty list beside it, and this gate cannot drop one.
    ...{
      // Synchronous behind an async contract: the Codex catalogue is a cache the
      // refresh timer fills, and the OpenCode half is the provider's discovered catalog,
      // so neither half has anything to await since the transport migration. The
      // signature stays a promise because it is the seam a live catalogue would
      // reappear in.
      listModels: async () => [
        ...(codexModelCatalog?.list() ?? configuredCodexModels),
        ...(await openCodeModels()),
      ],
    },
    ...(config.logger !== undefined ? { logger: config.logger } : {}),
    ...(config.workspacesDir !== undefined ? { spawnWorktreeRoot: config.workspacesDir } : {}),
    ...(worktrees !== undefined ? { worktrees } : {}),
    ...(branches !== undefined ? { branches } : {}),
    forgejoEnabled: projectRelayEnabled && provisioner !== undefined,
    branchPr: async (b: string, wt: string) =>
      (await forgeForWorktree(wt))?.prServiceFor(wt).prForBranch(b) ?? null,
    branchPrStatus: readWorktreeStatus,
    invalidateProjectPrStatus: (projectId) => {
      const scope = statusScopes.get(projectId);
      if (scope) sharedForgeStatus.invalidate(scope);
    },
    branchPrStatusForBranches: async (bs: readonly string[], wt: string) => {
      const values = [];
      for (const branch of bs) values.push(await readWorktreeStatus(branch, wt));
      return selectBranchStatus(values, (await forgeForWorktree(wt))?.id ?? 'github');
    },
    repairPullRequest: async (project, number) => {
      const provider = await projectForgeProvider(eventStore, githubForge, project);
      return (await provider?.repositoryOperations(project).findPullRequest({ number })) ?? null;
    },
    qaAnalysisRead: async (project, request, authorize) => {
      if (project.kind === 'forgejo') {
        await authorize();
        const provider = await projectForgeProvider(eventStore, githubForge, project);
        if (request.action === 'pulls' && provider?.discover) {
          const page = await provider.discover(project, request.page);
          await authorize();
          return {
            data: page.pulls,
            nextPage: page.nextPage,
            checkedAt: new Date().toISOString(),
            untrusted: true,
          };
        }
        if (request.action === 'pull_status' && provider) {
          const pull = await provider
            .repositoryOperations(project)
            .findPullRequest({ number: request.number });
          await authorize();
          const status = pull ? await readProjectStatus(project, pull.head) : null;
          await authorize();
          return {
            data: status?.number === request.number ? status : null,
            checkedAt: new Date().toISOString(),
            untrusted: true,
          };
        }
        return {
          available: false,
          reason:
            'This Forgejo integration supports PR reads, not historical Actions/release analysis',
        };
      }
      if (project.kind !== 'github')
        return { available: false, reason: 'This project has no supported repository provider' };
      return githubQAAnalysis(project, request, authorize);
    },
    projectPullRequests,
    repairDiscovery: async (project, pageNumber) => {
      const provider = await projectForgeProvider(eventStore, githubForge, project);
      if (!provider?.discover) throw new Error('Repository monitoring unsupported');
      const firstPage = await provider.discover(project, 1);
      const olderPage = pageNumber > 1 ? await provider.discover(project, pageNumber) : undefined;
      const page = olderPage
        ? {
            ...olderPage,
            pulls: [
              ...new Map(
                [...firstPage.pulls, ...olderPage.pulls].map((p) => [p.number, p]),
              ).values(),
            ],
            runs: [
              ...new Map([...firstPage.runs, ...olderPage.runs].map((r) => [r.id, r])).values(),
            ],
          }
        : firstPage;
      const statuses = [];
      for (const pull of page.pulls) {
        if (pull.fork) continue;
        const status = await readProjectStatus(project, pull.branch);
        if (status && status.number === pull.number && status.headSha === pull.sha)
          statuses.push({ branch: pull.branch, status });
        else await eventStore.repairs.invalidateObservation(project.id, `pr:${pull.number}`);
      }
      for (const incident of await eventStore.repairs.incidents(project.id)) {
        if (
          !incident.resource.startsWith('pr:') ||
          ['resolved', 'superseded'].includes(incident.state)
        )
          continue;
        const evidence = JSON.parse(incident.evidence) as { branch?: string };
        if (
          !evidence.branch ||
          statuses.some((row) => `pr:${row.status.number}` === incident.resource)
        )
          continue;
        const tracked = await provider.repositoryOperations(project).findPullRequest({
          number: Number(incident.resource.slice(3)),
        });
        if (tracked && tracked.state !== 'open') {
          await eventStore.repairs.retireResource(project.id, incident.resource);
          continue;
        }
        const status = await readProjectStatus(project, evidence.branch);
        const discovered = page.pulls.find((p) => `pr:${p.number}` === incident.resource);
        if (
          status &&
          `pr:${status.number}` === incident.resource &&
          (!discovered || (!discovered.fork && status.headSha === discovered.sha))
        )
          statuses.push({ branch: evidence.branch, status });
      }
      return { page, statuses };
    },
    mergePr: async (n: number, wt: string, expectedHeadSha?: string) =>
      (await forgeForWorktree(wt))?.prServiceFor(wt).mergePr(n, expectedHeadSha) ?? false,
    repoIdentity: async (wt: string) => (await forgeForWorktree(wt))?.identityFor(wt)() ?? null,
    // Live GitHub-App credential validation for the onboarding wizard (#320). The
    // route reads + decrypts the stored creds itself (unsealed-only) and hands them
    // here; this just performs the redaction-safe test-mint against GitHub.
    githubAppValidate: (creds: GitHubAppCreds) => validateGitHubAppCreds(creds),
    // GitHub-token broker: resolve a sandbox capability + mint its repo-scoped token.
    ghTokenCapabilities,
    // `verity-repo`: the project's code host executes pull request and issue actions.
    projectRepository: async (project: ProjectRecord) => {
      const provider = await projectForgeProvider(eventStore, githubForge, project);
      if (provider === undefined) return undefined;
      return {
        hostName: provider.id === 'forgejo' ? 'Forgejo' : 'GitHub',
        operations: provider.repositoryOperations(project),
        listIssues: () => provider.listIssues(project),
      };
    },
    ghTokenMint: async (project: {
      owner: string;
      repo: string;
      forgeConnectionId?: string | null;
    }) => (await forgeRepositoryAccess(project))?.token ?? githubForge.mintProjectToken(project),
    // Loopback MCP gateway for ACP sessions (ADR 0014 D1). The approval seam is
    // deliberately absent here and bound inside buildServer to its own conductor.
    mcpGateway,
    mcpProxyResolveCaller: (input) => Promise.resolve(mcpProxyTokens.resolve(input)),
    // Derive the git committer identity from the App installation for the
    // signing-key onboarding step. Resolves the (decrypted) creds from settings;
    // undefined when no App is configured yet (nothing to derive).
    resolveGitHubAppIdentity: async (): Promise<GitHubAppIdentityResult | undefined> => {
      const creds = await resolveGithubAppCreds();
      return creds === undefined ? undefined : resolveGitHubAppIdentity(creds);
    },
    // Live Doppler Service Account token validation for the OPTIONAL onboarding
    // Doppler step (#320). The route reads + decrypts the stored token itself
    // (unsealed-only) and hands it here; this just performs the redaction-safe
    // list-projects check against Doppler.
    dopplerValidate: (token: string) => validateDopplerToken(token),
    dopplerCredentialReader: readBrokerDopplerCredential,
    // Live Doppler project/config listing for the binding picker (#320). Both read
    // the account token from the decrypting route (unsealed-only) and list from
    // that TRUSTED token — NOT repo content (closes the confused-deputy). Both are
    // contractually redaction-safe: never log/echo the token; return only the
    // NON-secret slug/name summaries.
    dopplerListProjects: (token: string) => listDopplerProjects(token),
    dopplerListConfigs: (token: string, project: string) => listDopplerConfigs(token, project),
    // Real code→App conversion for the manifest one-click onboarding routes
    // (#320). Redaction-safe by contract: never logs the PEM / GitHub body. The
    // callback route persists the returned app id + PEM via the sealed store.
    manifestConvert: defaultManifestConvert(),
    // Real server-side ssh-keygen for the onboarding signing-key step (#320).
    // Needs `openssh-client` in the Server image (deploy/Dockerfile). Injectable
    // so tests never shell out.
    sshKeygen: defaultSshKeygenSpawner,
    // Give server-side model queries the configured repository as context.
    ...(config.repoDir ? { refineCwd: config.repoDir } : {}),
    listProjectGitHubIssues: async (project: ProjectRecord) =>
      (await projectForgeProvider(eventStore, githubForge, project))?.listIssues(project) ?? {
        connected: false,
        viewerLogin: null,
        issues: [],
      },
    latestRelease: (owner: string, repo: string) => githubForge.latestRelease({ owner, repo }),
    refreshLatestRelease: (owner: string, repo: string) =>
      githubForge.refreshLatestRelease({ owner, repo }),
    // Multi-repo fleet-registry listing (concept §19, #174). The provider syncs
    // the live GitHub-App-installation repos into the durable `projects` cache
    // (upsert preserves worker-owned state — cloning/container_starting/active/
    // failed survives a list-refresh that runs mid-provisioning) and returns the
    // cache. New repos land as `state='absent'`; Verity-self's row appears after
    // the first `GET /projects` because Verity is itself a normal installation
    // repo (§19.1).
    ...(installationService !== undefined && projectList !== undefined
      ? {
          ...(refreshProjectToken !== undefined ? { refreshProjectToken } : {}),
          listProjects: async () => {
            if (hasMasterPassword && secretCipher.isSealed()) throw new SealedError();
            return projectList.list();
          },
          invalidateProjectList: () => projectList.invalidate(),
          listAvailableRepositories: async () => {
            if (hasMasterPassword && secretCipher.isSealed()) throw new SealedError();
            return syncProjectsFromInstallation(eventStore, installationService, {
              includeHidden: true,
            });
          },
        }
      : {}),
    // Single-project freshness for `GET /projects/:id` (the screen that owns
    // Repair). Deliberately independent of `listProjects`: no GitHub-installation
    // sync and no list cache, just one container inspect — so detail stays correct
    // while the installation sync is degraded, and a sandbox that died is visible
    // the moment the screen loads instead of after the next overview poll.
    ...(docker !== undefined
      ? {
          reconcileProjectState: async (project: ProjectRecord) => {
            const [reconciled] = await reconcileProjectContainerStates(
              [project],
              docker,
              (id, state, provisionError, provisionWarning) =>
                eventStore.updateProjectState(id, state, provisionError, provisionWarning),
              (id) => provisioner?.isProjectProvisioning(id) === true,
              provisioner?.recoverInterruptedSleep?.bind(provisioner),
              provisioner?.recoverInterruptedWake?.bind(provisioner),
            );
            return reconciled ?? project;
          },
        }
      : {}),
    ...(projectDocker !== undefined
      ? {
          sandboxUpdates: createSandboxUpdateChecker({
            docker: projectDocker,
            defaultProjectImage,
            defaultProjectImageVersion: config.defaultProjectImageVersion,
            toolkitFeatureRef:
              devcontainerFeature === undefined
                ? undefined
                : async () => (await devcontainerFeature())?.ref,
          }),
        }
      : {}),
    // Repo root reserved for the human/main session — the server's delete path
    // never removes it (#105 safety guard); sessions always run in their own worktree.
    ...(config.repoDir !== undefined ? { workspaceDir: config.repoDir } : {}),
    // Multi-repo fleet-registry provisioner + deprovisioner (§19.3/#19.8). Absent →
    // the `project` field on POST /sessions and POST /projects/:id/deprovision
    // both return 503 (the mobile picker hides the fleet-registry UI).
    ...(provisioner !== undefined ? { provisioner } : {}),
    ...(provisioner !== undefined ? { projectSandboxLifecycleTelemetry } : {}),
    ...(config.dockerBaseUrl !== undefined && config.hostCloneRoot !== undefined
      ? { projectCloneRoot: config.hostCloneRoot }
      : {}),
    ...(!config.repoDir && config.hostCloneRoot !== undefined
      ? { projectWorktreeBranchesOnly: true }
      : {}),
    ...(config.dockerBaseUrl !== undefined && config.hostCloneRoot !== undefined
      ? {
          projectBackend: (project: ProjectRecord, selected, settings) =>
            new DockerExecBackend({
              containerName: project.containerName,
              hostProjectRoot: projectClonePath(config.hostCloneRoot as string, project),
              dockerBaseUrl: config.dockerBaseUrl,
              backend: selected,
              containerEnv: projectSettingsEnv(settings),
            }),
          // Git for the GitHub-free merge, run inside the project's own container.
          // Same shape as the backend above on purpose: the merge touches a clone the
          // session owns, so it must execute where the session's own code executes.
          // Needs the daemon client too — without one there is no way to tell a stopped
          // sandbox from a failing git, so the route reports merging as unconfigured
          // rather than running it somewhere else.
          ...(projectDocker !== undefined
            ? {
                sandboxGit: (project: ProjectRecord, clonePath: string) =>
                  createSandboxGit({
                    containerName: project.containerName,
                    hostRoot: clonePath,
                    dockerBaseUrl: config.dockerBaseUrl,
                    // Which of the two failed is settled with the daemon, never with the
                    // failed command's own output — which the repository can write.
                    inspect: () => projectDocker.inspectContainer(project.containerName),
                  }),
              }
            : {}),
          ...(config.enableProjectRuntime === true
            ? {
                projectRuntime: new DockerProjectRuntime({
                  resolveUser: resolvePreviewUser,
                  dockerBaseUrl: config.dockerBaseUrl,
                }),
              }
            : {}),
        }
      : {}),
    audit: {
      recorder: auditRecorder,
      log: auditLog,
      buildDiagnostics,
      serverLogs: createServerLogSource(runtimeDocker, config.diagnosticServerContainerId),
    },
    ...(projectDocker === undefined
      ? {}
      : {
          onProjectHidden: async () => {
            await runDockerGc({
              docker: projectDocker,
              log: app.log,
              imageReferences,
              ...(config.dockerGcPolicy !== undefined ? { policy: config.dockerGcPolicy } : {}),
              imagesOnly: true,
              onProjectImageRemoved: (image) =>
                auditRecorder.imageRemoved({ imageRef: image.ref, imageId: image.imageId }),
            });
          },
        }),
    ...(deprovisioner !== undefined ? { deprovisioner } : {}),
    // Per-project session worktree factory whose `refreshBase` fetch carries the
    // project-scoped token (only wired when the App-token mint + docker/clone-root
    // are configured — same guard as `refreshProjectToken`).
    ...(projectWorktrees !== undefined ? { projectWorktrees } : {}),
    conductor: {
      ensureWorkspace: (session) => sessionStorage?.ensureWorkspace(session) ?? Promise.resolve(),
      // Stable ACP v1 is the only Claude transport (ADR 0012); the native
      // stream-json backend it replaced has been removed, rollback included.
      backend: new AcpClaudeBackend(),
      // ACP delegates every approval decision to its client. Keep Verity's
      // durable permission card/decision channel authoritative for those calls.
      permissionControl: true,
      // Capture each session's verbatim .jsonl so it survives + is resumable.
      transcript: transcriptStore,
      ...(config.dataVolumeRoot !== undefined
        ? {
            agentContext: async (session, initiatedBy) => {
              const status =
                session.projectId && config.runnerSupervisor === true
                  ? await requestRunnerSupervisor(
                      join(config.dataVolumeRoot!, 'runners', session.projectId, 'supervisor.sock'),
                      { kind: 'status' },
                    ).catch(() => undefined)
                  : undefined;
              return resolveAgentContext(
                eventStore,
                config.dataVolumeRoot!,
                session,
                (projectId) =>
                  readOrMigrateProjectOverview(config.dataVolumeRoot!, projectId, async () => {
                    const approved = await eventStore.knowledge.getProjectOverview(projectId);
                    return (
                      approved?.bodyMarkdown ??
                      (await eventStore.getProjectSettingsRaw(projectId))?.memory ??
                      undefined
                    );
                  }),
                status?.['builtInSkillsVersion'] === 1 &&
                  status['builtInSkillsManifestHash'] === AGENT_SKILL_MANIFEST_HASH,
                initiatedBy,
              );
            },
            projectOverview: async (projectId: string) => {
              return readOrMigrateProjectOverview(config.dataVolumeRoot!, projectId, async () => {
                const approved = await eventStore.knowledge.getProjectOverview(projectId);
                if (approved !== null) return approved.bodyMarkdown;
                return (await eventStore.getProjectSettingsRaw(projectId))?.memory ?? undefined;
              });
            },
            projectDecisionDirectory: (projectId: string) =>
              projectDecisionDirectory(config.dataVolumeRoot!, projectId),
          }
        : {}),
      // ADR 0011 D3: expose the project's secret alias names to every turn whose
      // transport carries the brokered tools — ACP included, not just codex.
      brokeredSecretAliases,
      // ADR 0011 D2: scoped operator grants auto-approve matching brokered-secret prompts.
      checkBrokeredHttpGrant: async (input) => {
        const bindingId = await brokeredGrantBindingId(input.projectId);
        return bindingId === undefined ||
          (input.bindingId !== undefined && input.bindingId !== bindingId)
          ? false
          : brokeredHttpGrants.check({ ...input, bindingId: input.bindingId ?? bindingId });
      },
      persistBrokeredHttpGrant: async (input) => {
        const bindingId = await brokeredGrantBindingId(input.projectId);
        if (
          bindingId === undefined ||
          (input.bindingId !== undefined && input.bindingId !== bindingId)
        ) {
          throw new Error('Doppler access changed before saving approval');
        }
        await brokeredHttpGrants.grant({ ...input, bindingId: input.bindingId ?? bindingId });
      },
      // Auto-name an unnamed session from its opening turn: the conductor derives a
      // 2–3 word title from the first chat using the session's OWN model (routed via
      // the same backend its turns run on). `afterTurns: 1` names off the very first
      // exchange, and the attempt fires at turn START — concurrently with the turn, off
      // the operator's prompt — so the name lands in seconds rather than waiting for the
      // reply to stream or the turn to settle. Best-effort — a failure just leaves the
      // branch label. When a title lands, also ask the same model for a short
      // English branch candidate and let the branch service rename only fresh,
      // unpublished Verity-created branches in place.
      autoTitle: {
        afterTurns: 1,
        ...(branches !== undefined
          ? {
              onBranchName: async (session, branchName) => {
                if (
                  !(await branchRenameAppliesToSession(session, (id) => eventStore.getProject(id)))
                ) {
                  return;
                }
                await branches.autoRename(session.worktree, branchName);
              },
            }
          : {}),
      },
      // Runner wiring (ADR 0006), opt-in per deployment flag — see {@link
      // buildRunnerConductorWiring}. `runnerSupervisor` routes project turns through a
      // restart-surviving Sandbox {@link SupervisorRunnerClient} (Server-owned transcript
      // + reattach recovery); `runnerTransport` uses the in-process
      // {@link FileTailRunnerClient} event-file/control-socket transport; neither leaves
      // the Conductor's default loopback byte-for-byte unchanged. `eventStore` is the real
      // EventSink; events republish onto the SAME hoisted `bus` the live WS stream reads.
      // Switching a session to another backend drops the previous backend's
      // `session_backend_state` row, and that row was the only thing naming its files
      // on the runner runtime. Purging here is the one chance to reach them; otherwise
      // they survive even the eventual delete of the session that wrote them. The
      // `backend-switch` scope keeps what the session still needs while it lives —
      // claude's `subagents/` tree has no other copy — and the startup sweep collects
      // that remainder once the displaced id is no longer live.
      ...(purgeRunnerArtifacts === undefined
        ? {}
        : {
            purgeBackendArtifacts: async (
              sessionId: string,
              bindings: readonly { backend: string; backendSessionId: string }[],
            ): Promise<void> => {
              await purgeRunnerArtifacts(sessionId, bindings, 'backend-switch');
            },
          }),
      ...buildRunnerConductorWiring({
        // The dedicated control-plane service is itself a supervisor transport;
        // never let its feature flag coexist with loopback conductor wiring.
        runnerSupervisor: config.runnerSupervisor === true || config.controlPlaneRunner === true,
        runnerTransport: config.runnerTransport === true,
        dataVolumeRoot: config.dataVolumeRoot,
        ...(config.controlPlaneRunner === true
          ? { controlPlaneProjectId: CONTROL_PLANE_RUNNER_PROJECT_ID }
          : {}),
        isControlPlaneProject: async (projectId) =>
          (await eventStore.getProject(projectId))?.kind === 'control_plane',
        store: eventStore,
        bus,
        transcript: transcriptStore,
        allocateEventFile,
        allocateControlSocket,
        getSession: (sessionId) => eventStore.getSession(sessionId),
        onMissingSupervisorSocket: ({ projectId, socketPath, reason }) => {
          app.log.warn(
            { projectId, socketPath, reason },
            'verity: project runner supervisor is unavailable',
          );
        },
        hostCloneRoot: config.hostCloneRoot,
        containerProjectRoot: RUNNER_CONTAINER_PROJECT_ROOT,
        // ADR 0014 D1: the ACP tool gateway bearer registry. The
        // registry is the Server's half of the gateway bearer — the runner client
        // mints one per ACP turn and retires it when the turn settles.
        mcpGatewayTokens,
        turnCredentials,
        mcpProxyTokens,
        listProjectHttpMcpServers: async (projectId, initiatedBy) => {
          const [bindings, connections] = await Promise.all([
            eventStore.listProjectMcpBindings(projectId),
            eventStore.listHttpMcpConnections(),
          ]);
          const enabled = new Set(
            bindings.filter((binding) => binding.enabled).map((binding) => binding.connectionId),
          );
          return connections
            .filter(
              (connection) =>
                connection.enabled &&
                enabled.has(connection.id) &&
                httpMcpConnectionUsableBy(connection, initiatedBy?.userId),
            )
            .map((connection) => ({ id: connection.id, name: connection.name }));
        },
        // ADR 0011 D2: a standing grant answers the prompt inside the tail, before
        // it can become an approval card or a push notification.
        autoApprovePermission: async (sessionId, request, channel) => {
          const toolName = brokeredGrantToolName(request.toolName);
          if (toolName === undefined) return false;
          const target = brokeredGrantTarget(toolName, request.input);
          if (target === undefined) return false;
          const session = await eventStore.getSession(sessionId);
          const projectId =
            session?.projectId ??
            (session !== undefined && config.controlPlaneRunner === true
              ? CONTROL_PLANE_RUNNER_PROJECT_ID
              : undefined);
          if (projectId == null) return false;
          const bindingId = await brokeredGrantBindingId(projectId);
          if (bindingId === undefined) return false;
          return brokeredHttpGrants.check({
            projectId,
            sessionId,
            bindingId,
            channel,
            ...target,
          });
        },
      }),
      ...(config.permissionMode !== undefined ? { permissionMode: config.permissionMode } : {}),
      // OpenCode backend (#143) for provider-qualified models, over ACP like every
      // other agent since ADR 0012 Amendment 4. The conductor routes by model; not
      // enabled → Claude-only.
      openCodeBackend: new AcpOpenCodeBackend(),
      // Codex runs exclusively over ACP. ADR 0014 supplies its brokered tools through
      // the approval-gated per-turn MCP gateway.
      ...(config.codexEnabled === true
        ? {
            codexBackend: new AcpCodexBackend(),
          }
        : {}),
      sessionBackend: async (session, selected, preparation) => {
        const isClaudeSession = usesClaudeBackend(session.model);
        const isCodexSession = isCodexModel(session.model);
        const isOpenCodeSession = selected.runnerSupervisorBackend === 'opencode-acp';
        // Every branch below assumes a Claude turn is an ACP turn: none of them
        // fetches an access token, and no agent process is handed
        // `CLAUDE_CODE_OAUTH_TOKEN` except the non-secret egress placeholder. The
        // refusal that makes that assumption safe is a tested pure decision.
        const transportRefusal = claudeTransportRefusal({
          isClaudeSession,
          runnerSupervisorBackend: selected.runnerSupervisorBackend,
        });
        if (transportRefusal !== undefined) throw new Error(transportRefusal);
        const prepareControlPlaneRunner = (): Promise<boolean> =>
          prepareControlPlaneRunnerForTurn({
            enabled: config.controlPlaneRunner === true,
            dataVolumeRoot: config.dataVolumeRoot,
            refreshIdentity: refreshControlPlaneRunnerIdentity,
            awaitIdentity: awaitControlPlaneRunnerIdentity,
          });
        // Keep Claude ACP selected even when the pre-preparation socket snapshot is
        // absent: serializeProjectTurnPreparation below may recreate the Sandbox and
        // restore its supervisor. The runner performs the authoritative reachability
        // check after that repair and fails Claude ACP closed instead of falling back.
        // Project-less control-plane sessions resolve the fixed dedicated runtime
        // above. Every other ACP backend uses the same fail-closed boundary.
        const sessionSelected = selected;
        // Ask the closed set of supervised backends rather than listing today's three:
        // each of them runs in the dedicated Runner, needs it prepared, and needs the
        // gateway synchronized before the turn — and the per-backend disjunction this
        // replaces had already been written twice, once here and once for projects
        // below, so a fourth backend would have had to be remembered in four places.
        // The label only names the backend in the refusal; it decides nothing.
        const controlPlaneRunnerTurn = async (
          backend: RunnerSupervisorBackend,
        ): Promise<typeof sessionSelected> => {
          if (!(await prepareControlPlaneRunner())) {
            throw new Error(
              `${runnerSupervisorBackendLabel(backend)} control-plane turns require the dedicated control-plane runner.`,
            );
          }
          await synchronizeAgentGatewayForTurn();
          return sessionSelected;
        };
        const acpControlPlaneBackend = isRunnerSupervisorBackend(selected.runnerSupervisorBackend)
          ? selected.runnerSupervisorBackend
          : undefined;
        if (session.projectId === null) {
          if (acpControlPlaneBackend !== undefined) {
            return await controlPlaneRunnerTurn(acpControlPlaneBackend);
          }
          // Whatever is left is a loopback backend with no Verity-held provider
          // credential of its own, so it inherits the control-plane agent
          // environment and nothing else.
          return withControlPlaneAgentCredentials(sessionSelected, async (inherited) =>
            materializeControlPlaneAgentEnv(secretRoot, inherited),
          );
        }
        const store = new EventStore(db, secretCipher);
        const project = await store.getProject(session.projectId);
        if (project === undefined) {
          if (isClaudeSession) {
            throw new Error('Claude ACP cannot verify its project isolation boundary.');
          }
          return undefined;
        }
        if (project.kind === 'control_plane') {
          if (acpControlPlaneBackend !== undefined) {
            return await controlPlaneRunnerTurn(acpControlPlaneBackend);
          }
          return withControlPlaneAgentCredentials(sessionSelected, async (inherited) =>
            materializeControlPlaneAgentEnv(secretRoot, inherited),
          );
        }
        const supervisorRefusal = acpSupervisorWiringRefusal({
          runnerSupervisorBackend: selected.runnerSupervisorBackend,
          runnerSupervisor: config.runnerSupervisor === true,
          dataVolumeRootAvailable: config.dataVolumeRoot !== undefined,
          dockerAvailable: config.dockerBaseUrl !== undefined,
          cloneRootAvailable: config.hostCloneRoot !== undefined,
        });
        if (supervisorRefusal !== undefined) throw new Error(supervisorRefusal);
        // Refused BEFORE `serializeProjectTurnPreparation`, so a pure configuration
        // error leaves no half-prepared turn behind. Both operands are assigned once
        // during start-up (`claudeEgressIdentity` above; nothing in a turn creates the
        // service), so the answer cannot change inside the preparation below.
        //
        // Two operands, not three: the routed env also needs the gateway itself, but a
        // deployment that can serve project turns at all already refuses to START
        // without it ('Project Docker provisioning requires the Agent Gateway'), so
        // `routed` can never point an agent at a connector that was never provisioned.
        const claudeEgressActive =
          claudeEgressIdentity !== undefined && config.claudeConnectorPort !== undefined;
        const egressRefusal = claudeProjectEgressRefusal({
          isClaudeSession,
          egressActive: claudeEgressActive,
        });
        if (egressRefusal !== undefined) throw new Error(egressRefusal);
        if (config.dockerBaseUrl === undefined || config.hostCloneRoot === undefined) {
          return undefined;
        }
        const dockerBaseUrl = config.dockerBaseUrl;
        const hostCloneRoot = config.hostCloneRoot;
        return serializeProjectTurnPreparation(
          project.id,
          preparation.sessionId,
          preparation.canWait,
          async (queuedSessionIds) => {
            await ensureProjectSandboxReadyForTurn({
              project,
              getProject: (projectId) => store.getProject(projectId),
              canWait: preparation.canWait,
              waitingOn: (message) => preparation.waitingOn(message),
              requestingSessionIds: queuedSessionIds,
              ...(provisioner?.ensureProjectSandboxAwake === undefined
                ? {}
                : {
                    ensureAwake: provisioner.ensureProjectSandboxAwake.bind(provisioner),
                  }),
            });
            await refreshProjectToken?.(project);
            const settings = isProjectSettingsReader(store)
              ? await store.getProjectSettings(project.id)
              : undefined;
            // A sandbox is single-homed on its own project network and reaches Claude
            // only through its generation-matched relay, so the target stamped on it
            // is that relay (`provisioner.ts`: claudeGatewayUrl(relayActivation)) —
            // never the gateway origin. Comparing the stamp against the gateway URL
            // therefore never matched and failed every Claude turn closed; the relay,
            // not the sandbox, is what forwards to the gateway.
            if (
              (isClaudeSession || isCodexSession || isOpenCodeSession) &&
              claudeEgressActive &&
              agentGatewayUrl !== undefined
            ) {
              if (docker === undefined) {
                throw new Error('Claude egress routing target cannot be verified');
              }
              let gatewayReady: boolean;
              let repairFailure: AgentGatewayRepairFailure | undefined;
              try {
                const inspected = await docker.inspectContainer(project.containerName);
                gatewayReady = await agentGatewayReady(project.id, inspected);
              } catch (error) {
                app.log.warn(
                  { err: error, projectId: project.id },
                  'Could not verify agent gateway relay provisioning',
                );
                throw new Error('Claude egress routing target cannot be verified', {
                  cause: error,
                });
              }
              if (!gatewayReady) {
                // The Sandbox cannot serve this turn — but that is a repairable state,
                // not a reason to end the turn. Failing here surfaced as a red
                // `run_failed` the operator had to resolve by hand, and the periodic
                // reconciler could not resolve it either: it defers around in-flight
                // turns, and the turn waiting on the repair is what keeps the project
                // busy. So rebuild now, tell the operator it is happening, and continue
                // the turn on the fresh Sandbox once it is up. Background resolutions
                // (auto-title, reattach) don't wait — they keep failing fast.
                const repair = await repairSandboxForAgentTurn(
                  project,
                  preparation,
                  queuedSessionIds,
                );
                gatewayReady = repair.ready;
                repairFailure = repair.ready ? undefined : repair.failure;
              }
              if (!gatewayReady) {
                const message = agentGatewayUnavailableMessage(repairFailure);
                // A background resolution never attempted the rebuild above, so its
                // failure says nothing about whether the Sandbox is repairable — only
                // that this resolution would not wait for one. Reporting it as the
                // transient class keeps it from freezing the session on `crashed` (the
                // badge outlives the turn; the Sandbox usually does not). A foreground
                // turn, whose repair genuinely ran and failed, keeps the red badge and
                // the operator-facing instruction above.
                throw preparation.canWait ? new Error(message) : sandboxNotReadyError(message);
              }
              // Binding issuance and revocation keep the routed set current: read the
              // latest rotating credential and wait for the gateway to acknowledge
              // that exact cached identity configuration.
              await synchronizeAgentGatewayForTurn();
              // The checks above trust Docker's `running`, which a relay reaches
              // before its process listens. Confirm from inside the Sandbox that
              // the connections this agent needs accept connects before launching
              // it; until then the turn waits visibly instead of failing on a
              // refused connection.
              if (dataVolumeRoot !== undefined) {
                await waitForSandboxTurnReadiness({
                  projectId: project.id,
                  sessionId: preparation.sessionId,
                  agent: isClaudeSession ? 'claude' : isCodexSession ? 'codex' : 'opencode',
                  relayed: projectRelayEnabled,
                  canWait: preparation.canWait,
                  waitingOn: (message) => preparation.waitingOn(message),
                  probe: () => probeSandboxEgressReadiness(dataVolumeRoot, project.id),
                  log: app.log,
                });
              }
            }
            // A Claude project agent is pointed at the sandbox connector with only the
            // placeholder, so the real token never enters the untrusted sandbox.
            // Non-Claude sessions never route.
            const egressRouted = claudeEgressRouteEnabled({
              isClaudeSession,
              egressActive: claudeEgressActive,
            });
            return new DockerExecBackend({
              containerName: project.containerName,
              hostProjectRoot: projectClonePath(hostCloneRoot, project),
              dockerBaseUrl,
              backend: sessionSelected,
              containerEnv: {
                ...projectSettingsEnv(settings),
                ...claudeEgressAgentEnv({
                  routed: egressRouted,
                  connectorPort: config.claudeConnectorPort,
                }),
              },
            });
          },
        );
      },
    },
  });
  if (managedMatrixControl) {
    const retryMatrixActivation = async (): Promise<void> => {
      try {
        await activateMatrixIfConfigured();
      } catch (error) {
        app.log.warn({ err: error }, 'Matrix connector activation will retry');
      }
    };
    void retryMatrixActivation();
    const matrixActivationTimer = setInterval(() => void retryMatrixActivation(), 10_000);
    matrixActivationTimer.unref?.();
    app.addHook('onClose', () => clearInterval(matrixActivationTimer));
  }
  // Bind before any unlock or startup can dial, so handshake diagnostics use pino.
  uplinkLog.bind(app.log);
  // One-time reconciliation of backend transcripts left by sessions that no longer
  // exist (see `session-artifact-sweep.ts`). Deleting a session now takes its
  // transcripts with it, but everything deleted BEFORE that fix left its files behind
  // and no future delete can reach them — those sessions are gone from the store. It is
  // also the backstop for the one case the delete path cannot cover: a backend switch
  // leaves claude's `subagents/` tree in place (it is the only copy while the session
  // lives), so the tree of a displaced binding is collected once the session it belongs
  // to is deleted and its worktree stops being live.
  //
  // Not awaited into the boot: a start must not wait on a directory walk, and nothing
  // downstream depends on the outcome. What IS handed back on the server object is the
  // store-read phase alone ({@link EmbeddedServer.transcriptSweep}), so a caller that
  // closes immediately — a test, a one-shot CLI run — settles those two queries before
  // `destroy()` without also waiting out the walk behind them. Blocking a SIGTERM on a
  // full walk of a large volume is how a graceful shutdown becomes a SIGKILL, and the
  // walk touches nothing that shutdown tears down. Not on a timer either: the ongoing
  // case is handled at the delete itself, so once per start is enough.
  const sweepMode = config.transcriptSweep ?? 'on';
  let transcriptSweep: Promise<void> | undefined;
  let transcriptSweepWalk: Promise<SweepResult | undefined> | undefined;
  // Aborted by `close()`, which then waits for the walk to notice. Without it a caller
  // that closes the server and tears its data root down is racing a delete loop over that
  // same root — `main.ts` never sees it because it exits immediately after, but this is a
  // public entry point and not every caller does.
  const sweepAbort = new AbortController();
  /**
   * Started only once the rest of the build has succeeded — see the call site.
   *
   * Nothing here depends on where it is defined; what matters is that the walk is not
   * running while `buildEmbeddedServer` can still throw. A rejected build hands the caller
   * no server, so nobody holds {@link sweepAbort} or the walk promise, and a delete loop
   * over `runners/` would carry on under a boot that failed.
   */
  const startTranscriptSweep = (): void => {
    if (dataVolumeRoot === undefined || sweepMode === 'off') return;
    const runnersRoot = join(dataVolumeRoot, 'runners');
    const dryRun = sweepMode === 'dry';
    let storeReadsDone!: () => void;
    const storeReads = new Promise<void>((resolve) => {
      storeReadsDone = resolve;
    });
    transcriptSweep = storeReads;
    transcriptSweepWalk = (async () => {
      let liveIds: string[];
      let worktrees: string[];
      try {
        [liveIds, worktrees] = await Promise.all([
          eventStore.listLiveBackendSessionIds(),
          eventStore.listSessionWorktrees(),
        ]);
      } finally {
        storeReadsDone();
      }
      const result = await sweepOrphanArtifacts({
        runnersRoot,
        liveIds: new Set(liveIds),
        // The claude directory name of every session that still exists. `encodeCwd` is
        // claude's own naming rule, applied to the cwd as the SANDBOX saw it — the same
        // derivation the delete path uses, so the two agree on which directory belongs
        // to which session.
        liveCwdDirs: new Set(worktrees.map((worktree) => encodeCwd(sessionSandboxCwd(worktree)))),
        dryRun,
        signal: sweepAbort.signal,
      });
      // Logged unconditionally, at info: this deletes conversations, so what it did on
      // a given boot has to be answerable afterwards — including "nothing".
      const summary = {
        dryRun,
        scanned: result.scanned,
        // Under `dry` nothing was deleted, so the count goes out under a name that
        // says so: a dashboard summing `removed` must not be fed files that are still
        // there by a run whose whole point was not to touch them.
        ...(dryRun ? { wouldRemove: result.removed } : { removed: result.removed }),
        megabytes: Number((result.bytes / 1024 / 1024).toFixed(1)),
        liveKept: result.liveKept,
        graceKept: result.graceKept,
        liveCwdSkipped: result.liveCwdSkipped,
        claudeCwdDirsSeen: result.claudeCwdDirsSeen,
        failed: result.failed,
      };
      if (result.aborted) {
        // Shutdown reached the walk before the walk was done. Its own line rather than the
        // ordinary one, because every count in the summary is a partial and the ordinary
        // line is what someone reads to answer "what did this boot delete".
        app.log.info(
          { ...summary, aborted: true },
          'verity: orphaned backend transcript sweep stopped by shutdown',
        );
        return result;
      }
      if (result.storeReportedNoSession) {
        // The bluntest of the two refusals, and the one that catches a server pointed at
        // the wrong control-plane database: the store named no session at all, the volume
        // was full of transcripts, and both readings of that — a deployment with no
        // sessions, or a database that is not this volume's — end with nothing deleted.
        // If the store really is this volume's and really is empty, the held files are
        // dead and can be removed from the volume directly; the sweep will not do it on a
        // store it cannot corroborate.
        app.log.error(
          { ...summary, held: result.held },
          'verity: orphaned transcript sweep removed nothing — the store knows of no session at all',
        );
        return result;
      }
      if (result.claudeGuardUnproven !== undefined) {
        // Either way the sweep collected no claude file this boot, and either way the count
        // it did NOT take goes out with it. The level splits on how much the sweep actually
        // knows. A contradiction means one live backend id appeared under multiple cwd
        // directories, so no legacy mapping is unique; this line is then the only warning
        // before a session's unreproducible `subagents/` tree would have gone. The weaker check only
        // says nothing matched, which a deployment whose live sessions have never run claude
        // sits in legitimately and indefinitely — an error line that never clears teaches
        // people to ignore error lines.
        const level = result.claudeGuardUnproven === 'contradiction' ? 'error' : 'warn';
        app.log[level](
          { ...summary, held: result.held, signal: result.claudeGuardUnproven },
          'verity: orphaned transcript sweep kept every claude file — live-worktree guard unproven',
        );
        return result;
      }
      app.log.info(
        summary,
        dryRun
          ? 'verity: orphaned backend transcript sweep (dry run, nothing removed)'
          : 'verity: orphaned backend transcript sweep',
      );
      return result;
    })().catch((error: unknown) => {
      // Covers the store reads too, which is why `storeReadsDone` resolves from a
      // `finally` — a close waiting on that promise must not hang on a failed query.
      app.log.warn({ err: error }, 'verity: orphaned transcript sweep failed');
      return undefined;
    });
  };

  app.addHook('onClose', async () => {
    maintenanceImages?.abort();
    await runnerCacheStorage?.stop();
    await sessionStorage?.stop();
  });

  if (embeddedSecretJobs !== undefined) {
    registerSecretJobRoutes(app, embeddedSecretJobs.service, (header) => {
      const token = /^Bearer ([^\s]+)$/i.exec(header ?? '')?.[1];
      const actorId = authRegistry.resolveId(token);
      if (token === undefined || actorId === undefined) return undefined;
      return {
        actorId,
        authorizationHash: createHash('sha256')
          .update(`verity.secret-job-approval.v1\0${token}`)
          .digest('hex'),
      };
    });
    app.addHook('onClose', () => embeddedSecretJobs.service.close());
  }
  if (secretProviderCatalog !== undefined) {
    const dopplerOptions = config.secretJobs!.doppler!;
    registerSecretProviderRoutes(
      app,
      secretProviderCatalog,
      createDopplerSecretNameLister({
        ...dopplerOptions,
        readCredential: readBrokerDopplerCredential,
      }),
      async (header, projectId) => {
        const token = /^Bearer ([^\s]+)$/i.exec(header ?? '')?.[1];
        const actorId = token === undefined ? undefined : authRegistry.resolveId(token);
        if (
          actorId === undefined ||
          !(await config.secretJobs!.authorizeProviderAdministration!(actorId, projectId))
        ) {
          return undefined;
        }
        return actorId;
      },
    );
  }
  // Adopt the handed-off key (ADR 0008 D8) only now that everything is built.
  // Every component above was therefore constructed against a sealed store, the
  // way it is on an interactive boot, and the key goes in through the same door
  // an operator unlock uses — the very callback `onSecretUnlocked` runs.
  if (handedOffKeyMaterial !== undefined) {
    await adoptHandedOffSecretKey({
      cipher: secretCipher,
      material: handedOffKeyMaterial,
      activate: async () => {
        await projectAgentGatewayIdentity();
        // The candidate constructed every component against a sealed store, so the
        // Runner identity publish was deferred exactly as on an interactive boot.
        // This callback IS the update path's unlock — carry it out here too, or the
        // promoted Server runs without Runner identity until some later turn
        // happens to refresh it. Best-effort for the same reason the boot path is:
        // a certificate must never cost the key handover it rides in on.
        await publishRunnerIdentity('key handover');
        await codexModelCatalog?.refresh();
      },
    });
  }
  // A sealed credentials read triggers feature revocation. Wait for key handover;
  // interactive boots start the client through onSecretUnlocked instead.
  if (!secretCipher.isSealed()) uplinkControl?.start();
  if (localPreviewManager && projectDocker) {
    const sweepLocalConnectors = () =>
      sweepOrphanedLocalPreviews(projectDocker, hostname(), (id, shareId) =>
        localPreviewManager.ownsConnector(id, shareId),
      );
    const reconcileLocal = async (): Promise<void> => {
      if (secretCipher.isSealed()) return;
      // Restore durable ownership before cleanup can classify surviving connectors.
      await localPreviewManager.reconcile();
      previewRecoveryReady = true;
      await sweepLocalConnectors();
    };
    await reconcileLocal().catch((error) =>
      app.log.warn({ err: error }, 'local preview recovery deferred until dependencies recover'),
    );
    const stopLocalReconciler = startRunnerSupervisorReconciler(reconcileLocal, 10_000, (error) =>
      app.log.warn({ err: error }, 'local preview reconciliation failed'),
    );
    app.addHook('onClose', async () => {
      previewRecoveryReady = false;
      await stopLocalReconciler();
      await managedDevServerManager?.close();
      await localPreviewManager.close();
    });
  }
  await trustedCliOutput.cleanup();
  let outputSweepRunning = false;
  const outputSweep = setInterval(() => {
    if (outputSweepRunning) return;
    outputSweepRunning = true;
    void trustedCliOutput
      .cleanup()
      .catch(() => {
        console.warn('verity: trusted CLI output cleanup failed');
      })
      .finally(() => {
        outputSweepRunning = false;
      });
  }, 60_000);
  outputSweep.unref();
  app.addHook('onClose', () => clearInterval(outputSweep));
  // An interrupted build must not hold build storage until someone reboots the host.
  // Ask at start and every five minutes whether earlier attempts provably ended.
  if (buildStorage !== undefined) {
    const storage = buildStorage;
    // A recreate refused for build storage waits out its backoff otherwise; the
    // space it waited for is free now, so let the next reconcile pass retry it.
    storage.setReleaseListener(() => provisioner?.resetStorageRefusedRepairBackoff?.());
    const buildDockerHost =
      config.dockerBaseUrl === undefined ? undefined : dockerHostFor(config.dockerBaseUrl);
    let reconciling = false;
    const reconcileBuildStorage = async () => {
      if (reconciling) return;
      reconciling = true;
      try {
        const unresolved = await storage.reconcile({
          ...(buildDockerHost === undefined
            ? {}
            : { buildkitIdle: () => devcontainerBuilderIdle(buildDockerHost) }),
          ...(config.projectEgressSocketPath && config.projectEgressKeyPath
            ? {
                protectedBuildStatus: (reference: { projectId: string; attemptId: string }) =>
                  createProtectedBuildClient({
                    socketPath: config.projectEgressSocketPath!,
                    token: () => readFileSync(config.projectEgressKeyPath!, 'utf8').trim(),
                  })({ operation: 'status', ...reference }),
                protectedBuildSlot: () =>
                  createProtectedBuildClient({
                    socketPath: config.projectEgressSocketPath!,
                    token: () => readFileSync(config.projectEgressKeyPath!, 'utf8').trim(),
                  })({ operation: 'slot' }),
              }
            : {}),
        });
        if (unresolved.length > 0)
          app.log.warn(
            { attempts: unresolved },
            'Build storage holds space for earlier build attempts whose end is not yet confirmed',
          );
      } catch (err) {
        app.log.warn({ err }, 'Build storage reconciliation failed');
      } finally {
        reconciling = false;
      }
    };
    void reconcileBuildStorage();
    const buildStorageTimer = setInterval(() => void reconcileBuildStorage(), 5 * 60_000);
    buildStorageTimer.unref();
    app.addHook('onClose', () => clearInterval(buildStorageTimer));
  }
  // Fixed-purpose counters exclude command arguments, environment values and identities.
  let previousDockerExecCounts = getDockerExecDiagnostics();
  const dockerExecDiagnosticTimer = setInterval(() => {
    const current = getDockerExecDiagnostics();
    if (
      current.started === previousDockerExecCounts.started &&
      current.active === previousDockerExecCounts.active
    )
      return;
    previousDockerExecCounts = current;
    app.log.info({ dockerExec: current }, 'verity: docker exec activity diagnostic');
  }, 60_000);
  dockerExecDiagnosticTimer.unref();
  app.addHook('onClose', () => clearInterval(dockerExecDiagnosticTimer));
  app.addHook('onClose', () => listenerDiscovery?.close());
  app.addHook('onClose', () => projectEgress?.close());
  app.addHook('onClose', () => clearInterval(systemInventoryTimer));
  if (!localPreviewManager) previewRecoveryReady = true;
  managedDevServerLog.current = (message, detail) => app.log.info(detail ?? {}, message);
  app.addHook('onClose', () => managedDevServerManager?.close());
  void listenerDiscovery?.reconcile();
  // A fresh installation provisions its starter project now, so the sandbox image
  // is pulled while the operator is still onboarding (see welcome-session.ts).
  const starterProvisioner = provisioner;
  if (starterProvisioner !== undefined) {
    void ensureStarterProject({
      store: eventStore,
      provision: (projectId) =>
        starterProvisioner.provision(projectId, {
          initiator: { kind: 'system', trigger: 'welcome_project' },
        }),
      log: app.log,
    });
  }
  app.addHook('onClose', () => claudeCredentialSync.close());
  let preserveProjectRelaysOnClose = false;
  app.addHook('onClose', () =>
    preserveProjectRelaysOnClose
      ? (projectRelayLifecycle?.suspend() ?? Promise.resolve())
      : (projectRelayLifecycle?.close() ?? Promise.resolve()),
  );
  if (previewShareManager !== undefined) {
    const reconcile = async (): Promise<void> => {
      if (secretCipher.isSealed()) return;
      await previewShareManager.reconcile();
    };
    await reconcile().catch((error) =>
      app.log.warn({ err: error }, 'public preview reconciliation failed'),
    );
    const stopPreviewReconciler = startRunnerSupervisorReconciler(reconcile, 30_000, (error) =>
      app.log.warn({ err: error }, 'public preview reconciliation failed'),
    );
    app.addHook('onClose', async () => {
      await stopPreviewReconciler();
      await uplinkControl?.stop();
    });
  } else if (projectDocker !== undefined) {
    // No edge control means no manager and therefore no reconciliation loop, so
    // shares an earlier version created would run on untouched. Close them out
    // instead of leaving live connectors and unrevocable records behind. This
    // retries on the reconcile cadence rather than only at boot — a Docker or
    // store hiccup during startup must not strand a share for the process
    // lifetime — and stops the timer once a sweep completes cleanly, because
    // without a manager nothing can create new shares to find.
    let sweeping = false;
    const sweep = async (): Promise<void> => {
      if (sweeping) return;
      sweeping = true;
      try {
        const swept = await sweepOrphanedPreviewShares({
          store: eventStore,
          docker: projectDocker,
          onShareEnded: ({ managedInstanceId, id }) => {
            if (managedInstanceId) managedLinkEnded.current?.(managedInstanceId, id);
          },
        });
        if (swept > 0) {
          app.log.warn({ swept }, 'revoked orphaned public preview shares');
        }
        clearInterval(sweepTimer);
      } catch (error) {
        app.log.warn({ err: error }, 'orphaned public preview sweep failed, retrying');
      } finally {
        sweeping = false;
      }
    };
    const sweepTimer = setInterval(() => void sweep(), 30_000);
    sweepTimer.unref?.();
    app.addHook('onClose', () => clearInterval(sweepTimer));
    void sweep();
  }

  app.addHook('onClose', () => stopNativeEvidence?.());

  let storageReclamation: StorageReclamation | undefined;

  // Host-disk GC (docker-gc.ts). Wired off `projectDocker` because that is the
  // client that CREATES the resources it collects — the devcontainer image cache
  // in `resolveOrBuildImage` and the sandbox containers whose anonymous volumes
  // can outlive them. Without this the runner's two append-only caches grow until
  // the disk is full; `docker system prune` does not reach either (the image tags
  // are tagged, not dangling, and prune skips volumes entirely).
  if (projectDocker !== undefined && config.dockerGc !== false) {
    let nativeMaintenanceRequested: string | null = null;
    const dockerGc = startDockerGcScheduler({
      docker: projectDocker,
      log: app.log,
      ...(config.dockerGcPolicy !== undefined ? { policy: config.dockerGcPolicy } : {}),
      // Free space is measured on the volume that actually fills up — the Verity
      // data root shares the host filesystem with /var/lib/docker in the reference
      // install, so this is the number that matters for disk-pressure escalation.
      ...(config.dataVolumeRoot !== undefined ? { dataRoot: config.dataVolumeRoot } : {}),
      // Read through the `let` on every pass, not captured once: the lifecycle is
      // constructed below this block, and its held set changes with every
      // provision. This is what keeps the sweep off a relay whose sandbox has not
      // been created yet — neither the listing nor elapsed time can see that.
      heldRelays: () => projectRelayLifecycle?.heldRelays() ?? [],
      beforeSweep: async () => {
        nativeMaintenanceRequested = null;
        await requestNativeReclamation()
          .then((requestedAt) => {
            nativeMaintenanceRequested = requestedAt;
          })
          .catch(() => undefined);
        await runnerCacheStorage?.runOnce();
        await sessionStorage?.runOnce();
      },
      onReport: (report) => {
        report.nativeRequestedAt = nativeMaintenanceRequested;
        lastDockerGcReport = report;
      },
      retireContainers: async () => {
        const removed = await retireCompletedUpdateContainers(projectDocker);
        if (!provisioner?.withProjectExclusiveMutation) return { removed, errors: [] };
        const result = await retireStoppedContainers({
          docker: projectDocker,
          listProjects: () => eventStore.listProjects(),
          // Match helper execution: acquire lifecycle ownership before preview/storage
          // barriers, and hold both until result collection/retention finishes.
          withProjectMutation: (id, run) =>
            provisioner.withProjectExclusiveMutation(id, () =>
              withStorageProjectMutation(id, async () => {
                if (managedDevServerManager?.hasRunningServers(id))
                  throw new Error('Managed dev server is active');
                if (
                  (localPreviewManager?.listProject(id).length ?? 0) > 0 ||
                  (await eventStore.listPublicPreviewShares(id)).some((s) =>
                    ['creating', 'active', 'revoking'].includes(s.state),
                  )
                )
                  throw new Error('Preview is active');
                await run();
              }),
            ),
        });
        return {
          removed: [...removed, ...result.removed],
          errors: result.errors,
          retained: result.retained,
        };
      },
      imageReferences,
      onProjectImageRemoved: (image) =>
        auditRecorder.imageRemoved({ imageRef: image.ref, imageId: image.imageId }),
    });
    storageReclamation = new StorageReclamation({
      collect: () => dockerGc.runOnce(),
      worktrees: () => sessionStorage?.lastReport,
      runnerCaches: () => runnerCacheStorage?.lastReport,
      dataRoot: config.dataVolumeRoot,
    });
    // A waiting build runs only the capacity steps, never the full maintenance
    // pass: that pass first works through runner caches and session worktrees,
    // which alone outlasted the build's reclamation deadline.
    buildStorage?.setReclaimer(async () =>
      describeBuildCapacityReclamation(await dockerGc.reclaimBuildCapacity()),
    );
    app.addHook('onClose', () => {
      dockerGc.stop();
    });
  }
  registerStorageReclamationRoutes(app, eventStore, storageReclamation);
  if (codexModelCatalog !== undefined) {
    app.addHook('onClose', () => codexModelCatalog.close());
  }

  if (projectRelayEnabled) {
    if (
      docker === undefined ||
      config.dataVolumeRoot === undefined ||
      config.dataVolume === undefined
    )
      throw new Error('project relay Docker runtime is unavailable');
    const relayGid = config.projectRelayGid ?? 65_532;
    if (!(process.getgroups?.() ?? []).includes(relayGid) && process.getgid?.() !== relayGid) {
      throw new Error(`project relay requires server membership in group ${String(relayGid)}`);
    }
    const brokerSocketRoot = join(config.dataVolumeRoot, 'relay', 'broker');
    const claudeSocketRoot = join(config.dataVolumeRoot, 'relay', 'claude');
    const codexSocketRoot = join(config.dataVolumeRoot, 'relay', 'codex');
    mkdirSync(brokerSocketRoot, { recursive: true, mode: 0o700 });
    mkdirSync(claudeSocketRoot, { recursive: true, mode: 0o700 });
    mkdirSync(codexSocketRoot, { recursive: true, mode: 0o700 });
    projectRelayLifecycle = createProjectRelayRuntime({
      app,
      docker,
      signingCapabilities,
      githubCapabilities: ghTokenCapabilities,
      forgeProxy,
      forgeProxyEnabled,
      forgeAuthorities: async (projectId) => {
        const project = await eventStore.getProject(projectId);
        if (project?.kind !== 'forgejo')
          return ['github.com:443', 'api.github.com:443', 'uploads.github.com:443', 'ghcr.io:443'];
        const connection = project.forgeConnectionId
          ? await eventStore.forgeConnections.get(project.forgeConnectionId)
          : undefined;
        if (!connection || connection.provider !== 'forgejo') return [];
        const url = new URL(connection.baseUrl);
        return [`${url.hostname}:${url.port || '443'}`];
      },
      image: config.projectRelayImage!,
      dataVolume: config.dataVolume,
      dataVolumeRoot: config.dataVolumeRoot,
      brokerSocketRoot,
      claudeSocketRoot,
      codexSocketRoot,
      socketOwnerUid: process.getuid?.() ?? 1000,
      relayGid,
      projectNetwork: projectNetworkName,
    });
  }

  if (
    provisioner !== undefined &&
    (config.runnerSupervisor === true || claudeEgressIdentity !== undefined)
  ) {
    const reconcileRunnerSupervisors = async (): Promise<void> => {
      await provisioner.reconcileRunnerSupervisors(
        await eventStore.listProjects({ includeHidden: true }),
      );
    };
    const reportReconcileError = (error: unknown): void => {
      app.log.warn({ err: error }, 'Runner supervisor reconciliation failed');
    };
    await reconcileRunnerSupervisors().catch(reportReconcileError);
    stopRunnerSupervisorReconciler = startRunnerSupervisorReconciler(
      reconcileRunnerSupervisors,
      config.runnerSupervisorReconcileIntervalMs,
      reportReconcileError,
    );
  }

  // Last thing before the server object exists, because from here on the only way out is
  // the `return` below: everything that could still have thrown has run, so the caller is
  // guaranteed to receive the handle that can stop this walk.
  startTranscriptSweep();
  sessionCleanupWorker?.start();

  // Latch so a double SIGINT/SIGTERM (or any repeat call) coalesces onto one
  // teardown instead of double-closing the app/db.
  let closing: Promise<void> | undefined;
  return {
    app,
    ...(embeddedSecretJobs !== undefined ? { secretJobs: embeddedSecretJobs } : {}),
    ...(transcriptSweep !== undefined ? { transcriptSweep } : {}),
    ...(transcriptSweepWalk !== undefined ? { transcriptSweepWalk } : {}),
    secretKeyHandoff: {
      exportKeyMaterial: () => secretCipher.exportKeyMaterial(),
    },
    close: (options = {}) =>
      (closing ??= (async () => {
        // Latched by the first close call, matching the coalesced teardown below.
        // Only standby quiescence is a handoff; SIGTERM and administrative stops
        // retain destructive relay/capability cleanup.
        preserveProjectRelaysOnClose = options.preserveProjectRelays === true;
        googleSlidesTool.close();
        await stopAgentGatewayCredentialProjection();
        await stopRunnerSupervisorReconciler();
        await agentGatewaySynchronizer?.close();
        await app.close();
        // The sweep, settled before the database goes: a short-lived process (a test, a
        // one-shot run) can otherwise reach `destroy()` with its two store reads still in
        // flight — and, worse, hand control back to a caller that tears down the data root
        // while the walk is still calling `rm` inside it.
        //
        // So the walk is told to stop rather than left to run: it checks between directory
        // entries and between deletes, and returns a partial result the next boot's sweep
        // completes. Waiting for it then costs one in-flight `fs` call, not a full volume
        // walk — blocking a SIGTERM on THAT is how a graceful shutdown becomes a SIGKILL.
        //
        // Bounded even so, and the bound is what makes this a strong guarantee only in the
        // normal case: if the timer wins, `close` resolves with the walk still somewhere
        // inside a call that never came back, so a caller that then removes the data root
        // is back to racing it. That is the wedged-volume case, where every other option —
        // waiting forever, and the SIGKILL that follows — is worse. The store reads are
        // full-table scans issued at boot and get the same treatment: giving up and
        // destroying under them costs at worst one logged query error on a process that is
        // exiting anyway. `ref: false` so the losing timer cannot itself hold the process
        // open for the rest of the window.
        sweepAbort.abort();
        cleanupAbort.abort();
        sessionCleanupWorker?.stop();
        await Promise.race([
          Promise.all([transcriptSweep, transcriptSweepWalk, sessionCleanupWorker?.settled()]),
          delay(SWEEP_SHUTDOWN_WAIT_MS, undefined, { ref: false }),
        ]);
        await db.destroy();
      })()),
  };
}
