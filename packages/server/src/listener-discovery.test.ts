import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import { InMemoryEventBus } from '@verity/session';
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
      expect(await discovery.listSessionDevServers('a')).toHaveLength(1);
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
