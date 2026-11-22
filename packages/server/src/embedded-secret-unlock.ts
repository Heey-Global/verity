import type { FastifyInstance } from 'fastify';
import type { EventStore } from '@verity/store';
import type { DockerClient } from './docker.js';
import type { ProvisionerImpl } from './provisioner.js';
import type { ServerDeps } from './server-deps.js';
import type { createEmbeddedAgentGateway } from './embedded-agent-gateway.js';
import type { createEmbeddedAgentGatewayReadiness } from './embedded-agent-gateway-routing.js';
import type { createEmbeddedAgentGatewayIdentityProjection } from './embedded-agent-gateway-identity.js';
import type { createEmbeddedRunnerIdentityPublisher } from './embedded-control-plane-runner-identity.js';
import type { startCodexModelCatalog } from './codex-model-catalog.js';
import type { createEmbeddedUplink } from './embedded-uplink.js';
import { originalSandbox } from './project-relay-lifecycle.js';

export function createEmbeddedSecretUnlock(ctx: {
  eventStore: Pick<EventStore, 'listProjects'>;
  docker: Pick<DockerClient, 'inspectContainer'> | undefined;
  provisioner: Pick<ProvisionerImpl, 'resumeProjectRelay' | 'repairSandboxForTurn'> | undefined;
  projectAgentGatewayIdentity: ReturnType<typeof createEmbeddedAgentGatewayIdentityProjection>;
  agentGatewayReady: ReturnType<typeof createEmbeddedAgentGatewayReadiness>['agentGatewayReady'];
  agentGatewayState: Pick<ReturnType<typeof createEmbeddedAgentGateway>['state'], 'bindings'>;
  publishRunnerIdentity: ReturnType<typeof createEmbeddedRunnerIdentityPublisher>;
  materializeOpenCodeConfig: (reason: 'boot' | 'secret unlock') => Promise<void>;
  codexModelCatalog: Pick<ReturnType<typeof startCodexModelCatalog>, 'refresh'> | undefined;
  uplinkControl:
    | Pick<NonNullable<ReturnType<typeof createEmbeddedUplink>['uplinkControl']>, 'start'>
    | undefined;
  log: () => FastifyInstance['log'];
}): NonNullable<ServerDeps['onSecretUnlocked']> {
  const {
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
    log,
  } = ctx;
  return async () => {
    // Restore process-local relay listeners before filtering persisted gateway
    // certificates. A new Server owns none yet; treating that as identity drift
    // would recreate a valid retained Sandbox while checking its unlock state.
    for (const project of await eventStore.listProjects()) {
      if (project.kind === 'control_plane' || project.state !== 'active') continue;
      try {
        await provisioner?.resumeProjectRelay?.(project.id);
      } catch (error) {
        log().warn(
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
          log().warn(
            { err: error, projectId: project.id },
            'Agent Gateway identity reconciliation deferred for project',
          );
        }
      }
    }
    await projectAgentGatewayIdentity(inspected > 0);
    log().info(
      { inspected, repaired, deferred, projectedBindings: agentGatewayState.bindings.length },
      'Agent Gateway identity reconciliation completed after secret unlock',
    );
    // Publishes what the sealed boot had to skip. Ordered after the gateway
    // projection because both mint from the same CA and the gateway is what a
    // Sandbox needs first; the Runner picks its material up by generation file.
    const runnerIdentityPublished = await publishRunnerIdentity('secret unlock');
    log().info(
      { published: runnerIdentityPublished },
      'control-plane Runner identity resume completed after secret unlock',
    );
    // The provider settings are readable now. A sealed boot can only have written
    // the credential-free fallback, and the Runner reads the file through a
    // directory mount, so replacing it here reaches containers already running.
    await materializeOpenCodeConfig('secret unlock');
    await codexModelCatalog?.refresh();
    uplinkControl?.start();
  };
}
