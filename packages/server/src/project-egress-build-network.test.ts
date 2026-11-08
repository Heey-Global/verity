import { describe, expect, it } from 'vitest';
import {
  ProtectedBuildNetworks,
  type ProtectedBuildNetworkIO,
} from './project-egress-build-network.js';
const image = `ghcr.io/example/server@sha256:${'a'.repeat(64)}`;
function fixture() {
  const calls: string[][] = [];
  let networkName = '';
  let bridge = '';
  let removed = false;
  let networkRemoved = false;
  let failRemoval = false;
  let foreign = false;
  let replaced = false;
  let denyFails = false;
  let mount = false;
  let stopped = false;
  const networkId = '1'.repeat(64),
    containerId = '2'.repeat(64);
  const io: ProtectedBuildNetworkIO = {
    imageRef: image,
    async checkpoint(value) {
      calls.push([value.pending ? 'intent' : 'checkpoint']);
    },
    async ensureBootstrap() {
      calls.push(['bootstrap']);
    },
    async assertBridgeFree(value) {
      calls.push(['bridge-free', value]);
    },
    async deny() {
      calls.push(['deny']);
      if (denyFails) throw new Error('deny failed');
    },
    async removeDeny() {
      calls.push(['remove-deny']);
    },
    async readNamespace() {
      return replaced ? 'net:[4321]' : 'net:[1234]';
    },
    async docker(args) {
      calls.push([...args]);
      if (args[0] === 'network' && args[1] === 'ls')
        return args.includes('--filter') && !networkRemoved ? networkId : '';
      if (args[0] === 'container' && args[1] === 'ls') return removed ? '' : containerId;
      if (args[0] === 'network' && args[1] === 'rm') {
        if (failRemoval) {
          failRemoval = false;
          throw new Error('removal reply lost');
        }
        networkRemoved = true;
      }
      if (args[0] === 'network' && args[1] === 'create') {
        networkName = args.at(-1)!;
        bridge = args[args.indexOf('--opt') + 1]!.split('=')[1]!;
        return networkId;
      }
      if (args[0] === 'network' && args[1] === 'inspect')
        return JSON.stringify([
          {
            Id: networkId,
            Name: networkName,
            Driver: 'bridge',
            EnableIPv6: true,
            Options: { 'com.docker.network.bridge.name': bridge },
            Containers: foreign ? { ['9'.repeat(64)]: {} } : removed ? {} : {},
          },
        ]);
      if (args[0] === 'container' && args[1] === 'create') return containerId;
      if (args[0] === 'container' && args[1] === 'inspect' && removed)
        throw new Error('No such container');
      if (args[0] === 'container' && args[1] === 'inspect')
        return JSON.stringify([
          {
            Id: containerId,
            Config: {
              Image: image,
              Entrypoint: ['/nodejs/bin/node'],
              Cmd: ['-e', 'setInterval(() => {}, 2147483647)'],
              User: '65534:65534',
              WorkingDir: '/',
            },
            HostConfig: {
              Runtime: 'runc',
              CgroupParent: 'verity-buildkit.slice',
              NetworkMode: networkId,
              Privileged: false,
              ReadonlyRootfs: true,
              CapAdd: null,
              CapDrop: ['ALL'],
              SecurityOpt: ['no-new-privileges'],
              RestartPolicy: { Name: 'no' },
              PidMode: '',
              IpcMode: 'private',
              Binds: null,
              Devices: null,
              PortBindings: null,
            },
            Mounts: mount ? [{}] : [],
            State: { Running: !stopped, Pid: stopped ? 0 : 77 },
            NetworkSettings: {
              SandboxKey: '/var/run/docker/netns/abc',
              Networks: {
                [networkName]: {
                  NetworkID: networkId,
                  EndpointID: '3'.repeat(64),
                  IPAddress: '10.10.0.2',
                  GlobalIPv6Address: 'fd00::2',
                  MacAddress: '02:00:00:00:00:03',
                },
              },
            },
          },
        ]);
      if (args[0] === 'container' && args[1] === 'rm') removed = true;
      return '';
    },
  };
  return {
    io,
    calls,
    failRemoval() {
      failRemoval = true;
    },
    failDeny() {
      denyFails = true;
    },
    foreign() {
      foreign = true;
    },
    replace() {
      replaced = true;
    },
    stop() {
      stopped = true;
    },
    mount() {
      mount = true;
    },
  };
}
describe('protected build Docker namespace anchor', () => {
  it('establishes bootstrap denial before network creation and denies before anchor start', async () => {
    const f = fixture();
    const networks = new ProtectedBuildNetworks(f.io);
    const binding = await networks.create('project-a', 'attempt-a');
    expect(f.calls[0]).toEqual(['bootstrap']);
    expect(f.calls.findIndex((call) => call[0] === 'deny')).toBeLessThan(
      f.calls.findIndex((call) => call[0] === 'container' && call[1] === 'start'),
    );
    expect(binding.binding.generation).toBe('attempt-a');
    expect(binding.containerId).toBe('2'.repeat(64));
    const create = f.calls.find((call) => call[0] === 'container' && call[1] === 'create')!;
    expect(create).toContain('--read-only');
    expect(create.slice(create.indexOf('--cap-drop'), create.indexOf('--cap-drop') + 2)).toEqual([
      '--cap-drop',
      'ALL',
    ]);
    expect(create.slice(create.indexOf('--runtime'), create.indexOf('--runtime') + 2)).toEqual([
      '--runtime',
      'runc',
    ]);
    expect(create).toContain('--pull=never');
    expect(create.slice(-4)).toEqual([
      '/nodejs/bin/node',
      image,
      '-e',
      'setInterval(() => {}, 2147483647)',
    ]);
    expect(
      create.some((arg) => ['--volume', '--mount', '--privileged', '--cap-add'].includes(arg)),
    ).toBe(false);
    expect(await networks.inspect(binding)).toEqual(binding);
    await networks.remove(binding, async () => true);
    expect(f.calls.at(-1)).toEqual(['remove-deny']);
  });
  it('never starts an anchor if denial fails', async () => {
    const f = fixture();
    f.failDeny();
    await expect(new ProtectedBuildNetworks(f.io).create('project-a', 'attempt-a')).rejects.toThrow(
      'deny failed',
    );
    expect(f.calls.some((call) => call[0] === 'container')).toBe(false);
  });
  it('rejects namespace replacement with otherwise identical Docker metadata', async () => {
    const f = fixture();
    const networks = new ProtectedBuildNetworks(f.io);
    const binding = await networks.create('project-a', 'attempt-a');
    f.replace();
    await expect(networks.inspect(binding)).rejects.toThrow('replaced');
  });
  it('rejects an anchor with any workload mount', async () => {
    const f = fixture();
    f.mount();
    await expect(
      new ProtectedBuildNetworks(f.io).create('project-a', 'attempt-a'),
    ).rejects.toThrow();
  });
  it('rejects a foreign container attached to the dedicated network', async () => {
    const f = fixture();
    f.foreign();
    await expect(new ProtectedBuildNetworks(f.io).create('project-a', 'attempt-a')).rejects.toThrow(
      'attachment mismatch',
    );
  });
  it('retains anchor and denial when host workload termination is uncertain', async () => {
    const f = fixture();
    const networks = new ProtectedBuildNetworks(f.io);
    const binding = await networks.create('project-a', 'attempt-a');
    await expect(networks.remove(binding, async () => false)).rejects.toThrow(
      'termination is unconfirmed',
    );
    expect(
      f.calls.some((call) => call[1] === 'stop' || call[1] === 'rm' || call[0] === 'remove-deny'),
    ).toBe(false);
  });
  it.each(['../project', 'a;reboot', '', 'a'.repeat(129)])(
    'rejects unsafe identity %s before host commands',
    async (value) => {
      const f = fixture();
      await expect(new ProtectedBuildNetworks(f.io).create(value, 'attempt-a')).rejects.toThrow(
        'identity',
      );
      expect(f.calls).toEqual([]);
    },
  );
  it('refuses mutable images', () => {
    const f = fixture();
    expect(
      () => new ProtectedBuildNetworks({ ...f.io, imageRef: 'example/server:latest' }),
    ).toThrow('pinned');
  });
});

it('persists unpredictable network creation intent before Docker can create a bridge', async () => {
  const f = fixture();
  await new ProtectedBuildNetworks(f.io).create('project-a', 'attempt-a');
  const creation = f.calls.findIndex((c) => c[0] === 'network' && c[1] === 'create');
  const intent = f.calls.findIndex((c) => c[0] === 'intent');
  expect(intent).toBeGreaterThanOrEqual(0);
  expect(intent).toBeLessThan(creation);
  const args = f.calls[creation]!;
  expect(args[args.indexOf('--label') + 1]).toMatch(/^io\.verity\.build-intent=[a-f0-9]{64}$/u);
});

it('removes owned stopped anchors after reboot without requiring the old namespace', async () => {
  const f = fixture();
  const network = new ProtectedBuildNetworks(f.io);
  const anchor = await network.create('project-a', 'attempt-a');
  f.stop();
  f.replace();
  await network.remove(anchor, async () => true);
  expect(f.calls.at(-1)).toEqual(['remove-deny']);
});

it('resumes cleanup after removing the anchor and failing network removal', async () => {
  const f = fixture();
  const networks = new ProtectedBuildNetworks(f.io);
  const anchor = await networks.create('project-a', 'attempt-a');
  f.failRemoval();
  await expect(networks.remove(anchor, async () => true)).rejects.toThrow('reply lost');
  expect(f.calls.some((call) => call[0] === 'remove-deny')).toBe(false);
  await networks.remove(anchor, async () => true);
  await networks.remove(anchor, async () => true);
  expect(f.calls.filter((call) => call[0] === 'container' && call[1] === 'rm')).toHaveLength(1);
  expect(f.calls.at(-1)).toEqual(['remove-deny']);
});

it('retains denial on an inventory query failure during cleanup', async () => {
  const f = fixture();
  const networks = new ProtectedBuildNetworks(f.io);
  const anchor = await networks.create('project-a', 'attempt-a');
  const docker = f.io.docker.bind(f.io);
  f.io.docker = async (args) => {
    if (args[1] === 'ls') throw new Error('daemon unreachable');
    return docker(args);
  };
  await expect(networks.remove(anchor, async () => true)).rejects.toThrow('daemon unreachable');
  expect(f.calls.some((call) => call[0] === 'remove-deny')).toBe(false);
});
it('rechecks foreign network attachments after partial cleanup', async () => {
  const f = fixture();
  const networks = new ProtectedBuildNetworks(f.io);
  const anchor = await networks.create('project-a', 'attempt-a');
  f.failRemoval();
  await expect(networks.remove(anchor, async () => true)).rejects.toThrow('reply lost');
  f.foreign();
  await expect(networks.remove(anchor, async () => true)).rejects.toThrow('attachment mismatch');
  expect(f.calls.some((call) => call[0] === 'remove-deny')).toBe(false);
});
