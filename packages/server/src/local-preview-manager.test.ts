import { afterEach, expect, it, vi } from 'vitest';
import { PreviewEdge } from '@verity/preview-tunnel';
import { LocalPreviewManager, type LocalPreviewManagerOptions } from './local-preview-manager.js';
import { containerGenerationOf } from './project-relay-migration.js';
import { PreviewShareManager } from './preview-share-manager.js';

const managers: LocalPreviewManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
});
function fixture() {
  const sandbox = {
    id: 'sandbox-id',
    running: true,
    startedAt: '2026-10-04T00:00:00Z',
    labels: { 'verity.container-generation': 'generation-1' },
  };
  const project = { id: 'p1', containerName: 'sandbox', state: 'active' };
  vi.spyOn(PreviewShareManager.prototype, 'prepareLocalTarget').mockResolvedValue({
    project: project as never,
    session: {} as never,
    generation: containerGenerationOf(sandbox)!,
    staticMount: undefined,
  });
  const docker = {
    createContainer: vi.fn(async () => ({ id: 'c1' })),
    startContainer: vi.fn(async () => {}),
    inspectContainer: vi.fn(async () => sandbox),
    containerLogs: vi.fn(async () => 'preview connector established'),
    removeContainer: vi.fn(async () => {}),
  };
  const options = {
    store: { getProject: async () => project, getSession: async () => ({ projectId: 'p1' }) },
    docker,
    resolveConnectorImage: async () => `example@sha256:${'a'.repeat(64)}`,
    publicHost: 'localhost',
    connectorHost: 'server',
    connectorNetwork: 'net',
    portRange: '18100-18101',
    isDevServerRunning: async () => false,
  } as unknown as LocalPreviewManagerOptions;
  const manager = new LocalPreviewManager(options);
  managers.push(manager);
  return { manager, docker, options };
}
it('deduplicates simultaneous creation and waits for connector readiness', async () => {
  const { manager, docker } = fixture();
  const [first, second] = await Promise.all([
    manager.create('s1', { targetPort: 3000 }),
    manager.create('s1', { targetPort: 3000 }),
  ]);
  expect(first.id).toBe(second.id);
  expect(docker.createContainer).toHaveBeenCalledTimes(1);
  expect(docker.containerLogs).toHaveBeenCalled();
});
it('releases the local port after connector creation fails', async () => {
  const { manager, docker } = fixture();
  docker.createContainer.mockRejectedValueOnce(new Error('failed'));
  await expect(manager.create('s1', { targetPort: 3000 })).rejects.toThrow('failed');
  const share = await manager.create('s1', { targetPort: 3000 });
  expect(new URL(share.url).port).toBe('18100');
});
it('fences mutation while preserving shares when a move is refused', async () => {
  const { manager } = fixture();
  const share = await manager.create('s1', { targetPort: 3000 });
  const release = await manager.beginSessionMove('p1');
  await expect(manager.create('s2', { targetPort: 4000 })).rejects.toThrow('project is changing');
  expect(manager.list('s1').map((value) => value.id)).toEqual([share.id]);
  release();
  await manager.withProjectMutation('p1', async () => {});
  expect(manager.list('s1')).toEqual([]);
});

it('lists ready shares by project, not only by session', async () => {
  const { manager } = fixture();
  const share = await manager.create('s1', { targetPort: 3000 });
  expect(manager.listProject('p1').map((value) => value.id)).toEqual([share.id]);
  expect(manager.listProject('p2')).toEqual([]);
});

it('reclaims expired local shares and their connector', async () => {
  const { manager, docker } = fixture();
  const share = await manager.create('s1', { targetPort: 3000 });
  share.expiresAt = new Date(Date.now() - 1);
  await manager.reconcile();
  expect(manager.list('s1')).toEqual([]);
  expect(docker.removeContainer).toHaveBeenCalledWith('c1');
});

it('dials the Server network address without assuming its hostname is a Docker DNS alias', async () => {
  const { manager, docker, options } = fixture();
  options.resolveConnectorHost = async () => '172.20.0.2';
  const share = await manager.create('s1', { targetPort: 3000 });
  expect(docker.createContainer).toHaveBeenCalledWith(
    expect.objectContaining({
      env: expect.arrayContaining([
        `VERITY_PREVIEW_EDGE_URL=ws://172.20.0.2:${new URL(share.url).port}/__verity/connector`,
      ]),
      labels: expect.objectContaining({ 'verity.local-preview-server': options.connectorHost }),
    }),
  );
});

it('replaces an expired share immediately without waiting for reconciliation', async () => {
  const { manager, docker } = fixture();
  const old = await manager.create('s1', { targetPort: 3000 });
  old.expiresAt = new Date(Date.now() - 1);
  const fresh = await manager.create('s1', { targetPort: 3000 });
  expect(fresh.id).not.toBe(old.id);
  expect(new URL(fresh.url).port).toBe(new URL(old.url).port);
  expect(docker.removeContainer).toHaveBeenCalledTimes(1);
});

it('repairs the loopback target while an active local share is reconciled', async () => {
  const { manager, options } = fixture();
  const prepareTargetPort = vi.fn(async () => 25173);
  options.prepareTargetPort = prepareTargetPort;
  const share = await manager.create('s1', { targetPort: 5173 });
  prepareTargetPort.mockClear();
  await manager.reconcile();
  expect(prepareTargetPort).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), 5173);
  expect(manager.list('s1').map((value) => value.id)).toContain(share.id);
});

it('retries Docker cleanup after the edge has already closed', async () => {
  const { manager, docker } = fixture();
  const share = await manager.create('s1', { targetPort: 3000 });
  docker.removeContainer.mockRejectedValueOnce(new Error('Docker offline'));
  await expect(manager.stop(share.id)).rejects.toThrow('Docker offline');
  await expect(manager.stop(share.id)).resolves.toBe(true);
  expect(manager.list('s1')).toEqual([]);
  expect(new URL((await manager.create('s1', { targetPort: 3000 })).url).port).toBe('18100');
});

it('revokes immediately when another process takes over the target', async () => {
  const { manager, options } = fixture();
  const share = await manager.create('s1', { targetPort: 3000 });
  vi.spyOn(PreviewShareManager.prototype, 'prepareLocalTarget').mockRejectedValueOnce(
    new Error('ownership changed'),
  );
  options.listListeningProcesses = async () => [
    { port: 3000, pid: 42, cwd: '/other-session', command: 'node', bind: 'any' },
  ];
  await manager.reconcile();
  expect(manager.list('s1')).not.toContainEqual(share);
});

it('revokes a link when the prepared connector port changes', async () => {
  const { manager, options } = fixture();
  const prepare = vi.fn(async () => 3000);
  options.prepareTargetPort = prepare;
  await manager.create('s1', { targetPort: 3000 });
  prepare.mockResolvedValueOnce(43000);
  await manager.reconcile();
  expect(manager.list('s1')).toEqual([]);
});

it('does not reconcile or collect a connector that is still being provisioned', async () => {
  const { manager, docker } = fixture();
  let finish!: (value: { id: string }) => void;
  let entered!: () => void;
  let shareId = '';
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  docker.createContainer.mockImplementationOnce((...args: unknown[]) => {
    shareId = (args[0] as { labels: Record<string, string> }).labels[
      'verity.local-preview-share-id'
    ]!;
    entered();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pending = manager.create('s1', { targetPort: 3000 });
  await started;
  try {
    expect(manager.ownsConnector('not-yet-returned', shareId)).toBe(true);
    await manager.reconcile();
    expect(docker.removeContainer).not.toHaveBeenCalled();
  } finally {
    finish({ id: 'c1' });
  }
  const share = await pending;
  expect(manager.list('s1')).toContainEqual(share);
});

it('releases a slot when its HTTP edge cannot bind', async () => {
  const { manager } = fixture();
  vi.spyOn(PreviewEdge.prototype, 'listen').mockRejectedValueOnce(new Error('port occupied'));
  await expect(manager.create('s1', { targetPort: 3000 })).rejects.toThrow('port occupied');
  expect(new URL((await manager.create('s1', { targetPort: 3000 })).url).port).toBe('18100');
});

it('retries cleanup after both provisioning and Docker removal fail', async () => {
  const { manager, docker } = fixture();
  docker.startContainer.mockRejectedValueOnce(new Error('startup failed'));
  docker.removeContainer.mockRejectedValueOnce(new Error('Docker offline'));
  await expect(manager.create('s1', { targetPort: 3000 })).rejects.toThrow('Docker offline');
  expect(manager.list('s1')).toEqual([]);
  await manager.reconcile();
  expect(docker.removeContainer).toHaveBeenCalledTimes(2);
  expect(new URL((await manager.create('s1', { targetPort: 3000 })).url).port).toBe('18100');
});
