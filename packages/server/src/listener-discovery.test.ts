import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import { InMemoryEventBus } from '@verity/session';
import type { ListeningProcess } from './listening-ports.js';
import { ListenerDiscovery } from './listener-discovery.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(() =>
    Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn(),
    }),
  ),
}));

describe('independent listener discovery', () => {
  it('shares in-flight scans with background refresh and reuses only fresh snapshots', async () => {
    const project = {
      id: 'p',
      owner: 'org',
      repo: 'repo',
      containerName: 'sandbox',
      state: 'active',
    };
    const session = { sessionId: 'a', projectId: 'p', worktree: '/data/org-repo/a' };
    const store = {
      getSession: vi.fn(async () => session),
      getProject: vi.fn(async () => project),
      listSessions: vi.fn(async () => [session]),
      getLatestDevServersEvent: vi.fn(async () => undefined),
      appendEvent: vi.fn(async () => ({ seq: 1, ts: 0 })),
    } as unknown as EventStore;
    let release!: (processes: ListeningProcess[]) => void;
    const scan = vi.fn(
      () =>
        new Promise<ListeningProcess[]>((done) => {
          release = done;
        }),
    );
    const bus = new InMemoryEventBus();
    const onScan = vi.fn();
    const discovery = new ListenerDiscovery({
      eventStore: store,
      bus,
      onScan,
      hostCloneRoot: '/data',
      scan,
    });
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const refresh = discovery.refreshProject(
        project as Parameters<typeof discovery.refreshProject>[0],
      );
      const first = discovery.listSessionDevServers('a');
      const second = discovery.listSessionDevServers('a');
      await new Promise((done) => setImmediate(done));
      expect(scan).toHaveBeenCalledOnce();
      release([]);
      await Promise.all([refresh, first, second]);
      await discovery.listSessionDevServers('a');
      expect(scan).toHaveBeenCalledOnce();
      bus.publish('a', {
        seq: 1,
        ts: 0,
        event: { t: 'tool_result', id: 'tool', output: '', isError: false },
      });
      await new Promise((done) => setImmediate(done));
      expect(scan).toHaveBeenCalledOnce();
      expect(onScan).toHaveBeenCalledOnce();
      now = 2_001;
      scan.mockImplementation(async () => []);
      await discovery.listSessionDevServers('a');
      expect(scan).toHaveBeenCalledTimes(2);
      await discovery.refreshProject(project as Parameters<typeof discovery.refreshProject>[0]);
      expect(scan).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
      discovery.close();
    }
  });

  it('rescans after a change arrives during a GET scan and drops replaced-container results', async () => {
    const project = {
      id: 'p',
      owner: 'org',
      repo: 'repo',
      containerName: 'sandbox',
      state: 'active',
    };
    const session = { sessionId: 'a', projectId: 'p', worktree: '/data/org-repo/a' };
    const store = {
      getSession: vi.fn(async () => session),
      getProject: vi.fn(async () => ({ ...project })),
      listSessions: vi.fn(async () => [session]),
      listProjects: vi.fn(async () => [{ ...project }]),
      getLatestDevServersEvent: vi.fn(async () => undefined),
      appendEvent: vi.fn(async () => ({ seq: 1, ts: 0 })),
    } as unknown as EventStore;
    let release!: (processes: ListeningProcess[]) => void;
    const scan = vi
      .fn(async () => [] as ListeningProcess[])
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            release = done;
          }),
      );
    const discovery = new ListenerDiscovery({
      eventStore: store,
      bus: new InMemoryEventBus(),
      hostCloneRoot: '/data',
      scan,
    });
    try {
      const read = discovery.listSessionDevServers('a');
      await new Promise((done) => setImmediate(done));
      const refresh = discovery.refreshProject(
        project as Parameters<typeof discovery.refreshProject>[0],
      );
      release([]);
      await Promise.all([read, refresh]);
      await new Promise((done) => setImmediate(done));
      expect(scan).toHaveBeenCalledTimes(2);
      scan.mockImplementationOnce(
        () =>
          new Promise((done) => {
            release = done;
          }),
      );
      const oldRefresh = discovery.refreshProject(
        project as Parameters<typeof discovery.refreshProject>[0],
      );
      await new Promise((done) => setImmediate(done));
      project.containerName = 'replacement';
      const replacement = discovery.reconcile();
      await new Promise((done) => setImmediate(done));
      release([{ port: 5173, pid: 1, cwd: '/work/a', command: 'old', bind: 'any' }]);
      await Promise.all([oldRefresh, replacement]);
      expect(await discovery.listSessionDevServers('a')).toEqual([]);
      expect(scan).toHaveBeenCalledTimes(4);
    } finally {
      discovery.close();
    }
  });
  it('includes unassigned project listeners and excludes another session', async () => {
    const project = {
      id: 'p',
      owner: 'org',
      repo: 'repo',
      containerName: 'sandbox',
      state: 'active',
    };
    const sessions = [
      { sessionId: 'a', projectId: 'p', worktree: '/data/org-repo/a' },
      { sessionId: 'b', projectId: 'p', worktree: '/data/org-repo/b' },
    ];
    const store = {
      getSession: vi.fn(async (id: string) => sessions.find((s) => s.sessionId === id)),
      getProject: vi.fn(async () => project),
      listSessions: vi.fn(async () => sessions),
    } as unknown as EventStore;
    const discovery = new ListenerDiscovery({
      eventStore: store,
      bus: new InMemoryEventBus(),
      hostCloneRoot: '/data',
      scan: async () => [
        { port: 5173, pid: 1, cwd: '/tmp', command: 'vite', bind: 'loopback', sessionId: 'a' },
        { port: 8000, pid: 2, cwd: '/work/b', command: 'node api', bind: 'any', sessionId: 'b' },
        { port: 8080, pid: 3, cwd: '/work', command: 'node server', bind: 'any' },
      ],
    });
    // Listing must work without provisioning a public share manager or entitlement.
    try {
      expect(await discovery.listSessionDevServers('a')).toMatchObject([
        { port: 5173, scope: 'session', reachable: true },
        { port: 8080, scope: 'project' },
      ]);
    } finally {
      discovery.close();
    }
  });
  it('does not append unchanged discovery snapshots after a restart', async () => {
    const project = {
      id: 'p',
      owner: 'org',
      repo: 'repo',
      containerName: 'sandbox',
      state: 'active',
    };
    const sessions = [{ sessionId: 'a', projectId: 'p', worktree: '/data/org-repo/a' }];
    let persisted: { t: 'dev_servers_changed'; devServers: unknown[] } | undefined;
    const appendEvent = vi.fn(async (_id: string, event: typeof persisted) => {
      persisted = event;
      return { seq: appendEvent.mock.calls.length, ts: Date.now() };
    });
    const store = {
      getProject: vi.fn(async () => project),
      listSessions: vi.fn(async () => sessions),
      listProjects: vi.fn(async () => [project]),
      getLatestDevServersEvent: vi.fn(async () => persisted),
      appendEvent,
    } as unknown as EventStore;
    let processes: ListeningProcess[] = [];
    const bus = new InMemoryEventBus();
    const refresh = async () => {
      const discovery = new ListenerDiscovery({
        eventStore: store,
        bus,
        hostCloneRoot: '/data',
        scan: async () => processes,
      });
      try {
        await discovery.reconcile();
        const child = vi.mocked(spawn).mock.results.at(-1)!.value;
        (child.stdout as PassThrough).emit('data', Buffer.from('changed\n'));
        // Await the scan's asynchronous append/publish before closing its watcher.
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        discovery.close();
      }
    };
    // An empty first scan must not make a previously read session look unread.
    await refresh();
    expect(appendEvent).not.toHaveBeenCalled();
    processes = [{ port: 5173, pid: 1, cwd: '/work/a', command: 'vite', bind: 'any' }];
    await refresh();
    expect(appendEvent).toHaveBeenCalledTimes(1);
    // The next server process rediscovers the same listener, not new activity.
    await refresh();
    expect(appendEvent).toHaveBeenCalledTimes(1);
    processes = [];
    await refresh();
    expect(appendEvent).toHaveBeenCalledTimes(2);
    expect(persisted).toEqual({ t: 'dev_servers_changed', devServers: [] });
  });
  it('retries a changed snapshot after its persistence fails', async () => {
    const project = {
      id: 'p',
      owner: 'org',
      repo: 'repo',
      containerName: 'sandbox',
      state: 'active',
    };
    const appendEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error('store unavailable'))
      .mockResolvedValue({ seq: 1, ts: Date.now() });
    const store = {
      getProject: vi.fn(async () => project),
      listSessions: vi.fn(async () => [
        { sessionId: 'a', projectId: 'p', worktree: '/data/org-repo/a' },
      ]),
      listProjects: vi.fn(async () => [project]),
      getLatestDevServersEvent: vi.fn(async () => undefined),
      appendEvent,
    } as unknown as EventStore;
    const discovery = new ListenerDiscovery({
      eventStore: store,
      bus: new InMemoryEventBus(),
      hostCloneRoot: '/data',
      scan: async () => [{ port: 5173, pid: 1, cwd: '/work/a', command: 'vite', bind: 'any' }],
    });
    try {
      await discovery.reconcile();
      const child = vi.mocked(spawn).mock.results.at(-1)!.value;
      (child.stdout as PassThrough).emit('data', Buffer.from('changed\n'));
      await new Promise((resolve) => setImmediate(resolve));
      (child.stdout as PassThrough).emit('data', Buffer.from('changed\n'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(appendEvent).toHaveBeenCalledTimes(2);
    } finally {
      discovery.close();
    }
  });
  it('retains healthy results on errors, clears inactive results and stops replaced watchers', async () => {
    const project = {
      id: 'p',
      owner: 'org',
      repo: 'repo',
      containerName: 'sandbox',
      state: 'active',
    };
    const sessions = [{ sessionId: 'a', projectId: 'p', worktree: '/data/org-repo/a' }];
    const appendEvent = vi.fn(async () => ({ seq: 1, ts: Date.now() }));
    const store = {
      getSession: vi.fn(async () => sessions[0]),
      getProject: vi.fn(async () => project),
      listSessions: vi.fn(async () => sessions),
      listProjects: vi.fn(async () => [project]),
      appendEvent,
      getLatestDevServersEvent: vi.fn(async () => undefined),
    } as unknown as EventStore;
    const scan = vi.fn(async () => [
      { port: 5173, pid: 1, cwd: '/work/a', command: 'vite', bind: 'any' as const },
    ]);
    const discovery = new ListenerDiscovery({
      eventStore: store,
      bus: new InMemoryEventBus(),
      hostCloneRoot: '/data',
      scan,
    });
    try {
      expect(await discovery.listSessionDevServers('a')).toHaveLength(1);
      const child = vi.mocked(spawn).mock.results.at(-1)!.value;
      expect(vi.mocked(spawn).mock.calls.at(-1)![1]).not.toContain('--user');
      scan.mockRejectedValueOnce(new Error('Docker unavailable'));
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_000);
      expect(await discovery.listSessionDevServers('a')).toHaveLength(1);
      clock.mockRestore();
      project.containerName = 'replacement';
      await discovery.reconcile();
      expect(vi.mocked(child).kill).toHaveBeenCalled();
      project.state = 'sleeping';
      await discovery.reconcile();
      expect(await discovery.listSessionDevServers('a')).toEqual([]);
      expect(appendEvent).toHaveBeenCalledWith('a', {
        t: 'dev_servers_changed',
        devServers: [],
      });
      project.state = 'active';
      await discovery.reconcile();
      const finalChild = vi.mocked(spawn).mock.results.at(-1)!.value;
      vi.mocked(store).listProjects.mockResolvedValueOnce([]);
      await discovery.reconcile();
      expect(vi.mocked(finalChild).kill).toHaveBeenCalled();
    } finally {
      discovery.close();
    }
  });
});
