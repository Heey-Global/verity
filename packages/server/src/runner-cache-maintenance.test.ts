import { describe, expect, it, vi } from 'vitest';
import type {
  ContainerInspect,
  ContainerSpec,
  DockerClient,
  DockerContainerSummary,
} from './docker.js';
import { RunnerCacheMaintenance, reclaimSleepingRunnerCaches } from './runner-cache-maintenance.js';

const report = { ok: true, report: { removedBytes: 12 } };
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
  const existing: ContainerInspect = {
    id: 'project',
    running: false,
    status: 'exited',
    mounts: [{ type: 'bind', source: '/data/runners/p', destination: '/run/verity-runner' }],
  };
  let spec: ContainerSpec | undefined;
  const docker = {
    listContainers: vi.fn(async (): Promise<DockerContainerSummary[]> => [
      { id: 'project', imageId: 'old' },
    ]),
    inspectContainer: vi.fn(async (id: string): Promise<ContainerInspect> =>
      id === 'helper' ? { id, running: false, status: 'exited', exitCode: 0 } : existing,
    ),
    createContainer: vi.fn(async (value: ContainerSpec) => {
      spec = value;
      return { id: 'helper', warnings: [] };
    }),
    startContainer: vi.fn(async () => {}),
    waitContainer: vi.fn(async () => 0),
    containerLogs: vi.fn(async () => JSON.stringify(report)),
    removeStoppedContainer: vi.fn(async () => {}),
  };
  const assertIdle = vi.fn(async () => {});
  const run = () =>
    reclaimSleepingRunnerCaches({
      docker: docker as unknown as DockerClient,
      projectId: 'p',
      runtimeRoot: '/data/runners/p',
      image: `sha256:${'a'.repeat(64)}`,
      runtime: 'runsc',
      serverContainerId: 'self',
      sessionIds: ['idle'],
      maxBytes: 4096,
      assertIdle,
    });
  return {
    docker,
    existing,
    assertIdle,
    run,
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
    expect(h.spec).toMatchObject({
      network: 'none',
      readOnlyRootfs: true,
      capDrop: ['ALL'],
      runtime: 'runsc',
      binds: ['/data/runners/p:/run/verity-runner'],
      labels: { 'verity.project-id': 'p', 'verity.component': 'runner-cache-maintenance' },
    });
    expect(h.docker.removeStoppedContainer).toHaveBeenCalledExactlyOnceWith('helper');
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
  it('retries an owned helper whose creator disconnected before start', async () => {
    const h = fixture();
    h.existing.status = 'created';
    h.existing.labels = {
      'verity.project-id': 'p',
      'verity.component': 'runner-cache-maintenance',
    };
    h.docker.listContainers.mockResolvedValueOnce([
      {
        id: 'project',
        imageId: 'old',
        names: ['verity-cache-maintenance-12345678-1234-1234-1234-123456789abc'],
      },
    ]);
    expect(await h.run()).toEqual(report);
    expect(h.docker.removeStoppedContainer).toHaveBeenNthCalledWith(1, 'project');
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
  it('fails closed on inventory and lifecycle errors', async () => {
    const h = fixture();
    h.docker.listContainers.mockRejectedValueOnce(new Error('inventory unavailable'));
    await expect(h.run()).rejects.toThrow('inventory unavailable');
    expect(h.docker.createContainer).not.toHaveBeenCalled();
    h.assertIdle.mockRejectedValueOnce(new Error('new turn'));
    await expect(h.run()).rejects.toThrow('new turn');
  });
  it('leaves a disconnected helper and its fence for admission guards to observe', async () => {
    const h = fixture();
    h.docker.waitContainer.mockRejectedValueOnce(new Error('connection lost'));
    await expect(h.run()).rejects.toThrow('connection lost');
    expect(h.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('retains failed helpers and bounded invalid output', async () => {
    const h = fixture();
    h.docker.containerLogs.mockResolvedValueOnce('x'.repeat(65537));
    await expect(h.run()).rejects.toMatchObject({
      runnerCacheFailure: { code: 'invalid-response' },
    });
    expect(h.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
});
