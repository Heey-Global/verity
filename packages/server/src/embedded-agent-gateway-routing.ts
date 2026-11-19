import type { EmbeddedServerConfig } from './embedded-types.js';
import type { createEmbeddedAgentGateway } from './embedded-agent-gateway.js';
import type { EventStore } from '@verity/store';
import { DockerError, type DockerClient } from './docker.js';
import type { ProjectRelayControl } from './provisioner.js';
import { originalSandbox, type ProjectRelaySandboxRef } from './project-relay-lifecycle.js';
import { projectedAgentGatewayFingerprint } from './agent-gateway-projection.js';
import { claudeEgressRelayHealthy } from './claude-egress-agent-env.js';
import { CONTAINER_GENERATION_LABEL } from './project-relay-migration.js';
import type { ClaudeEgressPeerBinding } from './claude-egress-mtls.js';
import { CONTROL_PLANE_RUNNER_PROJECT_ID } from './embedded-support.js';
import { recordedDefaultSandboxUser } from './project-sandbox.js';
import { sandboxIdentity } from './sandbox-identity.js';

type GatewayState = ReturnType<typeof createEmbeddedAgentGateway>['state'];

export function createEmbeddedAgentGatewayReadiness({
  secretRoot,
  state: agentGatewayState,
}: {
  secretRoot: string | undefined;
  state: Pick<GatewayState, 'bindings' | 'bindingProjection'>;
}) {
  const projectRelayControlRef: { current: Pick<ProjectRelayControl, 'isHealthy'> | undefined } = {
    current: undefined,
  };
  // Every check below names one sandbox, never a project: a member's own sandbox
  // has its own relay and its own gateway certificate, and a lookup by project id
  // alone would answer for the project's original sandbox instead (ADR 0023 §4).
  const healthyRelayGeneration = async (
    sandbox: ProjectRelaySandboxRef,
    inspected: Awaited<ReturnType<DockerClient['inspectContainer']>>,
  ): Promise<boolean> =>
    claudeEgressRelayHealthy(
      inspected,
      CONTAINER_GENERATION_LABEL,
      async (containerGeneration) =>
        (await projectRelayControlRef.current?.isHealthy?.({
          sandbox,
          containerGeneration,
        })) === true,
    );
  const hasProjectedAgentGatewayBinding = (
    sandbox: ProjectRelaySandboxRef,
    inspected: Awaited<ReturnType<DockerClient['inspectContainer']>>,
  ): boolean => {
    // A woken Sandbox holds a certificate re-issued after its creation-time label
    // was written; the provisioner vouches for that one per container generation.
    const fingerprint = projectedAgentGatewayFingerprint(secretRoot, sandbox.projectId, inspected);
    return (
      fingerprint !== undefined &&
      agentGatewayState.bindings.some(
        (binding) =>
          binding.projectId === sandbox.projectId &&
          binding.fingerprint256 === fingerprint &&
          // A binding names its person; it vouches only for that person's sandbox.
          (sandbox.userId === undefined ||
            binding.userId === undefined ||
            binding.userId === sandbox.userId),
      )
    );
  };
  const agentGatewayReady = async (
    sandbox: ProjectRelaySandboxRef,
    inspected: Awaited<ReturnType<DockerClient['inspectContainer']>>,
  ): Promise<boolean> => {
    await agentGatewayState.bindingProjection;
    return (
      (await healthyRelayGeneration(sandbox, inspected)) &&
      hasProjectedAgentGatewayBinding(sandbox, inspected)
    );
  };

  return { projectRelayControlRef, healthyRelayGeneration, agentGatewayReady };
}

export function createEmbeddedAgentGatewayRouting({
  config,
  agentGatewayUrl,
  getDocker,
  eventStore,
  state: agentGatewayState,
  healthyRelayGeneration,
}: {
  config: Pick<EmbeddedServerConfig, 'controlPlaneRunner'>;
  agentGatewayUrl: URL | undefined;
  getDocker: () => Pick<DockerClient, 'inspectContainer'> | undefined;
  eventStore: Pick<EventStore, 'getProject' | 'projectSandboxes'>;
  state: Pick<GatewayState, 'bindings'>;
  healthyRelayGeneration: ReturnType<
    typeof createEmbeddedAgentGatewayReadiness
  >['healthyRelayGeneration'];
}) {
  const routedAgentGatewayBindings = async (
    bindings: readonly ClaudeEgressPeerBinding[],
  ): Promise<readonly ClaudeEgressPeerBinding[]> => {
    const docker = getDocker();
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
      // A person's own sandbox is routed too: the gateway serves it with that
      // person's own login or none, and the synchronizer withdraws such routes
      // from a gateway that cannot tell people apart (ADR 0023 §3–4).
      try {
        // Each binding is checked against its own person's container and relay; the
        // original container vouches only for the original sandbox's bindings.
        const defaultUser = await recordedDefaultSandboxUser(eventStore, project.id);
        const sandbox =
          binding.userId === undefined || binding.userId === defaultUser
            ? originalSandbox(project.id)
            : { projectId: project.id, userId: binding.userId, projectDefault: false };
        const containerName =
          sandbox.userId === undefined
            ? project.containerName
            : sandboxIdentity(project, sandbox).containerName;
        const inspected = await docker.inspectContainer(containerName);
        if (await healthyRelayGeneration(sandbox, inspected)) {
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
        const previouslyRouted = agentGatewayState.bindings.some(
          (routed) =>
            routed.projectId === binding.projectId &&
            routed.userId === binding.userId &&
            routed.fingerprint256 === binding.fingerprint256,
        );
        if (transient && previouslyRouted) routed.push(binding);
      }
    }
    return routed;
  };
  return routedAgentGatewayBindings;
}
