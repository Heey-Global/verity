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
        Privileged: z.literal(false),
        RestartPolicy: z.object({ Name: z.literal('no') }),
        CapAdd: z.array(z.string()).nullable(),
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
): void {
  const value = container.parse(reply)[0]!;
  const endpoints = Object.entries(value.NetworkSettings.Networks);
  if (
    value.Id !== id ||
    ![binding.networkId, binding.networkName].includes(value.HostConfig.NetworkMode) ||
    (value.HostConfig.CapAdd?.length ?? 0) !== 0 ||
    endpoints.length !== 1 ||
    endpoints[0]![0] !== binding.networkName ||
    (endpoints[0]![1].NetworkID !== '' && endpoints[0]![1].NetworkID !== binding.networkId)
  )
    throw new Error('Host container attachment mismatch');
}
export async function inspectEgressHostNetwork(
  binding: ProjectEgressNetworkBinding,
  allowed: readonly string[],
): Promise<void> {
  verifyEgressHostNetwork(
    binding,
    JSON.parse(await projectEgressHostDocker('network', 'inspect', binding.networkId)),
    allowed,
  );
  const device = await lstat(`/sys/class/net/${binding.bridge}`);
  // sysfs network entries are symlinks, but their parent is kernel-owned.
  if (!device.isSymbolicLink()) throw new Error('Missing host bridge');
}
export async function inspectEgressHostContainer(
  binding: ProjectEgressNetworkBinding,
  id: string,
): Promise<void> {
  verifyEgressHostContainer(
    binding,
    id,
    JSON.parse(await projectEgressHostDocker('container', 'inspect', id)),
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
