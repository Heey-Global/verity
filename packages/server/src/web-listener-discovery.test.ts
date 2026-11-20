import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { EventStore, ProjectRecord } from '@verity/store';
import { InMemoryEventBus } from '@verity/session';
import { ListenerDiscovery } from './listener-discovery.js';
import { DockerProjectRuntime, type RuntimeRunner } from './project-runtime.js';
import { LISTENING_PORTS_SCRIPT } from './listening-ports.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(() =>
    Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn(),
    }),
  ),
}));

describe('web classification freshness through discovery', () => {
  it('rechecks the protocol of an unchanged socket on an explicit fresh read', async () => {
    const project = {
      id: 'p',
      owner: 'org',
      repo: 'repo',
      containerName: 'sandbox',
      state: 'active',
    } as ProjectRecord;
    const store = {
      getProject: async () => project,
      getSession: async () => ({ projectId: 'p' }),
      listSessions: async () => [{ sessionId: 's', projectId: 'p', worktree: '/data/org-repo/s' }],
    } as unknown as EventStore;
    let web = true;
    const output =
      '#tcp\n 0: 00000000:1435 00000000:0000 0A 0:0 0:0 0 1000 0 21\n#fd\n/proc/42/fd:\nlrwx -> socket:[21]\n#proc\nP\t42\t/work/s\tnode server.js\n';
    const runner = vi.fn<RuntimeRunner>(async (_command, args) => ({
      stdout: args.includes(LISTENING_PORTS_SCRIPT)
        ? output
        : JSON.stringify([web ? { protocol: 'http' } : null]),
      stderr: '',
      exitCode: 0,
    }));
    const runtime = new DockerProjectRuntime({ runner });
    const discovery = new ListenerDiscovery({
      eventStore: store,
      bus: new InMemoryEventBus(),
      hostCloneRoot: '/data',
      scan: (target, options) => runtime.listWebListeningProcesses(target, options),
    });
    try {
      expect(await discovery.listSessionDevServers('s')).toHaveLength(1);
      web = false;
      expect(await discovery.listSessionDevServers('s')).toHaveLength(1);
      expect(await discovery.listSessionDevServers('s', { fresh: true })).toEqual([]);
      expect(runner).toHaveBeenCalledTimes(4);
    } finally {
      discovery.close();
    }
  });
});
