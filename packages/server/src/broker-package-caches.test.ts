import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquirePackageCacheLease,
  agentLaunchSpec,
  prepareSessionHome,
  reclaimPackageCaches,
  runAgentSpawnBroker,
  sessionHomePath,
  type AgentSpawnBrokerOptions,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

let root: string;
let options: AgentSpawnBrokerOptions;
const cap = 4 * 1024 ** 3;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'verity-package-cache-'));
  options = {
    runtimeDir: root,
    enforceRoot: false,
    agentUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function cache(parent: string) {
  const path = join(parent, '_cacache');
  await mkdir(join(path, 'content-v2'), { recursive: true });
  await writeFile(join(path, 'content-v2', 'entry'), 'regenerable package content');
  return path;
}
async function legacy(sessionId: string) {
  const home = await prepareSessionHome(sessionId, options);
  return { home, path: await cache(join(home, 'cache')) };
}

describe('broker package caches', () => {
  it.each(['codex-acp', 'claude-agent-acp', 'opencode-acp'] as const)(
    'shares only npm content across %s homes and isolation modes',
    (command) => {
      const paths = new Set<string>();
      for (const mode of ['normal', 'planning', 'knowledge']) {
        const home = join(root, mode);
        const request = {
          command,
          args: [],
          cwd: root,
          ...(mode === 'normal'
            ? { managedHome: home }
            : {
                knowledgeHome: home,
                planning: mode === 'planning',
                knowledgeIsolation: mode === 'knowledge',
              }),
        };
        const spec = agentLaunchSpec(request, options);
        const env = spec.spawnOptions.env!;
        expect(env.HOME).toBe(home);
        expect(env.npm_config_logs_dir).toBe(join(home, 'cache', '_logs'));
        expect(env.XDG_CONFIG_HOME).toBe(join(home, 'config'));
        expect(env.XDG_CACHE_HOME).not.toBe(env.npm_config_cache);
        paths.add(env.npm_config_cache!);
        const flag = mode === 'planning' ? '--runtime-root' : '--write-root';
        expect(spec.args).toContain(flag);
        expect(spec.args[spec.args.indexOf(flag) + 1]).toBe(join(root, 'package-cache', 'npm'));
      }
      expect([...paths]).toEqual([join(root, 'package-cache', 'npm')]);
      const other = agentLaunchSpec(
        { command, args: [], cwd: root },
        { ...options, runtimeDir: `${root}-other-project` },
      );
      expect(other.spawnOptions.env!.npm_config_cache).not.toBe([...paths][0]);
    },
  );

  it('supports concurrent writers and defers destructive maintenance until every lease closes', async () => {
    const first = await acquirePackageCacheLease(options);
    const second = await acquirePackageCacheLease(options);
    try {
      await cache(join(root, 'package-cache', 'npm'));
      const busy = await reclaimPackageCaches({ sessionIds: [], maxBytes: 1 }, options);
      expect(busy).toMatchObject({
        sharedBytes: null,
        removedBytes: 0,
        usageComplete: false,
        sharedCachePruned: false,
      });
      expect(busy.blockers).toContain('package cache is in use');
      await first.close();
      expect(
        (await reclaimPackageCaches({ sessionIds: [], maxBytes: 1 }, options)).sharedCachePruned,
      ).toBe(false);
    } finally {
      await first.close();
      await second.close();
    }
    const clean = await reclaimPackageCaches({ sessionIds: [], maxBytes: 1 }, options);
    expect(clean).toMatchObject({ sharedBytes: 0, sharedCachePruned: true, usageComplete: true });
    expect(clean.removedBytes).toBeGreaterThan(0);
  });

  it('retains a lease inherited by a live child after the broker handle is closed', async () => {
    const lease = await acquirePackageCacheLease(options);
    const child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
      { stdio: ['ignore', 'pipe', 'pipe', lease.fd] },
    );
    const closed = once(child, 'close');
    try {
      await once(child.stdout!, 'data');
      await lease.close();
      await expect(acquirePackageCacheLease(options, true)).rejects.toThrow(
        'package cache is in use',
      );
    } finally {
      child.kill('SIGKILL');
      await closed;
      await lease.close();
    }
    await (await acquirePackageCacheLease(options, true)).close();
  });

  it('removes only legacy cacache while preserving private logs and backend state', async () => {
    const { home, path } = await legacy('idle-session');
    await writeFile(join(home, 'cache', 'private-log'), 'private');
    await writeFile(join(home, 'codex-state', 'state'), 'backend state');
    const report = await reclaimPackageCaches(
      { sessionIds: ['idle-session'], maxBytes: cap },
      options,
    );
    expect(report).toMatchObject({
      legacyCachesRemoved: 1,
      legacyBytes: 0,
      sharedBytes: 0,
      usageComplete: true,
    });
    expect(report.removedBytes).toBeGreaterThan(0);
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(home, 'cache', 'private-log'), 'utf8')).toBe('private');
    expect(await readFile(join(home, 'codex-state', 'state'), 'utf8')).toBe('backend state');
  });

  it('defers a legacy home whose cross-process session lease is still held', async () => {
    const { home, path } = await legacy('busy-session');
    const child = spawn(
      '/usr/bin/flock',
      [
        '--exclusive',
        `${home}.lock`,
        process.execPath,
        '-e',
        "process.stdout.write('ready');setInterval(()=>{},1000)",
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    const closed = once(child, 'close');
    try {
      await once(child.stdout, 'data');
      const report = await reclaimPackageCaches(
        { sessionIds: ['busy-session'], maxBytes: cap },
        options,
      );
      expect(report).toMatchObject({
        legacyBytes: null,
        legacyCachesRemoved: 0,
        removedBytes: 0,
        usageComplete: false,
      });
      expect((await lstat(path)).isDirectory()).toBe(true);
    } finally {
      process.kill(-child.pid!, 'SIGKILL');
      await closed;
    }
  });

  it.each(['parent', 'leaf', 'entry', 'hardlink'])(
    'refuses a legacy cache with an unsafe %s without deleting its target',
    async (kind) => {
      const { home, path } = await legacy('unsafe-session');
      const outside = join(root, 'outside');
      await mkdir(outside);
      const target = join(outside, 'keep');
      await writeFile(target, 'retain');
      if (kind === 'parent') {
        await rm(join(home, 'cache'), { recursive: true });
        await symlink(outside, join(home, 'cache'));
      } else if (kind === 'leaf') {
        await rm(path, { recursive: true });
        await symlink(outside, path);
      } else if (kind === 'entry') await symlink(target, join(path, 'redirect'));
      else await link(target, join(path, 'hardlink'));
      const report = await reclaimPackageCaches(
        { sessionIds: ['unsafe-session'], maxBytes: cap },
        options,
      );
      expect(report).toMatchObject({
        legacyBytes: null,
        removedBytes: 0,
        legacyCachesRemoved: 0,
        usageComplete: false,
      });
      expect(await readFile(target, 'utf8')).toBe('retain');
    },
  );

  it('retains the shared cache below its cap and reports remaining allocated bytes', async () => {
    await (await acquirePackageCacheLease(options)).close();
    await cache(join(root, 'package-cache', 'npm'));
    const report = await reclaimPackageCaches(
      { sessionIds: ['absent-session'], maxBytes: cap },
      options,
    );
    expect(report).toMatchObject({
      sharedCachePruned: false,
      legacyBytes: 0,
      removedBytes: 0,
      usageComplete: true,
    });
    expect(report.sharedBytes).toBeGreaterThan(0);
  });

  it('retains unknown homes and reports their cache usage as unknown', async () => {
    const { path } = await legacy('unknown-session');
    const report = await reclaimPackageCaches({ sessionIds: [], maxBytes: cap }, options);
    expect(report).toMatchObject({ legacyBytes: null, removedBytes: 0, usageComplete: false });
    expect(report.blockers).toContain('session home ownership is unknown');
    expect((await lstat(path)).isDirectory()).toBe(true);
  });

  it.each([1, cap])(
    'retains non-cacache shared entries with unknown usage while applying the %i-byte cacache target',
    async (maxBytes) => {
      await (await acquirePackageCacheLease(options)).close();
      const npm = join(root, 'package-cache', 'npm');
      const cacache = await cache(npm);
      await mkdir(join(npm, '_npx'));
      await writeFile(join(npm, '_npx', 'keep'), 'retained execution cache');
      const report = await reclaimPackageCaches({ sessionIds: [], maxBytes }, options);
      expect(report).toMatchObject({
        sharedBytes: null,
        usageComplete: false,
        sharedCachePruned: maxBytes === 1,
      });
      expect(report.blockers).toContain(
        'Retained non-cacache npm cache entries have unknown allocation',
      );
      expect(await readFile(join(npm, '_npx', 'keep'), 'utf8')).toBe('retained execution cache');
      if (maxBytes === 1) {
        expect(report.removedBytes).toBeGreaterThan(0);
        await expect(lstat(cacache)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(report.removedBytes).toBe(0);
        expect((await lstat(cacache)).isDirectory()).toBe(true);
      }
    },
  );

  it('rejects a redirected session-homes root even when the requested home is absent', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep'), 'private');
    await symlink(outside, join(root, 'session-homes'));
    const report = await reclaimPackageCaches(
      { sessionIds: ['absent-session'], maxBytes: cap },
      options,
    );
    expect(report).toMatchObject({ legacyBytes: null, removedBytes: 0, usageComplete: false });
    expect(report.blockers).toContain('unsafe session homes root');
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('private');
    await expect(lstat(sessionHomePath(outside, 'absent-session'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('holds the cache lease for an actual broker child until exit and cleanup', async () => {
    await chmod(root, 0o770);
    let child: ReturnType<typeof spawn> | undefined;
    let ready!: () => void;
    const running = new Promise<void>((resolveReady) => {
      ready = resolveReady;
    });
    const broker = await runAgentSpawnBroker({
      ...options,
      worktreeRoot: root,
      scriptIsolation: { available: true },
      spawnChild: (_command, _args, spawnOptions) => {
        child = spawn(
          process.execPath,
          ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
          spawnOptions,
        );
        child.stdout!.once('data', ready);
        return child;
      },
    });
    const socket = createConnection(broker.socketPath);
    const ended = once(socket, 'end');
    socket.resume();
    try {
      await once(socket, 'connect');
      socket.write(
        `${JSON.stringify({ protocolVersion: 1, kind: 'spawn-agent', command: 'claude-agent-acp', args: [], cwd: root })}\n`,
      );
      await running;
      const busy = await reclaimPackageCaches({ sessionIds: [], maxBytes: 1 }, options);
      expect(busy).toMatchObject({ sharedBytes: null, usageComplete: false });
      expect(busy.blockers).toContain('package cache is in use');
      child!.kill('SIGKILL');
      await ended;
      await (await acquirePackageCacheLease(options, true)).close();
    } finally {
      child?.kill('SIGKILL');
      socket.destroy();
      await broker.close();
    }
  });

  it.each([
    { sessionIds: ['duplicate', 'duplicate'], maxBytes: cap },
    { sessionIds: [''], maxBytes: cap },
    { sessionIds: Array.from({ length: 1001 }, (_, i) => `session-${i}`), maxBytes: cap },
    { sessionIds: [], maxBytes: 0 },
    { sessionIds: [], maxBytes: Infinity },
  ])('rejects invalid bounded inventory requests', async (request) => {
    await expect(reclaimPackageCaches(request, options)).rejects.toThrow(/invalid/u);
  });

  it('routes the maintenance request through the privileged broker protocol', async () => {
    await chmod(root, 0o770);
    const broker = await runAgentSpawnBroker({
      ...options,
      worktreeRoot: root,
      scriptIsolation: { available: true },
    });
    try {
      const response = await new Promise<unknown>((resolveResponse, rejectResponse) => {
        const socket = createConnection(broker.socketPath);
        let text = '';
        socket.on('connect', () =>
          socket.write(
            `${JSON.stringify({ protocolVersion: 1, kind: 'reclaim-package-caches', sessionIds: [], maxBytes: cap })}\n`,
          ),
        );
        socket.on('data', (chunk) => {
          text += chunk.toString('utf8');
        });
        socket.on('error', rejectResponse);
        socket.on('end', () => {
          try {
            const response: unknown = JSON.parse(text);
            resolveResponse(response);
          } catch (error) {
            rejectResponse(error instanceof Error ? error : new Error('Invalid broker response'));
          }
        });
      });
      expect(response).toMatchObject({ ok: true, report: { usageComplete: true } });
    } finally {
      await broker.close();
    }
  });
});
