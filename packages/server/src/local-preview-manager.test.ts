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
  const records = new Map<string, import('@verity/store').LocalPreviewShareRecord>();
  const options = {
    store: {
      getProject: async () => project,
      getSession: async () => ({ projectId: 'p1' }),
      createLocalPreviewShare: async (input: import('@verity/store').LocalPreviewShareRecord) => {
        records.set(input.id, { ...input, state: 'active' });
      },
      listLocalPreviewShares: async () => [...records.values()],
      updateLocalPreviewShareTarget: async (id: string, targetPort: number) => {
        records.get(id)!.targetPort = targetPort;
      },
      revokeLocalPreviewShare: async (id: string) => {
        const record = records.get(id);
        if (record) record.state = 'revoking';
      },
      deleteLocalPreviewShare: async (id: string) => {
        records.delete(id);
      },
    },
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
  expect(manager.list('s1')).toEqual([share]);
  await manager.reconcile();
  expect(manager.list('s1')).toEqual([share]);
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

it('preserves a link when the prepared connector port changes', async () => {
  const { manager, options } = fixture();
  const prepare = vi.fn(async () => 3000);
  options.prepareTargetPort = prepare;
  const share = await manager.create('s1', { targetPort: 3000 });
  prepare.mockResolvedValueOnce(43000);
  await manager.reconcile();
  expect(manager.list('s1')).toEqual([share]);
  await manager.reconcile();
  expect(manager.list('s1')).toHaveLength(1);
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

it.each([{ targetPort: 3000 }, { staticPath: 'public' }])(
  'restores durable identity and credentials after shutdown: %o',
  async (target) => {
    const { manager, docker, options } = fixture();
    const share = await manager.create('s1', target);
    const original = docker.createContainer.mock.calls[0];
    await manager.close();
    const restored = new LocalPreviewManager(options);
    managers.push(restored);
    await restored.reconcile();
    expect(restored.list('s1')).toEqual([share]);
    expect(docker.createContainer.mock.calls.at(-1)).toEqual(original);
    await restored.stop(share.id);
    await restored.close();
    const stopped = new LocalPreviewManager(options);
    managers.push(stopped);
    await stopped.reconcile();
    expect(stopped.list('s1')).toEqual([]);
  },
);

it('keeps a failed recovery reserved and retries without rotating credentials', async () => {
  const { manager, docker, options } = fixture();
  const share = await manager.create('s1', { targetPort: 3000 });
  await manager.close();
  const restored = new LocalPreviewManager(options);
  managers.push(restored);
  docker.createContainer.mockRejectedValueOnce(new Error('Docker unavailable'));
  await restored.reconcile();
  expect(restored.ownsConnector('orphan', share.id)).toBe(true);
  const other = await restored.create('s2', { targetPort: 4000 });
  expect(new URL(other.url).port).toBe('18101');
  await restored.reconcile();
  expect(restored.list('s1')).toEqual([share]);
});
it('does not revive an expired durable share after shutdown', async () => {
  const { manager, options } = fixture();
  const share = await manager.create('s1', { targetPort: 3000 });
  await manager.close();
  const records = await options.store.listLocalPreviewShares();
  records[0]!.expiresAt = new Date(Date.now() - 1);
  const restored = new LocalPreviewManager(options);
  managers.push(restored);
  await restored.reconcile();
  expect(restored.list('s1')).toEqual([]);
  expect(restored.ownsConnector('old', share.id)).toBe(false);
});

it('keeps identical targets isolated by session', async () => {
  const { manager } = fixture();
  const first = await manager.create('s1', { targetPort: 3000 });
  const second = await manager.create('s2', { targetPort: 3000 });
  expect(first.id).not.toBe(second.id);
  expect(manager.list('s1')).toEqual([first]);
  expect(manager.list('s2')).toEqual([second]);
});

it('shows durable shares and holds their port while restoration is unavailable', async () => {
  const { manager, options, docker } = fixture();
  const share = await manager.create('s1', { targetPort: 3000 });
  const port = manager.portOf(share.id)!;
  await manager.close();
  const restored = new LocalPreviewManager(options);
  managers.push(restored);
  docker.createContainer.mockRejectedValueOnce(new Error('unavailable'));
  await restored.reconcile();
  expect(restored.list('s1')).toEqual([share]);
  expect(restored.portOf(share.id)).toBe(port);
  expect(restored.heldPorts().get(port)).toEqual(share);
  await expect(restored.create('s2', { targetPort: 4000, networkPort: port })).rejects.toThrow(
    'in use',
  );
});

it('waits for restoration before removing an explicitly stopped connector', async () => {
  const { manager, options, docker } = fixture();
  const share = await manager.create('s1', { targetPort: 3000 });
  await manager.close();
  const restored = new LocalPreviewManager(options);
  managers.push(restored);
  let finish!: (value: { id: string }) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  docker.createContainer.mockImplementationOnce(() => {
    entered();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const recovery = restored.restore();
  await started;
  const stop = restored.stop(share.id);
  finish({ id: 'restored-connector' });
  await Promise.all([recovery, stop]);
  expect(docker.removeContainer).toHaveBeenCalledWith('restored-connector');
  expect(restored.list('s1')).toEqual([]);
  expect(await options.store.listLocalPreviewShares()).toEqual([]);
  await restored.reconcile();
  expect(restored.heldPorts().size).toBe(0);
});

it('follows a managed instance new target port while keeping local URL and credentials', async () => {
  const { manager, options, docker } = fixture();
  const instance = {
    id: 'managed',
    serverId: 'definition',
    localAccess: true,
    lastRunCommand: 'npm start',
    lastRunWorkdir: '.',
    sessionId: 's1',
    projectId: 'p1',
    sandboxPort: 3000,
    networkPort: 18100,
    desired: 'running',
  };
  Object.assign(options.store, {
    managedDevServers: {
      getInstance: async () => instance,
      isApproved: async () => true,
      listInstances: async () => [instance],
    },
  });
  const share = await manager.create('s1', {
    targetPort: 3000,
    networkPort: 18100,
    managedInstanceId: instance.id,
  });
  const credentials = (
    docker.createContainer.mock.calls[0] as unknown as [{ env: string[] }]
  )[0].env.find((entry) => entry.startsWith('VERITY_PREVIEW_CONNECTOR_TOKEN='));
  await manager.close();
  instance.sandboxPort = 4000;
  const restored = new LocalPreviewManager(options);
  managers.push(restored);
  await restored.reconcile();
  expect(restored.list('s1')).toEqual([{ ...share, targetPort: 4000 }]);
  expect(docker.createContainer).toHaveBeenLastCalledWith(
    expect.objectContaining({
      env: expect.arrayContaining([
        credentials,
        'VERITY_PREVIEW_TARGET_ORIGIN=http://sandbox:4000',
      ]),
    }),
  );
});

it.each(['access', 'approval'] as const)(
  'does not restore managed sharing when %s is revoked',
  async (reason) => {
    const { manager, options, docker } = fixture();
    const instance = {
      id: 'managed',
      serverId: 'definition',
      sessionId: 's1',
      projectId: 'p1',
      sandboxPort: 3000,
      networkPort: 18100,
      desired: 'running',
      localAccess: true,
      lastRunCommand: 'npm start',
      lastRunWorkdir: '.',
    };
    let approved = true;
    Object.assign(options.store, {
      managedDevServers: {
        getInstance: async () => instance,
        listInstances: async () => [instance],
        isApproved: async () => approved,
      },
    });
    const share = await manager.create('s1', {
      targetPort: 3000,
      networkPort: 18100,
      managedInstanceId: instance.id,
    });
    await manager.close();
    if (reason === 'access') instance.localAccess = false;
    else approved = false;
    docker.createContainer.mockClear();
    const restored = new LocalPreviewManager(options);
    managers.push(restored);
    await restored.reconcile();
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(await options.store.listLocalPreviewShares()).toHaveLength(reason === 'access' ? 0 : 1);
    if (reason === 'approval') {
      approved = true;
      await restored.reconcile();
      expect(restored.list('s1')).toEqual([share]);
    }
  },
);

it('releases an active managed connector when command approval is removed', async () => {
  const { manager, options, docker } = fixture();
  const instance = {
    id: 'managed',
    serverId: 'definition',
    sessionId: 's1',
    projectId: 'p1',
    sandboxPort: 3000,
    networkPort: 18100,
    desired: 'running',
    localAccess: true,
    lastRunCommand: 'npm start',
    lastRunWorkdir: '.',
  };
  let approved = true;
  Object.assign(options.store, {
    managedDevServers: {
      getInstance: async () => instance,
      listInstances: async () => [instance],
      isApproved: async () => approved,
    },
  });
  const share = await manager.create('s1', {
    targetPort: 3000,
    networkPort: 18100,
    managedInstanceId: instance.id,
  });
  approved = false;
  await manager.reconcile();
  expect(docker.removeContainer).toHaveBeenCalledWith('c1');
  expect(await options.store.listLocalPreviewShares()).toHaveLength(1);
  expect(manager.portOf(share.id)).toBe(18100);
});

it('does not resurrect a stopped durable snapshot while ownership lookup is pending', async () => {
  const { manager, options, docker } = fixture();
  const share = await manager.create('s1', { targetPort: 3000 });
  await manager.close();
  const restored = new LocalPreviewManager(options);
  managers.push(restored);
  let resume!: (value: Awaited<ReturnType<typeof options.store.getSession>>) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = options.store.getSession.bind(options.store);
  options.store.getSession = () => {
    entered();
    return new Promise((resolve) => {
      resume = resolve;
    });
  };
  docker.createContainer.mockClear();
  const recovery = restored.restore();
  await started;
  await restored.stop(share.id);
  options.store.getSession = original;
  resume(await original('s1'));
  await recovery;
  expect(docker.createContainer).not.toHaveBeenCalled();
  expect(restored.list('s1')).toEqual([]);
  expect(restored.heldPorts().size).toBe(0);
  expect(await options.store.listLocalPreviewShares()).toEqual([]);
});

it('does not recover a stale snapshot of a failed creation', async () => {
  const { manager, options, docker } = fixture();
  let rejectCreation!: (reason: Error) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  docker.createContainer.mockImplementationOnce(() => {
    entered();
    return new Promise((_resolve, reject) => {
      rejectCreation = reject;
    });
  });
  const creation = manager.create('s1', { targetPort: 3000 });
  const failed = expect(creation).rejects.toThrow('failed creation');
  await started;
  const read = options.store.listLocalPreviewShares.bind(options.store);
  const snapshot = (await read()).map((record) => ({ ...record }));
  let resume!: () => void;
  vi.spyOn(options.store, 'listLocalPreviewShares').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resume = () => resolve(snapshot);
      }),
  );
  const recovery = manager.restore();
  rejectCreation(new Error('failed creation'));
  await failed;
  resume();
  await recovery;
  expect(docker.createContainer).toHaveBeenCalledTimes(1);
  expect(manager.list('s1')).toEqual([]);
  expect(manager.heldPorts().size).toBe(0);
});
