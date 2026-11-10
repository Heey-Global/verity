import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DockerClient } from './docker.js';

export const dockerNetworkSchema = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/u),
  Name: z.string(),
  Driver: z.literal('bridge'),
  Labels: z.record(z.string(), z.string()).nullable(),
  Options: z.record(z.string(), z.string()).nullable(),
  // Missing attachment data must never mean an empty network.
  Containers: z.record(z.string().regex(/^[a-f0-9]{64}$/u), z.unknown()),
});
export type DockerNetwork = z.infer<typeof dockerNetworkSchema>;
export function generationNetworkIdentity(projectId: string, generation: string) {
  const hash = createHash('sha256').update(`${projectId}\0${generation}`).digest('hex');
  return { networkName: `verity-egress-${hash.slice(0, 32)}`, bridge: `vep${hash.slice(0, 12)}` };
}
export const generationNetworkLabels = (projectId: string, generation: string) => ({
  'verity.project-id': projectId,
  'verity.container-generation': generation,
  'verity.component': 'project-network',
});
/** Includes stopped containers whose saved NetworkMode still points at this network. */
export async function networkHasContainers(
  docker: DockerClient,
  network: DockerNetwork,
): Promise<boolean> {
  if (!docker.listContainers) throw new Error('Complete container inventory unavailable');
  const containers = await docker.listContainers();
  if (containers.length > 10000) throw new Error('Oversized container inventory');
  const deadline = performance.now() + 1000;
  let inspected = 0;
  for (const container of containers) {
    if (performance.now() >= deadline)
      throw new Error('Container network inventory budget exceeded');
    if (container.networkMode !== undefined && container.networkNames !== undefined) {
      if (
        [network.Id, network.Name].includes(container.networkMode) ||
        container.networkNames.includes(network.Name)
      )
        return true;
      continue;
    }
    if (++inspected > 64) throw new Error('Container network inspection budget exceeded');
    const value = await docker.inspectContainer(container.id);
    if (performance.now() >= deadline)
      throw new Error('Container network inventory budget exceeded');
    if (value.networkMode === undefined || value.networks === undefined)
      throw new Error('Incomplete container network inventory');
    if (
      [network.Id, network.Name].includes(value.networkMode) ||
      Object.hasOwn(value.networks, network.Name)
    )
      return true;
  }
  return false;
}

/** Caller holds the project's admission barrier. Docker refuses a racing attachment. */
export async function removeLegacyProjectNetwork(
  docker: DockerClient,
  projectId: string,
  expectedId?: string,
) {
  if (!docker.inspectNetwork || !docker.removeNetwork) return;
  const name = `verity-proj-${projectId}`;
  const network = await docker.inspectNetwork(name);
  if (!network || (expectedId !== undefined && network.Id !== expectedId)) return;
  if (
    network.Name !== name ||
    network.Labels?.['verity.project-id'] !== projectId ||
    (network.Labels?.['verity.component'] !== undefined &&
      network.Labels['verity.component'] !== 'project-network')
  )
    throw new Error('Project network ownership is unproven');
  if (Object.keys(network.Containers).length !== 0 || (await networkHasContainers(docker, network)))
    return;
  const current = await docker.inspectNetwork(network.Id);
  if (!current) return;
  if (
    current.Id !== network.Id ||
    current.Name !== name ||
    current.Labels?.['verity.project-id'] !== projectId ||
    (current.Labels?.['verity.component'] !== undefined &&
      current.Labels['verity.component'] !== 'project-network') ||
    Object.keys(current.Containers).length
  )
    return;
  await docker.removeNetwork(network.Id);
}
