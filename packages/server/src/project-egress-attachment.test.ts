import { expect, it, vi } from 'vitest';
import { inspectProjectFenceAttachment } from './project-egress-attachment.js';
const binding = {
  projectId: 'p',
  generation: 'g',
  containerId: 'a'.repeat(64),
  networkId: 'b'.repeat(64),
  endpointId: 'c'.repeat(64),
  bridge: 'vep0123456789ab',
  ipv4: '172.20.0.2',
  ipv6: 'fd42::2',
};
const container = {
  Id: binding.containerId,
  HostConfig: { NetworkMode: 'project' },
  NetworkSettings: {
    Networks: {
      project: {
        NetworkID: binding.networkId,
        EndpointID: binding.endpointId,
        IPAddress: binding.ipv4,
        GlobalIPv6Address: binding.ipv6,
      },
    },
  },
};
const network = {
  Id: binding.networkId,
  Driver: 'bridge',
  Options: { 'com.docker.network.bridge.name': binding.bridge },
};
it('validates a batched attachment afresh before and after asynchronous changes', async () => {
  const inspect = vi.fn(async () => JSON.stringify([network, container]));
  const io = { inspect, ifindex: vi.fn(async () => '7') };
  expect(await inspectProjectFenceAttachment(binding, io)).toEqual(binding);
  inspect.mockResolvedValueOnce(JSON.stringify([network, { ...container, Id: 'd'.repeat(64) }]));
  await expect(inspectProjectFenceAttachment(binding, io)).rejects.toThrow();
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(inspect).toHaveBeenCalledWith(binding.containerId, binding.networkId);
});
it('does not accept duplicate replies or a missing host bridge', async () => {
  await expect(
    inspectProjectFenceAttachment(binding, {
      inspect: async () => JSON.stringify([container, container]),
      ifindex: async () => '7',
    }),
  ).rejects.toThrow();
  await expect(
    inspectProjectFenceAttachment(binding, {
      inspect: async () => JSON.stringify([container, network]),
      ifindex: async () => '0',
    }),
  ).rejects.toThrow('Missing');
});
