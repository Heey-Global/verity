import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { ProjectRecord } from '@verity/store';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListeningProcess } from './listening-ports.js';
import type { LocalPreviewShare } from './local-preview-manager.js';
import {
  MANAGED_SILENT_LIMIT_MS,
  MANAGED_STARTUP_DEADLINE_MS,
  ManagedDevServerManager,
  type ManagedDevServerRuntime,
  type ManagedLocalShares,
} from './managed-dev-server-manager.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => ctx.close());

/** A sandbox in memory: started instances listen once `listen()` is called. */
function fakeSandbox() {
  const alive = new Map<string, { exitCode: number | null; alive: boolean }>();
  const listeners: ListeningProcess[] = [];
  const started: Array<{
    instanceId: string;
    command: string;
    workdir: string;
    env: Record<string, string>;
  }> = [];
  const stop = vi.fn<ManagedDevServerRuntime['stopManagedServer']>(async (_project, instanceId) => {
    alive.set(instanceId, { alive: false, exitCode: 143 });
    for (let i = listeners.length - 1; i >= 0; i--)
      if (listeners[i]!.instanceId === instanceId) listeners.splice(i, 1);
  });
  const runtime: ManagedDevServerRuntime = {
    startManagedServer: vi.fn<ManagedDevServerRuntime['startManagedServer']>(
      async (_project, input) => {
        started.push(input);
        alive.set(input.instanceId, { alive: true, exitCode: null });
        return { ok: true as const };
      },
    ),
    stopManagedServer: stop,
    managedServerStatus: vi.fn<ManagedDevServerRuntime['managedServerStatus']>(
      async (_project, instanceId) => alive.get(instanceId) ?? { alive: false, exitCode: null },
    ),
    managedServerLogs: vi.fn<ManagedDevServerRuntime['managedServerLogs']>(
      async () => 'log line\n',
    ),
    listListeningProcesses: vi.fn<ManagedDevServerRuntime['listListeningProcesses']>(async () => [
      ...listeners,
    ]),
  };
  const listen = (instanceId: string, port: number) =>
    listeners.push({
      port,
      bind: 'any',
      pid: 1,
      cwd: '/work',
      command: 'node',
      instanceId,
      sessionId: 's1',
    });
  const crash = (instanceId: string, exitCode: number) => {
    alive.set(instanceId, { alive: false, exitCode });
    for (let i = listeners.length - 1; i >= 0; i--)
      if (listeners[i]!.instanceId === instanceId) listeners.splice(i, 1);
  };
  const recreate = () => {
    alive.clear();
    listeners.splice(0);
  };
  return { runtime, stop, started, listen, crash, recreate, listeners };
}

function fakeShares() {
  const shares: LocalPreviewShare[] = [];
  const ports = new Map<string, number>();
  const create = vi.fn<ManagedLocalShares['create']>(async (sessionId, input) => {
    const share = {
      id: `local-${String(input.networkPort)}`,
      url: `http://verity.local:${String(input.networkPort)}`,
      projectId: 'p1',
      sessionId,
      targetPort: input.targetPort,
      staticPath: null,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
    };
    shares.push(share);
    ports.set(share.id, input.networkPort);
    return share;
  });
  const local: ManagedLocalShares = {
    create,
    stop: async (id) => {
      const index = shares.findIndex((share) => share.id === id);
      if (index >= 0) shares.splice(index, 1);
      return index >= 0;
    },
    list: (sessionId) => shares.filter((share) => share.sessionId === sessionId),
    heldPorts: () => new Map(shares.map((share) => [ports.get(share.id)!, share])),
    portOf: (id) => ports.get(id),
  };
  return { local, create, shares };
}

let now = Date.parse('2026-10-05T10:00:00Z');
let sandbox: ReturnType<typeof fakeSandbox>;
let shares: ReturnType<typeof fakeShares>;
let manager: ManagedDevServerManager;

beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'local',
    repo: 'demo',
    containerName: 'sandbox',
    state: 'active',
  });
  await ctx.store.createSession({
    sessionId: 's1',
    worktree: '/clone/s1',
    model: 'm',
    projectId: 'p1',
  });
  await ctx.store.createSession({
    sessionId: 's2',
    worktree: '/clone/s2',
    model: 'm',
    projectId: 'p1',
  });
  sandbox = fakeSandbox();
  shares = fakeShares();
  manager = new ManagedDevServerManager({
    store: ctx.store,
    runtime: sandbox.runtime,
    localShares: shares.local,
    networkPorts: [8100, 8101],
    sandboxWorktree: (_project: ProjectRecord, worktree: string) =>
      worktree.replace('/clone', '/work'),
    now: () => now,
  });
});
afterEach(() => manager.close());

const instanceOf = async (sessionId = 's1') => (await manager.view(sessionId))[0]!.instance!;

describe('isolated managed server runtimes', () => {
  it('stops an active sibling even when the calling session is sleeping', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.start('s2', 'Demo', 'agent');
    const instanceId = sandbox.started[0]!.instanceId;
    manager.close();
    const resolve = vi.fn(async (sessionId: string, project: ProjectRecord) => ({
      ...project,
      containerName: `private-${sessionId}`,
      state: sessionId === 's1' ? ('sleeping' as const) : ('active' as const),
    }));
    manager = new ManagedDevServerManager({
      store: ctx.store,
      runtime: sandbox.runtime,
      networkPorts: [8100, 8101],
      sandboxWorktree: () => '/work',
      resolveSessionProject: resolve,
    });
    await ctx.store.updateProjectState('p1', 'sleeping');
    await manager.stopElsewhere('s1', instanceId);
    expect(sandbox.stop).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: 'private-s2', state: 'active' }),
      instanceId,
    );
  });

  it('stops legacy migration processes without resolving a private clone and propagates failures', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.start('s1', 'Demo', 'agent');
    manager.close();
    const resolve = vi.fn(async () => {
      throw new Error('Legacy linked worktree is not an independent clone');
    });
    manager = new ManagedDevServerManager({
      store: ctx.store,
      runtime: sandbox.runtime,
      networkPorts: [8100, 8101],
      sandboxWorktree: () => '/work',
      resolveSessionProject: resolve,
    });
    sandbox.stop.mockRejectedValueOnce(new Error('Runtime stop failed'));
    await expect(manager.stopSession('s1', { legacyRuntime: true })).rejects.toThrow(
      'Runtime stop failed',
    );
    expect(resolve).not.toHaveBeenCalled();
    await manager.stopSession('s1', { legacyRuntime: true });
    expect(sandbox.stop).toHaveBeenLastCalledWith(
      expect.objectContaining({ containerName: 'sandbox' }),
      sandbox.started[0]!.instanceId,
    );
    expect(
      (await ctx.store.managedDevServers.getInstance(sandbox.started[0]!.instanceId))?.state,
    ).toBe('stopped');
  });

  it('supervises active private siblings while the parent and another sibling sleep', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.start('s1', 'Demo', 'agent');
    await manager.start('s2', 'Demo', 'agent');
    const active = sandbox.started[1]!;
    sandbox.listen(active.instanceId, Number(active.env.PORT));
    manager.close();
    await ctx.store.updateProjectState('p1', 'sleeping');
    const scanned = vi.spyOn(sandbox.runtime, 'listListeningProcesses');
    scanned.mockClear();
    scanned.mockImplementation(async (project) => {
      if (project.containerName !== 'private-s2') throw new Error('Container is stopped');
      return sandbox.listeners;
    });
    manager = new ManagedDevServerManager({
      store: ctx.store,
      runtime: sandbox.runtime,
      networkPorts: [8100, 8101],
      sandboxWorktree: () => '/work',
      resolveSessionProject: async (sessionId, project) => ({
        ...project,
        containerName: `private-${sessionId}`,
        state: sessionId === 's2' ? 'active' : 'sleeping',
      }),
      now: () => now,
    });
    await manager.tick();
    expect(scanned.mock.calls.map(([project]) => project.containerName)).toEqual(['private-s2']);
    expect((await ctx.store.managedDevServers.getInstance(active.instanceId))?.state).toBe(
      'running',
    );
  });

  it('prepares only explicit starts and targets each session container for supervision and stop', async () => {
    manager.close();
    const resolve = vi.fn(async (sessionId: string, project: ProjectRecord) => ({
      ...project,
      containerName: `private-${sessionId}`,
    }));
    const started = vi.spyOn(sandbox.runtime, 'startManagedServer');
    const scanned = vi.spyOn(sandbox.runtime, 'listListeningProcesses');
    const prepare = vi.fn(async (sessionId: string, project: ProjectRecord) =>
      resolve(sessionId, project),
    );
    manager = new ManagedDevServerManager({
      store: ctx.store,
      runtime: sandbox.runtime,
      networkPorts: [8100, 8101],
      sandboxWorktree: () => '/work',
      resolveSessionProject: resolve,
      prepareSessionProject: prepare,
      now: () => now,
    });
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.view('s2');
    expect(prepare).not.toHaveBeenCalled();

    await manager.start('s1', 'Demo', 'agent');
    await manager.start('s2', 'Demo', 'agent');
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['s1', 's2']);
    expect(started.mock.calls.map(([project]) => project.containerName)).toEqual([
      'private-s1',
      'private-s2',
    ]);
    for (const run of sandbox.started) sandbox.listen(run.instanceId, Number(run.env.PORT));
    scanned.mockClear();
    await manager.tick();
    expect(scanned.mock.calls.map(([project]) => project.containerName)).toEqual([
      'private-s1',
      'private-s2',
    ]);
    expect(prepare).toHaveBeenCalledTimes(2);
    await manager.logs('s1', 'Demo');
    expect(prepare).toHaveBeenCalledTimes(2);
    await manager.stop('s1', 'Demo');
    expect(sandbox.stop.mock.calls.at(-1)?.[0].containerName).toBe('private-s1');
    expect(sandbox.stop.mock.calls.some(([project]) => project.containerName === 'sandbox')).toBe(
      false,
    );
  });
});

describe('managed dev servers', () => {
  it('starts an entry with its own port and reports running only once the port answers', async () => {
    await manager.add('s1', {
      name: 'Curtis Demo',
      command: 'node server.mjs --port {port}',
      workdir: 'curtis-voice',
    });
    await manager.start('s1', 'curtis demo', 'agent');
    const [run] = sandbox.started;
    expect(run!.command).toMatch(/^node server\.mjs --port 41\d{3}$/u);
    expect(run!.env).toMatchObject({
      VERITY_SESSION_ID: 's1',
      PORT: run!.command.split(' ').at(-1),
    });
    expect(run!.workdir).toBe('curtis-voice');
    expect((await instanceOf()).state).toBe('starting');

    sandbox.listen(run!.instanceId, Number(run!.env.PORT));
    await manager.tick();
    expect((await instanceOf()).state).toBe('running');
  });

  // An agent-started server stays off the network until the operator approved
  // its command once; then it is published without another tap.
  it('publishes locally only after the operator approved the command', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.start('s1', 'Demo', 'agent');
    const run = sandbox.started[0]!;
    sandbox.listen(run.instanceId, Number(run.env.PORT));
    await manager.tick();
    expect(await instanceOf()).toMatchObject({
      state: 'running',
      url: null,
      awaitingApproval: true,
    });
    expect(shares.create).not.toHaveBeenCalled();

    await expect(
      manager.approve('s1', 'Demo', { command: 'node other.mjs', workdir: '.' }),
    ).rejects.toThrow(/changed in the meantime/u);
    await manager.approve('s1', 'Demo', { command: 'node server.mjs', workdir: '.' });
    expect(await instanceOf()).toMatchObject({
      url: 'http://verity.local:8100',
      awaitingApproval: false,
    });
  });

  it('refuses an operator start of an unapproved command', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await expect(manager.start('s1', 'Demo', 'operator')).rejects.toThrow(/approve/u);
    expect(sandbox.started).toHaveLength(0);
  });

  // A changed command keeps running the old one until a restart, and the old
  // approval does not carry over to the new command.
  it('needs a new approval after the agent changes the command', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.approve('s1', 'Demo', { command: 'node server.mjs', workdir: '.' });
    await manager.start('s1', 'Demo', 'operator');
    let run = sandbox.started[0]!;
    sandbox.listen(run.instanceId, Number(run.env.PORT));
    await manager.tick();
    expect((await instanceOf()).url).not.toBeNull();

    await manager.update('s1', 'Demo', { command: 'node changed.mjs' });
    expect(await instanceOf()).toMatchObject({ restartToApply: true });
    await manager.restart('s1', 'Demo', 'agent');
    run = sandbox.started[1]!;
    sandbox.listen(run.instanceId, Number(run.env.PORT));
    await manager.tick();
    expect(await instanceOf()).toMatchObject({
      url: null,
      awaitingApproval: true,
      restartToApply: false,
    });
  });

  it('reports a crash with its exit code and does not restart it', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.start('s1', 'Demo', 'agent');
    const run = sandbox.started[0]!;
    sandbox.listen(run.instanceId, Number(run.env.PORT));
    await manager.tick();
    sandbox.crash(run.instanceId, 1);
    await manager.tick();
    expect(await instanceOf()).toMatchObject({
      state: 'crashed',
      detail: 'The server exited with code 1',
    });
    await manager.tick();
    expect(sandbox.started).toHaveLength(1);
  });

  // The usual cause is a command that ignores $PORT; saying where it listens
  // instead lets the agent fix the entry.
  it('crashes and stops a server that never answers on its port', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.start('s1', 'Demo', 'agent');
    const run = sandbox.started[0]!;
    sandbox.listen(run.instanceId, 3000);
    now += MANAGED_STARTUP_DEADLINE_MS + 1;
    await manager.tick();
    expect(await instanceOf()).toMatchObject({
      state: 'crashed',
      detail: expect.stringContaining('listens on 3000 instead'),
    });
    expect(sandbox.stop).toHaveBeenCalled();
  });

  // After a sandbox is recreated nothing runs and no exit was recorded. The
  // server comes back with the command that last ran, not a pending update.
  it('retargets a retained local address after a sandbox-port collision', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.approve('s1', 'Demo', { command: 'node server.mjs', workdir: '.' });
    await manager.start('s1', 'Demo', 'agent');
    const first = sandbox.started[0]!;
    sandbox.listen(first.instanceId, Number(first.env.PORT));
    await manager.tick();
    const old = (await manager.view('s1'))[0]!.instance!;
    expect(old.localShareId).toBe(shares.shares[0]!.id);
    expect(old.localShareId).not.toBe(old.id);
    sandbox.recreate();
    sandbox.listeners.push({
      port: Number(first.env.PORT),
      bind: 'any',
      pid: 7,
      cwd: '/work',
      command: 'foreign',
      sessionId: 's1',
    });
    now += 10_000;
    await manager.tick();
    const second = sandbox.started[1]!;
    expect(second.env.PORT).not.toBe(first.env.PORT);
    sandbox.listen(second.instanceId, Number(second.env.PORT));
    await manager.tick();
    expect(shares.shares).toHaveLength(1);
    expect(shares.shares[0]!.targetPort).toBe(Number(second.env.PORT));
    expect((await manager.view('s1'))[0]!.instance!.url).toBe(old.url);
  });

  it('restarts after sandbox recreation with the command that last ran', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.start('s1', 'Demo', 'agent');
    sandbox.listen(sandbox.started[0]!.instanceId, Number(sandbox.started[0]!.env.PORT));
    await manager.tick();
    await manager.update('s1', 'Demo', { command: 'node pending.mjs' });
    sandbox.recreate();
    now += 10_000;
    await manager.tick();
    expect(sandbox.started).toHaveLength(2);
    expect(sandbox.started[1]!.command).toBe('node server.mjs');
  });

  // A sleeping sandbox must not turn the switch into an error: the start is
  // recorded, the sandbox wakes, and supervision starts the server afterwards.
  it('wakes a sleeping sandbox and starts the server once it is up', async () => {
    const wake = vi.fn(async () => {
      await ctx.store.updateProjectState('p1', 'active');
    });
    manager.close();
    manager = new ManagedDevServerManager({
      store: ctx.store,
      runtime: sandbox.runtime,
      localShares: shares.local,
      networkPorts: [8100, 8101],
      sandboxWorktree: (_project: ProjectRecord, worktree: string) => worktree,
      wakeSandbox: wake,
      now: () => now,
    });
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await ctx.store.updateProjectState('p1', 'sleeping');
    await manager.start('s1', 'Demo', 'agent');
    expect(await instanceOf()).toMatchObject({ state: 'starting', detail: 'Waking sandbox…' });
    expect(manager.hasRunningServers('p1')).toBe(true);
    expect(wake).toHaveBeenCalledWith('p1', 's1');
    expect(sandbox.started).toHaveLength(0);
    await vi.waitFor(async () => expect((await ctx.store.getProject('p1'))?.state).toBe('active'));
    now += 10_000;
    await manager.tick();
    expect(sandbox.started).toHaveLength(1);
  });

  // A parent process (npm, a watcher) can outlive its crashed server; the
  // address must not keep pointing at nothing.
  it('crashes a running server that stays off its port while processes live', async () => {
    await manager.add('s1', { name: 'Demo', command: 'npm run dev' });
    await manager.start('s1', 'Demo', 'agent');
    const run = sandbox.started[0]!;
    sandbox.listen(run.instanceId, Number(run.env.PORT));
    await manager.tick();
    sandbox.listeners.splice(0);
    await manager.tick();
    expect((await instanceOf()).state).toBe('running');
    now += MANAGED_SILENT_LIMIT_MS + 1;
    await manager.tick();
    expect(await instanceOf()).toMatchObject({
      state: 'crashed',
      detail: 'Stopped answering on its port',
    });
  });

  it('refuses an operator restart of a changed command before stopping anything', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.start('s1', 'Demo', 'agent');
    await manager.update('s1', 'Demo', { command: 'node changed.mjs' });
    await expect(manager.restart('s1', 'Demo', 'operator')).rejects.toThrow(/approve/u);
    expect(sandbox.stop).not.toHaveBeenCalled();
  });

  // A moved session leaves its instances behind in the source project, where
  // they would hold network ports nobody can manage any more.
  it('forgets a moved session’s instances after stopping them', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.start('s1', 'Demo', 'agent');
    await manager.stopSession('s1', { forget: true });
    expect(sandbox.stop).toHaveBeenCalled();
    expect(await ctx.store.managedDevServers.listInstances({ sessionId: 's1' })).toEqual([]);
  });

  it('stops recovering a server that keeps disappearing without an exit code', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.start('s1', 'Demo', 'agent');
    for (let round = 0; round < 4; round++) {
      sandbox.recreate();
      now += 10_000;
      await manager.tick();
    }
    expect(sandbox.started).toHaveLength(4);
    expect(await instanceOf()).toMatchObject({
      state: 'crashed',
      detail: expect.stringContaining('stopped from outside'),
    });
  });

  // A sandbox put to sleep keeps its /tmp; an exit code from an earlier run
  // must not be read as the woken start crashing.
  it('launches a woken instance even when an old exit code is left behind', async () => {
    manager.close();
    manager = new ManagedDevServerManager({
      store: ctx.store,
      runtime: sandbox.runtime,
      localShares: shares.local,
      networkPorts: [8100, 8101],
      sandboxWorktree: (_project: ProjectRecord, worktree: string) => worktree,
      wakeSandbox: () => ctx.store.updateProjectState('p1', 'active'),
      now: () => now,
    });
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.start('s1', 'Demo', 'agent');
    const first = sandbox.started[0]!;
    sandbox.crash(first.instanceId, 1);
    await manager.stop('s1', 'Demo');
    await ctx.store.updateProjectState('p1', 'sleeping');
    await manager.start('s1', 'Demo', 'agent');
    await vi.waitFor(async () => expect((await ctx.store.getProject('p1'))?.state).toBe('active'));
    sandbox.crash(first.instanceId, 1);
    await manager.tick();
    expect(sandbox.started).toHaveLength(2);
  });

  it('stops tagged processes whose instance no longer exists', async () => {
    const project = (await ctx.store.getProject('p1'))!;
    await manager.sweepOrphans(project, [
      { port: 41000, bind: 'any', pid: 9, cwd: '/work', command: 'node', instanceId: 'gone' },
    ]);
    expect(sandbox.stop).toHaveBeenCalledWith(expect.anything(), 'gone');
  });

  it('gives sibling entries of the session their internal URLs', async () => {
    await manager.add('s1', { name: 'Voice API', command: 'node api.mjs' });
    await manager.add('s1', { name: 'Web', command: 'vite --port {port}' });
    await manager.start('s1', 'Voice API', 'agent');
    const api = sandbox.started[0]!;
    await manager.start('s1', 'Web', 'agent');
    expect(sandbox.started[1]!.env.VERITY_SERVER_VOICE_API_URL).toBe(
      `http://127.0.0.1:${api.env.PORT!}`,
    );
  });

  it('shows instances in other sessions and stops them from there', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.start('s2', 'Demo', 'agent');
    const [view] = await manager.view('s1');
    expect(view!.instance).toBeNull();
    expect(view!.elsewhere).toHaveLength(1);
    await manager.stopElsewhere('s1', view!.elsewhere[0]!.instanceId);
    expect((await manager.view('s1'))[0]!.elsewhere).toHaveLength(0);
  });

  it('stops a session’s servers before the session goes away', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.start('s1', 'Demo', 'agent');
    await manager.stopSession('s1');
    expect(sandbox.stop).toHaveBeenCalledWith(expect.anything(), sandbox.started[0]!.instanceId);
  });

  it('removes an entry only after stopping every instance', async () => {
    await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
    await manager.start('s1', 'Demo', 'agent');
    await manager.start('s2', 'Demo', 'agent');
    await manager.remove('s1', 'Demo');
    expect(sandbox.stop).toHaveBeenCalledTimes(2);
    expect(await manager.view('s1')).toEqual([]);
  });
});

it('removes network access when repeated external kills exhaust recovery', async () => {
  await manager.add('s1', { name: 'Demo', command: 'node server.mjs' });
  await manager.approve('s1', 'Demo', { command: 'node server.mjs', workdir: '.' });
  await manager.start('s1', 'Demo', 'agent');
  for (let attempt = 0; attempt < 4; attempt++) {
    const launched = sandbox.started.at(-1)!;
    sandbox.listen(launched.instanceId, Number(launched.env.PORT));
    await manager.tick();
    expect(shares.shares).toHaveLength(1);
    sandbox.recreate();
    now += 10_000;
    await manager.tick();
  }
  expect(await instanceOf()).toMatchObject({ state: 'crashed', desired: 'stopped' });
  expect(shares.shares).toHaveLength(0);
});
