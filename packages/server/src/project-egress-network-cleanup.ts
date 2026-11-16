import { DockerError, type DockerClient } from './docker.js';
import type { ProjectEgressNetworkBinding } from './project-egress-host.js';
import {
  generationNetworkIdentity,
  generationNetworkLabels,
  networkHasContainers,
} from './project-network-cleanup.js';

type Identity = { projectId: string; generation: string };
/** Root host service only. No caller-selected path, flags, labels, bridge or address pool. */
export function createHostProjectNetworks(
  docker: DockerClient,
  allocationDocker: DockerClient = docker,
) {
  const inspect = async (id: string) => {
    if (!docker.inspectNetwork) throw new Error('Host network inspection unavailable');
    return docker.inspectNetwork(id);
  };
  const remove = async (id: string) => {
    if (!docker.removeNetwork) throw new Error('Host network removal unavailable');
    await docker.removeNetwork(id);
  };
  return {
    allocateNetwork: async (identity: Identity): Promise<ProjectEgressNetworkBinding> => {
      if (!allocationDocker.createEgressNetwork)
        throw new Error('Host network allocation unavailable');
      const names = generationNetworkIdentity(identity.projectId, identity.generation);
      const { id } = await allocationDocker.createEgressNetwork(
        names.networkName,
        names.bridge,
        generationNetworkLabels(identity.projectId, identity.generation),
      );
      return { ...identity, ...names, networkId: id };
    },
    cleanupNetwork: async (
      binding: ProjectEgressNetworkBinding,
      containers: { sandbox?: string | undefined; relay?: string | undefined } = {},
      discoverUnstarted = false,
    ): Promise<boolean> => {
      const names = generationNetworkIdentity(binding.projectId, binding.generation);
      // Legacy registered generations may have no labels; the durable exact binding is authority.
      if (binding.networkName !== names.networkName || binding.bridge !== names.bridge)
        throw new Error('Retired network binding mismatch');
      const ids = new Set(Object.values(containers).filter((id): id is string => id !== undefined));
      if (discoverUnstarted) {
        if (!docker.listContainers) throw new Error('Container inventory unavailable');
        const inventory = await docker.listContainers();
        if (inventory.length > 10000) throw new Error('Oversized container inventory');
        for (const candidate of inventory)
          if (
            candidate.labels?.['verity.project-id'] === binding.projectId &&
            candidate.labels?.['verity.container-generation'] === binding.generation
          )
            ids.add(candidate.id);
        if (ids.size > 16) throw new Error('Oversized abandoned allocation');
      }
      for (const id of ids) {
        if (!id || !docker.removeStoppedContainer) continue;
        try {
          const container = await docker.inspectContainer(id);
          if (
            container.id !== id ||
            container.running ||
            !['created', 'exited', 'dead'].includes(container.status ?? '') ||
            container.labels?.['verity.project-id'] !== binding.projectId ||
            container.labels?.['verity.container-generation'] !== binding.generation ||
            ![binding.networkId, binding.networkName].includes(container.networkMode ?? '')
          )
            continue;
          await docker.removeStoppedContainer(id);
        } catch (error) {
          if (!(error instanceof DockerError && error.kind === 'container_not_found')) throw error;
        }
      }
      const value = await inspect(binding.networkId);
      if (!value) return true;
      if (
        value.Id !== binding.networkId ||
        value.Name !== binding.networkName ||
        value.Options?.['com.docker.network.bridge.name'] !== binding.bridge
      )
        throw new Error('Retired network identity mismatch');
      if (Object.keys(value.Containers).length || (await networkHasContainers(docker, value)))
        return false;
      const current = await inspect(binding.networkId);
      if (!current) return true;
      if (
        current.Name !== value.Name ||
        current.Options?.['com.docker.network.bridge.name'] !== binding.bridge ||
        Object.keys(current.Containers).length
      )
        throw new Error('Retired network changed during cleanup');
      await remove(value.Id);
      return true;
    },
    cleanupPendingNetwork: async (identity: Identity): Promise<void> => {
      const names = generationNetworkIdentity(identity.projectId, identity.generation);
      const value = await inspect(names.networkName);
      if (!value) return;
      const labels = generationNetworkLabels(identity.projectId, identity.generation);
      if (
        value.Name !== names.networkName ||
        value.Options?.['com.docker.network.bridge.name'] !== names.bridge ||
        Object.entries(labels).some(([key, label]) => value.Labels?.[key] !== label) ||
        Object.keys(value.Containers).length
      )
        throw new Error('Pending network ownership or attachments mismatch');
      if (await networkHasContainers(docker, value))
        throw new Error('Pending network has configured containers');
      const current = await inspect(value.Id);
      if (!current) return;
      if (
        current.Name !== value.Name ||
        current.Options?.['com.docker.network.bridge.name'] !== names.bridge ||
        Object.entries(labels).some(([key, label]) => current.Labels?.[key] !== label) ||
        Object.keys(current.Containers).length
      )
        throw new Error('Pending network changed during cleanup');
      await remove(value.Id);
    },
  };
}
