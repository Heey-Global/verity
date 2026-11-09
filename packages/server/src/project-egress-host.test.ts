import { DockerError } from './docker.js';
import { ProjectEgressInventoryError } from './project-egress-inventory-error.js';
import { createProjectEgressHostClient } from './project-egress-host-client.js';
import { ProtectedBuildHost } from './project-egress-build.js';
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
  createEgressHostRuntimeRegistrationGuard,
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
  const buildReady = vi.fn(async () => true);
  const builds = new ProtectedBuildHost(
    {
      ready: buildReady,
      prepare: async () => {},
      renew: async () => {},
      start: async () => {},
      status: async () => 'running',
      deny: async () => {},
      stop: async () => {},
      ended: async () => true,
      remove: async () => {},
    },
    async () => {},
  );
  servers.push(
    await listenProjectEgressHost({
      directory: root,
      token: 'a'.repeat(64),
      controller: host,
      builds,
    }),
  );
  const send = (token: string, body: unknown, path = '/v1/command') =>
    new Promise<number>((resolve, reject) => {
      const call = request(
        {
          socketPath: join(root, 'control.sock'),
          path,
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
  expect(await send('wrong', { operation: 'health' }, '/v1/build')).toBe(401);
  expect(buildReady).not.toHaveBeenCalled();
  expect(await send('a'.repeat(64), { operation: 'health' }, '/v1/build')).toBe(200);
  expect(buildReady).toHaveBeenCalledTimes(1);
  expect(await send('a'.repeat(64), { operation: 'exec', command: 'true' }, '/v1/build')).toBe(409);
  expect(await send('wrong', { operation: 'health' })).toBe(401);
  expect(await send('a'.repeat(64), { operation: 'health' })).toBe(200);
  expect(deps.save).not.toHaveBeenCalled();
  expect(deps.inspectNetwork).not.toHaveBeenCalled();
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
  expect(rules).toContain('tcp dport { 53, 8080, 8443 }');
  expect(rules).not.toContain('8444');
  // UDP appears only for the relay's DNS answerer on the exact pair.
  for (const rule of rules.split('\n').filter((line) => line.includes('udp ')))
    expect(rule).toMatch(
      /ip saddr 172\.20\.0\.(?:2 ip daddr 172\.20\.0\.3 udp dport|3 ip daddr 172\.20\.0\.2 udp sport) 53 /u,
    );
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

it('answers names read-only from enforcement, never for unknown or retired generations', async () => {
  const admitted = vi.fn((_binding: unknown, name: string) =>
    name === 'downloads.example.com' ? { addresses: ['8.8.8.8'], ttlSeconds: 3 } : undefined,
  );
  const invalidate = vi.fn();
  const enforcement = {
    directAuthority: () => true,
    invalidate,
    connect: vi.fn(),
    deny: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
    admitted,
    requestDirect: vi.fn(),
  };
  const { deps } = fixture();
  const host = new ProjectEgressHost(
    { version: 1, records: [] },
    { ...deps, enforcement, bootId: '00000000-0000-4000-8000-000000000000' },
  );
  await host.execute({ operation: 'register', binding });
  invalidate.mockClear();
  const ask = (name: string, generation = binding.generation) =>
    host.execute({ operation: 'resolve-direct', projectId: binding.projectId, generation, name });
  expect(await ask('downloads.example.com')).toEqual({
    state: 'resolved',
    generation: 'gen1',
    addresses: ['8.8.8.8'],
    ttlSeconds: 3,
  });
  expect(await ask('other.example.com')).toEqual({ state: 'unresolved', generation: 'gen1' });
  expect(await ask('downloads.example.com', 'gen2')).toEqual({
    state: 'unresolved',
    generation: 'gen2',
  });
  // Only an ungranted name of the current generation becomes a destination request.
  expect(enforcement.requestDirect).toHaveBeenCalledTimes(1);
  expect(enforcement.requestDirect).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: binding.projectId, generation: 'gen1' }),
    'other.example.com',
  );
  // Reading never invalidates pending admission or alters rules.
  expect(invalidate).not.toHaveBeenCalled();
  expect(enforcement.refresh).not.toHaveBeenCalled();
  for (const name of ['Downloads.Example.com', 'https://downloads.example.com', '8.8.8.8', 'a'])
    expect(() =>
      projectEgressHostRequest.parse({
        operation: 'resolve-direct',
        projectId: binding.projectId,
        generation: binding.generation,
        name,
      }),
    ).toThrow();
  await host.execute({ operation: 'retire', projectId: binding.projectId, generation: 'gen1' });
  expect(await ask('downloads.example.com')).toEqual({ state: 'unresolved', generation: 'gen1' });
  expect(enforcement.requestDirect).toHaveBeenCalledTimes(1);
});

it('does not advertise health when read-only host compatibility checks fail', async () => {
  const { deps } = fixture();
  const verifyHealth = vi.fn(async () => {
    throw new Error('unsupported Docker host');
  });
  const host = new ProjectEgressHost({ version: 1, records: [] }, { ...deps, verifyHealth });
  await expect(host.execute({ operation: 'health' })).rejects.toThrow('unsupported Docker host');
  expect(verifyHealth).toHaveBeenCalledExactlyOnceWith();
  expect(deps.save).not.toHaveBeenCalled();
  expect(deps.apply).not.toHaveBeenCalled();
  expect(deps.inspectNetwork).not.toHaveBeenCalled();
});

it('pins serving runtime registrations even when a replacement is otherwise supported', () => {
  const runtimes = {
    'runsc-project': {
      path: '/opt/verity/runsc/release-20261101.0/runsc',
      runtimeArgs: ['--host-uds=create', '--network=sandbox', '--platform=systrap'],
    },
    'runsc-relay': {
      path: '/opt/verity/runsc/release-20261101.0/runsc',
      runtimeArgs: ['--host-uds=open', '--network=sandbox', '--platform=systrap'],
    },
  };
  const verify = createEgressHostRuntimeRegistrationGuard(runtimes);
  verify(structuredClone(runtimes));
  const changed = structuredClone(runtimes);
  changed['runsc-relay'].path = '/opt/verity/runsc/release-20261102.0/runsc';
  verifyEgressHostRuntime(changed, 'relay');
  expect(() => verify(changed)).toThrow('registration changed');
  changed['runsc-relay'] = structuredClone(runtimes['runsc-relay']);
  changed['runsc-project'].runtimeArgs.reverse();
  expect(() => verify(changed)).toThrow('registration changed');
});

it('secures a fresh Docker bind directory before reading the missing host registry', async () => {
  const root = await mkdtemp('/tmp/egress-initial-bind-');
  try {
    await chmod(root, 0o755);
    await expect(openProjectEgressHostStore(root)).rejects.toThrow('private');
    const store = await openProjectEgressHostStore(root, { preparePrivate: true });
    expect(await store.load()).toEqual({ version: 1, records: [] });
    // The normal serving path now accepts the prepared directory without mutation.
    await expect(openProjectEgressHostStore(root)).resolves.toBeDefined();
    await chmod(root, 0o777);
    await expect(openProjectEgressHostStore(root, { preparePrivate: true })).rejects.toThrow(
      'writable',
    );
    await chmod(root, 0o700);
    const link = root + '-link';
    await symlink(root, link);
    try {
      await expect(openProjectEgressHostStore(link, { preparePrivate: true })).rejects.toThrow();
    } finally {
      await rm(link);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('carries sanitized inventory errors through the authenticated real listener with safe correlation', async () => {
  const root = await directory();
  const { host } = fixture();
  vi.spyOn(host, 'execute').mockRejectedValue(
    new ProjectEgressInventoryError('inventory_dns_failed'),
  );
  const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    servers.push(
      await listenProjectEgressHost({ directory: root, token: 'a'.repeat(64), controller: host }),
    );
    const command = createProjectEgressHostClient({
      socketPath: join(root, 'control.sock'),
      token: 'a'.repeat(64),
    });
    const refused = await command({
      operation: 'inventory-commit',
      token: '00000000-0000-4000-8000-000000000001',
      hosts: ['private.example.org'],
      addresses: [],
    }).catch((error: unknown) => error);
    if (!(refused instanceof ProjectEgressInventoryError))
      throw new Error('Expected inventory refusal');
    expect(refused.reason).toBe('inventory_dns_failed');
    expect(refused.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(log).toHaveBeenCalledWith('verity: inventory command refused', {
      operation: 'inventory-commit',
      reason: 'inventory_dns_failed',
      correlationId: refused.correlationId,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private.example.org');
    expect(JSON.stringify(log.mock.calls)).not.toContain('00000000-0000-4000-8000-000000000001');
  } finally {
    log.mockRestore();
  }
});

it('durably reserves host allocation before Docker create and recovers a failed creation after restart', async () => {
  const f = fixture();
  const identity = { projectId: binding.projectId, generation: binding.generation };
  const allocateNetwork = vi.fn(async () => {
    expect(f.saved().pendingNetworks).toEqual([identity]);
    throw new Error('daemon response lost');
  });
  const cleanupPendingNetwork = vi.fn(async () => {});
  const host = new ProjectEgressHost(
    { version: 1, records: [] },
    { ...f.deps, allocateNetwork, cleanupPendingNetwork },
  );
  await expect(host.execute({ operation: 'allocate-network', ...identity })).rejects.toThrow(
    'response lost',
  );
  const restarted = new ProjectEgressHost(f.saved(), {
    ...f.deps,
    allocateNetwork,
    cleanupPendingNetwork,
  });
  await restarted.cleanupNetworks();
  expect(cleanupPendingNetwork).toHaveBeenCalledWith(identity);
  expect(f.saved().pendingNetworks).toEqual([]);
});
it('serializes pending cleanup behind creation and preserves registered live networks', async () => {
  const f = fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cleanupPendingNetwork = vi.fn(async () => {});
  const host = new ProjectEgressHost(
    { version: 1, records: [] },
    {
      ...f.deps,
      allocateNetwork: async () => {
        await wait;
        return binding;
      },
      cleanupPendingNetwork,
    },
  );
  const creating = host.execute({
    operation: 'allocate-network',
    projectId: binding.projectId,
    generation: binding.generation,
  });
  const cleaning = host.cleanupNetworks();
  release();
  await expect(creating).resolves.toEqual({ state: 'network-allocated', binding });
  await cleaning;
  expect(cleanupPendingNetwork).not.toHaveBeenCalled();
  expect(f.saved().pendingNetworks).toEqual([]);
  expect(f.saved().records).toHaveLength(1);
});
it('retries retired cleanup after failure while retaining deny fences and permanent tombstones', async () => {
  const f = fixture({ version: 1, records: [{ binding, retired: true, containers: {} }] });
  const cleanupNetwork = vi
    .fn()
    .mockRejectedValueOnce(new Error('Docker offline'))
    .mockResolvedValue(true);
  const host = new ProjectEgressHost(f.saved(), { ...f.deps, cleanupNetwork });
  await expect(host.cleanupNetworks()).rejects.toThrow('cleanup deferred');
  await host.cleanupNetworks();
  expect(cleanupNetwork).toHaveBeenCalledTimes(2);
  expect(f.deps.apply).toHaveBeenCalledTimes(2);
  await expect(host.execute(start)).rejects.toThrow('Retired');
});

it('retries a failed explicit retirement stop after restart before removing its network', async () => {
  const f = fixture();
  await f.host.execute({ operation: 'register', binding });
  await f.host.execute(start);
  f.deps.stopContainer.mockRejectedValueOnce(new Error('Docker temporarily unavailable'));
  await expect(
    f.host.execute({
      operation: 'retire',
      projectId: binding.projectId,
      generation: binding.generation,
    }),
  ).rejects.toThrow('container stop failed');
  const cleanupNetwork = vi.fn(async () => {
    expect(f.deps.stopContainer).toHaveBeenCalledTimes(2);
    return true;
  });
  const restarted = new ProjectEgressHost(f.saved(), { ...f.deps, cleanupNetwork });
  await restarted.cleanupNetworks();
  expect(cleanupNetwork).toHaveBeenCalledWith(binding, { sandbox: id }, undefined);
  expect(f.saved().records[0]?.networkRemoved).toBe(true);
  await expect(restarted.execute(start)).rejects.toThrow('Retired');
});

it('accepts a matching allocation acknowledgement through the authenticated host transport', async () => {
  const root = await directory();
  const { deps } = fixture();
  const host = new ProjectEgressHost(
    { version: 1, records: [] },
    { ...deps, allocateNetwork: async () => binding },
  );
  servers.push(
    await listenProjectEgressHost({ directory: root, token: 'a'.repeat(64), controller: host }),
  );
  const command = createProjectEgressHostClient({
    socketPath: join(root, 'control.sock'),
    token: 'a'.repeat(64),
  });
  await expect(
    command({
      operation: 'allocate-network',
      projectId: binding.projectId,
      generation: binding.generation,
    }),
  ).resolves.toEqual({ state: 'network-allocated', binding });
});

it('returns only a fixed address-pool diagnostic through authenticated network allocation', async () => {
  const root = await directory();
  const { deps } = fixture();
  const host = new ProjectEgressHost(
    { version: 1, records: [] },
    {
      ...deps,
      allocateNetwork: async () => {
        throw new DockerError({
          kind: 'address_pool_exhausted',
          message: 'private daemon details',
        });
      },
    },
  );
  servers.push(
    await listenProjectEgressHost({ directory: root, token: 'a'.repeat(64), controller: host }),
  );
  const command = createProjectEgressHostClient({
    socketPath: join(root, 'control.sock'),
    token: 'a'.repeat(64),
  });
  const error = await command({
    operation: 'allocate-network',
    projectId: 'p1',
    generation: 'g1',
  }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(DockerError);
  expect(error).toMatchObject({
    kind: 'address_pool_exhausted',
    message: expect.stringContaining('default-address-pools'),
  });
  expect(String(error)).not.toContain('private daemon details');
});

it('recovers the allocation intent when network creation succeeded but registration inspection failed', async () => {
  const f = fixture();
  const cleanupPendingNetwork = vi.fn(async () => {});
  const host = new ProjectEgressHost(
    { version: 1, records: [] },
    {
      ...f.deps,
      allocateNetwork: async () => binding,
      inspectNetwork: async () => {
        throw new Error('inspection interrupted');
      },
    },
  );
  await expect(
    host.execute({
      operation: 'allocate-network',
      projectId: binding.projectId,
      generation: binding.generation,
    }),
  ).rejects.toThrow('inspection interrupted');
  expect(f.saved().records).toEqual([]);
  const restarted = new ProjectEgressHost(f.saved(), { ...f.deps, cleanupPendingNetwork });
  await restarted.cleanupNetworks();
  expect(cleanupPendingNetwork).toHaveBeenCalledExactlyOnceWith({
    projectId: binding.projectId,
    generation: binding.generation,
  });
});

it('keeps failed pending cleanup intents durable and eventually visits entries beyond the bounded batch', async () => {
  const f = fixture();
  const pendingNetworks = Array.from({ length: 9 }, (_, i) => ({
    projectId: 'p1',
    generation: `g${i}`,
  }));
  const cleanupPendingNetwork = vi.fn(async () => {
    throw new Error('unknown ownership');
  });
  const host = new ProjectEgressHost(
    { version: 1, records: [], pendingNetworks },
    { ...f.deps, cleanupPendingNetwork },
  );
  await expect(host.cleanupNetworks()).rejects.toThrow('cleanup deferred');
  expect(cleanupPendingNetwork).toHaveBeenCalledTimes(8);
  await expect(host.cleanupNetworks()).rejects.toThrow('cleanup deferred');
  expect(cleanupPendingNetwork).toHaveBeenCalledWith(pendingNetworks[8]);
  expect(f.deps.save).not.toHaveBeenCalled();
});

it('expires a completed allocation with a lost reply and no future provisioning, even after host restart', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const f = fixture();
    const host = new ProjectEgressHost(
      { version: 1, records: [] },
      { ...f.deps, allocateNetwork: async () => binding },
    );
    await host.execute({
      operation: 'allocate-network',
      projectId: binding.projectId,
      generation: binding.generation,
    });
    const cleanupNetwork = vi.fn(async () => true);
    const restarted = new ProjectEgressHost(f.saved(), { ...f.deps, cleanupNetwork });
    await restarted.cleanupNetworks();
    expect(cleanupNetwork).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await expect(restarted.execute(start)).rejects.toThrow('allocation expired');
    await restarted.cleanupNetworks();
    expect(cleanupNetwork).toHaveBeenCalledWith(binding, {}, true);
    expect(f.saved().records[0]).toMatchObject({
      retired: true,
      allocationAbandoned: true,
      networkRemoved: true,
    });
  } finally {
    vi.useRealTimers();
  }
});

it('does not block another project query or admission behind slow retired Docker housekeeping', async () => {
  const f = fixture({ version: 1, records: [{ binding, retired: true, containers: {} }] });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = new ProjectEgressHost(f.saved(), {
    ...f.deps,
    cleanupNetwork: async () => {
      entered();
      await wait;
      return true;
    },
  });
  const cleaning = host.cleanupNetworks();
  await started;
  await expect(
    host.execute({ operation: 'current', projectId: 'another-project' }),
  ).resolves.toMatchObject({ state: 'current', binding: null });
  release();
  await cleaning;
});

it('clears allocation expiry after verified transport and preserves the connected generation after the deadline', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const f = fixture({
      version: 1,
      records: [
        {
          binding,
          retired: false,
          allocationExpiresAt: Date.now() + 5 * 60_000,
          containers: { sandbox: id, relay: 'c'.repeat(64) },
        },
      ],
    });
    const cleanupNetwork = vi.fn(async () => true);
    const host = new ProjectEgressHost(f.saved(), {
      ...f.deps,
      cleanupNetwork,
      inspectTransport: async () => ({
        sandbox: {
          address: '172.30.0.3',
          mac: '02:42:ac:1e:00:03',
          device: 'vethsandbox',
          index: 10,
        },
        relay: { address: '172.30.0.2', mac: '02:42:ac:1e:00:02', device: 'vethrelay', index: 11 },
        codex: true,
      }),
    });
    await expect(host.execute(start)).resolves.toMatchObject({ state: 'started-connected' });
    expect(f.saved().records[0]?.allocationExpiresAt).toBeUndefined();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await host.cleanupNetworks();
    expect(cleanupNetwork).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('logs correlated protected-build refusals without exposing raw exception data', async () => {
  const { host } = fixture();
  const root = await directory();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const builds = new ProtectedBuildHost(
      {
        ready: async () => {
          throw new Error('SECRET /private/daemon/path');
        },
        prepare: async () => {},
        renew: async () => {},
        start: async () => {},
        status: async () => 'running',
        deny: async () => {},
        stop: async () => {},
        ended: async () => true,
        remove: async () => {},
      },
      async () => {},
    );
    servers.push(
      await listenProjectEgressHost({
        directory: root,
        token: 'a'.repeat(64),
        controller: host,
        builds,
      }),
    );
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const call = request(
        {
          socketPath: join(root, 'control.sock'),
          path: '/v1/build',
          method: 'POST',
          headers: { authorization: `Bearer ${'a'.repeat(64)}` },
        },
        (reply) => {
          let body = '';
          reply.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          reply.on('end', () => resolve({ status: reply.statusCode!, body }));
        },
      );
      call.on('error', reject);
      call.end(JSON.stringify({ operation: 'health' }));
    });
    expect(response.status).toBe(409);
    const diagnostic = JSON.parse(response.body) as { reason: string; correlationId: string };
    expect(diagnostic).toMatchObject({
      reason: 'operation_refused',
      correlationId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    });
    expect(warn).toHaveBeenCalledWith('verity: protected build operation refused', {
      operation: 'health',
      reason: diagnostic.reason,
      correlationId: diagnostic.correlationId,
    });
    expect(response.body + JSON.stringify(warn.mock.calls)).not.toMatch(/SECRET|\/private/u);
  } finally {
    warn.mockRestore();
  }
});

it('carries a correlated startup refusal through host control and confirms release after containment', async () => {
  const { createProtectedBuildClient } = await import('./project-egress-build-client.js');
  const { superviseProtectedBuild } = await import('./project-egress-build-worker.js');
  const { ProtectedBuildFailure } = await import('./project-egress-build-error.js');
  const { host } = fixture();
  const root = await directory();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const remove = vi.fn(async () => {});
  const buildRequest = {
    projectId: 'project-a',
    attemptId: '11111111-1111-4111-8111-111111111111',
    snapshot: 'attempt-a/verity-build-a',
    image: `verity-devc-repo:${'a'.repeat(12)}`,
    noCache: false,
  };
  try {
    const builds = new ProtectedBuildHost(
      {
        ready: async () => true,
        prepare: async () => {
          throw new ProtectedBuildFailure('files_prepare_failed', {
            cause: new Error('SECRET /private/path'),
          });
        },
        renew: async () => {},
        start: async () => {},
        status: async () => 'failed',
        deny: async () => {},
        stop: async () => {},
        ended: async () => true,
        remove,
      },
      async () => {},
    );
    servers.push(
      await listenProjectEgressHost({
        directory: root,
        token: 'a'.repeat(64),
        controller: host,
        builds,
      }),
    );
    const client = createProtectedBuildClient({
      socketPath: join(root, 'control.sock'),
      token: () => 'a'.repeat(64),
    });
    const result = await superviseProtectedBuild(buildRequest, client);
    expect(result).toMatchObject({
      success: false,
      failure: {
        reason: 'files_prepare_failed',
        correlationId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      },
    });
    expect(remove).toHaveBeenCalledExactlyOnceWith(buildRequest);
    expect(warn).toHaveBeenCalledWith('verity: protected build operation refused', {
      operation: 'begin',
      ...result.failure,
    });
    expect(JSON.stringify(result) + JSON.stringify(warn.mock.calls)).not.toMatch(
      /SECRET|\/private/u,
    );
  } finally {
    warn.mockRestore();
  }
});
