import { inspectEgressRelay, type EgressRelayPolicy } from './project-egress-relay-policy.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  projectEgressHostState,
  type ProjectEgressNetworkBinding,
  type ProjectEgressHostState,
} from './project-egress-host.js';
const exec = promisify(execFile);
const dockerOptions = {
  timeout: 5000,
  maxBuffer: 2 * 1024 * 1024,
  env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DOCKER_HOST: 'unix:///var/run/docker.sock' },
};
export async function projectEgressHostDocker(...args: string[]): Promise<string> {
  return (await exec('/usr/bin/docker', args, dockerOptions)).stdout;
}
const network = z
  .array(
    z.object({
      Id: z.string(),
      Name: z.string(),
      Driver: z.literal('bridge'),
      EnableIPv6: z.literal(true),
      Options: z.record(z.string(), z.string()),
      Containers: z.record(z.string(), z.unknown()).default({}),
    }),
  )
  .length(1);
const container = z
  .array(
    z.object({
      Id: z.string(),
      HostConfig: z.object({
        NetworkMode: z.string(),
        Runtime: z.string(),
        Privileged: z.literal(false),
        RestartPolicy: z.object({ Name: z.literal('no') }),
        CapAdd: z.array(z.string()).nullable(),
        CapDrop: z.array(z.string()),
        SecurityOpt: z.array(z.string()),
      }),
      NetworkSettings: z.object({
        Networks: z.record(z.string(), z.object({ NetworkID: z.string() })),
      }),
    }),
  )
  .length(1);
/** Inspection input must be an actual local daemon reply, not a request payload. */
export function verifyEgressHostNetwork(
  binding: ProjectEgressNetworkBinding,
  reply: unknown,
  allowed: readonly string[],
): void {
  const value = network.parse(reply)[0]!;
  if (
    value.Id !== binding.networkId ||
    value.Name !== binding.networkName ||
    value.Options['com.docker.network.bridge.name'] !== binding.bridge ||
    Object.keys(value.Containers).some((id) => !allowed.includes(id))
  )
    throw new Error('Host network attachment mismatch');
}
export function verifyEgressHostContainer(
  binding: ProjectEgressNetworkBinding,
  id: string,
  reply: unknown,
  role: 'sandbox' | 'relay' = 'sandbox',
): void {
  const value = container.parse(reply)[0]!;
  const endpoints = Object.entries(value.NetworkSettings.Networks);
  // Fixed Runner identity-switching capabilities, inside isolated gVisor only.
  // Never accept a caller-supplied capability list or networking/admin capabilities.
  const runnerCaps = ['CHOWN', 'KILL', 'SETGID', 'SETPCAP', 'SETUID'];
  const caps = (value.HostConfig.CapAdd ?? []).map((cap) => cap.replace(/^CAP_/u, '')).sort();
  const permittedCaps =
    caps.length === 0 ||
    (role === 'sandbox' && JSON.stringify(caps) === JSON.stringify(runnerCaps));
  if (
    value.HostConfig.Runtime !== (role === 'relay' ? 'runsc-relay' : 'runsc-project') ||
    value.Id !== id ||
    ![binding.networkId, binding.networkName].includes(value.HostConfig.NetworkMode) ||
    !permittedCaps ||
    value.HostConfig.CapDrop.length !== 1 ||
    value.HostConfig.CapDrop[0] !== 'ALL' ||
    !value.HostConfig.SecurityOpt.some(
      (option) => option === 'no-new-privileges' || option === 'no-new-privileges=true',
    ) ||
    endpoints.length !== 1 ||
    endpoints[0]![0] !== binding.networkName ||
    (endpoints[0]![1].NetworkID !== '' && endpoints[0]![1].NetworkID !== binding.networkId)
  )
    throw new Error('Host container attachment mismatch');
}
export async function inspectEgressHostNetwork(
  binding: ProjectEgressNetworkBinding,
  allowed: readonly string[],
  docker = projectEgressHostDocker,
): Promise<void> {
  verifyEgressHostNetwork(
    binding,
    JSON.parse(await docker('network', 'inspect', binding.networkId)),
    allowed,
  );
  const device = await lstat(`/sys/class/net/${binding.bridge}`);
  // sysfs network entries are symlinks, but their parent is kernel-owned.
  if (!device.isSymbolicLink()) throw new Error('Missing host bridge');
}
/** A runtime name alone does not prove Docker uses isolated gVisor networking. */
export function verifyEgressHostRuntime(
  reply: unknown,
  role: 'sandbox' | 'relay' = 'sandbox',
): void {
  const name = role === 'relay' ? 'runsc-relay' : 'runsc-project';
  const runtime = z
    .object({
      [name]: z.object({
        path: z.string().regex(/^\/opt\/verity\/runsc\/release-[0-9.]+\/runsc$/u),
        runtimeArgs: z.array(z.string()),
      }),
    })
    .parse(reply)[name]!;
  const expected = [
    role === 'relay' ? '--host-uds=open' : '--host-uds=create',
    '--network=sandbox',
    '--platform=systrap',
  ];
  if (JSON.stringify([...runtime.runtimeArgs].sort()) !== JSON.stringify(expected))
    throw new Error('Unsupported host runtime network profile');
}

export async function inspectEgressHostContainer(
  binding: ProjectEgressNetworkBinding,
  id: string,
  role: 'sandbox' | 'relay',
  relayPolicy?: EgressRelayPolicy,
  restoring = false,
  docker = projectEgressHostDocker,
): Promise<void> {
  verifyEgressHostRuntime(JSON.parse(await docker('info', '--format', '{{json .Runtimes}}')), role);
  if (role === 'relay') {
    if (!relayPolicy) throw new Error('Relay host policy is not configured');
    await inspectEgressRelay(binding, id, relayPolicy, docker, restoring);
  }
  verifyEgressHostContainer(
    binding,
    id,
    JSON.parse(await docker('container', 'inspect', id)),
    role,
  );
}

/** The service manager holds an exclusive flock for this directory for its lifetime. */
export async function openProjectEgressHostStore(directory: string): Promise<{
  load(): Promise<ProjectEgressHostState>;
  save(state: ProjectEgressHostState): Promise<void>;
}> {
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Host state directory must be private and owned by the service');
  const path = join(directory, 'registry.json');
  return {
    async load() {
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
        throw error;
      }
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.uid !== stat.uid ||
          (info.mode & 0o077) !== 0 ||
          info.size > 16 * 1024 * 1024
        )
          throw new Error('Invalid host registry file');
        return projectEgressHostState.parse(JSON.parse(await file.readFile('utf8')));
      } finally {
        await file.close();
      }
    },
    async save(state) {
      projectEgressHostState.parse(state);
      const temporary = join(directory, `.registry-${randomUUID()}`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(state));
        await file.sync();
        await file.close();
        await rename(temporary, path);
        const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      } finally {
        await file.close();
        await unlink(temporary).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
    },
  };
}

/** Daemon facts from the already role-validated registered pair, never labels. */
export async function inspectEgressHostDirect(
  binding: import('./project-egress-host.js').ProjectEgressNetworkBinding,
  ids: { sandbox: string; relay: string },
): Promise<{
  corridor: import('./project-egress-transport.js').EgressDirectCorridor;
  relayEndpointId: string;
}> {
  const replies = [];
  const endpointSchema = z.object({
    NetworkID: z.string(),
    EndpointID: z.string().regex(/^[a-f0-9]{64}$/u),
    IPAddress: z.ipv4(),
    GlobalIPv6Address: z.ipv6(),
    Gateway: z.ipv4(),
    IPv6Gateway: z.ipv6(),
  });
  for (const id of [ids.sandbox, ids.relay]) {
    const value = z
      .array(
        z.object({
          Id: z.literal(id),
          NetworkSettings: z.object({
            Networks: z.record(z.string(), endpointSchema),
          }),
        }),
      )
      .length(1)
      .parse(JSON.parse(await projectEgressHostDocker('inspect', id)))[0]!;
    const networks = Object.entries(value.NetworkSettings.Networks);
    if (
      networks.length !== 1 ||
      networks[0]![0] !== binding.networkName ||
      networks[0]![1].NetworkID !== binding.networkId
    )
      throw new Error('Host direct network mismatch');
    replies.push(networks[0]![1]);
  }
  const sandbox = replies[0]!;
  return {
    corridor: {
      binding: {
        projectId: binding.projectId,
        generation: binding.generation,
        containerId: ids.sandbox,
        networkId: binding.networkId,
        endpointId: sandbox.EndpointID,
        bridge: binding.bridge,
        ipv4: sandbox.IPAddress,
        ipv6: sandbox.GlobalIPv6Address,
      },
      gateway4: sandbox.Gateway,
      gateway6: sandbox.IPv6Gateway,
    },
    relayEndpointId: replies[1]!.EndpointID,
  };
}
