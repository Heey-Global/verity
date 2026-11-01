import { readEgressDockerObject } from './project-egress-docker-read.js';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ProjectFenceBinding } from './project-egress-fence.js';
const id = z.string().regex(/^[a-f0-9]{64}$/u);
const endpoint = z.object({
  NetworkID: id,
  EndpointID: id,
  IPAddress: z.string(),
  GlobalIPv6Address: z.string(),
});
const containerSchema = z
  .array(
    z.object({
      Id: id,
      HostConfig: z.object({ NetworkMode: z.string() }),
      NetworkSettings: z.object({ Networks: z.record(z.string(), endpoint) }),
    }),
  )
  .length(1);
const networkSchema = z
  .array(
    z.object({ Id: id, Driver: z.literal('bridge'), Options: z.record(z.string(), z.string()) }),
  )
  .length(1);

/** Parse only trusted Docker daemon replies. Project/generation come from the
 * lifecycle registrar, never Docker labels or fields supplied by a workload. */
export function verifyProjectFenceAttachment(
  expected: ProjectFenceBinding,
  containerJson: unknown,
  networkJson: unknown,
): ProjectFenceBinding {
  const container = containerSchema.parse(containerJson)[0]!;
  const network = networkSchema.parse(networkJson)[0]!;
  const endpoints = Object.values(container.NetworkSettings.Networks);
  if (
    container.Id !== expected.containerId ||
    network.Id !== expected.networkId ||
    endpoints.length !== 1 ||
    ['host', 'none'].includes(container.HostConfig.NetworkMode)
  )
    throw new Error('Project fence requires one dedicated bridge attachment');
  const attached = endpoints[0]!;
  const bridge = network.Options['com.docker.network.bridge.name'];
  if (
    attached.NetworkID !== network.Id ||
    attached.EndpointID !== expected.endpointId ||
    attached.IPAddress !== expected.ipv4 ||
    attached.GlobalIPv6Address !== expected.ipv6 ||
    bridge !== expected.bridge
  )
    throw new Error('Project fence daemon attachment mismatch');
  return { ...expected };
}

/** Host-side only. No Docker socket or command endpoint is exposed to a project. */
export async function inspectProjectFenceAttachment(
  binding: ProjectFenceBinding,
  io = {
    inspect: async (containerId: string, networkId: string) =>
      JSON.stringify([
        await readEgressDockerObject('container', containerId),
        await readEgressDockerObject('network', networkId),
      ]),
    ifindex: (bridge: string) => readFile(`/sys/class/net/${bridge}/ifindex`, 'utf8'),
  },
): Promise<ProjectFenceBinding> {
  if (![binding.containerId, binding.networkId].every((value) => /^[a-f0-9]{64}$/u.test(value)))
    throw new Error('Invalid daemon object id');
  const replies = z
    .array(z.object({ Id: id }).passthrough())
    .length(2)
    .parse(JSON.parse(await io.inspect(binding.containerId, binding.networkId)));
  const container = replies.filter((value) => value.Id === binding.containerId);
  const network = replies.filter((value) => value.Id === binding.networkId);
  const result = verifyProjectFenceAttachment(binding, container, network);
  if (!/^[a-zA-Z0-9_-]{1,15}$/u.test(result.bridge)) throw new Error('Invalid bridge interface');
  // A daemon record alone is insufficient if its network device no longer exists.
  const ifindex = Number((await io.ifindex(result.bridge)).trim());
  if (!Number.isSafeInteger(ifindex) || ifindex < 1) throw new Error('Missing host bridge');
  return result;
}
