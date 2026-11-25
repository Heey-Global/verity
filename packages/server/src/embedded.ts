import { createEmbeddedConductor } from './embedded-conductor.js';
import { createEmbeddedAudit, createEmbeddedAuditBindings } from './embedded-audit.js';
import { createEmbeddedProjectRuntimeBindings } from './embedded-project-runtime.js';
import {
  activateEmbeddedSecretHandoff,
  createEmbeddedSecretUnlock,
} from './embedded-secret-unlock.js';
import {
  installEmbeddedLocalPreviewRecovery,
  installEmbeddedPublicPreviewRecovery,
} from './embedded-preview-recovery.js';
import {
  createEmbeddedPersonalProviderCredentials,
  createEmbeddedClaudeCredentialSync,
  createEmbeddedProviderCredentialBindings,
} from './embedded-provider-credentials.js';
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
import { createEmbeddedAgentGateway } from './embedded-agent-gateway.js';
import { createEmbeddedSecretJobs, installEmbeddedSecretJobs } from './embedded-secret-jobs.js';
import {
  createEmbeddedUplink,
  createEmbeddedUplinkBindings,
  installEmbeddedTeamOutbox,
  createEmbeddedTeamSharingBindings,
} from './embedded-uplink.js';
import { createEmbeddedDocker } from './embedded-docker.js';
import { createEmbeddedForgeProxy } from './embedded-forge-proxy.js';
import { createEmbeddedBranches } from './embedded-branches.js';
import {
  createEmbeddedWorktreeBindings,
  createEmbeddedWorktreeForge,
  createEmbeddedWorktreeStatus,
  createEmbeddedProjectWorktrees,
  createEmbeddedWorktrees,
} from './embedded-worktrees.js';
import {
  createEmbeddedRepositoryAnalysisBindings,
  createEmbeddedProjectRepositoryBindings,
  createEmbeddedRepositoryReadBindings,
  createEmbeddedRepositoryAccess,
  createEmbeddedRepositoryPullRequests,
} from './embedded-repositories.js';
import { createEmbeddedGitHub, createEmbeddedGitHubOnboardingBindings } from './embedded-github.js';
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
import { MaintenanceImages } from './maintenance-image.js';
import {
  installEmbeddedPersonalSandboxSleep,
  startEmbeddedStarterProject,
} from './embedded-project-startup.js';
import { resolveTurnSandbox } from './turn-sandbox.js';
import { sandboxIdentity, sandboxNetworkName } from './sandbox-identity.js';
import {
  createEmbeddedControlPlaneRunnerIdentity,
  createEmbeddedRunnerIdentityPublisher,
} from './embedded-control-plane-runner-identity.js';
import { createBrokeredSecretAliases } from './brokered-secret-aliases.js';
import { refreshProjectGitHubToken } from './embedded-support.js';
import {
  createEmbeddedDefaultProjectImage,
  prepareEmbeddedToolkitFeature,
} from './embedded-image-sources.js';
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
import {
  runnerSandboxPath,
  RUNNER_CONTAINER_PROJECT_ROOT,
  startEmbeddedRunnerRecovery,
} from './embedded-runner-wiring.js';
export {
  buildRunnerConductorWiring,
  runnerSandboxPath,
  runnerAuthorizationProjectId,
  RUNNER_CONTAINER_PROJECT_ROOT,
} from './embedded-runner-wiring.js';
import {
  installEmbeddedDockerGc,
  createEmbeddedProjectHiddenGcBindings,
} from './embedded-docker-gc.js';
import { createEmbeddedSessionStorage } from './embedded-session-storage.js';
import type { DockerGcReport } from './docker-gc.js';
import type { BuildStorage } from './build-storage.js';
import {
  createEmbeddedBuildStorage,
  installEmbeddedBuildStorage,
} from './embedded-build-storage.js';
import { createProjectImageReferences } from './derived-image-references.js';
import * as devServerSecrets from './managed-dev-server-secrets.js';
import { LocalPreviewManager } from './local-preview-manager.js';
import { localPreviewPorts } from './local-preview-ports.js';
import { ManagedDevServerManager } from './managed-dev-server-manager.js';
import { isManagedSandboxRunning } from './managed-dev-server-recovery.js';
import { ListenerDiscovery } from './listener-discovery.js';
export { parsePort } from './deployment-port.js';
import {
  classifyProbeError,
  parseEgressReadiness,
  type SandboxEgressProbe,
} from './sandbox-turn-readiness.js';
import { InMemoryEventBus, requestRunnerSupervisor } from '@verity/session';
import {
  createPostgresDb,
  createSealableSecretCipher,
  EventStore,
  keyMatchesVerifier,
  LEGACY_DOPPLER_CONNECTION_ID,
  migrateToLatest,
  migrationProvider,
  SealedError,
  TranscriptStore,
  type Database,
  type ProjectRecord,
} from '@verity/store';
import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import { readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createEmbeddedModels, installEmbeddedModels } from './embedded-models.js';

import { buildControlPlane } from './app.js';
import {
  createEmbeddedRuntimeDiagnostics,
  installEmbeddedDockerExecDiagnostics,
} from './embedded-runtime-diagnostics.js';
import {
  createEmbeddedProjectList,
  createEmbeddedProjectFleetBindings,
} from './embedded-project-fleet.js';

import { createAuthTokenRegistry } from './auth.js';
import { ensureControlPlaneProject } from './control-plane-project.js';
import { createExpoPushTransport, createPushSender } from './push-sender.js';
import { healAdminGitdirsAtStartup } from './worktree.js';
import { startCloneConfigSweep } from './clone-config-guard.js';
import { type GitHubInstallationService } from './github.js';
import type { DockerClient } from './docker.js';
import { DataVolumeUsage } from './data-volume-usage.js';
import { PreviewShareConflictError, PreviewShareManager } from './preview-share-manager.js';
import { createPostgresSecretAuditLog } from './secret-audit-log.js';
import { createGatewayRequestMacKeyring } from './gateway-request-mac.js';
import { createTurnCredentials } from './turn-credentials.js';
import { createGitHubUserAuthorization } from './github-user-authorization.js';
import { listDopplerProjectSecretNames } from './doppler-secret-resolver.js';

import {
  createEmbeddedSessionCleanup,
  createEmbeddedSessionCleanupBindings,
} from './embedded-session-cleanup.js';

import { createRunnerArtifactPurge } from './runner-artifact-purge.js';
import { createEmbeddedSessionMaintenance } from './embedded-session-maintenance.js';
import { createEmbeddedShutdown } from './embedded-shutdown.js';
import { createGhTokenCapabilityRegistry } from './github-token-broker.js';
import { createSigningCapabilityRegistry } from './signing-capability.js';
import { type ProvisionerImpl, projectClonePath } from './provisioner.js';
import { ProjectSandboxLifecycleTelemetry } from './project-lifecycle-telemetry.js';
import { trustedToolkitIdentity } from './runner-boundary-attestation.js';
import { reportToolkitDrift } from './toolkit-drift.js';
import { defaultSshKeygenSpawner } from './signing-key.js';
import { requestArrivedInternally } from './internal-listener.js';

import { containerPathFor } from './project-backend.js';
import {
  createClaudeEgressIdentityService,
  type ClaudeEgressIdentityService,
} from './claude-egress-identity.js';
import { installEmbeddedProjectRelayRuntime } from './embedded-project-relay-runtime.js';
import type { ProjectRelayLifecycle } from './project-relay-lifecycle.js';
import { ProjectEgressLifecycle } from './project-egress-lifecycle.js';
import { projectEgressAvailability } from './project-egress-health.js';
import { createProjectEgressHostClient } from './project-egress-host-client.js';
import { DockerProjectRuntime } from './project-runtime.js';
import { createEmbeddedMatrix, installEmbeddedMatrix } from './embedded-matrix.js';
import { SERVER_COMPAT } from './self-update/compat.js';
import { createEmbeddedBackup } from './embedded-backup.js';

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
    getBrokeredProjectBindings,
    brokeredGrantBindingIds,
    brokeredGrantBindingIdFor,
    resolveBrokerDopplerSecret,
    brokeredHttpTool,
  } = createEmbeddedBrokeredHttp(db, eventStore, dopplerCredentialFor, dopplerPersonId);
  const { trustedCliOutput, trustedCliTool } = createEmbeddedTrustedCli(db, secretCipher, {
    getBrokeredProjectBindings,
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
  const { mcpGatewayTokens, mcpProxyTokens, mcpGateway } = createEmbeddedMcpGateway(config, db, {
    secretAuditLog,
    gatewayRequestMacKeys,
    getBrokeredProjectBindings,
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

  // ADR 0011 D3: secret NAMES (never values) for the turn context, per person.
  const brokeredSecretAliases = createBrokeredSecretAliases({
    getProjectBindings: getBrokeredProjectBindings,
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
  } = createEmbeddedGitHub(config, eventStore, () => provisioner);
  const forgeRepositoryAccess = createEmbeddedRepositoryAccess(eventStore);
  const forgeForWorktree = createEmbeddedWorktreeForge(config, eventStore, githubForge);
  const { readProjectStatus, forgeStatusDeps, projectPullRequests } =
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
  const models = await createEmbeddedModels({ config, eventStore, secretRoot });
  const { materializeOpenCodeConfig, codexModelCatalog } = models;

  const { projectDocker, runtimeDocker, resolvePreviewUser } = createEmbeddedDocker(config);
  const managedLinkEnded: { current?: (instanceId: string, shareId: string) => void } = {};
  const listenerRuntime = new DockerProjectRuntime({
    resolveUser: resolvePreviewUser,
    dockerBaseUrl: config.dockerBaseUrl,
  });
  const scanPreviewListeners = listenerRuntime.listWebListeningProcesses.bind(listenerRuntime);
  const listListeningProcesses = (project: ProjectRecord, options?: { fresh?: boolean }) =>
    listenerDiscovery?.listListeningProcesses(project, options) ??
    listenerRuntime.listWebListeningProcesses(project, options);
  const previewSandboxFor = async (project: ProjectRecord, userId: string | null) => {
    const sandbox = await resolveTurnSandbox(
      eventStore,
      project.id,
      userId === null ? undefined : { userId },
    );
    return sandboxIdentity(project, sandbox);
  };
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
      sandboxFor: previewSandboxFor,
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
          listListeningProcesses: scanPreviewListeners,
        }).ensurePreviewTarget(project, port),
      listSessionServers: (sessionId, options) =>
        listenerDiscovery?.listSessionDevServers(sessionId, options) ?? Promise.resolve([]),
      listListeningProcesses: scanPreviewListeners,
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
  let dependencyCapacity: ReturnType<typeof createEmbeddedBuildStorage>['dependencyCapacity'];
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
  const personalProviderCredentials = createEmbeddedPersonalProviderCredentials({
    store: eventStore,
    secretRoot,
    config,
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
  let refreshProjectToken: ((project: ProjectRecord) => Promise<void>) | undefined;
  let projectTurnReconciler: ((projectId: string) => Promise<void>) | undefined;
  let projectWorktrees: ReturnType<typeof createEmbeddedProjectWorktrees> | undefined;
  const defaultProjectImage = createEmbeddedDefaultProjectImage(config);
  const resolveDevcontainerFeature = prepareEmbeddedToolkitFeature(config);
  const imageReferences = createProjectImageReferences(db);
  const maintenanceImages = projectDocker
    ? new MaintenanceImages(projectDocker, imageReferences)
    : undefined;
  const preparedWorktreeImages = new Map<string, string>();
  const { auditRecorder, auditLog, buildDiagnostics } = createEmbeddedAudit({
    config,
    db,
    projectDocker,
  });
  const devcontainerFeature = resolveDevcontainerFeature();
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
    projectWorktrees = createEmbeddedProjectWorktrees(
      projectTokenMint,
      forgeRepositoryAccess,
      secretRoot,
    );
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
    ({ buildStorage, dependencyCapacity, stopNativeEvidence } = createEmbeddedBuildStorage(
      config,
      eventStore,
    ));
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

  // Runner transport and the control plane share the event bus for live streams.
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
  const managedDevServerLog: {
    current?: (message: string, detail?: Record<string, unknown>) => void;
  } = {};
  const localPreviewManager =
    projectDocker && localConnectorImage && config.hostCloneRoot
      ? new LocalPreviewManager({
          store: eventStore,
          sandboxFor: previewSandboxFor,
          docker: projectDocker,
          resolveConnectorImage: localConnectorImage,
          hostCloneRoot: config.hostCloneRoot,
          ...(config.dataVolume ? { dataVolume: config.dataVolume } : {}),
          ...(config.dataVolumeRoot ? { dataVolumeRoot: config.dataVolumeRoot } : {}),
          ...(config.agentSeedHostPath ? { agentSeedHostPath: config.agentSeedHostPath } : {}),
          isDevServerRunning: () => Promise.resolve(false),
          listListeningProcesses: scanPreviewListeners,
          listSessionServers: (sessionId, options) =>
            listenerDiscovery?.listSessionDevServers(sessionId, options) ?? Promise.resolve([]),
          prepareTargetPort: (project, port) =>
            new DockerProjectRuntime({
              resolveUser: resolvePreviewUser,
              dockerBaseUrl: config.dockerBaseUrl,
              listListeningProcesses: scanPreviewListeners,
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
      sandboxRunning: (name) => isManagedSandboxRunning(projectDocker, name),
      providerSnapshot: async (projectId, bindings) =>
        devServerSecrets.managedDevServerProviderSnapshot(
          await eventStore.projectDopplerBindings.list(projectId),
          bindings,
        ),
      resolveSecrets: devServerSecrets.createManagedDevServerSecretResolver({
        getProjectBindings: getBrokeredProjectBindings,
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

  const claudeCredentialSync = createEmbeddedClaudeCredentialSync(eventStore, secretRoot);
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

  const projectList = createEmbeddedProjectList({
    eventStore,
    installationService,
    docker,
    provisioner,
  });

  const matrix = createEmbeddedMatrix({ integrations: eventStore.integrations });

  const backup = await createEmbeddedBackup({ config, projectDocker, eventStore });
  let lastDockerGcReport: DockerGcReport | undefined;
  const volumeUsage = dataVolumeRoot ? new DataVolumeUsage({ root: dataVolumeRoot }) : undefined;
  const { sessionStorage, runnerCacheStorage } = createEmbeddedSessionStorage({
    log: () => app.log,
    config,
    eventStore,
    projectDocker,
    provisioner,
    withStorageProjectMutation,
    devServers: () => managedDevServerManager,
    localPreviewManager,
    preparedWorktreeImages,
    defaultProjectImage,
    maintenanceImages,
    cachedProjectTokenMint,
    dataVolumeRoot,
    readProjectStatus,
  });
  const { cleanupAbort, cleanupProcessor, runPendingCleanup, sessionCleanupWorker } =
    createEmbeddedSessionCleanup({ dataVolumeRoot, config, eventStore, log: () => app.log });
  const app = buildControlPlane({
    onConductorReady: (conductor) => {
      projectTurnReconciler = (projectId) => conductor.reconcileProjectTurns(projectId);
    },
    ...(sessionStorage ? { sessionStorage } : {}),
    eventStore,
    ...(backup ? { backup } : {}),
    ...matrix.bindings,
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
    ...createEmbeddedSessionCleanupBindings({
      dataVolumeRoot,
      config,
      eventStore,
      purgeRunnerArtifacts,
      sessionSandboxCwd,
      cleanupProcessor,
      sessionCleanupWorker,
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
    ...createEmbeddedUplinkBindings({
      eventStore,
      uplinkControl,
      remoteConnector,
      returnPath,
      coordinatedRecording,
      previewShareManager,
    }),
    googleAccessToken,
    ...createEmbeddedProviderCredentialBindings({
      secretRoot,
      config,
      claudeCredentialSync,
      personalProviderCredentials,
      refreshAgentGatewayCredential,
      codexModelCatalog,
      codexGatewayCredentialProvider,
      codexGatewayControlSocket,
    }),
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
    ...createEmbeddedTeamSharingBindings({ config, uplinkControl }),
    onSecretUnlocked: createEmbeddedSecretUnlock({
      eventStore,
      docker,
      provisioner,
      projectAgentGatewayIdentity,
      agentGatewayReady,
      agentGatewayState,
      publishRunnerIdentity,
      materializeOpenCodeConfig,
      codexModelCatalog,
      uplinkControl,
      log: () => app.log,
    }),
    authRegistry,
    ...(config.https !== undefined ? { https: config.https } : {}),
    ...(config.devicePairing !== undefined ? { devicePairing: config.devicePairing } : {}),
    pushEnabled: config.pushEnabled === true,
    listBrokeredGrants: async (projectId) =>
      brokeredHttpGrants.list(projectId, await brokeredGrantBindingIds(projectId)),
    revokeBrokeredGrant: (projectId, grantId) => brokeredHttpGrants.revoke(projectId, grantId),
    runtimeDiagnostics: createEmbeddedRuntimeDiagnostics({
      config,
      db,
      buildStorage,
      dependencyCapacity,
      sessionStorage,
      runnerCacheStorage,
      volumeUsage,
      provisioner,
      getLastDockerGcReport: () => lastDockerGcReport,
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
    ...models.bindings,
    ...(config.logger !== undefined ? { logger: config.logger } : {}),
    ...(config.workspacesDir !== undefined ? { spawnWorktreeRoot: config.workspacesDir } : {}),
    ...(worktrees !== undefined ? { worktrees } : {}),
    ...(branches !== undefined ? { branches } : {}),
    forgejoEnabled: projectRelayEnabled && provisioner !== undefined,
    ...createEmbeddedWorktreeBindings({ forgeForWorktree, readWorktreeStatus }),
    ...forgeStatusDeps,
    ...createEmbeddedRepositoryAnalysisBindings({
      eventStore,
      githubForge,
      githubQAAnalysis,
      readProjectStatus,
      projectPullRequests,
    }),
    ...createEmbeddedGitHubOnboardingBindings(resolveGithubAppCreds),
    // GitHub-token broker: resolve a sandbox capability + mint its repo-scoped token.
    ghTokenCapabilities,
    dependencyCapacity,
    ...createEmbeddedProjectRepositoryBindings({ eventStore, githubForge, forgeRepositoryAccess }),
    // Loopback MCP gateway for ACP sessions (ADR 0014 D1). The approval seam is
    // deliberately absent here and bound inside buildServer to its own conductor.
    mcpGateway,
    mcpProxyResolveCaller: (input) => Promise.resolve(mcpProxyTokens.resolve(input)),
    ...dopplerServerDeps,
    ...(config.secretJobs?.doppler !== undefined
      ? {
          secretJobDopplerConnectionId:
            config.secretJobs.doppler.connectionId ?? LEGACY_DOPPLER_CONNECTION_ID,
        }
      : {}),
    // Real server-side ssh-keygen for the onboarding signing-key step (#320).
    // Needs `openssh-client` in the Server image (deploy/Dockerfile). Injectable
    // so tests never shell out.
    sshKeygen: defaultSshKeygenSpawner,
    // Give server-side model queries the configured repository as context.
    ...(config.repoDir ? { refineCwd: config.repoDir } : {}),
    ...createEmbeddedRepositoryReadBindings({ eventStore, githubForge }),
    ...createEmbeddedProjectFleetBindings({
      eventStore,
      installationService,
      docker,
      provisioner,
      projectList,
      hasMasterPassword,
      secretCipher,
      refreshProjectToken,
    }),
    ...createEmbeddedProjectRuntimeBindings({
      config,
      projectDocker,
      defaultProjectImage,
      devcontainerFeature,
      provisioner,
      projectSandboxLifecycleTelemetry,
      resolvePreviewUser,
    }),
    ...createEmbeddedAuditBindings({
      config,
      auditRecorder,
      auditLog,
      buildDiagnostics,
      runtimeDocker,
    }),
    ...createEmbeddedProjectHiddenGcBindings({
      config,
      projectDocker,
      imageReferences,
      auditRecorder,
      log: () => app.log,
    }),
    ...(deprovisioner !== undefined ? { deprovisioner } : {}),
    // Per-project session worktree factory whose `refreshBase` fetch carries the
    // project-scoped token (only wired when the App-token mint + docker/clone-root
    // are configured — same guard as `refreshProjectToken`).
    ...(projectWorktrees !== undefined ? { projectWorktrees } : {}),
    conductor: createEmbeddedConductor({
      config,
      eventStore,
      sessionStorage,
      transcriptStore,
      brokeredSecretAliases,
      brokeredGrantBindingIds,
      brokeredGrantBindingIdFor,
      brokeredHttpGrants,
      branches,
      purgeRunnerArtifacts,
      bus,
      allocateEventFile,
      allocateControlSocket,
      mcpGatewayTokens,
      turnCredentials,
      mcpProxyTokens,
      getLog: () => app.log,
      sessionBackend: {
        config,
        createStore: () => new EventStore(db, secretCipher),
        secretRoot,
        dataVolumeRoot,
        agentGatewayUrl,
        projectRelayEnabled,
        refreshProjectToken,
        refreshAgentGatewayCredential,
        synchronizeAgentGatewayForTurn,
        agentGatewayReady,
        probeSandboxEgressReadiness,
        repairPersonalSandboxForAgentTurn,
        repairSandboxForAgentTurn,
        serializeProjectTurnPreparation,
        runtime: {
          get log() {
            return app.log;
          },
          get docker() {
            return docker;
          },
          get provisioner() {
            return provisioner;
          },
          get claudeEgressActive() {
            return claudeEgressIdentity !== undefined && config.claudeConnectorPort !== undefined;
          },
          get refreshControlPlaneRunnerIdentity() {
            return refreshControlPlaneRunnerIdentity;
          },
          get awaitControlPlaneRunnerIdentity() {
            return awaitControlPlaneRunnerIdentity;
          },
        },
      },
    }),
  });
  startCloneConfigSweep(config.hostCloneRoot, Boolean(durableServerRoot), (event, msg) =>
    app.log.warn(event, msg),
  );
  installEmbeddedMatrix(app, matrix);
  // Bind before any unlock or startup can dial, so handshake diagnostics use pino.
  uplinkLog.bind(app.log);
  const sessionMaintenance = createEmbeddedSessionMaintenance({
    config,
    dataVolumeRoot,
    eventStore,
    sessionSandboxCwd,
    log: app.log,
    cleanupAbort,
    sessionCleanupWorker,
  });

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
  await activateEmbeddedSecretHandoff({
    secretCipher,
    handedOffKeyMaterial,
    projectAgentGatewayIdentity,
    publishRunnerIdentity,
    codexModelCatalog,
  });
  // A sealed credentials read triggers feature revocation. Wait for key handover;
  // interactive boots start the client through onSecretUnlocked instead.
  if (!secretCipher.isSealed()) uplinkControl?.start();
  await installEmbeddedLocalPreviewRecovery(app, {
    localPreviewManager,
    projectDocker,
    secretCipher,
    managedDevServerManager,
    setPreviewRecoveryReady: (ready) => {
      previewRecoveryReady = ready;
    },
  });
  await installEmbeddedTrustedCli(app, { trustedCliOutput });
  installEmbeddedPersonalSandboxSleep(app, eventStore, managedDevServerManager, provisioner);
  installEmbeddedBuildStorage(app, { config, buildStorage, provisioner, dependencyCapacity });
  installEmbeddedDockerExecDiagnostics(app);
  app.addHook('onClose', () => listenerDiscovery?.close());
  app.addHook('onClose', () => projectEgress?.close());
  app.addHook('onClose', stopSystemInventory);
  if (!localPreviewManager) previewRecoveryReady = true;
  managedDevServerLog.current = (message, detail) => app.log.info(detail ?? {}, message);
  app.addHook('onClose', () => managedDevServerManager?.close());
  void listenerDiscovery?.reconcile();
  startEmbeddedStarterProject(app, eventStore, provisioner);
  app.addHook('onClose', () => claudeCredentialSync.close());
  installEmbeddedTeamOutbox(app, eventStore.projectTeam, uplinkControl, config.devicePairing);
  let preserveProjectRelaysOnClose = false;
  app.addHook('onClose', () =>
    preserveProjectRelaysOnClose
      ? (projectRelayLifecycle?.suspend() ?? Promise.resolve())
      : (projectRelayLifecycle?.close() ?? Promise.resolve()),
  );
  await installEmbeddedPublicPreviewRecovery(app, {
    previewShareManager,
    projectDocker,
    secretCipher,
    uplinkControl,
    eventStore,
    managedLinkEnded,
  });

  app.addHook('onClose', () => stopNativeEvidence?.());

  installEmbeddedDockerGc(app, {
    config,
    projectDocker,
    eventStore,
    provisioner,
    withStorageProjectMutation,
    managedDevServerManager,
    localPreviewManager,
    getProjectRelayLifecycle: () => projectRelayLifecycle,
    runnerCacheStorage,
    sessionStorage,
    volumeUsage,
    imageReferences,
    auditRecorder,
    buildStorage,
    onReport: (report) => {
      lastDockerGcReport = report;
    },
  });
  installEmbeddedModels(app, models);

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
  const stopRunnerSupervisorReconciler = await startEmbeddedRunnerRecovery({
    config,
    provisioner,
    eventStore,
    log: app.log,
    hasClaudeEgressIdentity: claudeEgressIdentity !== undefined,
  });
  // Last thing before the server object exists, because from here on the only way out is
  // the `return` below: everything that could still have thrown has run, so the caller is
  // guaranteed to receive the handle that can stop this walk.
  const transcriptSweep = sessionMaintenance.start();
  sessionCleanupWorker?.start();
  return {
    app,
    ...(embeddedSecretJobs !== undefined ? { secretJobs: embeddedSecretJobs } : {}),
    ...transcriptSweep,
    secretKeyHandoff: {
      exportKeyMaterial: () => secretCipher.exportKeyMaterial(),
    },
    close: createEmbeddedShutdown({
      closeGoogleSlides: () => googleSlidesTool.close(),
      stopAgentGatewayCredentialProjection,
      stopRunnerSupervisorReconciler,
      closeAgentGatewaySynchronizer: () => agentGatewaySynchronizer?.close(),
      closeApp: () => app.close(),
      closeSessionMaintenance: () => sessionMaintenance.close(),
      destroyDatabase: () => db.destroy(),
      setPreserveProjectRelays: (preserve) => {
        preserveProjectRelaysOnClose = preserve;
      },
    }),
  };
}
