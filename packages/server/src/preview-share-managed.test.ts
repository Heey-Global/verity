import type { EventStore } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import type { DockerClient } from './docker.js';
import { managedDevServerProviderSnapshot } from './managed-dev-server-secrets.js';
import { fixture } from './preview-share-manager.test-helper.js';
import { PreviewShareManager } from './preview-share-manager.js';

describe('managed public links', () => {
  function managedFixture(legacyPort = false, personal = false) {
    const f = fixture();
    let share: Awaited<ReturnType<EventStore['getPublicPreviewShare']>> = {
      ...f.record,
      devServerId: null,
      sessionId: 's1',
      managedInstanceId: legacyPort ? null : 'instance-1',
      state: 'active',
      connectorContainerId: 'connector-id',
    };
    let instance: Awaited<ReturnType<EventStore['managedDevServers']['getInstance']>> = {
      id: 'instance-1',
      serverId: 'entry-1',
      projectId: 'p1',
      sessionId: 's1',
      localAccess: true,
      sandboxPort: 41000,
      networkPort: 8100,
      state: 'stopped',
      desired: 'stopped',
      detail: null,
      lastRunSecretBindings: [],
      lastRunProviderAuthority: null,
      lastRunUserId: null,
      lastRunCommand: 'node server.mjs',
      lastRunWorkdir: '.',
      startedAt: null,
      accessStartedAt: null,
      lastRanAt: null,
    };
    let running = false;
    let tag = 'instance-1';
    const getInstance = vi.fn(async () => instance);
    const secretBindings = [{ env: 'API_KEY', secretAlias: 'API_KEY' }];
    const dopplerBinding = {
      id: 'binding-1',
      connectionId: 'doppler-1',
      dopplerProject: 'portal',
      dopplerConfig: 'prd',
      isDefault: true,
      tokenRevision: '11111111-1111-4111-8111-111111111111',
    };
    const approved = managedDevServerProviderSnapshot([dopplerBinding], secretBindings).authority;
    const listBindings = vi.fn(async () => [dopplerBinding]);
    const store = {
      ...f.store,
      managedDevServers: { getInstance, approvedProviderAuthority: async () => approved },
      projectDopplerBindings: { list: listBindings },
      getSession: vi.fn<EventStore['getSession']>(
        async () =>
          ({ sessionId: 's1', projectId: 'p1', worktree: '/wt/s1' }) as Awaited<
            ReturnType<EventStore['getSession']>
          >,
      ),
      listPublicPreviewShares: vi.fn(async () => (share ? [share] : [])),
      getPublicPreviewShare: vi.fn(async () => share),
      transitionPublicPreviewShare: vi.fn<EventStore['transitionPublicPreviewShare']>(
        async (_id, from, state, patch = {}) => {
          if (!share || !from.includes(share.state)) return undefined;
          share = { ...share, ...patch, state };
          return share;
        },
      ),
    };
    let connectorEnv: string[] = [];
    const containerName = personal ? 'personal-sandbox' : 'verity-project';
    const prepareTargetPort = vi.fn(
      async (_project: { containerName: string }, port: number) => port,
    );
    const docker = {
      ...f.docker,
      inspectContainer: vi.fn(async (id: string) =>
        id === containerName
          ? { ...f.inspect, labels: { 'verity.container-generation': 'generation-2' } }
          : { ...f.inspect, env: connectorEnv },
      ),
      createContainer: vi.fn<DockerClient['createContainer']>(async (spec) => {
        connectorEnv = spec.env ?? [];
        return { id: 'connector-id', warnings: [] };
      }),
    };
    const manager = new PreviewShareManager({
      store: store as unknown as EventStore,
      docker: docker as unknown as DockerClient,
      edge: f.edge,
      resolveConnectorImage: f.resolveConnectorImage,
      isDevServerRunning: async () => false,
      prepareTargetPort,
      ...(personal
        ? { sandboxFor: async () => ({ containerName, networkName: 'personal-network' }) }
        : {}),
      listSessionServers: async () =>
        running
          ? [
              {
                port: instance!.sandboxPort,
                managedInstanceId: instance!.id,
                reachable: true,
                pid: 42,
                command: 'node server.mjs',
                workdir: '.',
                name: 'Demo',
              },
            ]
          : [],
      listListeningProcesses: async (project) =>
        running && project.containerName === containerName
          ? [
              {
                port: instance!.sandboxPort,
                bind: 'any',
                instanceId: tag,
                pid: 42,
                cwd: '/wt/s1',
                command: 'node server.mjs',
              },
            ]
          : [],
      now: () => new Date('2030-01-01T00:00:00Z'),
    });
    return {
      manager,
      docker,
      edge: f.edge,
      store,
      listBindings,
      prepareTargetPort,
      share: () => share!,
      run: (port = 41001, marker = 'instance-1') => {
        instance = { ...instance!, sandboxPort: port, state: 'running', desired: 'running' };
        running = true;
        tag = marker;
      },
      runWithDoppler: () => {
        instance = {
          ...instance!,
          state: 'running',
          desired: 'running',
          lastRunSecretBindings: secretBindings,
          lastRunProviderAuthority: approved,
        };
        running = true;
      },
      rotateDopplerToken: () => {
        dopplerBinding.tokenRevision = '22222222-2222-4222-8222-222222222222';
      },
      remove: () => {
        instance = undefined;
      },
    };
  }

  it('rejects new public shares and revokes active shares for a stale Doppler run', async () => {
    const f = managedFixture();
    f.runWithDoppler();
    await f.manager.reconcile();
    expect(f.share().state).toBe('active');
    f.rotateDopplerToken();
    await expect(
      f.manager.create({
        sessionId: 's1',
        managedInstanceId: 'instance-1',
        pin: '123456',
        ttlSeconds: 3600,
      }),
    ).rejects.toThrow('Doppler access changed');
    expect(f.edge.create).not.toHaveBeenCalled();
    await f.manager.reconcile();
    expect(f.share().state).toBe('revoked');
    expect(f.edge.remove).toHaveBeenCalledWith('share-id');
  });

  it('checks a managed listener reached through a legacy port share', async () => {
    const f = managedFixture(true);
    f.runWithDoppler();
    await f.manager.reconcile();
    expect(f.share().state).toBe('active');
    f.rotateDopplerToken();
    await expect(
      f.manager.create({
        sessionId: 's1',
        targetPort: 41000,
        pin: '123456',
        ttlSeconds: 3600,
      }),
    ).rejects.toThrow('Doppler access changed');
    await f.manager.reconcile();
    expect(f.docker.createContainer).toHaveBeenLastCalledWith(
      expect.objectContaining({ env: expect.arrayContaining(['VERITY_PREVIEW_OFFLINE=1']) }),
    );
  });

  it('probes and prepares forwarding in the managed server’s personal sandbox', async () => {
    const f = managedFixture(false, true);
    f.run();
    await f.manager.reconcile();
    expect(f.prepareTargetPort).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: 'personal-sandbox' }),
      41001,
    );
    expect(f.docker.createContainer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: 'personal-network',
        env: expect.arrayContaining(['VERITY_PREVIEW_TARGET_ORIGIN=http://personal-sandbox:41001']),
      }),
    );
  });

  it('does not start a connector if the token changes during container creation', async () => {
    const f = managedFixture();
    f.runWithDoppler();
    const create = f.docker.createContainer.getMockImplementation()!;
    f.docker.createContainer.mockImplementationOnce(async (spec) => {
      f.rotateDopplerToken();
      return create(spec);
    });
    await expect(f.manager.reconcile()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: expect.stringContaining('Doppler access changed') }),
      ],
    });
    expect(f.docker.startContainer).not.toHaveBeenCalled();
    expect(f.docker.removeContainer).toHaveBeenCalledWith('connector-id');
  });

  it('takes public forwarding offline during an authority lookup failure and restores the same link', async () => {
    const f = managedFixture();
    f.runWithDoppler();
    await f.manager.reconcile();
    f.listBindings.mockRejectedValueOnce(new Error('database unavailable'));
    await f.manager.reconcile();
    expect(f.edge.remove).not.toHaveBeenCalled();
    expect(f.share().state).toBe('active');
    expect(f.docker.createContainer).toHaveBeenLastCalledWith(
      expect.objectContaining({ env: expect.arrayContaining(['VERITY_PREVIEW_OFFLINE=1']) }),
    );
    await f.manager.reconcile();
    expect(f.share().state).toBe('active');
    expect(f.docker.createContainer).toHaveBeenLastCalledWith(
      expect.objectContaining({ env: expect.not.arrayContaining(['VERITY_PREVIEW_OFFLINE=1']) }),
    );
  });

  it.each([false, true])(
    'takes managed forwarding offline when sandbox inspection fails (running: %s)',
    async (running) => {
      const f = managedFixture();
      if (running) f.run();
      f.docker.inspectContainer.mockRejectedValueOnce(new Error('inspection unavailable'));
      await f.manager.reconcile();
      expect(f.docker.removeContainer).toHaveBeenCalledWith('connector-id');
      expect(f.docker.createContainer).toHaveBeenLastCalledWith(
        expect.objectContaining({ env: expect.arrayContaining(['VERITY_PREVIEW_OFFLINE=1']) }),
      );
      expect(f.share().state).toBe('active');
    },
  );

  it('revokes managed links on protected generations even while the managed instance is stopped', async () => {
    const f = managedFixture();
    const original = f.docker.inspectContainer.getMockImplementation()!;
    f.docker.inspectContainer.mockImplementation(async (id) => ({
      ...(await original(id)),
      networks: { [`verity-egress-${'a'.repeat(32)}`]: {} },
    }));
    await f.manager.reconcile();
    expect(f.share().state).toBe('revoked');
    expect(f.edge.remove).toHaveBeenCalledWith('share-id');
    expect(f.docker.removeContainer).toHaveBeenCalledWith('connector-id');
    expect(f.docker.createContainer).not.toHaveBeenCalled();
  });

  // A port-based link used to be revoked here, silently changing both its URL and PIN.
  it('keeps the link offline and retargets the same link after restart and sandbox recreation', async () => {
    const f = managedFixture();
    const original = f.share();
    await f.manager.reconcile();
    expect(f.docker.createContainer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        env: expect.arrayContaining(['VERITY_PREVIEW_OFFLINE=1']),
        network: 'verity-net',
      }),
    );
    expect(f.share()).toMatchObject({
      state: 'active',
      publicOrigin: original.publicOrigin,
      pin: original.pin,
    });
    const count = f.docker.createContainer.mock.calls.length;
    await f.manager.reconcile();
    expect(f.docker.createContainer).toHaveBeenCalledTimes(count);
    f.run();
    await f.manager.reconcile();
    expect(f.share()).toMatchObject({
      targetPort: 41001,
      containerGeneration: 'generation-2',
      publicOrigin: original.publicOrigin,
      pin: original.pin,
    });
    expect(f.docker.createContainer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        env: expect.arrayContaining(['VERITY_PREVIEW_TARGET_ORIGIN=http://verity-project:41001']),
      }),
    );
    expect(f.edge.create).not.toHaveBeenCalled();
    expect(f.edge.remove).not.toHaveBeenCalled();
  });

  it('keeps a foreign listener offline instead of exposing it on the retained link', async () => {
    const f = managedFixture();
    f.run(41000, 'foreign');
    await f.manager.reconcile();
    expect(f.docker.createContainer).toHaveBeenLastCalledWith(
      expect.objectContaining({ env: expect.arrayContaining(['VERITY_PREVIEW_OFFLINE=1']) }),
    );
  });

  it('revokes the link when its instance has been deleted', async () => {
    const f = managedFixture();
    f.remove();
    await f.manager.reconcile();
    expect(f.edge.remove).toHaveBeenCalledWith('share-id');
    expect(f.share().state).toBe('revoked');
  });
});
