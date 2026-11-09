import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:net';
import { constants, openSync, fstatSync, closeSync, fsyncSync } from 'node:fs';
import {
  chmod,
  open,
  chown,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { createDevcontainerBuildSnapshot } from './devcontainer-build-boundary.js';
import { createProtectedBuildAdmission } from './project-egress-build-admission.js';
import { egressBuildProtectedNetworks } from './project-egress-host-authority.js';
import { inspectProjectFenceAttachment } from './project-egress-attachment.js';
import type { ProjectFenceBinding, ProjectFenceDependencies } from './project-egress-fence.js';
import {
  ProtectedBuildHost,
  protectedBuildRequest,
  protectedBuildRecord,
  type ProtectedBuildRequest,
  type ProtectedBuildRecord,
} from './project-egress-build.js';
import {
  ProtectedBuildNetworks,
  type ProtectedBuildAnchor,
} from './project-egress-build-network.js';
import {
  createProtectedBuildRuntime,
  type ProtectedBuildRuntimeState,
} from './project-egress-build-runtime.js';

const ROOT = '/var/lib/verity/protected-build';
const INSPECTION = '/var/lib/verity-egress/build-anchors';
const exec = promisify(execFile);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const attemptKey = (request: ProtectedBuildRequest) =>
  hash(`${request.projectId}\0${request.attemptId}`);
export const protectedBuildAttemptDirectory = (
  request: Pick<ProtectedBuildRequest, 'projectId' | 'attemptId'>,
) => join(ROOT, 'attempts', attemptKey(request as ProtectedBuildRequest));
const folder = protectedBuildAttemptDirectory;
const unit = (request: ProtectedBuildRequest) =>
  `verity-protected-build-${attemptKey(request).slice(0, 32)}.service`;
const oid = z.string().regex(/^[a-f0-9]{64}$/u);
const checkpointSchema = z.object({
  binding: z.object({
    projectId: z.string(),
    generation: z.string(),
    networkId: oid,
    networkName: z.string(),
    bridge: z.string().regex(/^veb[a-f0-9]{12}$/u),
  }),
  attemptId: z.string(),
  containerId: oid.optional(),
  pending: z.boolean().optional(),
});
const bootId = () =>
  readFile('/proc/sys/kernel/random/boot_id', 'utf8').then((value) => value.trim());
export const protectedBuildHostConfig = z.strictObject({
  version: z.literal(1),
  imageRef: z.string().regex(/^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/u),
  dataVolume: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u),
});

export const protectedBuildDockerHost = z.object({
  CgroupDriver: z.literal('systemd'),
  CgroupVersion: z.literal('2'),
});

export const protectedBuildResult = z.strictObject({
  version: z.literal(1),
  state: z.enum(['succeeded', 'failed']),
});
export function protectedBuildResourcesReady(slice: string, service: string): boolean {
  const fields = (value: string) =>
    Object.fromEntries(
      value
        .trim()
        .split('\n')
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
  const budget = fields(slice);
  const daemon = fields(service);
  return (
    budget.LoadState === 'loaded' &&
    ['MemoryMax', 'CPUQuotaPerSecUSec', 'TasksMax'].every((name) =>
      /^[1-9][0-9]*(?:us|ms|s|min|h)?$/u.test(budget[name] ?? ''),
    ) &&
    daemon.Slice === 'verity-buildkit.slice' &&
    (daemon.ActiveState === 'inactive' ||
      daemon.ActiveState === 'failed' ||
      (daemon.ActiveState === 'active' &&
        daemon.ControlGroup === '/verity.slice/verity-buildkit.slice/verity-buildkit.service'))
  );
}

/** systemctl reports a collected/missing transient unit on stdout while exiting
 * nonzero. Only that exact response is absence evidence; bus failures are not.
 */
export async function readProtectedBuildUnit(
  name: string,
  run: (file: string, args: readonly string[]) => Promise<string>,
): Promise<Record<string, string>> {
  if (!/^verity-protected-build-[a-f0-9]{32}\.service$/u.test(name))
    throw new Error('Invalid protected build unit');
  const parse = (output: string) => {
    if (Buffer.byteLength(output) > 16384) throw new Error('Oversized protected unit state');
    const fields: Record<string, string> = {};
    for (const line of output.trim().split('\n').filter(Boolean)) {
      const split = line.indexOf('=');
      const key = line.slice(0, split);
      if (
        split < 1 ||
        !['LoadState', 'ActiveState', 'SubState', 'Result', 'ControlGroup'].includes(key) ||
        key in fields
      )
        throw new Error('Invalid protected unit state');
      fields[key] = line.slice(split + 1);
    }
    return fields;
  };
  try {
    return parse(
      await run('/usr/bin/systemctl', [
        'show',
        name,
        '--property=LoadState,ActiveState,SubState,Result,ControlGroup',
        '--no-pager',
      ]),
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'number' &&
      error.code !== 0 &&
      'stdout' in error &&
      typeof error.stdout === 'string'
    ) {
      const fields = parse(error.stdout);
      if (
        fields.LoadState === 'not-found' &&
        fields.ActiveState === 'inactive' &&
        fields.ControlGroup === ''
      )
        return fields;
    }
    throw error;
  }
}

export async function protectedBuildUnitEnded(
  value: Record<string, string>,
  readEvents: (path: string) => Promise<string>,
): Promise<boolean> {
  if (value.LoadState === 'not-found') return true;
  if (
    !['inactive', 'failed'].includes(value.ActiveState ?? '') &&
    !(value.ActiveState === 'active' && value.SubState === 'exited')
  )
    return false;
  if (!value.ControlGroup) return true;
  if (
    !/^\/verity\.slice\/verity-buildkit\.slice\//u.test(value.ControlGroup) ||
    value.ControlGroup.includes('..')
  )
    throw new Error('Untrusted protected build cgroup');
  try {
    return (await readEvents('/sys/fs/cgroup' + value.ControlGroup + '/cgroup.events'))
      .split('\n')
      .includes('populated 0');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function privateDirectory(path: string): Promise<void> {
  for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) {
    try {
      const value = await lstat(parent);
      if (
        !value.isDirectory() ||
        value.isSymbolicLink() ||
        value.uid !== 0 ||
        (value.mode & 0o022) !== 0
      )
        throw new Error('Untrusted protected build parent directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const value = await lstat(path);
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    value.uid !== 0 ||
    (value.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  )
    throw new Error('Untrusted protected build directory');
}
/** Terminal receipts only answer status queries for storage reservations that the
 * Server reconciles every few minutes. Retain them far longer than that, bounded in
 * age and count, so host state cannot grow by one file per attempt forever. A
 * receipt pruned too early only keeps a reservation held; it never releases one. */
const PROTECTED_BUILD_RECEIPT_RETENTION = { maxAgeMs: 30 * 24 * 3600_000, maxCount: 4096 };
export async function pruneProtectedBuildReceipts(
  directory: string,
  now: number,
  retention = PROTECTED_BUILD_RECEIPT_RETENTION,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const receipts: { path: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const path = join(directory, entry.name);
    const info = await lstat(path).catch(() => undefined);
    if (info?.isFile()) receipts.push({ path, mtimeMs: info.mtimeMs });
  }
  receipts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const [index, receipt] of receipts.entries())
    if (index >= retention.maxCount || now - receipt.mtimeMs > retention.maxAgeMs)
      await rm(receipt.path, { force: true }).catch(() => undefined);
}
async function privateRead(path: string): Promise<unknown> {
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!fd) return undefined;
  try {
    const value = await fd.stat();
    if (
      !value.isFile() ||
      value.uid !== 0 ||
      (value.mode & 0o077) !== 0 ||
      value.nlink !== 1 ||
      value.size > 128 * 1024
    )
      throw new Error('Untrusted protected build state');
    return JSON.parse(await fd.readFile('utf8')) as unknown;
  } finally {
    await fd.close();
  }
}

async function privateWrite(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = path + '.' + randomUUID();
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    const fd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    await rename(temporary, path);
    const directoryFd = openSync(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
function binding(anchor: ProtectedBuildAnchor): ProjectFenceBinding {
  return {
    projectId: anchor.binding.projectId,
    generation: anchor.binding.generation,
    containerId: anchor.containerId,
    networkId: anchor.binding.networkId,
    endpointId: anchor.endpointId,
    bridge: anchor.binding.bridge,
    ipv4: anchor.ipv4,
    ipv6: anchor.ipv6,
  };
}
function bindingKey(value: ProjectFenceBinding) {
  return hash(
    JSON.stringify([
      value.projectId,
      value.generation,
      value.containerId,
      value.networkId,
      value.endpointId,
      value.bridge,
      value.ipv4,
      value.ipv6,
    ]),
  );
}

/** Separate wildcard fence: runtime vep* generations and their tables are untouched. */
export function protectedBuildBootstrapRules(active: readonly string[] = []): string {
  if (active.some((value) => !/^veb[a-f0-9]{12}$/u.test(value)))
    throw new Error('Invalid protected build bridge');
  const elements = active.map((value) => `"${value}"`).join(', ');
  return ['inet', 'bridge']
    .map(
      (family) =>
        `add table ${family} verity_build_boot\ndelete table ${family} verity_build_boot\ntable ${family} verity_build_boot {\n set active { type ifname; ${elements ? 'elements = { ' + elements + ' };' : ''} }\n chain forward { type filter hook forward priority -225; policy accept; ${family === 'inet' ? 'iifname "veb*" iifname != @active counter drop; oifname "veb*" oifname != @active counter drop;' : 'meta ibrname "veb*" meta ibrname != @active counter drop; meta obrname "veb*" meta obrname != @active counter drop;'} }\n chain input { type filter hook input priority -225; policy accept; ${family === 'inet' ? 'iifname "veb*" iifname != @active counter drop;' : 'meta ibrname "veb*" meta ibrname != @active counter drop;'} }\n}\n`,
    )
    .join('');
}
export interface NativeProtectedBuildOptions {
  imageRef: string;
  cleanupImageRef?: string;
  dataVolume: string;
  dependencies: Omit<ProjectFenceDependencies, 'policyCurrent' | 'inspect' | 'relay'>;
  verifyReady(): Promise<void>;
  run?(this: void, file: string, args: readonly string[], timeout?: number): Promise<string>;
}
/** Real host adapter. Every project-selected input is confined to the shared
 * bounded snapshot; command plans, images, rules and policy derive from host state.
 */
export async function createNativeProtectedBuildHost(options: NativeProtectedBuildOptions) {
  protectedBuildHostConfig.parse({
    version: 1,
    imageRef: options.imageRef,
    dataVolume: options.dataVolume,
  });
  if (options.cleanupImageRef !== undefined)
    protectedBuildHostConfig.shape.imageRef.parse(options.cleanupImageRef);
  for (const path of [ROOT, join(ROOT, 'attempts'), join(ROOT, 'projects'), INSPECTION])
    await privateDirectory(path);
  const run =
    options.run ??
    (async (file, args, timeout = 5000) =>
      (
        await exec(file, [...args], {
          timeout,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
            DOCKER_HOST: 'unix:///var/run/docker.sock',
          },
        })
      ).stdout);
  const docker = (args: readonly string[]) => run('/usr/bin/docker', args, 30000);
  const active = new Set<string>();
  const admissions = new Map<string, ReturnType<typeof createProtectedBuildAdmission>>();
  const dns = new Map<string, Server>();
  const bootstrap = () => options.dependencies.apply(protectedBuildBootstrapRules([...active]));
  const volume = async () => {
    const value = z
      .array(
        z.object({
          Name: z.literal(options.dataVolume),
          Driver: z.literal('local'),
          Mountpoint: z.string(),
        }),
      )
      .length(1)
      .parse(JSON.parse(await docker(['volume', 'inspect', options.dataVolume])))[0]!;
    if (
      !value.Mountpoint.startsWith('/var/lib/docker/volumes/') ||
      (await realpath(value.Mountpoint)) !== value.Mountpoint
    )
      throw new Error('Untrusted protected build data volume');
    return join(value.Mountpoint, 'build-storage');
  };
  const shared = async (request: ProtectedBuildRequest) => {
    protectedBuildRequest.parse(request);
    const root = await volume();
    const snapshot = join(root, request.snapshot);
    if (
      (await realpath(snapshot)) !== snapshot ||
      (await realpath(dirname(snapshot))) !== dirname(snapshot)
    )
      throw new Error('Protected build snapshot escaped its lease');
    const staging = join(dirname(snapshot), 'protected-build');
    const value = await lstat(staging);
    if (
      !value.isDirectory() ||
      value.isSymbolicLink() ||
      (value.mode & 0o077) !== 0 ||
      (await realpath(staging)) !== staging
    )
      throw new Error('Untrusted protected build staging');
    return { snapshot, staging, uid: value.uid, gid: value.gid };
  };
  const sharedJSON = async (path: string) => {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const value = await fd.stat();
      if (!value.isFile() || value.nlink !== 1 || (value.mode & 0o077) !== 0 || value.size > 32768)
        throw new Error('Invalid protected build private input');
      return JSON.parse(await fd.readFile('utf8')) as unknown;
    } finally {
      await fd.close();
    }
  };
  const checkpointPath = (request: ProtectedBuildRequest) =>
    join(folder(request), 'checkpoint.json');
  const loadState = async (
    request: ProtectedBuildRequest,
  ): Promise<ProtectedBuildRuntimeState | undefined> => {
    const raw = await privateRead(join(folder(request), 'runtime.json'));
    if (raw === undefined) return undefined;
    const parsed = z
      .object({
        bootId: z.uuid(),
        state: z.object({
          request: protectedBuildRequest,
          anchor: z.unknown(),
          launched: z.boolean(),
        }),
      })
      .parse(raw);
    // Old boot state is useful only for denial/cleanup; no admission is resumed.
    return parsed.state as ProtectedBuildRuntimeState;
  };
  const ensureBootstrap = async () => {
    // Refuse foreign reserved bridges before installing a wildcard denial.
    const links = z
      .array(z.object({ ifname: z.string() }))
      .parse(JSON.parse(await run('/sbin/ip', ['-j', 'link', 'show'])));
    const known = new Set<string>();
    const current = await privateRead(join(ROOT, 'controller.json'));
    if (current && typeof current === 'object' && 'request' in current) {
      const req = protectedBuildRequest.parse(current.request);
      const point = await privateRead(checkpointPath(req));
      if (point) {
        const checkpoint = checkpointSchema.parse(point);
        const saved = checkpoint.binding;
        if (checkpoint.pending && !links.some((link) => link.ifname === saved.bridge)) {
          const listed = (await docker(['network', 'ls', '--format', '{{.Name}}']))
            .trim()
            .split('\n');
          if (listed.includes(saved.networkName))
            throw new Error('Pending build bridge is missing');
          await rm(checkpointPath(req), { force: true });
        }
        if (links.some((link) => link.ifname === saved.bridge)) {
          const live = z
            .array(
              z.object({
                Id: oid,
                Name: z.string(),
                Driver: z.literal('bridge'),
                Options: z.record(z.string(), z.string()),
                Labels: z.record(z.string(), z.string()).default({}),
              }),
            )
            .length(1)
            .parse(
              JSON.parse(
                await docker([
                  'network',
                  'inspect',
                  checkpoint.pending ? saved.networkName : saved.networkId,
                ]),
              ),
            )[0]!;
          if (
            (checkpoint.pending
              ? live.Labels['io.verity.build-intent'] !== saved.networkId
              : live.Id !== saved.networkId) ||
            live.Name !== saved.networkName ||
            live.Options['com.docker.network.bridge.name'] !== saved.bridge
          )
            throw new Error('Protected build bridge ownership changed');
          if (checkpoint.pending) {
            checkpoint.binding.networkId = live.Id;
            delete checkpoint.pending;
            await privateWrite(checkpointPath(req), checkpoint);
          }
          known.add(saved.bridge);
        }
      }
    }
    if (
      links.some(
        (link) => /^veb/u.test(link.ifname) && !known.has(link.ifname) && !active.has(link.ifname),
      )
    )
      throw new Error('Foreign protected build bridge collision');
    await bootstrap();
  };
  const networks = new ProtectedBuildNetworks({
    imageRef: options.imageRef,
    ...(options.cleanupImageRef === undefined
      ? {}
      : { cleanupImageRef: options.cleanupImageRef }),
    docker,
    readNamespace: async (path) =>
      (
        await run('/usr/bin/nsenter', ['--net=' + path, '/usr/bin/readlink', '/proc/self/ns/net'])
      ).trim(),
    async checkpoint(value) {
      const request = { projectId: value.binding.projectId, attemptId: value.attemptId };
      await privateWrite(
        join(
          ROOT,
          'attempts',
          hash(`${request.projectId}\0${request.attemptId}`),
          'checkpoint.json',
        ),
        value,
      );
    },
    ensureBootstrap,
    async assertBridgeFree(bridge) {
      const links = z
        .array(z.object({ ifname: z.string() }))
        .parse(JSON.parse(await run('/sbin/ip', ['-j', 'link', 'show'])));
      if (links.some((link) => link.ifname === bridge))
        throw new Error('Protected build bridge collision');
    },
    async deny(value) {
      active.delete(value.bridge);
      await bootstrap();
    },
    async removeDeny(value) {
      active.delete(value.bridge);
      await bootstrap();
    },
  });
  const admission = (anchor: ProtectedBuildAnchor) => {
    const key = attemptKey({
      projectId: anchor.binding.projectId,
      attemptId: anchor.attemptId,
    } as ProtectedBuildRequest);
    let value = admissions.get(key);
    if (!value) {
      value = createProtectedBuildAdmission({
        binding: binding(anchor),
        networkInventory: () => egressBuildProtectedNetworks(),
        dependencies: {
          ...options.dependencies,
          inspect: async (expected) => {
            await networks.inspect(anchor);
            return inspectProjectFenceAttachment(expected);
          },
        },
      });
      admissions.set(key, value);
    }
    return value;
  };
  const deny = async (anchor: ProtectedBuildAnchor) => {
    active.delete(anchor.binding.bridge);
    await bootstrap();
    const current = admissions.get(hash(`${anchor.binding.projectId}\0${anchor.attemptId}`));
    if (current) await current.revoke();
  };
  const unitState = (name: string) => readProtectedBuildUnit(name, run);
  const ended = async (name: string) =>
    protectedBuildUnitEnded(await unitState(name), (path) => readFile(path, 'utf8'));
  const stopUnit = async (name: string) => {
    if ((await unitState(name)).LoadState !== 'not-found')
      await run('/usr/bin/systemctl', ['stop', name], 40000);
  };
  const startDNS = async (request: ProtectedBuildRequest, anchor: ProtectedBuildAnchor) => {
    const key = attemptKey(request);
    if (dns.has(key)) return;
    const path = join(folder(request), 'n');
    await rm(path, { force: true });
    let pending = 0;
    const server = createServer((connection) => {
      if (pending >= 16) {
        connection.destroy();
        return;
      }
      pending++;
      connection.setTimeout(1000, () => connection.destroy());
      let input = '';
      let done = false;
      connection.on('close', () => {
        pending--;
      });
      connection.on('data', (chunk) => {
        if (done) return;
        input += chunk.toString('utf8');
        if (Buffer.byteLength(input) > 4096) {
          done = true;
          connection.destroy();
          return;
        }
        if (!input.includes('\n')) return;
        done = true;
        void (async () => {
          const { name } = z
            .strictObject({
              name: z
                .string()
                .max(253)
                .regex(
                  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
                ),
            })
            .parse(JSON.parse(input.split('\n')[0]!));
          const value = await admission(anchor).resolve(name);
          connection.end(JSON.stringify(value ?? { addresses: [], ttlSeconds: 1 }) + '\n');
        })().catch(() => connection.destroy());
      });
    });
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        accept();
      });
    });
    await chmod(path, 0o600);
    dns.set(key, server);
  };
  const partial = async (request: ProtectedBuildRequest) => {
    await ensureBootstrap();
    const value = await privateRead(checkpointPath(request));
    if (value === undefined) return undefined;
    const result = checkpointSchema.parse(value);
    if (
      result.binding.projectId !== request.projectId ||
      result.attemptId !== request.attemptId ||
      result.binding.generation !== request.attemptId
    )
      throw new Error('Changed protected build checkpoint');
    return result;
  };
  const partialContainer = async (request: ProtectedBuildRequest) => {
    const point = await partial(request);
    if (!point) return undefined;
    // Recover a crash between Docker create and the following durable checkpoint.
    // A name is discovery only; immutable identity and complete shape are checked below.
    const name = 'verity-build-anchor-' + attemptKey(request).slice(0, 32);
    const listing = (
      await docker([
        'container',
        'ls',
        '--all',
        '--no-trunc',
        '--filter',
        'name=^/' + name + '$',
        '--format',
        '{{json .}}',
      ])
    ).trim();
    const found = z
      .array(z.object({ ID: oid, Names: z.literal(name) }))
      .max(1)
      .parse(listing ? listing.split('\n').map((line) => JSON.parse(line) as unknown) : []);
    if (!found.length) return undefined;
    const discovered = found[0]!.ID;
    if (point.containerId && point.containerId !== discovered)
      throw new Error('Changed protected build partial container');
    point.containerId = discovered;
    const values = z
      .array(
        z.object({
          Id: oid,
          Config: z.object({
            Image: z
              .string()
              .refine((image) => image === options.imageRef || image === options.cleanupImageRef),
            Entrypoint: z.array(z.string()),
            Cmd: z.array(z.string()),
            User: z.literal('65534:65534'),
          }),
          Mounts: z.array(z.unknown()).length(0),
          HostConfig: z.object({
            Runtime: z.literal('runc'),
            CgroupParent: z.literal('verity-buildkit.slice'),
            NetworkMode: z.string(),
            Privileged: z.literal(false),
            ReadonlyRootfs: z.literal(true),
            CapDrop: z.array(z.string()).length(1),
            CapAdd: z.array(z.string()).nullable(),
            SecurityOpt: z.array(z.string()),
            Devices: z.array(z.unknown()).nullable(),
            PortBindings: z.record(z.string(), z.unknown()).nullable(),
            Binds: z.array(z.string()).nullable(),
          }),
          State: z.object({ Running: z.boolean() }),
        }),
      )
      .length(1)
      .parse(JSON.parse(await docker(['container', 'inspect', point.containerId])));
    const value = values[0]!;
    if (
      value.Id !== point.containerId ||
      value.HostConfig.NetworkMode !== point.binding.networkId ||
      value.Config.Entrypoint.join('\0') !== '/nodejs/bin/node' ||
      value.Config.Cmd.join('\0') !== '-e\0setInterval(() => {}, 2147483647)' ||
      value.HostConfig.CapDrop[0] !== 'ALL' ||
      (value.HostConfig.CapAdd?.length ?? 0) !== 0 ||
      (value.HostConfig.Devices?.length ?? 0) !== 0 ||
      (value.HostConfig.Binds?.length ?? 0) !== 0 ||
      Object.keys(value.HostConfig.PortBindings ?? {}).length !== 0 ||
      !value.HostConfig.SecurityOpt.some(
        (option) => option === 'no-new-privileges' || option === 'no-new-privileges=true',
      )
    )
      throw new Error('Changed protected build partial anchor');
    return { point, value };
  };
  const stopPartial = async (request: ProtectedBuildRequest) => {
    const point = await partial(request);
    if (point) {
      active.delete(point.binding.bridge);
      await bootstrap();
    }
    await stopUnit(unit(request));
    const container = await partialContainer(request);
    if (container?.value.State.Running)
      await docker(['container', 'stop', container.point.containerId!]);
  };
  const removePartial = async (request: ProtectedBuildRequest) => {
    if (!(await ended(unit(request))))
      throw new Error('Protected build partial termination is unconfirmed');
    const container = await partialContainer(request);
    if (container) await docker(['container', 'rm', container.point.containerId!]);
    const point = await partial(request);
    if (point) {
      // A lost removal reply may leave only the checkpoint. Inspect failures are
      // not absence evidence; enumerate the exact immutable network ID first.
      const ids = (
        await docker([
          'network',
          'ls',
          '--quiet',
          '--no-trunc',
          '--filter',
          'id=' + point.binding.networkId,
        ])
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      if (ids.some((id) => id !== point.binding.networkId))
        throw new Error('Changed protected build partial network');
      if (ids.length) {
        const value = z
          .array(
            z.object({
              Id: oid,
              Name: z.string(),
              Options: z.record(z.string(), z.string()),
              Containers: z.record(z.string(), z.unknown()).default({}),
            }),
          )
          .length(1)
          .parse(JSON.parse(await docker(['network', 'inspect', point.binding.networkId])))[0]!;
        if (
          value.Id !== point.binding.networkId ||
          value.Name !== point.binding.networkName ||
          value.Options['com.docker.network.bridge.name'] !== point.binding.bridge ||
          Object.keys(value.Containers).length
        )
          throw new Error('Changed protected build partial network');
        await docker(['network', 'rm', point.binding.networkId]);
      }
    }
    await rm(folder(request), { recursive: true, force: true });
  };
  const exportFile = async (
    request: ProtectedBuildRequest,
    filename: 'image.tar' | 'build.log',
  ) => {
    const directory = folder(request);
    const source = join(directory, filename);
    const sourceFd = openSync(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let targetFd: number | undefined;
    let temporary: string | undefined;
    try {
      const actual = fstatSync(sourceFd);
      if (
        !actual.isFile() ||
        actual.uid !== 0 ||
        actual.nlink !== 1 ||
        actual.size === 0 ||
        (filename === 'build.log' && actual.size > 262144) ||
        (actual.mode & 0o077) !== 0
      )
        throw new Error('Untrusted protected build archive');
      const target = await shared(request);
      targetFd = openSync(
        target.staging,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const directoryIdentity = fstatSync(targetFd);
      const pinned = '/proc/self/fd/' + targetFd;
      temporary = pinned + '/' + filename + '-' + randomUUID() + '.tmp';
      await copyFile('/proc/self/fd/' + sourceFd, temporary, constants.COPYFILE_EXCL);
      await chmod(temporary, 0o600);
      await chown(temporary, target.uid, target.gid);
      const latest = await lstat(target.staging);
      if (
        latest.dev !== directoryIdentity.dev ||
        latest.ino !== directoryIdentity.ino ||
        (await realpath(target.staging)) !== target.staging
      )
        throw new Error('Changed protected build output directory');
      await rename(temporary, pinned + '/' + filename);
    } finally {
      if (temporary) await rm(temporary, { force: true });
      if (targetFd !== undefined) closeSync(targetFd);
      closeSync(sourceFd);
    }
  };
  const exportResult = async (request: ProtectedBuildRequest) => {
    try {
      await exportFile(request, 'build.log');
    } catch {
      // Optional diagnostics cannot turn a stopped attempt into an unknown process.
    }
    const result = protectedBuildResult.safeParse(
      await privateRead(join(folder(request), 'result.json')),
    );
    if (result.success && result.data.state === 'succeeded') await exportFile(request, 'image.tar');
  };
  const runtime = createProtectedBuildRuntime({
    networks,
    async ready() {
      await options.verifyReady();
      protectedBuildDockerHost.parse(JSON.parse(await docker(['info', '--format', '{{json .}}'])));
      await run('/usr/local/libexec/verity-buildkit/protected-build-attempt', ['check'], 5000);
      const slice = await run('/usr/bin/systemctl', [
        'show',
        'verity-buildkit.slice',
        '--property=LoadState,MemoryMax,CPUQuotaPerSecUSec,TasksMax',
        '--no-pager',
      ]);
      const sharedService = await run('/usr/bin/systemctl', [
        'show',
        'verity-buildkit.service',
        '--property=Slice,ActiveState,ControlGroup',
        '--no-pager',
      ]);
      if (!protectedBuildResourcesReady(slice, sharedService))
        throw new Error('Protected builder shared resource budget is not ready');
      return true;
    },
    load: loadState,
    async save(value) {
      await privateWrite(join(folder(value.request), 'runtime.json'), {
        bootId: await bootId(),
        state: value,
      });
    },
    stopPartial,
    endedPartial: (request) => ended(unit(request)),
    removePartial,
    async prepareFiles(request, plan) {
      const source = await shared(request);
      const job = z
        .strictObject({ request: protectedBuildRequest })
        .parse(await sharedJSON(join(source.staging, 'job.json')));
      if (JSON.stringify(job.request) !== JSON.stringify(request))
        throw new Error('Changed protected build staged request');
      const inputs = z
        .strictObject({ additionalFeatures: z.string() })
        .parse(await sharedJSON(join(source.staging, 'inputs.json')));
      const manifest = z
        .object({ additionalFeatures: z.array(z.string()) })
        .parse(
          JSON.parse(await readFile('/opt/verity-egress/protected-build-toolchain.json', 'utf8')),
        );
      if (!manifest.additionalFeatures.includes(inputs.additionalFeatures))
        throw new Error('Unapproved protected build toolkit');
      await privateDirectory(plan.directory);
      await privateDirectory(plan.projectCache);
      const snapshot = await createDevcontainerBuildSnapshot(source.snapshot, plan.directory);
      await rename(snapshot.workspaceFolder, join(plan.directory, 'workspace'));
      const state = await loadState(request);
      if (!state) throw new Error('Missing protected build attachment');
      await privateWrite(join(plan.directory, 'descriptor.json'), {
        version: 1,
        request,
        additionalFeatures: inputs.additionalFeatures,
      });
      await privateWrite(join(plan.directory, 'namespace.json'), {
        identity: state.anchor.namespaceIdentity,
      });
      await privateWrite(join(plan.directory, 'cni.json'), {
        cniVersion: '1.0.0',
        name: 'verity-protected-build',
        plugins: [
          {
            type: 'bridge',
            bridge: 'vbki0',
            isGateway: true,
            ipMasq: true,
            ipam: {
              type: 'host-local',
              subnet: '10.215.0.0/24',
              routes: [{ dst: '0.0.0.0/0' }],
              dataDir: join(plan.directory, 'cni-state'),
            },
          },
          { type: 'loopback' },
        ],
      });
      try {
        const registry = await sharedJSON(join(source.staging, 'registry.json'));
        await privateWrite(join(plan.directory, 'registry.json'), registry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await startDNS(request, state.anchor);
    },
    async launch(plan) {
      await run(plan.executable, plan.args, 30000);
    },
    async status(name) {
      const value = await unitState(name);
      if (
        !['inactive', 'failed'].includes(value.ActiveState ?? '') &&
        !(value.ActiveState === 'active' && value.SubState === 'exited')
      )
        return 'running';
      if (!(await ended(name))) return 'failed';
      const raw = await privateRead(join(ROOT, 'controller.json'));
      if (!raw || typeof raw !== 'object' || !('request' in raw)) return 'failed';
      const request = protectedBuildRequest.parse(raw.request);
      if (unit(request) !== name) return 'failed';
      if (value.Result !== 'success') {
        try {
          await exportFile(request, 'build.log');
        } catch {
          /* Diagnostics are optional. */
        }
        return 'failed';
      }
      const result = protectedBuildResult.safeParse(
        await privateRead(join(folder(request), 'result.json')),
      );
      if (!result.success || result.data.state !== 'succeeded') return 'failed';
      await exportResult(request);
      return 'succeeded';
    },
    stop: stopUnit,
    // Termination proof must survive disposal of the Server's exported artifacts.
    ended,
    async cleanup(request, plan) {
      const server = dns.get(attemptKey(request));
      if (server) {
        await new Promise<void>((accept, reject) =>
          server.close((error) => (error ? reject(error) : accept())),
        );
        dns.delete(attemptKey(request));
      }
      await rm(plan.directory, { recursive: true, force: true });
    },
    authority: {
      async prepare(anchor) {
        const value = binding(anchor);
        await privateWrite(join(INSPECTION, bindingKey(value) + '.json'), {
          version: 1,
          binding: value,
          namespace: anchor.namespacePath,
          bootId: await bootId(),
        });
        await admission(anchor).prepare();
      },
      async renew(anchor) {
        await admission(anchor).refresh();
        active.add(anchor.binding.bridge);
        await bootstrap();
      },
      deny,
      async release(anchor) {
        const current = admissions.get(hash(`${anchor.binding.projectId}\0${anchor.attemptId}`));
        if (current) await current.retire();
        admissions.delete(
          attemptKey({
            projectId: anchor.binding.projectId,
            attemptId: anchor.attemptId,
          } as ProtectedBuildRequest),
        );
        await rm(join(INSPECTION, bindingKey(binding(anchor)) + '.json'), { force: true });
      },
    },
  });
  const controller = new ProtectedBuildHost(
    runtime,
    async (record: ProtectedBuildRecord | undefined) => {
      if (record) await privateWrite(join(ROOT, 'controller.json'), record);
      else await rm(join(ROOT, 'controller.json'), { force: true });
    },
    undefined,
    {
      async save(record) {
        const terminal = protectedBuildRecord.parse(record);
        if (!terminal.ended || !['succeeded', 'failed'].includes(terminal.phase))
          throw new Error('Protected build receipt is not terminal');
        const path = join(ROOT, 'receipts', attemptKey(terminal.request) + '.json');
        const existing = await privateRead(path);
        if (existing !== undefined) {
          const previous = protectedBuildRecord.parse(existing);
          if (JSON.stringify(previous) !== JSON.stringify(terminal))
            throw new Error('Protected build terminal receipt changed');
          return;
        }
        await privateWrite(path, terminal);
        await pruneProtectedBuildReceipts(dirname(path), Date.now());
      },
      async load(projectId, attemptId) {
        const request = { projectId, attemptId } as ProtectedBuildRequest;
        const value = await privateRead(join(ROOT, 'receipts', attemptKey(request) + '.json'));
        return value === undefined ? undefined : protectedBuildRecord.parse(value);
      },
    },
  );
  return {
    controller,
    async restore() {
      active.clear();
      await ensureBootstrap();
      await controller.restore(await privateRead(join(ROOT, 'controller.json')));
    },
    async close() {
      await controller.close();
      for (const server of dns.values()) server.close();
      dns.clear();
    },
  };
}
