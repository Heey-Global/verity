import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EventStore } from '@verity/store';
import type { EmbeddedServerConfig } from './embedded-types.js';
import {
  createProjectRelayRuntime,
  type ProjectRelayRuntimeOptions,
} from './project-relay-runtime.js';
import { recordedDefaultSandboxUser } from './project-sandbox.js';

type Context = Pick<
  ProjectRelayRuntimeOptions,
  'app' | 'signingCapabilities' | 'forgeProxy' | 'forgeProxyEnabled'
> & {
  config: Pick<
    EmbeddedServerConfig,
    'dataVolumeRoot' | 'dataVolume' | 'projectRelayGid' | 'projectRelayImage'
  >;
  projectRelayEnabled: boolean;
  docker: ProjectRelayRuntimeOptions['docker'] | undefined;
  ghTokenCapabilities: ProjectRelayRuntimeOptions['githubCapabilities'];
  eventStore: Pick<EventStore, 'getProject' | 'forgeConnections' | 'projectSandboxes'>;
  sandboxNetworkName: ProjectRelayRuntimeOptions['sandboxNetwork'];
};

export function installEmbeddedProjectRelayRuntime({
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
}: Context): ReturnType<typeof createProjectRelayRuntime> | undefined {
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
    return createProjectRelayRuntime({
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
      sandboxNetwork: sandboxNetworkName,
      defaultSandboxUser: (projectId) => recordedDefaultSandboxUser(eventStore, projectId),
    });
  }
  return undefined;
}
