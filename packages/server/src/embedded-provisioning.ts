import type { ProjectRecord } from '@verity/store';
import type { FastifyBaseLogger } from 'fastify';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EmbeddedServerConfig } from './embedded-types.js';
import {
  ProvisionerImpl,
  type ProvisionerOptions,
  type DevcontainerFeatureSource,
} from './provisioner.js';
import { DeprovisionerImpl } from './deprovisioner.js';
import type { createEmbeddedGitHub } from './embedded-github.js';
import type { createEmbeddedForgeProxy } from './embedded-forge-proxy.js';
import type { createEmbeddedPreviewMutations } from './embedded-preview-mutations.js';
import type { ProjectSandboxLifecycleTelemetry } from './project-lifecycle-telemetry.js';
import type { SigningCapabilityRegistry } from './signing-capability.js';
import type { ListenerDiscovery } from './listener-discovery.js';
import { sandboxUpdateLifecycleHooks } from './sandbox-update-recovery.js';
import { cloneConfigRepairOptions } from './clone-config-guard.js';
import { projectForgeProvider } from './project-forge-provider.js';
import { createProtectedDevcontainerBuilder } from './protected-devcontainer-builder.js';
import { createDockerGvisorRuntimeVerifier } from './docker-gvisor-runtime-verifier.js';
import {
  PINNED_PROJECT_RUNSC_ARGS,
  PINNED_RUNSC_PATH,
  PROJECT_RUNSC_RUNTIME,
} from './gvisor-runtime-config.js';
import {
  createGitHubAppInstallationTokenMint,
  REGISTRY_GITHUB_TOKEN_PERMISSIONS,
} from './github-app-token.js';
import { devcontainerProvisionerOptionsForDockerBaseUrl } from './embedded-support.js';

type UpdateRuntime = Parameters<typeof sandboxUpdateLifecycleHooks>[0];
type ProvisioningContext = Pick<
  ReturnType<typeof createEmbeddedGitHub>,
  'baseMintOpts' | 'githubForge' | 'projectTokenMint'
> & {
  config: Pick<
    EmbeddedServerConfig,
    | 'agentSeedHostPath'
    | 'claudeConfigVolume'
    | 'claudeConnectorPort'
    | 'claudeEgressGatewayHost'
    | 'claudeEgressGatewayUrl'
    | 'codexConfigVolume'
    | 'codexEgressGatewayUrl'
    | 'dataDir'
    | 'dataVolume'
    | 'dataVolumeRoot'
    | 'projectEgressKeyPath'
    | 'projectEgressSocketPath'
    | 'publicPreviews'
    | 'recreateEnvDriftedSandboxes'
    | 'resolvePreviewConnectorImage'
    | 'runnerRuntimeGid'
    | 'runnerSupervisor'
    | 'runnerSupervisorTrustedDefaultImage'
    | 'sandboxAllowPrivilegeEscalation'
    | 'sandboxCapAdd'
    | 'sandboxCpuShares'
    | 'sandboxDnsServers'
    | 'sandboxHostReserveBytes'
    | 'sandboxMemoryBytes'
    | 'sandboxMemoryReservationBytes'
    | 'sandboxNanoCpus'
    | 'sandboxOomScoreAdj'
    | 'sandboxPidsLimit'
    | 'sandboxSwapBytes'
    | 'workspacesDir'
  >;
  hostCloneRoot: string;
  dockerBaseUrl: string;
  buildStorage: NonNullable<ProvisionerOptions['buildStorage']>;
  imageReferences: ProvisionerOptions['imageReferences'];
  auditRecorder: ProvisionerOptions['audit'];
  buildDiagnostics: ProvisionerOptions['buildDiagnostics'];
  eventStore: ProvisionerOptions['store'];
  db: ProvisionerOptions['db'];
  docker: ProvisionerOptions['docker'];
  defaultProjectImage: ProvisionerOptions['defaultImageRef'];
  forgeRepositoryAccess: ProvisionerOptions['forgeRepositoryAccess'];
  secretRoot: string;
  durableServerRoot: string | undefined;
  ghTokenCapabilities: ProvisionerOptions['ghTokenCapabilities'];
  forgeIdentity: Awaited<ReturnType<typeof createEmbeddedForgeProxy>>['forgeIdentity'];
  forgeProxyEnabled: Awaited<ReturnType<typeof createEmbeddedForgeProxy>>['forgeProxyEnabled'];
  projectRelayControl: ProvisionerOptions['projectRelay'] | undefined;
  claudeEgressIdentity: ProvisionerOptions['claudeEgressIdentity'];
  claudeEgressServerName: string | undefined;
  agentGatewayUrl: URL | undefined;
  projectSandboxLifecycleTelemetry: Pick<ProjectSandboxLifecycleTelemetry, 'record'>;
  withPreviewProjectMutation: ReturnType<
    typeof createEmbeddedPreviewMutations
  >['withPreviewProjectMutation'];
  devcontainerFeature: DevcontainerFeatureSource | undefined;
  signingCapabilities: SigningCapabilityRegistry;
  projectEgress: ProvisionerOptions['projectEgress'];
  // These resources are initialized after provisioning. Read each binding only
  // when its lifecycle callback runs, including after subsequent replacements.
  runtime: {
    readonly log: FastifyBaseLogger;
    readonly managedDevServerManager: ReturnType<UpdateRuntime['devServers']>;
    readonly localPreviewManager: ReturnType<UpdateRuntime['local']>;
    readonly previewShareManager: ReturnType<UpdateRuntime['public']>;
    readonly runPendingCleanup: ((projectId: string) => Promise<unknown>) | undefined;
    readonly projectTurnReconciler: ((projectId: string) => Promise<void>) | undefined;
    readonly listenerDiscovery: Pick<ListenerDiscovery, 'invalidateProject'> | undefined;
    readonly projectAgentGatewayIdentity: (confirm?: boolean) => Promise<void>;
  };
};

export function createEmbeddedProvisioning({
  config,
  hostCloneRoot,
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
  runtime,
}: ProvisioningContext) {
  const provisioner = new ProvisionerImpl({
    ...sandboxUpdateLifecycleHooks({
      store: eventStore,
      devServers: () => runtime.managedDevServerManager,
      local: () => runtime.localPreviewManager,
      public: () => runtime.previewShareManager,
      log: () => runtime.log,
    }),
    beforeRunnerAdmission: async (project) => {
      await runtime.runPendingCleanup?.(project.id);
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
    ...cloneConfigRepairOptions(durableServerRoot, (event, msg) => runtime.log.warn(event, msg)),
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
      await runtime.projectTurnReconciler?.(project.id);
    },
    onContainerStarted: async (project) => {
      runtime.listenerDiscovery?.invalidateProject(project.id);
      await runtime.projectAgentGatewayIdentity(true);
    },
    onSandboxLifecycle: (event) => {
      projectSandboxLifecycleTelemetry.record(event);
      // One line per transition, so a turn that failed right after a wake can be
      // placed against it; the aggregate above cannot say which project woke.
      runtime.log[event.outcome === 'failed' ? 'warn' : 'info'](
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
      runtime.log[event.outcome === 'failed' ? 'warn' : 'info'](
        { ...event, ...cause },
        'verity: project Sandbox recreated',
      );
    },
    onSandboxWakeFallback: (event) => {
      runtime.log.warn(event, 'verity: sleeping Sandbox requires cold wake fallback');
    },
    withContainerReplace: <T>(
      project: ProjectRecord,
      mutation: () => Promise<T>,
      beforeRetire?: () => Promise<void>,
    ) => withPreviewProjectMutation(project.id, mutation, beforeRetire),
    ...(config.dataVolume !== undefined ? { dataVolume: config.dataVolume } : {}),
    ...(config.dataVolumeRoot !== undefined ? { dataVolumeRoot: config.dataVolumeRoot } : {}),
    ...(config.runnerSupervisor !== undefined ? { runnerSupervisor: config.runnerSupervisor } : {}),
    ...(config.runnerRuntimeGid !== undefined ? { runnerRuntimeGid: config.runnerRuntimeGid } : {}),
    ...(config.runnerSupervisorTrustedDefaultImage !== undefined
      ? { runnerSupervisorTrustedDefaultImage: config.runnerSupervisorTrustedDefaultImage }
      : {}),
    // Provisioner enforces hardened defaults for unset runtime limits.
    ...(config.sandboxPidsLimit !== undefined ? { sandboxPidsLimit: config.sandboxPidsLimit } : {}),
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
    ...(config.sandboxSwapBytes !== undefined ? { sandboxSwapBytes: config.sandboxSwapBytes } : {}),
    ...(config.sandboxNanoCpus !== undefined ? { sandboxNanoCpus: config.sandboxNanoCpus } : {}),
    ...(config.sandboxCpuShares !== undefined ? { sandboxCpuShares: config.sandboxCpuShares } : {}),
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
    hostCloneRoot: hostCloneRoot,
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
  const deprovisioner = new DeprovisionerImpl(
    eventStore,
    db,
    docker,
    hostCloneRoot,
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
      runtime.log.warn(
        { projectId: project.id, step, err: cause },
        'verity: project teardown step failed — deprovision continued',
      ),
    // Revoked fail-closed on teardown: `relay.stop` above is best-effort, so
    // its capability revocation is repeated here where a failure is fatal.
    signingCapabilities,
  );
  return { provisioner, deprovisioner };
}
