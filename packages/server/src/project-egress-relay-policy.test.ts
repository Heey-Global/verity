import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { chmod, chown, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  inspectEgressRelay,
  relaySocketMounts,
  verifyEgressRelay,
} from './project-egress-relay-policy.js';
import {
  verifyEgressHostRuntime,
  verifyEgressHostContainer,
} from './project-egress-host-runtime.js';
const binding = {
  projectId: 'a',
  generation: 'g1',
  networkId: 'a'.repeat(64),
  networkName: 'a-g1',
  bridge: 'vep0123456789ab',
};
const policy = {
  image: `repo@sha256:${'a'.repeat(64)}`,
  dataVolume: 'data',
  socketOwnerUid: process.getuid!(),
  relayGid: process.getgid!() || 65532,
  brokerSubpath: 'b',
  claudeSubpath: 'c',
  codexSubpath: 'x',
};
const image = [{ Id: `sha256:${'b'.repeat(64)}`, Config: { Env: ['PATH=/usr/bin'] } }];
function fixture(root = '/var/lib/docker/volumes/data/_data') {
  const expected = relaySocketMounts(binding, policy);
  return {
    volume: [{ Name: 'data', Driver: 'local', Mountpoint: root, Options: null }],
    reply: [
      {
        Id: 'c'.repeat(64),
        Image: image[0]!.Id,
        Config: {
          Image: policy.image,
          User: `65532:${policy.relayGid}`,
          Entrypoint: ['/nodejs/bin/node', '/app/dist/main.js'],
          Cmd: null as string[] | null,
          Env: ['PATH=/usr/bin', 'NODE_OPTIONS=--max-old-space-size=96'],
        },
        HostConfig: {
          Runtime: 'runsc-relay',
          Privileged: false,
          RestartPolicy: { Name: 'no' },
          CapAdd: null as string[] | null,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges=true'],
          NetworkMode: binding.networkName,
          ReadonlyRootfs: true,
          PublishAllPorts: false,
          PidMode: '',
          UTSMode: '',
          IpcMode: 'private',
          CgroupnsMode: 'private',
          Sysctls: { 'net.ipv4.ip_unprivileged_port_start': '53' },
          UsernsMode: '',
          Binds: null as string[] | null,
          VolumesFrom: null,
          Devices: [] as unknown[] | null,
          DeviceRequests: null,
          GroupAdd: null,
          PortBindings: {},
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=1m' },
          Mounts: expected.map((m) => ({
            Type: 'volume',
            Source: 'data',
            Target: m.target,
            ReadOnly: true,
            VolumeOptions: { Subpath: m.subpath },
          })),
        },
        NetworkSettings: { Networks: { [binding.networkName]: { NetworkID: binding.networkId } } },
        Mounts: expected.map((m) => ({
          Type: 'volume',
          Name: 'data',
          Source: root,
          Destination: m.target,
          RW: false,
          Driver: 'local',
        })),
      },
    ],
  };
}
it('accepts exact host-owned relay configuration and rejects unsafe substitutions', () => {
  const check = (f: ReturnType<typeof fixture>) =>
    verifyEgressRelay(binding, policy, f.reply, image, f.volume);
  expect(check(fixture())).toHaveLength(3);
  const noDevices = fixture();
  noDevices.reply[0]!.HostConfig.Devices = null;
  expect(check(noDevices)).toHaveLength(3);
  noDevices.reply[0]!.HostConfig.Devices = [
    { PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' },
  ];
  expect(() => check(noDevices)).toThrow();
  const healthcheck = fixture();
  Object.assign(healthcheck.reply[0]!.Config, {
    Healthcheck: { Test: ['CMD', '/nodejs/bin/node', '-e', 'arbitrary()'] },
  });
  expect(() => check(healthcheck)).toThrow();
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.reply[0]!.HostConfig.PublishAllPorts = true;
    },
    (f) => {
      f.reply[0]!.HostConfig.SecurityOpt.push('seccomp=unconfined');
    },
    (f) => {
      f.reply[0]!.HostConfig.CgroupnsMode = 'host';
    },
    (f) => {
      f.reply[0]!.HostConfig.Sysctls['net.ipv4.ip_unprivileged_port_start'] = '0';
    },
    (f) => {
      f.reply[0]!.Config.Image = 'repo:latest';
    },
    (f) => {
      f.reply[0]!.Image = `sha256:${'d'.repeat(64)}`;
    },
    (f) => {
      f.reply[0]!.Config.User = '0:0';
    },
    (f) => {
      f.reply[0]!.Config.Entrypoint = ['/bin/sh'];
    },
    (f) => {
      f.reply[0]!.Config.Cmd = ['arbitrary'];
    },
    (f) => {
      f.reply[0]!.Config.Env.push('NODE_OPTIONS=--require=/tmp/evil.js');
    },
    (f) => {
      f.reply[0]!.HostConfig.ReadonlyRootfs = false;
    },
    (f) => {
      f.reply[0]!.HostConfig.IpcMode = 'host';
    },
    (f) => {
      f.reply[0]!.HostConfig.PidMode = 'container:other';
    },
    (f) => {
      f.reply[0]!.HostConfig.UTSMode = 'host';
    },
    (f) => {
      f.reply[0]!.HostConfig.UsernsMode = 'host';
    },
    (f) => {
      f.reply[0]!.HostConfig.Binds = ['/var/run/docker.sock:/host.sock'];
    },
    (f) => {
      f.reply[0]!.HostConfig.Mounts[0]!.VolumeOptions.Subpath = 'b/foreign-generation';
    },
    (f) => {
      f.reply[0]!.HostConfig.Mounts[0]!.Source = 'foreign-volume';
    },
    (f) => {
      f.reply[0]!.HostConfig.Mounts[0]!.ReadOnly = false;
    },
    (f) => {
      f.reply[0]!.Mounts[0]!.Source = '/foreign';
    },
    (f) => {
      f.reply[0]!.Mounts[0]!.RW = true;
    },
    (f) => {
      f.reply[0]!.Mounts.push({ ...f.reply[0]!.Mounts[0]!, Destination: '/extra' });
    },
    (f) => {
      f.reply[0]!.HostConfig.Mounts.push({
        ...f.reply[0]!.HostConfig.Mounts[0]!,
        Target: '/extra',
      });
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    expect(() => check(f)).toThrow();
  }
  expect(() =>
    verifyEgressRelay(
      { ...binding, generation: 'g2' },
      policy,
      fixture().reply,
      image,
      fixture().volume,
    ),
  ).toThrow();
});
it('binds actual runtime arguments and capabilities to the role', () => {
  const path = '/opt/verity/runsc/release-20260714.0/runsc';
  const runtimes = {
    'runsc-relay': {
      path,
      runtimeArgs: ['--platform=systrap', '--network=sandbox', '--host-uds=open'],
    },
  };
  expect(() => verifyEgressHostRuntime(runtimes, 'relay')).not.toThrow();
  expect(() => verifyEgressHostRuntime(runtimes, 'sandbox')).toThrow();
  for (const uds of ['all', 'create', 'none']) {
    expect(() =>
      verifyEgressHostRuntime(
        {
          'runsc-relay': {
            path,
            runtimeArgs: ['--platform=systrap', '--network=sandbox', `--host-uds=${uds}`],
          },
        },
        'relay',
      ),
    ).toThrow();
  }
  const f = fixture();
  expect(() => verifyEgressHostContainer(binding, f.reply[0]!.Id, f.reply, 'relay')).not.toThrow();
  expect(() => verifyEgressHostContainer(binding, f.reply[0]!.Id, f.reply, 'sandbox')).toThrow();
  f.reply[0]!.HostConfig.CapAdd = ['CHOWN', 'KILL', 'SETGID', 'SETPCAP', 'SETUID'];
  expect(() => verifyEgressHostContainer(binding, f.reply[0]!.Id, f.reply, 'relay')).toThrow();
});
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
it('checks actual socket ownership, contents and non-symlinked ancestors', async () => {
  // Keep AF_UNIX names short while avoiding the intentionally writable /tmp ancestor.
  const root = await mkdtemp(
    join(process.getuid!() === 0 ? '/root' : dirname(process.cwd()), 'eg-'),
  );
  roots.push(root);
  const f = fixture(root);
  const expected = relaySocketMounts(binding, policy);
  for (const item of expected) {
    const dir = join(root, item.subpath);
    await mkdir(dir, { recursive: true });
    await chown(dir, policy.socketOwnerUid, policy.relayGid);
    await chmod(dir, 0o710);
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(join(dir, item.socket), resolve));
    await chown(join(dir, item.socket), policy.socketOwnerUid, policy.relayGid);
    await chmod(join(dir, item.socket), 0o660);
  }
  const docker = async (kind: string) =>
    JSON.stringify(kind === 'container' ? f.reply : kind === 'image' ? image : f.volume);
  await expect(
    inspectEgressRelay(binding, f.reply[0]!.Id, policy, docker),
  ).resolves.toBeUndefined();
  const dir = join(root, expected[0]!.subpath);
  await writeFile(join(dir, 'extra'), 'unexpected');
  await expect(inspectEgressRelay(binding, f.reply[0]!.Id, policy, docker)).rejects.toThrow();
  await rm(join(dir, 'extra'));
  await chmod(dir, 0o777);
  await expect(inspectEgressRelay(binding, f.reply[0]!.Id, policy, docker)).rejects.toThrow();
  await chmod(dir, 0o710);
  const link = `${root}-link`;
  roots.push(link);
  await symlink(root, link);
  const linked = fixture(link);
  await expect(
    inspectEgressRelay(binding, f.reply[0]!.Id, policy, async (kind) =>
      JSON.stringify(
        kind === 'container' ? linked.reply : kind === 'image' ? image : linked.volume,
      ),
    ),
  ).rejects.toThrow();
});
