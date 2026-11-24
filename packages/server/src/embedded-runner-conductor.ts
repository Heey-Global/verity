import type { EventStore } from '@verity/store';
import { httpMcpConnectionUsableBy } from '@verity/store';
import type { FastifyBaseLogger } from 'fastify';
import { brokeredGrantTarget, brokeredGrantToolName } from '@verity/session';
import type { EmbeddedServerConfig } from './embedded-types.js';
import {
  buildRunnerConductorWiring,
  RUNNER_CONTAINER_PROJECT_ROOT,
} from './embedded-runner-wiring.js';
import { CONTROL_PLANE_PROJECT_ID as CONTROL_PLANE_RUNNER_PROJECT_ID } from './control-plane-project.js';
import { resolveTurnSandbox } from './turn-sandbox.js';
import { resolveTurnGitAuthor, turnSignsCommits } from './turn-git-author.js';
import { personForCredential } from './personless-credential.js';
import type { createBrokeredHttpGrantStore } from './brokered-http-grants.js';

type RunnerWiring = Parameters<typeof buildRunnerConductorWiring>[0];
type EmbeddedRunnerConductorDeps = Pick<
  RunnerWiring,
  | 'bus'
  | 'allocateEventFile'
  | 'allocateControlSocket'
  | 'mcpGatewayTokens'
  | 'turnCredentials'
  | 'mcpProxyTokens'
> & {
  config: Pick<
    EmbeddedServerConfig,
    | 'runnerSupervisor'
    | 'controlPlaneRunner'
    | 'runnerTransport'
    | 'dataVolumeRoot'
    | 'hostCloneRoot'
  >;
  eventStore: EventStore;
  transcriptStore: RunnerWiring['transcript'];
  getLog: () => Pick<FastifyBaseLogger, 'warn'>;
  /** The grant binding id of a call reading these secret references (ADR 0031). */
  brokeredGrantBindingIdFor: (
    projectId: string,
    references: readonly string[],
  ) => Promise<string | undefined>;
  brokeredHttpGrants: Pick<ReturnType<typeof createBrokeredHttpGrantStore>, 'check'>;
};

/** Bind Runner transport and recovery to the application's identity and grant stores. */
export function createEmbeddedRunnerConductorWiring(
  deps: EmbeddedRunnerConductorDeps,
): ReturnType<typeof buildRunnerConductorWiring> {
  const {
    config,
    eventStore,
    bus,
    transcriptStore,
    allocateEventFile,
    allocateControlSocket,
    mcpGatewayTokens,
    turnCredentials,
    mcpProxyTokens,
    getLog,
    brokeredGrantBindingIdFor,
    brokeredHttpGrants,
  } = deps;
  return buildRunnerConductorWiring({
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
      getLog().warn(
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
    turnSandbox: (projectId, initiatedBy) => resolveTurnSandbox(eventStore, projectId, initiatedBy),
    turnGitAuthor: (userId) =>
      resolveTurnGitAuthor(
        {
          gitIdentity: (id) => eventStore.userGitIdentities.author(id),
          githubAccount: (id) => eventStore.userGithubAuthorizations.account(id),
          displayName: async (id) => (await eventStore.userProfiles.read(id))?.displayName,
        },
        userId,
      ),
    turnSignsCommits: (userId) =>
      turnSignsCommits(
        {
          hasSigningKey: async (id) =>
            (await eventStore.userGitIdentities.publicIdentity(id)).hasSigningKey,
          isAdministrator: (id) => eventStore.isActiveAdministrator(id),
        },
        userId,
      ),
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
      const bindingId = await brokeredGrantBindingIdFor(projectId, target.secretAliases);
      if (bindingId === undefined) return false;
      // Only the running turn's person can have consented in advance (ADR 0023 §3).
      const running = (await eventStore.listRunningTurns()).find(
        (turn) => turn.sessionId === sessionId,
      );
      if (running === undefined) return false;
      const initiator = await eventStore.promptInitiatorAt(sessionId, running.promptSeq);
      return brokeredHttpGrants.check({
        projectId,
        sessionId,
        userId: await personForCredential(eventStore, projectId, initiator?.userId),
        bindingId,
        channel,
        ...target,
      });
    },
  });
}
