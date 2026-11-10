import { describe, expect, it, vi } from 'vitest';
import type {
  ContainerInspect,
  ContainerSpec,
  DockerClient,
  DockerContainerSummary,
} from './docker.js';
import {
  CACHE_HELPER_RESOURCES,
  RunnerCacheMaintenance,
  reclaimSleepingRunnerCaches,
} from './runner-cache-maintenance.js';
import { cacheHelperCommand } from './runner-cache-helper.js';

const report = {
  ok: true,
  report: {
    observedAt: '2026-11-09T19:00:00Z',
    sharedBytes: 0,
    legacyBytes: 12,
    removedBytes: 12,
    legacyCachesRemoved: 1,
    sharedCachePruned: false,
    usageComplete: true,
    blockers: [],
  },
};
describe('runner maintenance negotiation and ownership', () => {
  it('continues authenticated pages with database ownership rather than backend identity', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cacheMaintenanceVersion: 2, turnOwnershipVersion: 1 })
      .mockResolvedValueOnce({
        ok: true,
        maintenancePending: true,
        scanId: 'scan',
        cursor: '1',
        turnsNeedingOwnership: [{ turnId: 'turn', startCommandId: 'command' }],
      })
      .mockResolvedValueOnce(report);
    const resolveOwners = vi.fn(async () => [
      { turnId: 'turn', sessionId: 'session', conflict: false },
    ]);
    const offline = vi.fn();
    const maintenance = new RunnerCacheMaintenance({ request, resolveOwners, offline });
    expect(await maintenance.request('project', ['session'], 4096)).toEqual(report);
    expect(resolveOwners).toHaveBeenCalledWith({
      sessionIds: ['session'],
      turns: [{ turnId: 'turn', startCommandId: 'command' }],
    });
    expect(request.mock.calls[2]).toEqual([
      'project',
      {
        kind: 'reclaim-package-caches',
        maintenanceVersion: 2,
        sessionIds: ['session'],
        maxBytes: 4096,
        scanId: 'scan',
        turnOwners: [{ turnId: 'turn', sessionId: 'session', conflict: false }],
      },
    ]);
    expect(offline).not.toHaveBeenCalled();
  });
  it('retains a continuation across bounded passes', async () => {
    let time = 0;
    const request = vi.fn(async (_project: string, value: Record<string, unknown>) => {
      if (value.kind === 'status') return { cacheMaintenanceVersion: 2, turnOwnershipVersion: 1 };
      if (value.scanId) return report;
      time = 6000;
      return {
        ok: true,
        maintenancePending: true,
        scanId: 'scan',
        cursor: '1',
        turnsNeedingOwnership: [],
      };
    });
    const maintenance = new RunnerCacheMaintenance({
      request,
      resolveOwners: async () => [],
      offline: vi.fn(),
      now: () => time,
    });
    expect(await maintenance.request('p', [], 4096)).toMatchObject({
      report: { usageComplete: false, removedBytes: 0 },
    });
    expect(await maintenance.request('p', [], 4096)).toEqual(report);
    expect(request.mock.calls[3]?.[1]).toHaveProperty('scanId', 'scan');
  });
  it('only attempts independently fenced offline maintenance for an absent listener', async () => {
    const offline = vi.fn(async () => report);
    const request = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      .mockResolvedValueOnce({});
    const maintenance = new RunnerCacheMaintenance({
      request,
      resolveOwners: async () => [],
      offline,
    });
    expect(await maintenance.request('p', [], 4096)).toEqual(report);
    await expect(maintenance.request('p', [], 4096)).rejects.toMatchObject({
      runnerCacheFailure: { code: 'unsupported' },
    });
    expect(offline).toHaveBeenCalledOnce();
  });
  it('rejects unbound ownership results', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cacheMaintenanceVersion: 2, turnOwnershipVersion: 1 })
      .mockResolvedValueOnce({
        ok: true,
        maintenancePending: true,
        scanId: 'scan',
        cursor: '1',
        turnsNeedingOwnership: [{ turnId: 'expected' }],
      });
    const maintenance = new RunnerCacheMaintenance({
      request,
      resolveOwners: async () => [{ turnId: 'foreign', sessionId: 's', conflict: false }],
      offline: vi.fn(),
    });
    await expect(maintenance.request('p', ['s'], 4096)).rejects.toMatchObject({
      runnerCacheFailure: { code: 'invalid-response' },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

function fixture() {
  const image = `sha256:${'a'.repeat(64)}`;
  const existing: ContainerInspect = {
    id: 'project',
    imageId: 'old',
    running: false,
    status: 'exited',
    mounts: [{ type: 'bind', source: '/data/runners/p', destination: '/run/verity-runner' }],
  };
  const helpers = new Map<string, { summary: DockerContainerSummary; inspect: ContainerInspect }>();
  let sequence = 0;
  let nextExit = 0;
  let spec: ContainerSpec | undefined;
  const addHelper = (id: string, status = 'exited', since = Date.now() - 60_000) => {
    const labels = { 'verity.project-id': 'p', 'verity.component': 'runner-cache-maintenance' };
    const summary: DockerContainerSummary = {
      id,
      imageId: image,
      state: status,
      created: Math.floor(since / 1000),
      names: [
        `verity-cache-maintenance-12345678-1234-1234-1234-${String(helpers.size + 1).padStart(12, '0')}`,
      ],
      labels,
    };
    const inspect: ContainerInspect = {
      id,
      imageId: image,
      running: status === 'running',
      status,
      finishedAt: new Date(since).toISOString(),
      exitCode: 2,
      labels,
      mounts: existing.mounts,
    };
    helpers.set(id, { summary, inspect });
    return helpers.get(id)!;
  };
  const finish = (id: string, exitCode = nextExit) => {
    const helper = helpers.get(id)!;
    helper.summary.state = 'exited';
    Object.assign(helper.inspect, {
      status: 'exited',
      running: false,
      exitCode,
      finishedAt: new Date(Date.now() - 1000 + sequence).toISOString(),
    });
    return exitCode;
  };
  const docker = {
    listContainers: vi.fn(async (): Promise<DockerContainerSummary[]> => [
      {
        id: 'project',
        imageId: 'old',
        ...(existing.status === undefined ? {} : { state: existing.status }),
        ...(existing.labels === undefined ? {} : { labels: existing.labels }),
      },
      ...[...helpers.values()].map(({ summary }) => ({ ...summary })),
    ]),
    inspectContainer: vi.fn(async (id: string): Promise<ContainerInspect> => {
      if (id === 'self')
        return {
          id: 'self',
          running: true,
          status: 'running',
          mounts: [
            {
              type: 'volume',
              name: 'data',
              source: '/var/lib/docker/volumes/data/_data',
              destination: '/data',
            },
          ],
        };
      if (id === 'project') return existing;
      const helper = helpers.get(id);
      if (!helper) throw new Error('unknown container');
      return { ...helper.inspect };
    }),
    createContainer: vi.fn(async (value: ContainerSpec) => {
      spec = value;
      const id = ++sequence === 1 ? 'helper' : `helper-${sequence}`;
      const helper = addHelper(id, 'created', Date.now() - 1000 + sequence);
      helper.summary.names = [value.name];
      return { id, warnings: [] };
    }),
    startContainer: vi.fn(async (id: string) => {
      const helper = helpers.get(id)!;
      helper.summary.state = 'running';
      Object.assign(helper.inspect, { running: true, status: 'running' });
    }),
    waitContainer: vi.fn(async (id: string) => finish(id)),
    containerLogs: vi.fn(async () => JSON.stringify(report)),
    removeStoppedContainer: vi.fn(async (id: string) => {
      helpers.delete(id);
    }),
  };
  const assertIdle = vi.fn(async () => {});
  const run = (dataVolume?: { name: string; root: string }) =>
    reclaimSleepingRunnerCaches({
      docker: docker as unknown as DockerClient,
      projectId: 'p',
      runtimeRoot: '/data/runners/p',
      image,
      runtime: 'runsc',
      serverContainerId: 'self',
      sessionIds: ['idle'],
      maxBytes: 4096,
      assertIdle,
      ...(dataVolume ? { dataVolume } : {}),
    });
  return {
    docker,
    existing,
    helpers,
    addHelper,
    finish,
    assertIdle,
    run,
    setExit: (code: number) => {
      nextExit = code;
    },
    get spec() {
      return spec;
    },
  };
}
describe('sleeping runner cache helpers', () => {
  it('uses a restricted current image without waking the stopped project or deleting volumes', async () => {
    const h = fixture();
    expect(await h.run()).toEqual(report);
    expect(h.assertIdle).toHaveBeenCalledTimes(2);
    expect(h.docker.startContainer).toHaveBeenCalledExactlyOnceWith('helper');
    expect(h.spec?.command).toEqual(['-e', cacheHelperCommand]);
    expect(h.spec).toMatchObject({
      network: 'none',
      entrypoint: ['timeout', '--kill-after=5s', '25s', 'node'],
      // No swap beyond the memory bound; the pids bound covers gVisor host threads.
      memoryBytes: CACHE_HELPER_RESOURCES.memoryBytes,
      memorySwapBytes: CACHE_HELPER_RESOURCES.memoryBytes,
      pidsLimit: CACHE_HELPER_RESOURCES.pidsLimit,
      readOnlyRootfs: true,
      capDrop: ['ALL'],
      runtime: 'runsc',
      binds: ['/var/lib/docker/volumes/data/_data/runners/p:/run/verity-runner'],
      labels: { 'verity.project-id': 'p', 'verity.component': 'runner-cache-maintenance' },
    });
    expect(h.docker.removeStoppedContainer).toHaveBeenCalledExactlyOnceWith('helper');
  });
  it('uses the proven Docker host path when Server paths differ', async () => {
    const h = fixture();
    const inspect = h.docker.inspectContainer.getMockImplementation()!;
    h.docker.inspectContainer.mockImplementation(async (id) => {
      const result = await inspect(id);
      return id === 'self'
        ? {
            ...result,
            mounts: [
              { type: 'bind', source: '/srv/verity', destination: '/data' },
              { type: 'bind', source: '/srv/project-runtime', destination: '/data/runners/p' },
            ],
          }
        : result;
    });
    await h.run();
    expect(h.spec?.binds).toEqual(['/srv/project-runtime:/run/verity-runner']);
  });
  it('refuses a helper bind without proven host storage', async () => {
    const h = fixture();
    const inspect = h.docker.inspectContainer.getMockImplementation()!;
    h.docker.inspectContainer.mockImplementation(async (id) => {
      const result = await inspect(id);
      return id === 'self' ? { ...result, mounts: [] } : result;
    });
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: { code: 'runtime-not-idle' },
    });
    expect(h.docker.createContainer).not.toHaveBeenCalled();
  });
  it.each(['running', 'created', 'paused', 'unknown'])(
    'retains caches when a consumer is %s',
    async (status) => {
      const h = fixture();
      h.existing.status = status;
      h.existing.running = status === 'running';
      await expect(h.run()).rejects.toMatchObject({
        runnerCacheFailure: { code: 'runtime-not-idle' },
      });
      expect(h.docker.createContainer).not.toHaveBeenCalled();
    },
  );
  it('removes an owned never-started helper before retrying without leaving an admission fence', async () => {
    const h = fixture();
    h.addHelper('abandoned', 'created');
    expect(await h.run()).toEqual(report);
    expect(h.helpers.has('abandoned')).toBe(false);
    expect(h.docker.removeStoppedContainer).toHaveBeenNthCalledWith(1, 'abandoned');
    expect(h.docker.removeStoppedContainer).toHaveBeenNthCalledWith(2, 'helper');
    expect(h.docker.createContainer).toHaveBeenCalledOnce();
  });

  it('blocks an unlabelled consumer of a parent bind', async () => {
    const h = fixture();
    h.existing.running = true;
    h.existing.mounts![0]!.source = '/data';
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: { code: 'runtime-not-idle' },
    });
  });
  it.each([
    'runners',
    'runners/p',
    'runners/p/session-homes',
    'runners/./p/session-homes',
    '',
    '../runners/p',
  ])('blocks unlabelled named-volume consumers of overlapping subpath %s', async (subpath) => {
    const h = fixture();
    h.existing.running = true;
    h.existing.status = 'running';
    h.existing.mounts = [
      {
        type: 'volume',
        name: 'data',
        source: '/var/lib/docker/volumes/data/_data',
        subpath,
        destination: '/foreign',
      },
    ];
    await expect(h.run({ name: 'data', root: '/data' })).rejects.toMatchObject({
      runnerCacheFailure: { code: 'runtime-not-idle' },
    });
    expect(h.docker.createContainer).not.toHaveBeenCalled();
  });
  it('blocks a host bind alias of the Server data volume', async () => {
    const h = fixture();
    h.existing.running = true;
    h.existing.status = 'running';
    h.existing.mounts = [
      {
        type: 'bind',
        source: '/var/lib/docker/volumes/data/_data/runners/p/session-homes',
        destination: '/foreign',
      },
    ];
    await expect(h.run({ name: 'data', root: '/data' })).rejects.toMatchObject({
      runnerCacheFailure: { code: 'runtime-not-idle' },
    });
    expect(h.docker.createContainer).not.toHaveBeenCalled();
  });

  it('allows a disjoint named-volume project subpath', async () => {
    const h = fixture();
    h.existing.running = true;
    h.existing.status = 'running';
    h.existing.mounts = [
      {
        type: 'volume',
        name: 'data',
        source: '/var/lib/docker/volumes/data/_data',
        subpath: 'runners/other',
        destination: '/foreign',
      },
    ];
    expect(await h.run({ name: 'data', root: '/data' })).toEqual(report);
  });

  it('fails closed on inventory and lifecycle errors', async () => {
    const h = fixture();
    h.docker.listContainers.mockRejectedValueOnce(new Error('inventory unavailable'));
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: { code: 'maintenance-helper-retention-blocked' },
    });
    expect(h.docker.createContainer).not.toHaveBeenCalled();
    h.assertIdle.mockRejectedValueOnce(new Error('new turn'));
    await expect(h.run()).rejects.toThrow('new turn');
  });
  it('leaves a disconnected running helper and prevents another start', async () => {
    const h = fixture();
    h.docker.waitContainer.mockRejectedValueOnce(new Error('private connection detail'));
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: { code: 'maintenance-helper-failed', phase: 'wait' },
      runnerCacheCleanupFailed: true,
    });
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: { code: 'maintenance-helper-retention-blocked' },
    });
    expect(h.docker.createContainer).toHaveBeenCalledOnce();
    expect(h.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it.each([
    'x'.repeat(65537),
    'malformed',
    JSON.stringify({ ok: true, report: { removedBytes: 12 } }),
  ])('retains the latest helper with invalid output %#', async (output) => {
    const h = fixture();
    h.docker.containerLogs.mockResolvedValueOnce(output);
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: { code: 'invalid-response', phase: 'response', exitCode: 0 },
    });
    expect(h.helpers.has('helper')).toBe(true);
    expect(h.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it.each([2, 78])(
    'reads bounded diagnostics and retains a stopped helper after exit %s',
    async (exitCode) => {
      const h = fixture();
      h.setExit(exitCode);
      h.docker.containerLogs.mockResolvedValueOnce('private failure detail');
      const error = await h.run().catch((error: unknown) => error);
      expect(error).toMatchObject({
        runnerCacheFailure: {
          code: exitCode === 78 ? 'unsupported' : 'maintenance-helper-failed',
          exitCode,
          outputBytes: 22,
          memoryBytes: h.spec!.memoryBytes,
          pidsLimit: h.spec!.pidsLimit,
        },
      });
      expect(JSON.stringify(error)).not.toContain('private failure detail');
      expect(h.docker.containerLogs).toHaveBeenCalledExactlyOnceWith('helper', 1);
      expect(h.helpers.has('helper')).toBe(true);
      expect(h.docker.removeStoppedContainer).not.toHaveBeenCalled();
    },
  );
  it('classifies exit 78 as unsupported even when its logs cannot be read', async () => {
    const h = fixture();
    h.setExit(78);
    h.docker.containerLogs.mockRejectedValueOnce(new Error('private log detail'));
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: { code: 'unsupported', exitCode: 78, phase: 'logs' },
    });
    expect(h.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('retains the latest helper and sanitizes a failed log read', async () => {
    const h = fixture();
    h.docker.containerLogs.mockRejectedValueOnce(new Error('private log detail'));
    const error = await h.run().catch((error: unknown) => error);
    expect(error).toMatchObject({
      runnerCacheFailure: { code: 'maintenance-helper-failed', phase: 'logs', exitCode: 0 },
    });
    expect(JSON.stringify(error)).not.toContain('private log detail');
    expect(h.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('propagates nonforcing success cleanup failures for later recovery', async () => {
    const h = fixture();
    h.docker.removeStoppedContainer.mockRejectedValueOnce(new Error('removal unavailable'));
    await expect(h.run()).rejects.toThrow('removal unavailable');
    expect(h.helpers.has('helper')).toBe(true);
  });
  it('retains a helper if the post-wait inspection cannot prove termination', async () => {
    const h = fixture();
    const inspect = h.docker.inspectContainer.getMockImplementation()!;
    h.docker.inspectContainer.mockImplementation(async (id) => {
      const value = await inspect(id);
      return id === 'helper' ? { ...value, running: true, status: 'running' } : value;
    });
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: { code: 'maintenance-helper-failed', phase: 'inspect' },
      runnerCacheCleanupFailed: true,
    });
    expect(h.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('keeps the previous failed run when a later retry succeeds', async () => {
    const h = fixture();
    h.addHelper('old-failure');
    await h.run();
    expect([...h.helpers.keys()]).toEqual(['old-failure']);
    expect(h.docker.removeStoppedContainer).toHaveBeenCalledExactlyOnceWith('helper');
  });
  it('converges repeated failures to one newest run and preserves it after a successful retry', async () => {
    const h = fixture();
    h.setExit(2);
    for (let run = 1; run <= 4; run++) {
      await expect(h.run()).rejects.toMatchObject({
        runnerCacheFailure: { code: 'maintenance-helper-failed' },
      });
      expect(h.helpers.size).toBe(1);
      expect(h.helpers.has(run === 1 ? 'helper' : `helper-${run}`)).toBe(true);
    }
    h.setExit(0);
    await h.run();
    expect([...h.helpers.keys()]).toEqual(['helper-4']);
    expect(h.docker.createContainer).toHaveBeenCalledTimes(5);
  });
  it('skips new helper creation when old evidence cannot be bounded', async () => {
    const h = fixture();
    h.addHelper('oldest', 'exited', Date.now() - 120_000);
    h.addHelper('newer');
    h.docker.removeStoppedContainer.mockRejectedValueOnce(new Error('retention unavailable'));
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: { code: 'maintenance-helper-retention-blocked' },
    });
    expect(h.docker.createContainer).not.toHaveBeenCalled();
    expect(h.helpers.size).toBe(2);
  });
  it('blocks another helper when retained evidence has unknown timestamps', async () => {
    const h = fixture();
    delete h.addHelper('unknown').inspect.finishedAt;
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: { code: 'maintenance-helper-retention-blocked' },
    });
    expect(h.docker.createContainer).not.toHaveBeenCalled();
    expect(h.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
});

describe('helper recovery after uncertain Docker outcomes', () => {
  it('removes a never-started helper when start fails and preserves sanitized diagnostics', async () => {
    const h = fixture();
    h.docker.startContainer.mockRejectedValueOnce(new Error('private launch detail'));
    const error = await h.run().catch((error: unknown) => error);
    expect(error).toMatchObject({
      runnerCacheFailure: { code: 'maintenance-helper-failed', phase: 'start' },
    });
    expect(JSON.stringify(error)).not.toContain('private launch detail');
    expect(h.helpers.has('helper')).toBe(false);
    expect(h.docker.removeStoppedContainer).toHaveBeenCalledExactlyOnceWith('helper');
  });
  it('preserves previous completed failure evidence after failed start and admits a successful retry', async () => {
    const h = fixture();
    h.addHelper('previous-failure');
    h.docker.startContainer.mockRejectedValueOnce(new Error('private launch detail'));
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: { code: 'maintenance-helper-failed', phase: 'start' },
    });
    expect([...h.helpers.keys()]).toEqual(['previous-failure']);
    expect(h.docker.removeStoppedContainer).toHaveBeenCalledExactlyOnceWith('helper');
    await expect(h.run()).resolves.toEqual(report);
    expect([...h.helpers.keys()]).toEqual(['previous-failure']);
    expect(h.docker.createContainer).toHaveBeenCalledTimes(2);
    expect(h.docker.removeStoppedContainer).toHaveBeenNthCalledWith(2, 'helper-2');
  });
  it('retains a confirmed stopped helper after wait loses its reply', async () => {
    const h = fixture();
    h.docker.waitContainer.mockImplementationOnce(async (id) => {
      h.finish(id, 2);
      throw new Error('private wait detail');
    });
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: { code: 'maintenance-helper-failed', phase: 'wait' },
    });
    expect(h.helpers.has('helper')).toBe(true);
    expect(h.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('sanitizes create failure without attempting an unidentified removal', async () => {
    const h = fixture();
    h.docker.createContainer.mockRejectedValueOnce(new Error('private create detail'));
    const error = await h.run().catch((error: unknown) => error);
    expect(error).toMatchObject({
      runnerCacheFailure: { code: 'maintenance-helper-failed', phase: 'create' },
    });
    expect(JSON.stringify(error)).not.toContain('private create detail');
    expect(h.docker.startContainer).not.toHaveBeenCalled();
    expect(h.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('retains a helper when inspection is unavailable after timeout', async () => {
    const h = fixture();
    const inspect = h.docker.inspectContainer.getMockImplementation()!;
    h.docker.inspectContainer.mockImplementation(async (id) => {
      if (id === 'helper') throw new Error('inspection unavailable');
      return inspect(id);
    });
    h.docker.waitContainer.mockRejectedValueOnce(new Error('private timeout detail'));
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: { code: 'maintenance-helper-failed', phase: 'wait' },
      runnerCacheCleanupFailed: true,
    });
    expect(h.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('preserves resource failure diagnostics when pruning older evidence also fails', async () => {
    const h = fixture();
    h.addHelper('older-failure');
    h.setExit(2);
    h.docker.containerLogs.mockResolvedValueOnce(
      '[FATAL tini (2)] exec timeout failed: Cannot allocate memory',
    );
    h.docker.removeStoppedContainer.mockRejectedValueOnce(new Error('removal unavailable'));
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: {
        code: 'maintenance-helper-failed',
        phase: 'response',
        exitCode: 2,
        reason: 'resource-unavailable',
      },
      runnerCacheCleanupFailed: true,
      errors: [
        expect.objectContaining({ runnerCacheFailure: expect.any(Object) }),
        expect.objectContaining({ message: 'removal unavailable' }),
      ],
    });
    expect(h.helpers.size).toBe(2);
  });
});
