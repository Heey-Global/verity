import type { FastifyInstance } from 'fastify';

import type { DockerClient } from './docker.js';
import type { BrokeredForgeProxy } from './brokered-forge-proxy.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import {
  startProjectInternalUnixListener,
  type InternalConnectionIdentity,
  type ProjectInternalUnixListener,
} from './internal-listener.js';
import {
  startProjectClaudeUnixListener,
  type ProjectClaudeUnixListener,
} from './project-claude-unix-listener.js';
import { createDockerProjectRelayStarter } from './project-relay-docker.js';
import {
  ProjectRelayLifecycle,
  type ProjectRelayRuntime,
  type ProjectRelayStartContext,
} from './project-relay-lifecycle.js';
import type { SigningCapabilityRegistry } from './signing-capability.js';

export interface ProjectRelayRuntimeOptions {
  app: FastifyInstance;
  forgeProxy?: BrokeredForgeProxy | undefined;
  forgeProxyEnabled?: ((projectId: string) => boolean) | undefined;
  docker: DockerClient;
  signingCapabilities: SigningCapabilityRegistry;
  githubCapabilities: GhTokenCapabilityRegistry;
  image: string;
  dataVolume: string;
  dataVolumeRoot: string;
  brokerSocketRoot: string;
  claudeSocketRoot: string;
  codexSocketRoot?: string;
  socketOwnerUid: number;
  relayGid: number;
  projectNetwork(projectId: string): string;
  /** Narrow dependency-injection seams used by composition tests. */
  startBrokerListener?:
    ((identity: InternalConnectionIdentity) => Promise<ProjectInternalUnixListener>) | undefined;
  startClaudeListener?:
    | ((
        identity: InternalConnectionIdentity,
        gateway: { host: string; port: number },
      ) => Promise<ProjectClaudeUnixListener>)
    | undefined;
  startCodexListener?:
    | ((
        identity: InternalConnectionIdentity,
        gateway: { host: string; port: number },
      ) => Promise<ProjectClaudeUnixListener>)
    | undefined;
  startRelay?: ((context: ProjectRelayStartContext) => Promise<ProjectRelayRuntime>) | undefined;
}

/** Compose the complete, still explicitly activated per-project relay runtime. */
export function createProjectRelayRuntime(
  options: ProjectRelayRuntimeOptions,
): ProjectRelayLifecycle {
  const startBrokerListener =
    options.startBrokerListener ??
    ((identity: InternalConnectionIdentity) =>
      startProjectInternalUnixListener(options.app, {
        socketRoot: options.brokerSocketRoot,
        identity,
        ownerUid: options.socketOwnerUid,
        relayGid: options.relayGid,
        forgeProxy: options.forgeProxy,
      }));
  const startClaudeListener =
    options.startClaudeListener ??
    ((identity: InternalConnectionIdentity, gateway: { host: string; port: number }) =>
      startProjectClaudeUnixListener({
        socketRoot: options.claudeSocketRoot,
        identity,
        ownerUid: options.socketOwnerUid,
        relayGid: options.relayGid,
        gatewayHost: gateway.host,
        gatewayPort: gateway.port,
      }));
  const startCodexListener =
    options.startCodexListener ??
    (options.codexSocketRoot === undefined
      ? undefined
      : (identity: InternalConnectionIdentity, gateway: { host: string; port: number }) =>
          startProjectClaudeUnixListener({
            socketRoot: options.codexSocketRoot!,
            identity,
            ownerUid: options.socketOwnerUid,
            relayGid: options.relayGid,
            gatewayHost: gateway.host,
            gatewayPort: gateway.port,
            socketName: 'codex.sock',
            serviceName: 'Codex',
          }));
  const startRelay =
    options.startRelay ??
    createDockerProjectRelayStarter({
      docker: options.docker,
      forgeProxyEnabled: options.forgeProxyEnabled,
      image: options.image,
      dataVolume: options.dataVolume,
      dataVolumeRoot: options.dataVolumeRoot,
      brokerSocketRoot: options.brokerSocketRoot,
      claudeSocketRoot: options.claudeSocketRoot,
      ...(options.codexSocketRoot === undefined
        ? {}
        : { codexSocketRoot: options.codexSocketRoot }),
      socketOwnerUid: options.socketOwnerUid,
      relayGid: options.relayGid,
      projectNetwork: (projectId) => options.projectNetwork(projectId),
      log: options.app.log,
    });

  return new ProjectRelayLifecycle({
    signingCapabilities: options.signingCapabilities,
    githubCapabilities: options.githubCapabilities,
    startBrokerListener,
    startClaudeListener,
    ...(startCodexListener === undefined ? {} : { startCodexListener }),
    startRelay,
  });
}
