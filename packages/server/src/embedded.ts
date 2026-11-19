import { createEmbeddedRunnerConductorWiring } from './embedded-runner-conductor.js';
import {
  createEmbeddedProjectRelayControl,
  validateEmbeddedProjectRelay,
} from './embedded-project-relay-control.js';
import { createEmbeddedSandboxTurnPreparation } from './embedded-sandbox-turn-preparation.js';
import {
  createEmbeddedAgentGatewayReadiness,
  createEmbeddedAgentGatewayRouting,
} from './embedded-agent-gateway-routing.js';
import {
  createEmbeddedAgentGatewayBindingCallbacks,
  createEmbeddedAgentGatewayIdentityProjection,
} from './embedded-agent-gateway-identity.js';
import { createEmbeddedAgentGatewayCredentials } from './embedded-agent-gateway-credentials.js';
import type { CodexUsageCredentialProvider } from './codexUsage.js';
import { createEmbeddedAgentGateway } from './embedded-agent-gateway.js';
import { createEmbeddedSecretJobs, installEmbeddedSecretJobs } from './embedded-secret-jobs.js';
import { createEmbeddedUplink } from './embedded-uplink.js';
import { createEmbeddedDocker } from './embedded-docker.js';
import { createEmbeddedForgeProxy } from './embedded-forge-proxy.js';
import { createEmbeddedBranches } from './embedded-branches.js';
import {
  createEmbeddedWorktreeForge,
  createEmbeddedWorktreeStatus,
  createEmbeddedWorktrees,
} from './embedded-worktrees.js';
import {
  createEmbeddedRepositoryAccess,
  createEmbeddedRepositoryPullRequests,
} from './embedded-repositories.js';
import { createEmbeddedGitHub } from './embedded-github.js';
import { createEmbeddedDoppler } from './embedded-doppler.js';
import { createEmbeddedMcpGateway } from './embedded-mcp-gateway.js';
import { createEmbeddedTrustedCli, installEmbeddedTrustedCli } from './embedded-trusted-cli.js';
import { createEmbeddedBrokeredHttp } from './embedded-brokered-http.js';
import { startEmbeddedSystemInventory } from './embedded-system-inventory.js';
import { createEmbeddedIntegrationTools } from './embedded-integration-tools.js';
import { validateEmbeddedConfig } from './embedded-config.js';
import { createEmbeddedPreviewMutations } from './embedded-preview-mutations.js';
import { createEmbeddedProvisioning } from './embedded-provisioning.js';
import type { DeprovisionerImpl } from './deprovisioner.js';
import { MaintenanceImages, MaintenanceImageError } from './maintenance-image.js';
import { installPersonalSandboxSleep } from './personal-sandbox-sleep.js';
import { personalTurnRefusal, resolveTurnSandbox } from './turn-sandbox.js';
import { personForCredential } from './personless-credential.js';
import {
  sandboxIdentity,
  sandboxNetworkName,
  sandboxPersonTag,
  sandboxRunnerDir,
} from './sandbox-identity.js';
import {
  createEmbeddedControlPlaneRunnerIdentity,
  createEmbeddedRunnerIdentityPublisher,
} from './embedded-control-plane-runner-identity.js';
import { createBrokeredSecretAliases } from './brokered-secret-aliases.js';
import {
  isProjectSettingsReader,
  materializeControlPlaneAgentEnv,
  startClaudeCredentialSync,
  withControlPlaneAgentCredentials,
  prepareControlPlaneRunnerForTurn,
  startRunnerSupervisorReconciler,
  CONTROL_PLANE_RUNNER_PROJECT_ID,
  SWEEP_SHUTDOWN_WAIT_MS,
  candidateRunnerProjectIds,
  acpSupervisorWiringRefusal,
  rejectLatestImageRef,
  publishedDevcontainerFeatureRef,
  toolkitFeatureRefIsConfigured,
  resolveToolkitFeatureRef,
  branchRenameAppliesToSession,
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
import type { EmbeddedServerConfig, EmbeddedServer } from './embedded-types.js';
export type { EmbeddedServerConfig, EmbeddedServer } from './embedded-types.js';
import { runnerSandboxPath, RUNNER_CONTAINER_PROJECT_ROOT } from './embedded-runner-wiring.js';
export {
  buildRunnerConductorWiring,
  runnerSandboxPath,
  runnerAuthorizationProjectId,
  RUNNER_CONTAINER_PROJECT_ROOT,
} from './embedded-runner-wiring.js';
import { AGENT_SKILL_MANIFEST_HASH } from '@verity/events';
import { resolveAgentContext } from './agent-context.js';
import { projectDecisionDirectory } from './knowledge-decisions.js';
import {
  StorageReclamation,
  requestNativeReclamation,
  readNativeReclamation,
} from './storage-reclamation.js';
import { registerStorageReclamationRoutes } from './storage-reclamation-routes.js';
import { startNativeRetirementEvidence } from './native-buildkit.js';
import { SessionStorage, sessionStorageDiagnostics } from './session-storage.js';
import { sessionStorageAccess } from './session-storage-access.js';
import { RunnerCacheStorage } from './runner-cache-storage.js';
import {
  RunnerCacheMaintenance,
  reclaimSleepingRunnerCaches,
  cacheMaintenanceFailure,
} from './runner-cache-maintenance.js';
import {
  retireStoppedContainers,
  boundedContainerRetirement,
  retireCompletedUpdateContainers,
} from './stopped-container-gc.js';
import type { DockerGcReport } from './docker-gc.js';
import { createServerLogSource } from './server-log-source.js';
import { selectBranchStatus } from './forge-status-cache.js';
import { createBuildDiagnosticStore } from './build-diagnostics.js';
import { brokeredDopplerBindingId } from './brokered-doppler-binding.js';
import { BuildStorage } from './build-storage.js';
import { createProjectImageReferences } from './derived-image-references.js';
import { pinToolkitFeature, releaseToolkitFeature } from './devcontainer-feature-pin.js';
import { createManagedDevServerSecretResolver } from './managed-dev-server-secrets.js';
import { ensureStarterProject } from './welcome-session.js';
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
  AcpClaudeBackend,
  AcpCodexBackend,
  AcpOpenCodeBackend,
  CODEX_DEFAULT_MODEL,
  InMemoryEventBus,
  isCodexModel,
  isRunnerSupervisorBackend,
  requestRunnerSupervisor,
  runnerSupervisorBackendLabel,
  type RunnerSupervisorBackend,
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
} from '@verity/store';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchCodexBundledModels, startCodexModelCatalog } from './codex-model-catalog.js';

import { buildControlPlane } from './app.js';
import { createRuntimeDiagnostics } from './runtime-diagnostics.js';
import { createProjectListCache } from './project-list-cache.js';

import { createAuthTokenRegistry } from './auth.js';
import { ensureControlPlaneProject } from './control-plane-project.js';
import { createExpoPushTransport, createPushSender } from './push-sender.js';
import { healAdminGitdirsAtStartup } from './worktree.js';
import { startCloneConfigSweep } from './clone-config-guard.js';
import { type GitHubInstallationService } from './github.js';
import { projectForgeProvider } from './project-forge-provider.js';
import type { DockerClient } from './docker.js';
import {
  describeBuildCapacityReclamation,
  dockerGcDiagnostics,
  startDockerGcScheduler,
  runDockerGc,
} from './docker-gc.js';
import { DataVolumeUsage } from './data-volume-usage.js';
import { sweepOrphanedLocalPreviews } from './local-preview-orphans.js';
import {
  PreviewShareConflictError,
  PreviewShareManager,
  sweepOrphanedPreviewShares,
} from './preview-share-manager.js';
import { premiumFeatureSwitches } from './uplink-control-client.js';
import { teamSharingStatus } from './uplink-feature-state.js';
import { applyPremiumFeatureSwitches } from './premium-feature-switches.js';
import { PROJECT_RUNSC_RUNTIME } from './gvisor-runtime-config.js';
import { createPostgresSecretAuditLog } from './secret-audit-log.js';
import { createPostgresAuditLog, type AuditServerIdentity } from './audit-log.js';
import { createAuditRecorder } from './audit-recorder.js';
import { runtimeServerVersion } from './runtime-version.js';
import { createGatewayRequestMacKeyring } from './gateway-request-mac.js';
import { createTurnCredentials } from './turn-credentials.js';
import { createGitHubUserAuthorization } from './github-user-authorization.js';
import { listDopplerProjectSecretNames } from './doppler-secret-resolver.js';

import {
  pendingSessionCleanups,
  createSessionCleanupProcessor,
  deleteRunnerSessionHome,
  createSessionCleanupWorker,
} from './pending-session-cleanup.js';

import { createRunnerArtifactPurge } from './runner-artifact-purge.js';
import { startOrphanTranscriptSweep, type SweepResult } from './orphan-transcript-sweep.js';
import { purgeSessionArtifacts as purgeSessionArtifactFiles } from './session-artifacts.js';
import {
  validateGitHubAppCreds,
  resolveGitHubAppIdentity,
  type GitHubAppCreds,
  type GitHubAppIdentityResult,
} from './github-app-token.js';
import { defaultManifestConvert } from './github-manifest.js';
import { createGhTokenCapabilityRegistry } from './github-token-broker.js';
import { createSigningCapabilityRegistry } from './signing-capability.js';
import { readOrMigrateProjectOverview } from './project-overview-file.js';
import {
  type ProvisionerImpl,
  projectClonePath,
  devcontainerBuilderIdle,
  ensureOpenCodeSettingsMaterialized,
  materializeOpenCodeSettings,
  materializePersonalOpenCodeSettings,
  personalOpenCodeSubdir,
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
import { createSandboxGit } from './sandbox-git.js';
import { projectSettingsEnv } from './project-settings-env.js';
import { reconcileProjectContainerStates } from './project-state.js';
import {
  createClaudeEgressIdentityService,
  type ClaudeEgressIdentityService,
} from './claude-egress-identity.js';
import {
  agentGatewayUnavailableMessage,
  type AgentGatewayRepairFailure,
  claudeEgressAgentEnv,
  claudeEgressRouteEnabled,
  claudeProjectEgressRefusal,
  claudeTransportRefusal,
} from './claude-egress-agent-env.js';
import { ensureProjectSandboxReadyForTurn } from './project-auto-wake.js';
import { installEmbeddedProjectRelayRuntime } from './embedded-project-relay-runtime.js';
import { originalSandbox, type ProjectRelayLifecycle } from './project-relay-lifecycle.js';
import { ProjectEgressLifecycle } from './project-egress-lifecycle.js';
import { projectEgressAvailability } from './project-egress-health.js';
import { createProtectedBuildClient } from './project-egress-build-client.js';
import { createProjectEgressHostClient } from './project-egress-host-client.js';
import { readCodexAccessToken } from './agent-gateway-control.js';
import { createPersonalProviderCredentials } from './personal-provider-credentials.js';
import { installTeamOutbox } from './team-outbox-worker.js';
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
  validateEmbeddedConfig(config);

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
  const stopSystemInventory = await startEmbeddedSystemInventory(config, eventStore);

  if (config.controlPlaneRunner === true) {
    await ensureControlPlaneProject(eventStore);
  }
  const {
    googleAccessToken,
    googleSlidesTool,
    invokeGoogleSlides,
    invokeGoogleDocs,
    invokeGoogleSheets,
    invokeGoogleContacts,
    invokeGoogleCalendar,
    matrixTool,
    invokeGmail,
    googleDriveTool,
    invokeGoogleDrive,
  } = createEmbeddedIntegrationTools(eventStore, secretCipher);
  const {
    dopplerCredentialFor,
    dopplerPersonId,
    serverDeps: dopplerServerDeps,
  } = createEmbeddedDoppler(eventStore);
  const {
    brokeredHttpConsumptions,
    brokeredHttpGrants,
    getBrokeredProjectBinding,
    resolveBrokerDopplerSecret,
    brokeredHttpTool,
  } = createEmbeddedBrokeredHttp(db, eventStore, dopplerCredentialFor, dopplerPersonId);
  const { trustedCliOutput, trustedCliTool } = createEmbeddedTrustedCli(db, secretCipher, {
    getBrokeredProjectBinding,
    resolveBrokerDopplerSecret,
    brokeredHttpConsumptions,
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
  const turnCredentials = createTurnCredentials(
    config.turnCredentialStatePath === undefined
      ? undefined
      : { persistPath: config.turnCredentialStatePath },
  );
  // Each person's own GitHub App authorization; one instance so a token renews once.
  const githubUserAuthorization = createGitHubUserAuthorization({ store: eventStore });
  const { mcpGatewayTokens, mcpProxyTokens, mcpGateway } = createEmbeddedMcpGateway(config, {
    secretAuditLog,
    gatewayRequestMacKeys,
    getBrokeredProjectBinding,
    brokeredHttpTool,
    trustedCliTool,
    trustedCliOutput,
    invokeGoogleSlides,
    invokeGoogleDocs,
    invokeGoogleSheets,
    invokeGmail,
    matrixTool,
    invokeGoogleCalendar,
    invokeGoogleContacts,
    invokeGoogleDrive,
  });

  const brokeredGrantBindingId = async (projectId: string): Promise<string | undefined> => {
    const binding = await getBrokeredProjectBinding(projectId);
    if (binding === undefined) return undefined;
    return brokeredDopplerBindingId(binding);
  };
  // ADR 0011 D3: secret NAMES (never values) for the turn context, per person.
  const brokeredSecretAliases = createBrokeredSecretAliases({
    getProjectBinding: getBrokeredProjectBinding,
    credentialFor: dopplerCredentialFor,
    listNames: listDopplerProjectSecretNames,
  });
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
  // One-time, best-effort heal of admin `gitdir` links git cannot follow (see
  // healAdminGitdirsAtStartup): a heal failure must never block server boot.
  healAdminGitdirsAtStartup(config.repoDir, config.hostCloneRoot);
  const branches = createEmbeddedBranches(config, eventStore, {
    get projectDocker() {
      return projectDocker;
    },
    get defaultProjectImage() {
      return defaultProjectImage;
    },
    get dataVolumeRoot() {
      return dataVolumeRoot;
    },
  });
  const {
    resolveGithubAppCreds,
    baseMintOpts,
    githubAppAuthorityKey,
    projectTokenMint,
    cachedProjectTokenMint,
    githubQAAnalysis,
    githubForge,
  } = createEmbeddedGitHub(config, eventStore);
  const forgeRepositoryAccess = createEmbeddedRepositoryAccess(eventStore);
  const forgeForWorktree = createEmbeddedWorktreeForge(config, eventStore, githubForge);
  const { readProjectStatus, invalidateProjectStatus, projectPullRequests } =
    createEmbeddedRepositoryPullRequests(eventStore, githubForge);
  const readWorktreeStatus = createEmbeddedWorktreeStatus(
    eventStore,
    readProjectStatus,
    forgeForWorktree,
  );
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
  const worktrees = createEmbeddedWorktrees(config, githubForge, cachedProjectTokenMint);

  // Durable server storage for clone-config backups; without it Repair only reports the key.
  const durableServerRoot = config.dataVolumeRoot || config.dataDir || config.workspacesDir;
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

  const { projectDocker, runtimeDocker, resolvePreviewUser } = createEmbeddedDocker(config);
  // Filled once the managed dev server manager exists, further down.
  const managedLinkEnded: { current?: (instanceId: string, shareId: string) => void } = {};
  const listenerRuntime = new DockerProjectRuntime({
    resolveUser: resolvePreviewUser,
    dockerBaseUrl: config.dockerBaseUrl,
  });
  const listListeningProcesses = (project: ProjectRecord, options?: { fresh?: boolean }) =>
    listenerDiscovery?.listListeningProcesses(project, options) ??
    listenerRuntime.listWebListeningProcesses(project, options);
  let previewShareManager: PreviewShareManager | undefined;
  const { withPreviewProjectMutation, withStorageProjectMutation } = createEmbeddedPreviewMutations(
    {
      local: () => localPreviewManager,
      public: () => previewShareManager,
    },
  );
  const { uplinkLog, returnPath, coordinatedRecording, remoteConnector, uplinkControl } =
    createEmbeddedUplink({
      config,
      eventStore,
      projectDocker,
      getPreviewShareManager: () => previewShareManager,
    });
  if (
    uplinkControl !== undefined &&
    projectDocker !== undefined &&
    config.publicPreviews !== undefined
  ) {
    previewShareManager = new PreviewShareManager({
      store: eventStore,
      // A managed server's preview reaches the sandbox it runs in (ADR 0023 §4).
      sandboxFor: async (project, userId) => {
        const sandbox = await resolveTurnSandbox(
          eventStore,
          project.id,
          userId === null ? undefined : { userId },
        );
        const identity = sandboxIdentity(project, sandbox);
        return { containerName: identity.containerName, networkName: identity.networkName };
      },
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
      listSessionServers: (sessionId, options) =>
        listenerDiscovery?.listSessionDevServers(sessionId, options) ?? Promise.resolve([]),
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
  const { secretJobRuntimeReadiness, embeddedSecretJobs, secretProviderCatalog } =
    createEmbeddedSecretJobs({
      config,
      runtimeDocker,
      db,
      secretCipher,
      secretAuditLog,
      dopplerCredentialFor,
    });
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
  const publishRunnerIdentity = createEmbeddedRunnerIdentityPublisher(
    () => refreshControlPlaneRunnerIdentity,
  );
  const personalProviderCredentials = createPersonalProviderCredentials({
    store: eventStore,
    onError: (error) => {
      if (error instanceof SealedError) return;
      // Never include credential contents in this diagnostic.
      console.warn(`verity: a personal provider login could not be refreshed: ${String(error)}`);
    },
  });
  // A person's sandbox reads its OpenCode models from its own file; rewrite every
  // person's file when anyone's logins change, so a connected, changed or removed
  // provider reaches their running sandbox (the directory bind sees the swap).
  personalProviderCredentials.onChanged(() => {
    void (async () => {
      const connections = await eventStore.userProviderConnections.listByProvider('opencode');
      const written = new Set<string>();
      for (const connection of connections) {
        const tag = sandboxPersonTag(connection.userId);
        materializePersonalOpenCodeSettings(
          connection,
          secretRoot,
          tag,
          config.claudeConnectorPort,
        );
        written.add(personalOpenCodeSubdir(tag));
      }
      const prefix = personalOpenCodeSubdir('');
      for (const entry of existsSync(secretRoot) ? readdirSync(secretRoot) : []) {
        if (entry.startsWith(prefix) && !written.has(entry))
          materializePersonalOpenCodeSettings(
            undefined,
            secretRoot,
            entry.slice(prefix.length),
            config.claudeConnectorPort,
          );
      }
    })().catch((error: unknown) => {
      if (error instanceof SealedError) return;
      console.warn(`verity: personal OpenCode configuration not refreshed: ${String(error)}`);
    });
  });
  const {
    state: agentGatewayState,
    agentGatewayUrl,
    agentGatewaySynchronizer,
    codexGatewayControlSocket,
    codexGatewayCredentialProvider,
    agentGatewayConfiguration,
    syncAgentGateway,
    synchronizeAgentGatewayForTurn,
  } = createEmbeddedAgentGateway({
    config,
    personalProviderCredentials,
    getClaudeCredentialSync: () => claudeCredentialSync,
    onError: (error) =>
      app.log.warn({ err: error }, 'Standalone agent gateway reconciliation failed'),
  });
  /** Ask the project's runner supervisor whether its agent connections accept
   *  connects yet. A toolkit without the request keeps its previous behaviour. */
  const probeSandboxEgressReadiness = async (
    runnersVolumeRoot: string,
    /** The sandbox's runner directory, relative to the data volume root. */
    runnerDir: string,
  ): Promise<SandboxEgressProbe> => {
    try {
      return parseEgressReadiness(
        await requestRunnerSupervisor(
          join(runnersVolumeRoot, runnerDir, 'supervisor.sock'),
          { kind: 'egress-readiness' },
          3_000,
        ),
      );
    } catch (error) {
      return classifyProbeError(error);
    }
  };
  const { projectRelayControlRef, healthyRelayGeneration, agentGatewayReady } =
    createEmbeddedAgentGatewayReadiness({ secretRoot, state: agentGatewayState });
  const {
    repairPersonalSandboxForAgentTurn,
    repairSandboxForAgentTurn,
    serializeProjectTurnPreparation,
  } = createEmbeddedSandboxTurnPreparation({
    getDocker: () => docker,
    getProvisioner: () => provisioner,
    getLogger: () => app.log,
    refreshAgentGatewayCredential: () => refreshAgentGatewayCredential(),
    synchronizeAgentGatewayForTurn,
    agentGatewayReady,
  });
  const routedAgentGatewayBindings = createEmbeddedAgentGatewayRouting({
    config,
    agentGatewayUrl,
    getDocker: () => docker,
    eventStore,
    state: agentGatewayState,
    healthyRelayGeneration,
  });
  let projectRelayLifecycle: ProjectRelayLifecycle | undefined = undefined;
  const projectRelayEnabled = (config.projectRelayImage ?? '').trim().length > 0;
  const { forgeIdentity, forgeProxyEnabled, forgeProxy } = await createEmbeddedForgeProxy({
    projectRelayEnabled,
    secretRoot,
    eventStore,
    baseMintOpts,
    githubAppAuthorityKey,
    cachedProjectTokenMint,
    githubUserAuthorization,
    ghTokenCapabilities,
    turnCredentials,
  });
  validateEmbeddedProjectRelay({ config, projectRelayEnabled, agentGatewayUrl });
  const projectRelayControl = createEmbeddedProjectRelayControl({
    projectRelayEnabled,
    getLifecycle: () => projectRelayLifecycle,
    projectDocker,
  });
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
        ...createEmbeddedAgentGatewayBindingCallbacks({
          state: agentGatewayState,
          agentGatewayConfiguration,
          agentGatewaySynchronizer,
          syncAgentGateway,
          routedAgentGatewayBindings,
        }),
      });
      if (config.controlPlaneRunner === true) {
        ({ refreshControlPlaneRunnerIdentity, awaitControlPlaneRunnerIdentity } =
          await createEmbeddedControlPlaneRunnerIdentity({
            config,
            eventStore,
            claudeEgressIdentity,
          }));
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
    const retirementEvidence = startNativeRetirementEvidence(
      () => buildStorage?.retirementInventoryEmpty() === true,
    );
    stopNativeEvidence = () => retirementEvidence.stop();
    ({ provisioner, deprovisioner } = createEmbeddedProvisioning({
      config,
      dockerBaseUrl,
      buildStorage,
      imageReferences,
      auditRecorder,
      buildDiagnostics,
      eventStore,
      db,
      docker,
      defaultProjectImage,
      projectTokenMint,
      forgeRepositoryAccess,
      githubForge,
      secretRoot,
      durableServerRoot,
      ghTokenCapabilities,
      forgeIdentity,
      forgeProxyEnabled,
      projectRelayControl,
      claudeEgressIdentity,
      claudeEgressServerName,
      agentGatewayUrl,
      projectSandboxLifecycleTelemetry,
      withPreviewProjectMutation,
      baseMintOpts,
      devcontainerFeature,
      signingCapabilities,
      projectEgress,
      hostCloneRoot: config.hostCloneRoot,
      runtime: {
        get log() {
          return app.log;
        },
        get managedDevServerManager() {
          return managedDevServerManager;
        },
        get localPreviewManager() {
          return localPreviewManager;
        },
        get previewShareManager() {
          return previewShareManager;
        },
        get runPendingCleanup() {
          return runPendingCleanup;
        },
        get projectTurnReconciler() {
          return projectTurnReconciler;
        },
        get listenerDiscovery() {
          return listenerDiscovery;
        },
        get projectAgentGatewayIdentity() {
          return projectAgentGatewayIdentity;
        },
      },
    }));
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
          scan: (project, options) => listenerRuntime.listWebListeningProcesses(project, options),
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
          listSessionServers: (sessionId, options) =>
            listenerDiscovery?.listSessionDevServers(sessionId, options) ?? Promise.resolve([]),
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
      sandboxContainer: async (project, userId, start) => {
        const sandbox = await resolveTurnSandbox(
          eventStore,
          project.id,
          userId === null ? undefined : { userId },
        );
        if (sandbox.projectDefault) return project.containerName;
        if (start) {
          if (provisioner?.ensurePersonalSandbox === undefined)
            throw new Error('personal sandboxes are not available');
          return (await provisioner.ensurePersonalSandbox(project.id, sandbox.userId))
            .containerName;
        }
        return sandboxIdentity(project, sandbox).containerName;
      },
      agentPerson: async (sessionId) => {
        const running = (await eventStore.listRunningTurns()).find(
          (turn) => turn.sessionId === sessionId,
        );
        if (running === undefined) return undefined;
        return (await eventStore.promptInitiatorAt(sessionId, running.promptSeq))?.userId ?? null;
      },
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
  const { refreshAgentGatewayCredential, stopAgentGatewayCredentialProjection } =
    createEmbeddedAgentGatewayCredentials({
      config,
      eventStore,
      claudeCredentialSync,
      personalProviderCredentials,
      agentGatewayState,
      syncAgentGateway,
    });

  const projectAgentGatewayIdentity = createEmbeddedAgentGatewayIdentityProjection({
    state: agentGatewayState,
    agentGatewayConfiguration,
    agentGatewaySynchronizer,
    syncAgentGateway,
    routedAgentGatewayBindings,
    claudeEgressIdentity,
    refreshAgentGatewayCredential,
  });
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
      : createRunnerArtifactPurge({
          dataVolumeRoot,
          store: eventStore,
          log: () => app.log,
          controlPlaneRunner: config.controlPlaneRunner === true,
          sessionSandboxCwd,
        });

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
  const volumeUsage = dataVolumeRoot ? new DataVolumeUsage({ root: dataVolumeRoot }) : undefined;
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
          ...sessionStorageAccess({
            store: eventStore,
            docker: projectDocker,
            provisioner,
            withStorageProjectMutation,
            devServers: () => managedDevServerManager,
            localPreviews: localPreviewManager,
            preparedWorktreeImages,
            defaultProjectImage,
            maintenanceImages,
            projectTokenMint: cachedProjectTokenMint,
            hostCloneRoot: config.hostCloneRoot,
            dockerBaseUrl: config.dockerBaseUrl!,
            dataVolume: config.dataVolume,
            dataVolumeRoot,
          }),
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
                managedDevServerManager?.hasUnverifiedServers(projectId) ||
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
            // A person's own runtime (`u<tag>/<project>`) follows their sandbox.
            const [tag, ownProjectId] = projectId.split('/');
            if (ownProjectId !== undefined && tag !== undefined) {
              const sandbox = (await eventStore.projectSandboxes.list(ownProjectId)).find(
                (candidate) => sandboxPersonTag(candidate.userId) === tag,
              );
              const state =
                sandbox === undefined
                  ? undefined
                  : (await eventStore.projectSandboxes.state(ownProjectId, sandbox.userId))?.state;
              if (!runtimeExists) return state === undefined ? 'absent' : 'unavailable';
              if (state === 'active') return 'ready';
              if (state?.startsWith('sleeping')) return 'sleeping';
              return state === undefined ? 'absent' : 'unavailable';
            }
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
    teamLinkIdentity: () => {
      const identity = config.devicePairing?.identity();
      const installation = uplinkControl?.teamInstallation();
      return identity && installation && { ...identity, ...installation };
    },
    teamSharing: teamSharingStatus(uplinkControl),
    personalClaudeAccessToken: (userId: string) =>
      personalProviderCredentials.claudeAccessToken(userId),
    persistPersonalProviderCredentials: (userId, provider, write) =>
      personalProviderCredentials.persist(userId, provider, write),
    // The Codex quota probe reads its token from the gateway, the single refresh
    // authority for the rotating Codex login (ADR 0010) — deliberately not from the
    // stored `codexAuthJson`, which would make the Server a second writer. Without a
    // gateway the probe stays inert and the meter keeps its per-session signal.
    ...(codexGatewayCredentialProvider === undefined ? {} : { codexGatewayCredentialProvider }),
    ...(codexGatewayControlSocket === undefined
      ? {}
      : {
          codexGatewayCredentialFor:
            (userId: string): CodexUsageCredentialProvider =>
            () =>
              readCodexAccessToken(codexGatewayControlSocket, userId),
        }),
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
            if (await agentGatewayReady(originalSandbox(project.id), container)) continue;
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
        { inspected, repaired, deferred, projectedBindings: agentGatewayState.bindings.length },
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
          lastGc: lastDockerGcReport ? dockerGcDiagnostics(lastDockerGcReport) : null,
          dataVolume: volumeUsage?.diagnostics() ?? null,
          worktrees: report ? sessionStorageDiagnostics(report) : null,
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
    claudeEgressIdentity,
    githubUserAuthorization,
    // With a dedicated internal listener (main.ts starts it and tags its sockets),
    // only it serves `/internal/*`; the public one 404s them. Omit → no gate.
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
    invalidateProjectPrStatus: invalidateProjectStatus,
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
    ...dopplerServerDeps,
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
          : brokeredHttpGrants.check({
              ...input,
              // Work without a person holds the original sandbox's person's grants,
              // only where personless-credential.ts allows it at all.
              userId: await personForCredential(eventStore, input.projectId, input.userId),
              bindingId: input.bindingId ?? bindingId,
            });
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
              // A person's own thread (`backend#tag`) lives in their sandbox's runtime.
              const byPerson = new Map<string | undefined, typeof bindings>();
              for (const binding of bindings) {
                const [backend = binding.backend, tag] = binding.backend.split('#');
                byPerson.set(tag, [...(byPerson.get(tag) ?? []), { ...binding, backend }]);
              }
              for (const [tag, scoped] of byPerson)
                await purgeRunnerArtifacts(sessionId, scoped, 'backend-switch', tag);
            },
          }),
      // Each person resumes only their own backend thread (ADR 0023 §3–4).
      backendStateScope: async (session, initiatedBy) => {
        if (session.projectId === null) return undefined;
        const sandbox = await resolveTurnSandbox(eventStore, session.projectId, initiatedBy);
        return sandbox.projectDefault ? undefined : sandboxPersonTag(sandbox.userId);
      },
      ...createEmbeddedRunnerConductorWiring({
        config,
        eventStore,
        bus,
        transcriptStore,
        allocateEventFile,
        allocateControlSocket,
        mcpGatewayTokens,
        turnCredentials,
        mcpProxyTokens,
        getLog: () => app.log,
        brokeredGrantBindingId,
        brokeredHttpGrants,
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
        // A person's turn runs in their own sandbox (ADR 0023 §4), on their own
        // provider login: the gateway serves that sandbox with nobody else's. Without
        // one the turn is refused here, before anything is prepared, rather than
        // failing inside the agent.
        const turnSandbox = await resolveTurnSandbox(store, project.id, preparation.initiatedBy);
        const turnProvider = isClaudeSession
          ? 'claude'
          : isCodexSession
            ? 'codex'
            : isOpenCodeSession
              ? 'opencode'
              : undefined;
        const loginRefusal = await personalTurnRefusal(store, turnSandbox, turnProvider);
        if (loginRefusal !== undefined) throw new Error(loginRefusal);
        if (!turnSandbox.projectDefault && provisioner?.ensurePersonalSandbox === undefined)
          throw new Error('Personal sandboxes need the project provisioner.');
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
            // The person's own sandbox reuses the clone and image the project's
            // original sandbox prepared above; starting it is idempotent.
            const sandbox = turnSandbox.projectDefault
              ? sandboxIdentity(project, turnSandbox)
              : await provisioner!.ensurePersonalSandbox(project.id, turnSandbox.userId);
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
                const inspected = await docker.inspectContainer(sandbox.containerName);
                gatewayReady = await agentGatewayReady(sandbox, inspected);
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
                const repair = turnSandbox.projectDefault
                  ? await repairSandboxForAgentTurn(project, preparation, queuedSessionIds)
                  : await repairPersonalSandboxForAgentTurn(
                      project,
                      turnSandbox.userId,
                      preparation,
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
              // A person's own login may have been refreshed or connected just now;
              // project it before the gateway snapshot this turn waits for.
              if (!turnSandbox.projectDefault) await refreshAgentGatewayCredential();
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
                  probe: () =>
                    probeSandboxEgressReadiness(
                      dataVolumeRoot,
                      sandboxRunnerDir(project.id, turnSandbox),
                    ),
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
              containerName: sandbox.containerName,
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
  startCloneConfigSweep(config.hostCloneRoot, Boolean(durableServerRoot), (event, msg) =>
    app.log.warn(event, msg),
  );
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
    const sweep = startOrphanTranscriptSweep({
      runnersRoot: join(dataVolumeRoot, 'runners'),
      dryRun: sweepMode === 'dry',
      store: eventStore,
      sessionSandboxCwd,
      signal: sweepAbort.signal,
      log: app.log,
    });
    transcriptSweep = sweep.storeReads;
    transcriptSweepWalk = sweep.walk;
  };

  app.addHook('onClose', async () => {
    maintenanceImages?.abort();
    await runnerCacheStorage?.stop();
    await sessionStorage?.stop();
  });

  installEmbeddedSecretJobs(app, {
    config,
    embeddedSecretJobs,
    secretProviderCatalog,
    authRegistry,
    dopplerCredentialFor,
  });
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
  await installEmbeddedTrustedCli(app, { trustedCliOutput });
  // A person's own sandbox sleeps once nothing needs it (ADR 0023 §4), so a
  // member's container uses memory only while that member works.
  installPersonalSandboxSleep(app, {
    store: eventStore,
    hasRunningServersFor: async (projectId, userId) =>
      managedDevServerManager?.hasRunningServersFor(projectId, userId),
    sleepSandbox: () => provisioner?.sleepPersonalSandbox?.bind(provisioner),
  });
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
  app.addHook('onClose', stopSystemInventory);
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
  if (uplinkControl !== undefined) {
    // Deliver queued team changes to Uplink once it negotiated team v1.
    installTeamOutbox(app, {
      team: eventStore.projectTeam,
      uplink: uplinkControl,
      identityKey: () => config.devicePairing?.identity().identityKey,
      log: app.log,
      isSealed: (error) => error instanceof SealedError,
    });
  }
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
    let cacheHelperProjectOffset = 0;
    const retireProjectContainers = async (cacheHelpersOnly: boolean, capacityOnly = false) => {
      const removed =
        cacheHelpersOnly || capacityOnly
          ? []
          : await retireCompletedUpdateContainers(projectDocker);
      if (!provisioner?.withProjectExclusiveMutation) return { removed, errors: [] };
      const result = await retireStoppedContainers({
        docker: projectDocker,
        ...(cacheHelpersOnly || capacityOnly
          ? boundedContainerRetirement(cacheHelpersOnly, cacheHelperProjectOffset)
          : {}),
        listProjects: () => eventStore.listProjects(),
        withProjectMutation: (id, run) =>
          provisioner.withProjectExclusiveMutation(id, () =>
            withStorageProjectMutation(
              id,
              async () => {
                if (
                  managedDevServerManager?.hasRunningServers(id) ||
                  managedDevServerManager?.hasUnverifiedServers(id)
                )
                  throw new Error('Managed dev server is active');
                if (
                  (localPreviewManager?.listProject(id).length ?? 0) > 0 ||
                  (await eventStore.listPublicPreviewShares(id)).some((s) =>
                    ['creating', 'active', 'revoking'].includes(s.state),
                  )
                )
                  throw new Error('Preview is active');
                await run();
              },
              { waitForIdle: !cacheHelpersOnly && !capacityOnly },
            ),
          ),
      });
      if (cacheHelpersOnly || capacityOnly) cacheHelperProjectOffset += 8;
      return {
        removed: [...removed, ...result.removed],
        errors: result.errors,
        retained: result.retained,
      };
    };
    const dockerGc = startDockerGcScheduler({
      docker: projectDocker,
      log: app.log,
      ...(config.dockerGcPolicy !== undefined ? { policy: config.dockerGcPolicy } : {}),
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
        await volumeUsage?.runOnce();
      },
      describeCapacity: () => volumeUsage?.describe() ?? '',
      onReport: (report) => {
        report.nativeRequestedAt = nativeMaintenanceRequested;
        lastDockerGcReport = report;
      },
      retireContainers: () => retireProjectContainers(false),
      retireCacheHelpers: () => retireProjectContainers(true),
      retireCapacityContainers: () => retireProjectContainers(false, true),
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
    buildStorage?.setCapacityDescriber((short) => volumeUsage?.describe(short) ?? '');
    app.addHook('onClose', async () => {
      dockerGc.stop();
      await volumeUsage?.stop();
    });
  }
  registerStorageReclamationRoutes(app, eventStore, storageReclamation);
  if (codexModelCatalog !== undefined) {
    app.addHook('onClose', () => codexModelCatalog.close());
  }

  projectRelayLifecycle = installEmbeddedProjectRelayRuntime({
    app,
    config,
    projectRelayEnabled,
    docker,
    signingCapabilities,
    ghTokenCapabilities,
    forgeProxy,
    forgeProxyEnabled,
    eventStore,
    sandboxNetworkName,
  });
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
