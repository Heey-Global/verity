import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { renameSync, symlinkSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createManagedSecretServers,
  listTaggedManagedPids,
  stopTaggedManagedPids,
} from '../../../features/verity-sandbox-toolkit/bin/verity-managed-secret-servers.mjs';
import { PRIVILEGE_DROP_FLAGS } from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'verity-managed-secrets-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'private'), { mode: 0o700 });
  await chmod(root, 0o700);
  // Exercise the launched shell for real without requiring root in local tests.
  const launch = vi.fn<NonNullable<Parameters<typeof createManagedSecretServers>[0]['spawnChild']>>(
    (_command, args, options) => spawn('/bin/sh', args.slice(-6), options),
  );
  const broker = createManagedSecretServers({
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    privilegeDropFlags: PRIVILEGE_DROP_FLAGS,
    stopTagged: stopTaggedManagedPids,
    realpath,
    allowedPath: (path) => path === root || path.startsWith(`${root}/`),
    spawnChild: launch,
  });
  cleanup.push(() => broker.close());
  const request = {
    protocolVersion: 1,
    instanceId: randomUUID(),
    kind: 'managed-secret-start',
    worktree: root,
    workdir: 'private',
    command: 'test -n "$API_KEY"; echo "$API_KEY"; sleep 30',
    env: { PORT: '41000', VERITY_SESSION_ID: randomUUID() },
    secrets: [{ env: 'API_KEY', value: 'synthetic-private-key' }],
  };
  cleanup.push(async () => {
    await stopTaggedManagedPids(request.instanceId, 'SIGKILL');
  });
  return { root, broker, launch, request };
}

describe('managed secret server broker', () => {
  it('owns a private server beyond its launch request and stops it without persisting output', async () => {
    const { broker, launch, request } = await fixture();
    expect(await broker.handle(request)).toMatchObject({ found: true, alive: true });
    const [command, args, options] = launch.mock.calls[0]!;
    expect(command).toBe('/usr/bin/setpriv');
    expect(args).toEqual(expect.arrayContaining([...PRIVILEGE_DROP_FLAGS]));
    expect(options).toMatchObject({
      cwd: '/',
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { API_KEY: 'synthetic-private-key', VERITY_DEV_SERVER_INSTANCE: request.instanceId },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = { protocolVersion: 1, instanceId: request.instanceId };
    expect(await broker.handle({ ...status, kind: 'managed-secret-status' })).toMatchObject({
      alive: true,
    });
    const logs = await broker.handle({ ...status, kind: 'managed-secret-logs' });
    expect(JSON.stringify(logs)).not.toContain(request.secrets[0]!.value);
    expect(logs.logs).toContain('disabled');
    await broker.handle({ ...status, kind: 'managed-secret-stop' });
    expect(await broker.handle({ ...status, kind: 'managed-secret-status' })).toMatchObject({
      alive: false,
    });
  });

  it('checks containment before launching and refuses a symlink outside the worktree', async () => {
    const { root, broker, launch, request } = await fixture();
    await symlink(tmpdir(), join(root, 'escape'));
    await expect(broker.handle({ ...request, workdir: 'escape' })).rejects.toThrow('escaped');
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(['NODE_OPTIONS', 'VERITY_SESSION_ID', 'PATH', 'LD_PRELOAD'])(
    'rejects secret overrides of %s before launch',
    async (env) => {
      const { broker, launch, request } = await fixture();
      await expect(
        broker.handle({ ...request, secrets: [{ env, value: 'synthetic-private-key' }] }),
      ).rejects.toThrow('invalid');
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it('reports exit, terminates descendants and stops active servers on broker shutdown', async () => {
    const { broker, request } = await fixture();
    await broker.handle({ ...request, command: 'exit 7' });
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await broker.handle({
        protocolVersion: 1,
        instanceId: request.instanceId,
        kind: 'managed-secret-status',
      });
      if (!status.alive) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(
      await broker.handle({
        protocolVersion: 1,
        instanceId: request.instanceId,
        kind: 'managed-secret-status',
      }),
    ).toMatchObject({ alive: false, exitCode: 7 });
    await broker.handle(request);
    await broker.close();
    await expect(
      broker.handle({
        protocolVersion: 1,
        instanceId: request.instanceId,
        kind: 'managed-secret-status',
      }),
    ).rejects.toThrow('invalid managed server request');
  });
});

it('matches only complete managed identity tags without returning environment values', async () => {
  const { root, request } = await fixture();
  const proc = join(root, 'proc');
  await mkdir(join(proc, '123'), { recursive: true });
  await mkdir(join(proc, '456'), { recursive: true });
  await writeFile(
    join(proc, '123', 'environ'),
    `API_KEY=synthetic-hidden-value\0VERITY_DEV_SERVER_INSTANCE=${request.instanceId}\0`,
  );
  await writeFile(
    join(proc, '456', 'environ'),
    `OTHER=VERITY_DEV_SERVER_INSTANCE=${request.instanceId}\0`,
  );
  expect(await listTaggedManagedPids(request.instanceId, proc)).toEqual([123]);
});

it('stops a tagged descendant that detached into another process group', async () => {
  const { root, broker, request } = await fixture();
  // CI installs Node outside the broker's deliberately restricted default PATH.
  const node = "'" + process.execPath.replaceAll("'", "'\\''") + "'";
  await broker.handle({
    ...request,
    command: `${node} -e "const cp=require('node:child_process');const child=cp.spawn('sleep',['30'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync('daemon.pid',String(child.pid));child.unref()"`,
  });
  let pid = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    pid = Number(await readFile(join(root, 'private', 'daemon.pid'), 'utf8').catch(() => '0'));
    const status = await broker.handle({
      protocolVersion: 1,
      instanceId: request.instanceId,
      kind: 'managed-secret-status',
    });
    if (pid && !status.alive) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(pid).toBeGreaterThan(1);
  await broker.handle({
    protocolVersion: 1,
    instanceId: request.instanceId,
    kind: 'managed-secret-stop',
  });
  // A killed orphan can remain a zombie until the container init reaps it.
  let stopped = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    stopped = stat === '' || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
    if (stopped) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(stopped).toBe(true);
});

it('serializes a stop behind a pending launch so a lost start acknowledgement cannot leave a server running', async () => {
  const { root, request } = await fixture();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => undefined;
  const resolving = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const broker = createManagedSecretServers({
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    privilegeDropFlags: PRIVILEGE_DROP_FLAGS,
    realpath: async (path) => {
      reached();
      await gate;
      return realpath(path);
    },
    allowedPath: (path) => path === root || path.startsWith(`${root}/`),
    spawnChild: (_command, args, options) => spawn('/bin/sh', args.slice(-6), options),
  });
  cleanup.push(() => broker.close());
  const start = broker.handle(request);
  await resolving;
  const stop = broker.handle({
    protocolVersion: 1,
    instanceId: request.instanceId,
    kind: 'managed-secret-stop',
  });
  release();
  await Promise.all([start, stop]);
  expect(
    await broker.handle({
      protocolVersion: 1,
      instanceId: request.instanceId,
      kind: 'managed-secret-status',
    }),
  ).toMatchObject({ alive: false });
});

it('refuses a worktree replaced with an outside symlink after preflight', async () => {
  const { root, request } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'verity-managed-outside-'));
  await mkdir(join(outside, 'private'));
  const backup = root + '-original';
  cleanup.push(() => rm(outside, { recursive: true, force: true }));
  cleanup.push(() => rm(backup, { recursive: true, force: true }));
  const broker = createManagedSecretServers({
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    privilegeDropFlags: PRIVILEGE_DROP_FLAGS,
    realpath,
    allowedPath: (path) => path === root || path.startsWith(`${root}/`),
    spawnChild: (_command, args, options) => {
      renameSync(root, backup);
      symlinkSync(outside, root);
      return spawn('/bin/sh', args.slice(-6), options);
    },
  });
  cleanup.push(() => broker.close());
  await broker.handle({ ...request, command: 'touch escaped-marker' });
  let status: Awaited<ReturnType<typeof broker.handle>> | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await broker.handle({
      protocolVersion: 1,
      instanceId: request.instanceId,
      kind: 'managed-secret-status',
    });
    if (!status.alive) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(status).toMatchObject({ alive: false, exitCode: 4 });
  expect(await readFile(join(outside, 'private', 'escaped-marker')).catch(() => null)).toBeNull();
});

it('never signals the historical process group after the leader exits', async () => {
  const { broker, request } = await fixture();
  await broker.handle({ ...request, command: 'exit 0' });
  const status = { protocolVersion: 1, instanceId: request.instanceId };
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await broker.handle({ ...status, kind: 'managed-secret-status' })).alive) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(await broker.handle({ ...status, kind: 'managed-secret-status' })).toMatchObject({
    alive: false,
  });
  const kill = vi.spyOn(process, 'kill');
  try {
    await broker.handle({ ...status, kind: 'managed-secret-stop' });
    expect(kill.mock.calls.filter(([pid]) => pid < 0)).toEqual([]);
  } finally {
    kill.mockRestore();
  }
});

it('retains terminal status while counting only active servers toward the limit', async () => {
  const { root, request } = await fixture();
  const broker = createManagedSecretServers({
    uid: 1000,
    gid: 1000,
    privilegeDropFlags: PRIVILEGE_DROP_FLAGS,
    realpath,
    allowedPath: (path) => path === root || path.startsWith(`${root}/`),
    spawnChild: (() => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        child.emit('spawn');
        child.emit('close', 0);
      });
      return child;
    }) as unknown as NonNullable<Parameters<typeof createManagedSecretServers>[0]['spawnChild']>,
  });
  cleanup.push(() => broker.close());
  const first = randomUUID();
  for (let index = 0; index < 257; index++) {
    await expect(
      broker.handle({ ...request, instanceId: index === 0 ? first : randomUUID() }),
    ).resolves.toMatchObject({
      found: true,
    });
  }
  expect(
    await broker.handle({ protocolVersion: 1, instanceId: first, kind: 'managed-secret-status' }),
  ).toMatchObject({ found: true, alive: false, exitCode: 0 });
});

it('cleans surviving tagged processes before launching after broker state loss', async () => {
  const { root, request } = await fixture();
  const order: string[] = [];
  const stopTagged = vi.fn(async () => {
    order.push('stop');
  });
  const broker = createManagedSecretServers({
    uid: 1000,
    gid: 1000,
    privilegeDropFlags: PRIVILEGE_DROP_FLAGS,
    realpath,
    allowedPath: (path) => path === root || path.startsWith(`${root}/`),
    stopTagged,
    spawnChild: (() => {
      order.push('spawn');
      const child = new EventEmitter();
      queueMicrotask(() => {
        child.emit('spawn');
        child.emit('close', 0);
      });
      return child;
    }) as unknown as NonNullable<Parameters<typeof createManagedSecretServers>[0]['spawnChild']>,
  });
  cleanup.push(() => broker.close());
  await broker.handle(request);
  expect(order.slice(0, 2)).toEqual(['stop', 'spawn']);
  expect(stopTagged).toHaveBeenCalledWith(request.instanceId, 'SIGKILL');
});
