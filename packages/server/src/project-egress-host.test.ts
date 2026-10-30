import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, chmod, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import type { Server } from 'node:http';
import {
  ProjectEgressHost,
  projectEgressHostRequest,
  type ProjectEgressHostState,
} from './project-egress-host.js';
import {
  openProjectEgressHostStore,
  verifyEgressHostContainer,
  verifyEgressHostRuntime,
  verifyEgressHostNetwork,
} from './project-egress-host-runtime.js';
import { listenProjectEgressHost } from './project-egress-host-control.js';
const binding = {
  projectId: 'project-a',
  generation: 'gen1',
  networkId: 'a'.repeat(64),
  networkName: 'project-a-gen1',
  bridge: 'vep0123456789ab',
};
const id = 'b'.repeat(64);
const start = {
  operation: 'start',
  projectId: binding.projectId,
  generation: binding.generation,
  role: 'sandbox',
  containerId: id,
};
function fixture(initial: ProjectEgressHostState = { version: 1, records: [] }) {
  let saved = structuredClone(initial);
  const calls: string[] = [];
  const deps = {
    save: vi.fn(async (state: ProjectEgressHostState) => {
      calls.push('save');
      saved = structuredClone(state);
    }),
    apply: vi.fn(async (script: string) => {
      calls.push('deny');
      expect(script).toContain('counter drop');
    }),
    inspectNetwork: vi.fn(async () => {
      calls.push('network');
    }),
    inspectContainer: vi.fn(async () => {
      calls.push('container');
    }),
    startContainer: vi.fn(async () => {
      calls.push('start');
    }),
    stopContainer: vi.fn(async () => {
      calls.push('stop');
    }),
  };
  return { deps, calls, host: new ProjectEgressHost(initial, deps), saved: () => saved };
}
it('persists and acknowledges denial before starting, without endpoint information', async () => {
  const { host, calls, deps } = fixture();
  await host.execute({ operation: 'register', binding });
  calls.length = 0;
  expect(await host.execute(start)).toEqual({ state: 'started-denied', generation: 'gen1' });
  expect(calls).toEqual([
    'deny',
    'container',
    'save',
    'deny',
    'network',
    'container',
    'start',
    'container',
    'network',
  ]);
  const script = deps.apply.mock.calls.at(-1)![0];
  expect(script).toContain('meta ibrname');
  expect(script).not.toContain('ct state');
  expect(script).not.toContain('timeout');
});
it('never starts when persistence, denial or attachment inspection fails', async () => {
  for (const failure of ['save', 'apply', 'inspectNetwork', 'inspectContainer'] as const) {
    const { host, deps } = fixture();
    await host.execute({ operation: 'register', binding });
    deps[failure].mockRejectedValueOnce(new Error('injected failure'));
    await expect(host.execute(start)).rejects.toThrow();
    expect(deps.startContainer).not.toHaveBeenCalled();
  }
});
it('serializes retirement behind an in-flight start and rejects all later starts', async () => {
  const { host, deps, calls } = fixture();
  await host.execute({ operation: 'register', binding });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  deps.startContainer.mockImplementationOnce(async () => {
    calls.push('start');
    await gate;
  });
  const starting = host.execute(start);
  const retiring = host.execute({
    operation: 'retire',
    projectId: binding.projectId,
    generation: binding.generation,
  });
  release();
  await starting;
  await retiring;
  expect(calls.indexOf('start')).toBeLessThan(calls.indexOf('stop'));
  await expect(host.execute(start)).rejects.toThrow('Retired');
});
it('restores denial before reuse and retains retired identities across restarts', async () => {
  const first = fixture();
  await first.host.execute({ operation: 'register', binding });
  await first.host.execute(start);
  await first.host.execute({
    operation: 'retire',
    projectId: binding.projectId,
    generation: binding.generation,
  });
  const restarted = fixture(first.saved());
  await restarted.host.restore();
  expect(restarted.calls).toEqual(['deny', 'deny']);
  await expect(restarted.host.execute(start)).rejects.toThrow('Retired');
  await expect(
    restarted.host.execute({ operation: 'register', binding: { ...binding, generation: 'gen2' } }),
  ).rejects.toThrow('fresh network');
  await expect(
    restarted.host.execute({
      operation: 'register',
      binding: { ...binding, bridge: 'vep111111111111', networkId: 'c'.repeat(64) },
    }),
  ).rejects.toThrow('reserved');
});
it('rejects foreign, reused and changed identities and poisons state after save failure', async () => {
  const { host, deps } = fixture();
  await host.execute({ operation: 'register', binding });
  await expect(host.execute({ ...start, projectId: 'foreign' })).rejects.toThrow('Unknown');
  await host.execute(start);
  await expect(host.execute({ ...start, containerId: 'c'.repeat(64) })).rejects.toThrow('reserved');
  await expect(host.execute({ ...start, role: 'relay' })).rejects.toThrow('reserved');
  deps.save.mockRejectedValueOnce(new Error('disk failure'));
  await expect(host.execute(start)).rejects.toThrow('disk failure');
  await expect(host.execute(start)).rejects.toThrow('requires restart');
});
it('denies and stops after a post-start inspection mismatch', async () => {
  const { host, deps, calls } = fixture();
  await host.execute({ operation: 'register', binding });
  deps.inspectContainer
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('changed'));
  await expect(host.execute(start)).rejects.toThrow('containment attempted');
  expect(calls.slice(-2)).toEqual(['deny', 'stop']);
});
it('rejects supplied commands and admission operations absent from the protocol', () => {
  for (const input of [
    { ...start, command: 'nft flush ruleset' },
    { ...start, operation: 'renew' },
    { operation: 'register', binding: { ...binding, bridge: 'x";accept' } },
  ])
    expect(() => projectEgressHostRequest.parse(input)).toThrow();
});
it('validates daemon identities, restart policy and network membership rather than labels', () => {
  const network = [
    {
      Id: binding.networkId,
      Name: binding.networkName,
      Driver: 'bridge',
      EnableIPv6: true,
      Options: { 'com.docker.network.bridge.name': binding.bridge },
      Containers: {},
    },
  ];
  const container = [
    {
      Id: id,
      HostConfig: {
        NetworkMode: binding.networkName,
        Runtime: 'runsc-project',
        Privileged: false,
        RestartPolicy: { Name: 'no' },
        CapAdd: null as string[] | null,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges=true'],
      },
      NetworkSettings: { Networks: { [binding.networkName]: { NetworkID: '' } } },
    },
  ];
  expect(() => verifyEgressHostNetwork(binding, network, [])).not.toThrow();
  expect(() => verifyEgressHostContainer(binding, id, container)).not.toThrow();
  expect(() =>
    verifyEgressHostNetwork(binding, [{ ...network[0], Containers: { foreign: {} } }], []),
  ).toThrow();
  const config = container[0]!.HostConfig;
  config.CapAdd = ['CHOWN', 'SETUID', 'SETGID', 'KILL', 'SETPCAP'];
  expect(() => verifyEgressHostContainer(binding, id, container, 'sandbox')).not.toThrow();
  expect(() => verifyEgressHostContainer(binding, id, container, 'relay')).toThrow();
  for (const extra of ['NET_ADMIN', 'NET_RAW', 'SYS_ADMIN']) {
    config.CapAdd.push(extra);
    expect(() => verifyEgressHostContainer(binding, id, container, 'sandbox')).toThrow();
    config.CapAdd.pop();
  }
  config.SecurityOpt = [];
  expect(() => verifyEgressHostContainer(binding, id, container, 'sandbox')).toThrow();
  config.SecurityOpt = ['no-new-privileges=true'];
  config.CapDrop = [];
  expect(() => verifyEgressHostContainer(binding, id, container, 'sandbox')).toThrow();
  config.CapDrop = ['ALL'];
  config.CapAdd = null;
  container[0]!.HostConfig.Runtime = 'runc';
  expect(() => verifyEgressHostContainer(binding, id, container)).toThrow();
  container[0]!.HostConfig.Runtime = 'runsc-project';
  container[0]!.HostConfig.RestartPolicy.Name = 'unless-stopped';
  expect(() => verifyEgressHostContainer(binding, id, container)).toThrow();
  container[0]!.HostConfig.RestartPolicy.Name = 'no';
  container[0]!.HostConfig.NetworkMode = 'host';
  expect(() => verifyEgressHostContainer(binding, id, container)).toThrow();
});
const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join('/tmp', 'egress-host-'));
  directories.push(path);
  return path;
}
it('stores atomically and refuses corrupt or symlinked registry files', async () => {
  const root = await directory();
  const store = await openProjectEgressHostStore(root);
  const value: ProjectEgressHostState = {
    version: 1,
    records: [{ binding, retired: true, containers: { sandbox: id } }],
  };
  await store.save(value);
  expect(await store.load()).toEqual(value);
  await writeFile(join(root, 'registry.json'), '{');
  await expect(store.load()).rejects.toThrow();
  await rm(join(root, 'registry.json'));
  await symlink('/etc/passwd', join(root, 'registry.json'));
  await expect(store.load()).rejects.toThrow();
  await chmod(root, 0o777);
  await expect(openProjectEgressHostStore(root)).rejects.toThrow('private');
});
it('requires authentication on the real Unix listener and never exposes raw execution', async () => {
  const root = await directory();
  const { host, deps } = fixture();
  servers.push(
    await listenProjectEgressHost({ directory: root, token: 'a'.repeat(64), controller: host }),
  );
  const send = (token: string, body: unknown) =>
    new Promise<number>((resolve, reject) => {
      const call = request(
        {
          socketPath: join(root, 'control.sock'),
          path: '/v1/command',
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode!));
        },
      );
      call.on('error', reject);
      call.end(JSON.stringify(body));
    });
  expect(await send('wrong', { operation: 'register', binding })).toBe(401);
  expect(deps.apply).not.toHaveBeenCalled();
  expect(await send('a'.repeat(64), { operation: 'register', binding })).toBe(200);
  expect(await send('a'.repeat(64), { operation: 'exec', command: 'true' })).toBe(409);
});

it('still stops a mismatched started container when restoring the firewall also fails', async () => {
  const { host, deps } = fixture();
  await host.execute({ operation: 'register', binding });
  deps.inspectContainer
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('changed attachment'));
  deps.apply
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('nft unavailable'));
  await expect(host.execute(start)).rejects.toThrow('containment attempted');
  expect(deps.stopContainer).toHaveBeenCalledWith(id);
});

it('attempts every registered stop even when one container has disappeared', async () => {
  const { host, deps } = fixture();
  await host.execute({ operation: 'register', binding });
  await host.execute(start);
  const relay = 'c'.repeat(64);
  await host.execute({ ...start, role: 'relay', containerId: relay });
  deps.stopContainer.mockRejectedValueOnce(new Error('container missing'));
  await expect(
    host.execute({
      operation: 'retire',
      projectId: binding.projectId,
      generation: binding.generation,
    }),
  ).rejects.toThrow('container stop failed');
  expect(deps.stopContainer).toHaveBeenCalledWith(id);
  expect(deps.stopContainer).toHaveBeenCalledWith(relay);
  await expect(host.execute(start)).rejects.toThrow('Retired');
});

it('rejects a named gVisor runtime configured for host networking or overriding flags', () => {
  const runtime = {
    path: '/opt/verity/runsc/release-20260714.0/runsc',
    runtimeArgs: ['--platform=systrap', '--network=sandbox', '--host-uds=create'],
  };
  expect(() => verifyEgressHostRuntime({ 'runsc-project': runtime })).not.toThrow();
  for (const runtimeArgs of [
    ['--platform=systrap', '--network=host', '--host-uds=create'],
    [...runtime.runtimeArgs, '--network=host'],
    [],
  ])
    expect(() =>
      verifyEgressHostRuntime({ 'runsc-project': { ...runtime, runtimeArgs } }),
    ).toThrow();
});

it('recovers current authority without inspecting labels, mutating rules or leaking mutable state', async () => {
  const first = fixture();
  const query = { operation: 'current', projectId: binding.projectId };
  expect(await first.host.execute(query)).toEqual({
    state: 'current',
    projectId: binding.projectId,
    binding: null,
  });
  await first.host.execute({ operation: 'register', binding });
  const restarted = fixture(first.saved());
  const result = await restarted.host.execute(query);
  expect(result).toEqual({ state: 'current', projectId: binding.projectId, binding });
  if (result.state !== 'current' || result.binding === null) throw new Error('missing binding');
  result.binding.generation = 'forged';
  expect(await restarted.host.execute(query)).toEqual({
    state: 'current',
    projectId: binding.projectId,
    binding,
  });
  expect(restarted.calls).toEqual([]);
  await restarted.host.execute({
    operation: 'retire',
    projectId: binding.projectId,
    generation: binding.generation,
  });
  expect(await restarted.host.execute(query)).toEqual({
    state: 'current',
    projectId: binding.projectId,
    binding: null,
  });
});

it('revalidates restored roles before serving and stops incompatible containers', async () => {
  const initial: ProjectEgressHostState = {
    version: 1,
    records: [{ binding, retired: false, containers: { sandbox: id, relay: 'c'.repeat(64) } }],
  };
  const { host, deps } = fixture(initial);
  await host.restore();
  deps.inspectContainer.mockRejectedValueOnce(new Error('profile changed'));
  await expect(host.revalidate()).rejects.toThrow('containment attempted');
  expect(deps.stopContainer).toHaveBeenCalledWith(id);
  expect(deps.inspectContainer).toHaveBeenCalledWith(binding, 'c'.repeat(64), 'relay', true);
  await expect(host.execute(start)).rejects.toThrow();
});

const transport = {
  sandbox: { address: '172.20.0.2', mac: '02:42:ac:14:00:02', device: 'vethsandbox', index: 10 },
  relay: { address: '172.20.0.3', mac: '02:42:ac:14:00:03', device: 'vethrelay', index: 11 },
  codex: false,
};
function transportFixture() {
  const f = fixture({
    version: 1,
    records: [{ binding, retired: false, containers: { sandbox: id, relay: 'c'.repeat(64) } }],
  });
  const inspectTransport = vi.fn(async () => structuredClone(transport));
  const host = new ProjectEgressHost(f.saved(), { ...f.deps, inspectTransport });
  return { ...f, host, inspectTransport };
}
it('admits only the inspected pair after both role checks and confirms endpoints after apply', async () => {
  const f = transportFixture();
  expect(
    await f.host.execute({
      operation: 'connect',
      projectId: binding.projectId,
      generation: 'gen1',
    }),
  ).toEqual({ state: 'connected', generation: 'gen1', relayAddress: transport.relay.address });
  expect(f.inspectTransport).toHaveBeenCalledTimes(2);
  expect(f.deps.inspectContainer).toHaveBeenCalledWith(binding, id, 'sandbox');
  expect(f.deps.inspectContainer).toHaveBeenCalledWith(binding, 'c'.repeat(64), 'relay');
  const rules = f.deps.apply.mock.calls.at(-1)![0];
  expect(rules).toContain('meta iif 10 meta oif 11');
  expect(rules).toContain('tcp dport { 8080, 8443 }');
  expect(rules).not.toContain('8444');
  expect(rules).not.toContain('udp dport');
  expect(rules).toContain('meta obrname "vep*" counter drop');
  expect(rules).toContain('arp saddr ip 172.20.0.2 arp daddr ip 172.20.0.3');
});
it('rejects queued and new admissions during shutdown and fences after an in-flight write', async () => {
  const f = transportFixture();
  let release!: () => void;
  f.deps.apply.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const command = { operation: 'connect', projectId: binding.projectId, generation: 'gen1' };
  const inFlight = f.host.execute(command);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const queued = f.host.execute(command).then(
    () => false,
    () => true,
  );
  const stopping = f.host.shutdown();
  const late = f.host.execute(command).then(
    () => false,
    () => true,
  );
  release();
  await inFlight;
  await stopping;
  expect(await queued).toBe(true);
  expect(await late).toBe(true);
  const final = f.deps.apply.mock.calls.at(-1)![0];
  expect(final).toContain('iifname "vep*" counter drop');
  expect(final).not.toContain('ct label set');
});
it('revokes before prepare, restart validation and retirement including active connections', async () => {
  for (const operation of ['prepare', 'start', 'retire'] as const) {
    const f = transportFixture();
    await f.host.execute({
      operation: 'connect',
      projectId: binding.projectId,
      generation: 'gen1',
    });
    f.deps.apply.mockClear();
    if (operation === 'start')
      f.deps.inspectContainer.mockRejectedValueOnce(new Error('role changed'));
    await f.host
      .execute(
        operation === 'start'
          ? start
          : { operation, projectId: binding.projectId, generation: 'gen1' },
      )
      .catch(() => undefined);
    const rules = f.deps.apply.mock.calls[0]![0];
    expect(rules).not.toContain('tcp dport');
    expect(rules).not.toContain('ct state');
  }
});
it('restoration never replays an admitted endpoint', async () => {
  const f = transportFixture();
  await f.host.execute({ operation: 'connect', projectId: binding.projectId, generation: 'gen1' });
  f.deps.apply.mockClear();
  await f.host.restore();
  await f.host.revalidate();
  expect(f.deps.apply.mock.calls.every(([rules]) => !rules.includes('tcp dport'))).toBe(true);
});
it('rolls back admission if the host endpoint changes during the kernel transaction', async () => {
  const f = transportFixture();
  f.inspectTransport
    .mockResolvedValueOnce(transport)
    .mockResolvedValueOnce({ ...transport, relay: { ...transport.relay, index: 12 } });
  await expect(
    f.host.execute({ operation: 'connect', projectId: binding.projectId, generation: 'gen1' }),
  ).rejects.toThrow('changed during admission');
  expect(f.deps.apply.mock.calls.at(-1)![0]).not.toContain('tcp dport');
});
it('failed revocation poisons the controller and attempts both container stops', async () => {
  const f = transportFixture();
  await f.host.execute({ operation: 'connect', projectId: binding.projectId, generation: 'gen1' });
  f.deps.apply.mockRejectedValueOnce(new Error('nft unavailable'));
  await expect(
    f.host.execute({ operation: 'prepare', projectId: binding.projectId, generation: 'gen1' }),
  ).rejects.toThrow('containment attempted');
  expect(f.deps.stopContainer).toHaveBeenCalledWith(id);
  expect(f.deps.stopContainer).toHaveBeenCalledWith('c'.repeat(64));
  await expect(f.host.execute(start)).rejects.toThrow('requires restart');
});

it('failed restoration contains registered containers and prevents admission', async () => {
  const f = transportFixture();
  f.deps.apply.mockRejectedValueOnce(new Error('nft unavailable'));
  await expect(f.host.restore()).rejects.toThrow('Host restoration failed');
  expect(f.deps.stopContainer).toHaveBeenCalledWith(id);
  expect(f.deps.stopContainer).toHaveBeenCalledWith('c'.repeat(64));
  await expect(f.host.execute(start)).rejects.toThrow('requires restart');
});

it('uses a fresh SYN-bound flow label after prepare and controller restoration', async () => {
  const f = transportFixture();
  const command = { operation: 'connect', projectId: binding.projectId, generation: 'gen1' };
  const labels = new Set<string>();
  for (const operation of ['initial', 'prepare', 'restore']) {
    if (operation === 'prepare') await f.host.execute({ ...command, operation: 'prepare' });
    if (operation === 'restore') await f.host.restore();
    await f.host.execute(command);
    const rules = f.deps.apply.mock.calls.at(-1)![0];
    const label = /ct label set (\([0-9 |]+\))/u.exec(rules)?.[1];
    expect(label).toBeDefined();
    expect(labels.has(label!)).toBe(false);
    labels.add(label!);
    expect(rules).toContain('ct state new tcp flags & (syn | ack | rst | fin) == syn ct label set');
    expect(rules).toContain(`ct state established ct label == ${label}`);
    expect(rules).toContain(`ct state { new, established } ct label == ${label}`);
  }
});

it('attempts registered-container containment if shutdown fencing fails', async () => {
  const f = transportFixture();
  f.deps.apply.mockRejectedValueOnce(new Error('kernel unavailable'));
  await expect(f.host.shutdown()).rejects.toThrow('containment attempted');
  expect(f.deps.stopContainer).toHaveBeenCalledWith(id);
  expect(f.deps.stopContainer).toHaveBeenCalledWith('c'.repeat(64));
  await expect(
    f.host.execute({ operation: 'connect', projectId: binding.projectId, generation: 'gen1' }),
  ).rejects.toThrow();
});
