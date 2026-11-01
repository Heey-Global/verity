import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { projectSocketBindingName } from './project-relay-identity.js';
import type { ProjectEgressNetworkBinding } from './project-egress-host.js';

const subpath = z.string().regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u);
/** Loaded only by the host service, never from a start request or container label. */
export const egressRelayPolicy = z.strictObject({
  image: z.string().regex(/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/u),
  dataVolume: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u),
  socketOwnerUid: z.number().int().nonnegative(),
  relayGid: z.number().int().positive(),
  brokerSubpath: subpath,
  claudeSubpath: subpath,
  codexSubpath: subpath.optional(),
  /** Explicit experimental host selection; legacy fixtures do not claim deadlines. */
  packetEnforcement: z.boolean().optional(),
});
export type EgressRelayPolicy = z.infer<typeof egressRelayPolicy>;
const mount = z.object({
  Type: z.literal('volume'),
  Source: z.string(),
  Target: z.string(),
  ReadOnly: z.literal(true),
  VolumeOptions: z.object({ Subpath: z.string(), NoCopy: z.boolean().optional() }),
});
const relay = z
  .array(
    z.object({
      Image: z.string(),
      Config: z.object({
        Healthcheck: z.null().optional(),
        Image: z.string(),
        User: z.string(),
        Entrypoint: z.array(z.string()),
        Cmd: z.array(z.string()).nullable(),
        Env: z.array(z.string()),
      }),
      HostConfig: z.object({
        ReadonlyRootfs: z.literal(true),
        PublishAllPorts: z.literal(false),
        PidMode: z.literal(''),
        UTSMode: z.literal(''),
        IpcMode: z.literal('private'),
        CgroupnsMode: z.literal('private'),
        SecurityOpt: z.array(z.string()),
        Sysctls: z.record(z.string(), z.string()),
        UsernsMode: z.literal(''),
        Binds: z.array(z.string()).nullable(),
        VolumesFrom: z.array(z.string()).nullable(),
        Devices: z.array(z.unknown()).nullable(),
        DeviceRequests: z.array(z.unknown()).nullable(),
        GroupAdd: z.array(z.string()).nullable(),
        Mounts: z.array(mount),
        PortBindings: z.record(z.string(), z.unknown()).nullable(),
        Tmpfs: z.record(z.string(), z.string()),
      }),
      Mounts: z.array(
        z.object({
          Type: z.literal('volume'),
          Name: z.string(),
          Source: z.string(),
          Destination: z.string(),
          RW: z.literal(false),
          Driver: z.literal('local'),
        }),
      ),
    }),
  )
  .length(1);

export function relaySocketMounts(binding: ProjectEgressNetworkBinding, policy: EgressRelayPolicy) {
  const generation = projectSocketBindingName({
    projectId: binding.projectId,
    containerGeneration: binding.generation,
  });
  return [
    { kind: 'broker', root: policy.brokerSubpath },
    { kind: 'claude', root: policy.claudeSubpath },
    ...(policy.codexSubpath === undefined ? [] : [{ kind: 'codex', root: policy.codexSubpath }]),
  ].map(({ kind, root }) => ({
    subpath: `${root}/${generation}`,
    target: `/run/verity-relay/${kind}`,
    socket: `${kind}.sock`,
  }));
}

/** No arbitrary host paths, implicit mounts, namespace sharing or command overrides. */
export function verifyEgressRelay(
  binding: ProjectEgressNetworkBinding,
  policyInput: EgressRelayPolicy,
  reply: unknown,
  imageReply: unknown,
  volumeReply: unknown,
): { directory: string; socket: string }[] {
  const policy = egressRelayPolicy.parse(policyInput);
  const value = relay.parse(reply)[0]!;
  const image = z
    .array(z.object({ Id: z.string(), Config: z.object({ Env: z.array(z.string()) }) }))
    .length(1)
    .parse(imageReply)[0]!;
  const volume = z
    .array(
      z.object({
        Name: z.string(),
        Driver: z.literal('local'),
        Mountpoint: z.string(),
        Options: z.record(z.string(), z.string()).nullable(),
      }),
    )
    .length(1)
    .parse(volumeReply)[0]!;
  const config = value.HostConfig;
  const expected = relaySocketMounts(binding, policy);
  const environment = [...image.Config.Env, 'NODE_OPTIONS=--max-old-space-size=96'];
  if (
    value.Image !== image.Id ||
    value.Config.Image !== policy.image ||
    value.Config.User !== `65532:${policy.relayGid}` ||
    JSON.stringify(value.Config.Entrypoint) !==
      JSON.stringify(['/nodejs/bin/node', '/app/dist/main.js']) ||
    (value.Config.Cmd?.length ?? 0) !== 0 ||
    config.SecurityOpt.length !== 1 ||
    !['no-new-privileges', 'no-new-privileges=true'].includes(config.SecurityOpt[0]!) ||
    JSON.stringify(config.Sysctls) !==
      JSON.stringify({ 'net.ipv4.ip_unprivileged_port_start': '53' }) ||
    value.Config.Env.some((entry) => !environment.includes(entry)) ||
    new Set(value.Config.Env.map((entry) => entry.split('=')[0])).size !==
      value.Config.Env.length ||
    volume.Name !== policy.dataVolume ||
    !volume.Mountpoint.startsWith('/') ||
    Object.keys(volume.Options ?? {}).length !== 0 ||
    (config.Binds?.length ?? 0) !== 0 ||
    (config.VolumesFrom?.length ?? 0) !== 0 ||
    (config.Devices?.length ?? 0) !== 0 ||
    (config.DeviceRequests?.length ?? 0) !== 0 ||
    (config.GroupAdd?.length ?? 0) !== 0 ||
    Object.keys(config.PortBindings ?? {}).length !== 0 ||
    JSON.stringify(config.Tmpfs) !== JSON.stringify({ '/tmp': 'rw,noexec,nosuid,nodev,size=1m' }) ||
    config.Mounts.length !== expected.length ||
    value.Mounts.length !== expected.length
  ) {
    throw new Error('Untrusted relay image, execution configuration or mounts');
  }
  return expected.map((item) => {
    const declared = config.Mounts.filter((m) => m.Target === item.target);
    const actual = value.Mounts.filter((m) => m.Destination === item.target);
    const directory = join(volume.Mountpoint, item.subpath);
    if (
      declared.length !== 1 ||
      actual.length !== 1 ||
      declared[0]!.Source !== policy.dataVolume ||
      declared[0]!.VolumeOptions.Subpath !== item.subpath ||
      actual[0]!.Name !== policy.dataVolume ||
      ![volume.Mountpoint, directory].includes(actual[0]!.Source)
    ) {
      throw new Error('Relay socket mount is not bound to its generation');
    }
    return { directory, socket: item.socket };
  });
}

export async function inspectEgressRelay(
  binding: ProjectEgressNetworkBinding,
  id: string,
  policyInput: EgressRelayPolicy,
  docker: (...args: string[]) => Promise<string>,
  restoring = false,
): Promise<void> {
  const policy = egressRelayPolicy.parse(policyInput);
  const container: unknown = JSON.parse(await docker('container', 'inspect', id));
  const stopped = z
    .array(z.object({ State: z.object({ Running: z.literal(false) }) }))
    .length(1)
    .safeParse(container).success;
  const paths = verifyEgressRelay(
    binding,
    policy,
    container,
    JSON.parse(await docker('image', 'inspect', policy.image)),
    JSON.parse(await docker('volume', 'inspect', policy.dataVolume)),
  );
  // Shared ancestors belong to the same current inspection, not a later refresh.
  const ancestors = new Set<string>();
  for (const { directory, socket } of paths) {
    // Every ancestor is checked: a safe leaf below a writable/symlinked root is not a binding.
    for (let path = resolve(directory); !ancestors.has(path); path = dirname(path)) {
      const stat = await lstat(path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await realpath(path)) !== path ||
        ![0, policy.socketOwnerUid].includes(stat.uid) ||
        (stat.mode & 0o022) !== 0
      ) {
        throw new Error('Untrusted relay socket ancestor');
      }
      ancestors.add(path);
      if (path === '/') break;
    }
    const dir = await lstat(directory);
    // Docker boot restores stopped containers before the Server can recreate its
    // listeners. Only that deny-only restoration may accept an empty directory;
    // every start/admission and every running relay still requires the socket.
    const file = await lstat(join(directory, socket)).catch((error: unknown) => {
      if (restoring && stopped && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return undefined;
      throw error;
    });
    if (
      dir.uid !== policy.socketOwnerUid ||
      dir.gid !== policy.relayGid ||
      (dir.mode & 0o777) !== 0o710 ||
      (file !== undefined &&
        (!file.isSocket() ||
          file.isSymbolicLink() ||
          file.uid !== policy.socketOwnerUid ||
          file.gid !== policy.relayGid ||
          (file.mode & 0o777) !== 0o660)) ||
      JSON.stringify(await readdir(directory)) !==
        JSON.stringify(file === undefined ? [] : [socket])
    ) {
      throw new Error('Untrusted relay socket inode or directory contents');
    }
  }
}
