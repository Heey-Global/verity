import type { ProjectRecord } from '@verity/store';
import { sandboxNotReadyError } from '@verity/events';
import type { Backend, TurnPreparationContext } from '@verity/session';
import type { FastifyBaseLogger } from 'fastify';
import type { DockerClient } from './docker.js';
import type { Provisioner } from './provisioner.js';
import type { AgentGatewayRepairFailure } from './claude-egress-agent-env.js';
import type { createEmbeddedAgentGatewayReadiness } from './embedded-agent-gateway-routing.js';
import { originalSandbox } from './project-relay-lifecycle.js';
import { createProjectTurnPreparationSerializer } from './embedded-support.js';

export function createEmbeddedSandboxTurnPreparation({
  getDocker,
  getProvisioner,
  getLogger,
  refreshAgentGatewayCredential,
  synchronizeAgentGatewayForTurn,
  agentGatewayReady,
}: {
  getDocker: () => Pick<DockerClient, 'inspectContainer'> | undefined;
  getProvisioner: () =>
    | Pick<
        Provisioner,
        | 'ensurePersonalSandbox'
        | 'repairSandboxForTurn'
        | 'waitForTurnSandboxRepair'
        | 'turnSandboxRepairInFlight'
        | 'tryBeginProjectSandboxActivity'
        | 'endProjectSandboxActivity'
      >
    | undefined;
  getLogger: () => Pick<FastifyBaseLogger, 'warn'>;
  refreshAgentGatewayCredential: () => Promise<void>;
  synchronizeAgentGatewayForTurn: () => Promise<void>;
  agentGatewayReady: ReturnType<typeof createEmbeddedAgentGatewayReadiness>['agentGatewayReady'];
}) {
  /**
   * The repair of {@link repairSandboxForAgentTurn} for a person's own sandbox:
   * rebuild it and report whether the turn may proceed on it. Only that person's
   * sandbox is touched; the project's original one keeps running.
   */
  const repairPersonalSandboxForAgentTurn = async (
    project: ProjectRecord,
    userId: string,
    preparation: TurnPreparationContext,
  ): Promise<{ ready: true } | { ready: false; failure?: AgentGatewayRepairFailure }> => {
    const docker = getDocker();
    const provisioner = getProvisioner();
    if (!preparation.canWait || docker === undefined) return { ready: false };
    if (provisioner?.ensurePersonalSandbox === undefined) return { ready: false };
    preparation.waitingOn(
      'Your Sandbox has to be rebuilt before this message can run. Keeping the turn queued while Verity attempts the rebuild; it continues automatically if the Sandbox becomes ready.',
    );
    let containerName: string;
    try {
      containerName = (
        await provisioner.ensurePersonalSandbox(project.id, userId, { recreate: true })
      ).containerName;
    } catch (error) {
      getLogger().warn(
        { err: error, projectId: project.id },
        'turn-time personal sandbox repair failed',
      );
      return { ready: false, failure: { stage: 'rebuild', cause: error } };
    }
    try {
      const inspected = await docker.inspectContainer(containerName);
      await refreshAgentGatewayCredential();
      await synchronizeAgentGatewayForTurn();
      return (await agentGatewayReady(
        { projectId: project.id, userId, projectDefault: false },
        inspected,
      ))
        ? { ready: true }
        : { ready: false, failure: { stage: 'still_unready' } };
    } catch (error) {
      getLogger().warn(
        { err: error, projectId: project.id },
        'could not verify the Agent Gateway identity after a personal sandbox repair',
      );
      return { ready: false, failure: { stage: 'verify', cause: error } };
    }
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
    const docker = getDocker();
    const provisioner = getProvisioner();
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
      getLogger().warn({ err: error, projectId: project.id }, 'turn-time sandbox repair failed');
      return { ready: false, failure: { stage: 'rebuild', cause: error } };
    }
    // Trust the recreate only as far as the same check that rejected the Sandbox in
    // the first place: a repair that reports success but leaves the relay unhealthy
    // must not let the turn through to fail deeper in.
    try {
      const inspected = await docker.inspectContainer(project.containerName);
      await synchronizeAgentGatewayForTurn();
      return (await agentGatewayReady(originalSandbox(project.id), inspected))
        ? { ready: true }
        : { ready: false, failure: { stage: 'still_unready' } };
    } catch (error) {
      getLogger().warn(
        { err: error, projectId: project.id },
        'could not verify the Agent Gateway identity after a turn-time sandbox repair',
      );
      return { ready: false, failure: { stage: 'verify', cause: error } };
    }
  };

  const withProjectSandboxActivity = (projectId: string, backend: Backend): Backend => {
    const use = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (getProvisioner()?.tryBeginProjectSandboxActivity?.(projectId) === false) {
        // Same transient class as the serializer above — this wrapper is only ever
        // applied to a background resolution's backend, and a repair holding the
        // activity lock resolves itself.
        throw sandboxNotReadyError('project Sandbox repair is already in progress');
      }
      try {
        return await operation();
      } finally {
        getProvisioner()?.endProjectSandboxActivity?.(projectId);
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
      getProvisioner()?.waitForTurnSandboxRepair?.(projectId, sessionId) ?? Promise.resolve(),
    repairInFlight: (projectId) =>
      getProvisioner()?.turnSandboxRepairInFlight?.(projectId) === true,
    wrapBackground: withProjectSandboxActivity,
  });
  return {
    repairPersonalSandboxForAgentTurn,
    repairSandboxForAgentTurn,
    serializeProjectTurnPreparation,
  };
}
