import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ProjectEgressNetworkBinding } from './project-egress-host.js';

const id = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = /^[a-zA-Z0-9_-]{1,128}$/u;
const endpoint = z.object({
  NetworkID: id,
  EndpointID: id,
  IPAddress: z.ipv4(),
  GlobalIPv6Address: z.ipv6(),
  MacAddress: z.string().regex(/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u),
});
export interface ProtectedBuildAnchor {
  binding: ProjectEgressNetworkBinding;
  attemptId: string;
  containerId: string;
  endpointId: string;
  ipv4: string;
  ipv6: string;
  mac: string;
  pid: number;
  namespacePath: string;
  namespaceIdentity: string;
}
export interface ProtectedBuildNetworkIO {
  /** A release-authorized immutable image, never a project image/reference. */
  imageRef: string;
  /** Persist each allocated object before the next host mutation. */
  checkpoint(value: {
    binding: ProjectEgressNetworkBinding;
    attemptId: string;
    containerId?: string;
    pending?: boolean;
  }): Promise<void>;
  docker(args: readonly string[]): Promise<string>;
  /** Inspect a host-owned namespace inode with stat/nsenter; never evaluate a shell path. */
  readNamespace(path: string): Promise<string>;
  /** Must establish durable default-deny for all reserved veb* bridges. */
  ensureBootstrap(): Promise<void>;
  /** Reject any existing Linux device with this reserved name before creation. */
  assertBridgeFree(bridge: string): Promise<void>;
  deny(binding: ProjectEgressNetworkBinding): Promise<void>;
  removeDeny(binding: ProjectEgressNetworkBinding): Promise<void>;
}
const networkSchema = z
  .array(
    z.object({
      Id: id,
      Name: z.string(),
      Driver: z.literal('bridge'),
      EnableIPv6: z.literal(true),
      Options: z.record(z.string(), z.string()),
      Containers: z.record(z.string(), z.object({})).default({}),
    }),
  )
  .length(1);
const containerSchema = z
  .array(
    z.object({
      Id: id,
      Config: z.object({
        Image: z.string(),
        Entrypoint: z.array(z.string()),
        Cmd: z.array(z.string()),
        User: z.literal('65534:65534'),
        WorkingDir: z.literal('/'),
      }),
      HostConfig: z.object({
        Runtime: z.literal('runc'),
        CgroupParent: z.literal('verity-buildkit.slice'),
        NetworkMode: z.string(),
        Privileged: z.literal(false),
        ReadonlyRootfs: z.literal(true),
        CapAdd: z.array(z.string()).nullable(),
        CapDrop: z.array(z.string()),
        SecurityOpt: z.array(z.string()),
        RestartPolicy: z.object({ Name: z.literal('no') }),
        PidMode: z.literal(''),
        IpcMode: z.literal('private'),
        Binds: z.array(z.string()).nullable(),
        Devices: z.array(z.unknown()).nullable(),
        PortBindings: z.record(z.string(), z.unknown()).nullable(),
      }),
      Mounts: z.array(z.unknown()).length(0),
      State: z.object({ Running: z.literal(true), Pid: z.number().int().positive() }),
      NetworkSettings: z.object({
        SandboxKey: z.string().regex(/^\/var\/run\/docker\/netns\/[a-zA-Z0-9_-]+$/u),
        Networks: z.record(z.string(), endpoint),
      }),
    }),
  )
  .length(1);
function names(projectId: string, attemptId: string) {
  if (!identity.test(projectId) || !identity.test(attemptId))
    throw new Error('Invalid protected build identity');
  const hash = createHash('sha256').update(`${projectId}\0${attemptId}`).digest('hex');
  return {
    networkName: `verity-build-${hash.slice(0, 32)}`,
    bridge: `veb${hash.slice(0, 12)}`,
    containerName: `verity-build-anchor-${hash.slice(0, 32)}`,
  };
}
function checkImage(ref: string): void {
  if (!/^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/u.test(ref))
    throw new Error('Protected builder requires a pinned trusted image');
}

/** The runc anchor contains only a fixed unprivileged Node timer. It grants the
 * trusted host supervisor a genuine Docker endpoint/netns identity; no build
 * command, workload mount, Docker socket or network capability enters it.
 * Host CLI/daemon execution inside this namespace is a separate fixed contract.
 * Calls must be serialized with host Docker lifecycle operations.
 */
export class ProtectedBuildNetworks {
  constructor(private readonly io: ProtectedBuildNetworkIO) {
    checkImage(io.imageRef);
  }
  private async inspectNetwork(binding: ProjectEgressNetworkBinding, allowed: readonly string[]) {
    const value = networkSchema.parse(
      JSON.parse(await this.io.docker(['network', 'inspect', binding.networkId])),
    )[0]!;
    if (
      value.Id !== binding.networkId ||
      value.Name !== binding.networkName ||
      value.Options['com.docker.network.bridge.name'] !== binding.bridge ||
      Object.keys(value.Containers).some((container) => !allowed.includes(container))
    )
      throw new Error('Protected build network attachment mismatch');
  }
  async create(projectId: string, attemptId: string): Promise<ProtectedBuildAnchor> {
    const named = names(projectId, attemptId);
    await this.io.ensureBootstrap();
    // List before creation: Docker can reuse an existing named network. Never
    // claim or remove a foreign object merely because its name matches ours.
    const listing = await this.io.docker(['network', 'ls', '--format', '{{json .}}']);
    const existing = z.array(z.object({ Name: z.string() })).parse(
      listing.trim()
        ? listing
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as unknown)
        : [],
    );
    if (existing.some((value) => value.Name === named.networkName))
      throw new Error('Protected build network name collision');
    await this.io.assertBridgeFree(named.bridge);
    const intent: ProjectEgressNetworkBinding = {
      projectId,
      generation: attemptId,
      networkId: randomBytes(32).toString('hex'),
      networkName: named.networkName,
      bridge: named.bridge,
    };
    await this.io.checkpoint({ binding: intent, attemptId, pending: true });
    const networkId = id.parse(
      (
        await this.io.docker([
          'network',
          'create',
          '--driver',
          'bridge',
          '--ipv6',
          '--label',
          `io.verity.build-intent=${intent.networkId}`,
          '--opt',
          `com.docker.network.bridge.name=${named.bridge}`,
          named.networkName,
        ])
      ).trim(),
    );
    const binding: ProjectEgressNetworkBinding = {
      projectId,
      generation: attemptId,
      networkId,
      networkName: named.networkName,
      bridge: named.bridge,
    };
    await this.io.checkpoint({ binding, attemptId });
    await this.inspectNetwork(binding, []);
    await this.io.deny(binding);
    // All lifecycle inputs are fixed. In particular a repository cannot provide
    // an image, command, mount, capability or host namespace selector.
    const containerId = id.parse(
      (
        await this.io.docker([
          'container',
          'create',
          '--name',
          named.containerName,
          '--runtime',
          'runc',
          '--cgroup-parent=verity-buildkit.slice',
          '--network',
          networkId,
          '--pull=never',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--restart',
          'no',
          '--user',
          '65534:65534',
          '--workdir',
          '/',
          '--ipc',
          'private',
          '--entrypoint',
          '/nodejs/bin/node',
          this.io.imageRef,
          '-e',
          'setInterval(() => {}, 2147483647)',
        ])
      ).trim(),
    );
    await this.io.checkpoint({ binding, attemptId, containerId });
    await this.io.docker(['container', 'start', containerId]);
    return await this.inspectAnchor(binding, attemptId, containerId);
  }
  private async inspectAnchor(
    binding: ProjectEgressNetworkBinding,
    attemptId: string,
    containerId: string,
  ): Promise<ProtectedBuildAnchor> {
    const named = names(binding.projectId, attemptId);
    id.parse(containerId);
    id.parse(binding.networkId);
    if (
      binding.generation !== attemptId ||
      binding.bridge !== named.bridge ||
      binding.networkName !== named.networkName
    )
      throw new Error('Protected build identity mismatch');
    await this.inspectNetwork(binding, [containerId]);
    const value = containerSchema.parse(
      JSON.parse(await this.io.docker(['container', 'inspect', containerId])),
    )[0]!;
    const config = value.HostConfig;
    const entries = Object.entries(value.NetworkSettings.Networks);
    const attached = entries[0]?.[1];
    if (
      value.Id !== containerId ||
      value.Config.Image !== this.io.imageRef ||
      value.Config.Entrypoint.join('\0') !== '/nodejs/bin/node' ||
      value.Config.Cmd.join('\0') !== '-e\0setInterval(() => {}, 2147483647)' ||
      config.NetworkMode !== binding.networkId ||
      (config.CapAdd?.length ?? 0) !== 0 ||
      config.CapDrop.join('\0') !== 'ALL' ||
      !['no-new-privileges', 'no-new-privileges=true'].includes(config.SecurityOpt.join('\0')) ||
      (config.Binds?.length ?? 0) !== 0 ||
      (config.Devices?.length ?? 0) !== 0 ||
      Object.keys(config.PortBindings ?? {}).length !== 0 ||
      entries.length !== 1 ||
      entries[0]![0] !== binding.networkName ||
      attached?.NetworkID !== binding.networkId
    )
      throw new Error('Protected build anchor contract mismatch');
    const namespacePath = value.NetworkSettings.SandboxKey;
    const namespaceIdentity = (await this.io.readNamespace(namespacePath)).trim();
    if (
      !/^net:\[[1-9][0-9]*\]$/u.test(namespaceIdentity) ||
      (await this.io.readNamespace(`/proc/${value.State.Pid}/ns/net`)).trim() !== namespaceIdentity
    )
      throw new Error('Protected build namespace mismatch');
    return {
      binding: { ...binding },
      attemptId,
      containerId,
      endpointId: attached.EndpointID,
      ipv4: attached.IPAddress,
      ipv6: attached.GlobalIPv6Address,
      mac: attached.MacAddress,
      pid: value.State.Pid,
      namespacePath,
      namespaceIdentity,
    };
  }
  async inspect(expected: ProtectedBuildAnchor): Promise<ProtectedBuildAnchor> {
    const actual = await this.inspectAnchor(
      expected.binding,
      expected.attemptId,
      expected.containerId,
    );
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error('Protected build anchor was replaced');
    return actual;
  }
  /** Host workload cgroup must be empty: stopping sleep does not terminate
   * processes the trusted supervisor entered into the anchor's namespace. */
  async remove(
    expected: ProtectedBuildAnchor,
    workloadEnded: () => Promise<boolean>,
  ): Promise<void> {
    await this.io.deny(expected.binding);
    if (!(await workloadEnded())) throw new Error('Protected build termination is unconfirmed');
    // A failed or lost removal reply can leave either object already absent.
    // List exact immutable IDs; inspection failures are never evidence of absence.
    const exists = async (kind: 'container' | 'network', objectId: string) => {
      const ids = (
        await this.io.docker([
          kind,
          'ls',
          ...(kind === 'container' ? ['--all'] : []),
          '--quiet',
          '--no-trunc',
          '--filter',
          `id=${objectId}`,
        ])
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      if (ids.some((value) => value !== objectId))
        throw new Error('Protected build cleanup identity mismatch');
      return ids.length > 0;
    };
    const containerExists = await exists('container', expected.containerId);
    const networkExists = await exists('network', expected.binding.networkId);
    if (containerExists && !networkExists)
      throw new Error('Protected build anchor network missing');
    if (containerExists) {
      const raw: unknown = JSON.parse(
        await this.io.docker(['container', 'inspect', expected.containerId]),
      );
      const stopped = containerSchema.element
        .omit({ State: true, NetworkSettings: true })
        .extend({
          State: z.object({ Running: z.literal(false) }),
        })
        .array()
        .length(1)
        .safeParse(raw);
      if (stopped.success) {
        const value = stopped.data[0]!;
        const config = value.HostConfig;
        if (
          value.Id !== expected.containerId ||
          value.Config.Image !== this.io.imageRef ||
          value.Config.Entrypoint.join('\0') !== '/nodejs/bin/node' ||
          value.Config.Cmd.join('\0') !== '-e\0setInterval(() => {}, 2147483647)' ||
          config.NetworkMode !== expected.binding.networkId ||
          (config.CapAdd?.length ?? 0) !== 0 ||
          config.CapDrop.join('\0') !== 'ALL' ||
          !['no-new-privileges', 'no-new-privileges=true'].includes(
            config.SecurityOpt.join('\0'),
          ) ||
          (config.Binds?.length ?? 0) !== 0 ||
          (config.Devices?.length ?? 0) !== 0 ||
          Object.keys(config.PortBindings ?? {}).length !== 0
        )
          throw new Error('Stopped protected build anchor contract mismatch');
        await this.inspectNetwork(expected.binding, [expected.containerId]);
      } else await this.inspect(expected);
      await this.io.docker(['container', 'stop', expected.containerId]);
      await this.io.docker(['container', 'rm', expected.containerId]);
    }
    if (networkExists) {
      await this.inspectNetwork(expected.binding, []);
      await this.io.docker(['network', 'rm', expected.binding.networkId]);
    }
    await this.io.removeDeny(expected.binding);
  }
}
