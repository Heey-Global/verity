import { expect, it, vi } from 'vitest';
import { inspectEgressTransport, transportRules } from './project-egress-transport.js';
const binding = {
  projectId: 'p1',
  generation: 'g1',
  networkId: 'a'.repeat(64),
  networkName: 'project-network',
  bridge: 'vep0123456789ab',
};
const ids = { sandbox: 'b'.repeat(64), relay: 'c'.repeat(64) };
function fixture() {
  const endpoints = {
    [ids.sandbox]: {
      NetworkID: binding.networkId,
      IPAddress: '172.20.0.2',
      MacAddress: '02:42:ac:14:00:02',
    },
    [ids.relay]: {
      NetworkID: binding.networkId,
      IPAddress: '172.20.0.3',
      MacAddress: '02:42:ac:14:00:03',
    },
  };
  const network = {
    Id: binding.networkId,
    Name: binding.networkName,
    Driver: 'bridge',
    EnableIPv6: true,
    Options: { 'com.docker.network.bridge.name': binding.bridge },
    Containers: Object.fromEntries(
      Object.entries(endpoints).map(([id, v]) => [
        id,
        { IPv4Address: v.IPAddress + '/24', MacAddress: v.MacAddress },
      ]),
    ),
  };
  const containers = Object.fromEntries(
    Object.entries(endpoints).map(([id, v]) => [
      id,
      {
        Id: id,
        State: { Running: true },
        NetworkSettings: {
          SandboxKey: '/var/run/docker/netns/' + id[0],
          Networks: { [binding.networkName]: v },
        },
      },
    ]),
  );
  const io = {
    docker: vi.fn(async (...args: string[]) =>
      JSON.stringify(args[0] === 'network' ? [network] : [containers[args[1]!]!]),
    ),
    run: vi.fn(async (file: string, args: string[]) => {
      if (file === '/sbin/ip')
        return JSON.stringify([
          { ifindex: 10, ifname: 'vethsandbox' },
          { ifindex: 11, ifname: 'vethrelay' },
        ]);
      const sandbox = args[0]!.endsWith('/b');
      // gVisor moved the address into netstack; the kernel NIC has none.
      return JSON.stringify([
        {
          ifindex: 2,
          ifname: 'eth0',
          link_index: sandbox ? 10 : 11,
          address: endpoints[sandbox ? ids.sandbox : ids.relay]!.MacAddress,
          addr_info: [],
        },
      ]);
    }),
    readFile: vi.fn(async (path: string): Promise<string> =>
      path.endsWith('/iflink') ? '2' : path.includes('vethsandbox') ? '10' : '11',
    ),
    readlink: vi.fn(async () => `../../${binding.bridge}`),
  };
  return { io, network, containers, endpoints };
}
it('binds daemon-assigned IPs to kernel-proven peers even after runsc removes NIC addresses', async () => {
  const f = fixture();
  const t = await inspectEgressTransport(binding, ids, false, f.io);
  expect(t?.sandbox).toEqual({
    address: '172.20.0.2',
    mac: '02:42:ac:14:00:02',
    device: 'vethsandbox',
    index: 10,
  });
  const rules = transportRules(binding, t!, 'bridge');
  expect(rules).toContain('meta iif 10 meta oif 11');
  expect(rules).toContain('tcp dport { 8080, 8443 }');
  expect(rules).not.toContain('8444');
});
it.each([
  'foreign-network',
  'daemon-disagreement',
  'foreign-peer',
  'foreign-bridge',
  'extra-attachment',
  'extra-interface',
])('rejects %s', async (fault) => {
  const f = fixture();
  if (fault === 'foreign-network') f.endpoints[ids.sandbox]!.NetworkID = 'd'.repeat(64);
  if (fault === 'daemon-disagreement')
    f.network.Containers[ids.sandbox]!.IPv4Address = '172.20.0.99/24';
  if (fault === 'foreign-peer') f.io.readFile.mockResolvedValue('99');
  if (fault === 'foreign-bridge') f.io.readlink.mockResolvedValue('../../foreign');
  if (fault === 'extra-attachment')
    f.network.Containers['e'.repeat(64)] = {
      IPv4Address: '172.20.0.4/24',
      MacAddress: '02:42:ac:14:00:04',
    };
  if (fault === 'extra-interface')
    f.io.run.mockResolvedValue(
      JSON.stringify([
        {
          ifindex: 2,
          ifname: 'eth0',
          link_index: 10,
          address: f.endpoints[ids.sandbox]!.MacAddress,
          addr_info: [],
        },
        { ifindex: 3, ifname: 'eth1', address: '02:42:ac:14:00:05', addr_info: [] },
      ]),
    );
  await expect(inspectEgressTransport(binding, ids, true, f.io)).rejects.toThrow();
});
it('does not admit a stopped role', async () => {
  const f = fixture();
  f.containers[ids.relay]!.State.Running = false;
  expect(await inspectEgressTransport(binding, ids, true, f.io)).toBeUndefined();
});
it('refuses injected rule syntax and permits Codex only when host policy selects it', async () => {
  const f = fixture();
  const t = (await inspectEgressTransport(binding, ids, true, f.io))!;
  expect(transportRules(binding, t, 'bridge')).toContain('tcp dport { 8080, 8443, 8444 }');
  expect(() =>
    transportRules(binding, { ...t, relay: { ...t.relay, device: 'x" accept' } }, 'bridge'),
  ).toThrow();
});
