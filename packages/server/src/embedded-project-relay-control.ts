import type { EmbeddedServerConfig } from './embedded-types.js';
import type { ProjectRelayControl } from './provisioner.js';
import type { ProjectRelayLifecycle } from './project-relay-lifecycle.js';
import { projectRelayContainerName } from './project-relay-identity.js';
import { DockerError, type DockerClient } from './docker.js';

export function validateEmbeddedProjectRelay({
  config,
  projectRelayEnabled,
  agentGatewayUrl,
}: {
  config: Pick<
    EmbeddedServerConfig,
    | 'dockerBaseUrl'
    | 'hostCloneRoot'
    | 'dataVolume'
    | 'dataVolumeRoot'
    | 'claudeEgressGatewayUrl'
    | 'codexEgressGatewayUrl'
    | 'claudeConnectorPort'
    | 'projectRelayImage'
  >;
  projectRelayEnabled: boolean;
  agentGatewayUrl: URL | undefined;
}): void {
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
}

export function createEmbeddedProjectRelayControl({
  projectRelayEnabled,
  getLifecycle,
  projectDocker,
}: {
  projectRelayEnabled: boolean;
  getLifecycle: () =>
    | Pick<ProjectRelayLifecycle, 'start' | 'resume' | 'sleep' | 'reactivate' | 'stop' | 'isActive'>
    | undefined;
  projectDocker: Pick<DockerClient, 'inspectContainer'> | undefined;
}): ProjectRelayControl | undefined {
  return projectRelayEnabled
    ? {
        start: (binding) => {
          const projectRelayLifecycle = getLifecycle();
          if (projectRelayLifecycle === undefined)
            throw new Error('project relay runtime is not initialized');
          return projectRelayLifecycle.start(binding);
        },
        resume: async (binding) => {
          const projectRelayLifecycle = getLifecycle();
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
        sleep: (sandbox) => {
          const projectRelayLifecycle = getLifecycle();
          if (projectRelayLifecycle === undefined)
            throw new Error('project relay runtime is not initialized');
          return projectRelayLifecycle.sleep(sandbox);
        },
        reactivate: (binding) => {
          const projectRelayLifecycle = getLifecycle();
          if (projectRelayLifecycle === undefined)
            throw new Error('project relay runtime is not initialized');
          return projectRelayLifecycle.reactivate(binding);
        },
        stop: (sandbox) => getLifecycle()?.stop(sandbox) ?? Promise.resolve(),
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
        isHealthy: async ({ sandbox, containerGeneration }) => {
          if (getLifecycle()?.isActive(sandbox, containerGeneration) !== true) return false;
          const projectId = sandbox.projectId;
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
}
