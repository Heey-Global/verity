import type { EventStore } from '@verity/store';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerInspect, DockerClient } from './docker.js';
import {
  PreviewShareConflictError,
  PreviewShareInputError,
  PreviewShareManager,
  PreviewShareNotFoundError,
  sweepOrphanedPreviewShares,
} from './preview-share-manager.js';
import { projectNetworkName } from './provisioner.js';

const digest = `ghcr.io/heey-global/verity/preview-connector@sha256:${'a'.repeat(64)}`;
const project = {
  id: 'p1',
  containerName: 'verity-project',
  state: 'active',
};
const devServer = { id: 'dev-1', projectId: 'p1', containerPort: '3000' };

function fixture() {
  const record = {
    id: 'share-id',
    projectId: 'p1',
    devServerId: 'dev-1',
    containerGeneration: 'generation-1',
    targetPort: 3000,
    state: 'creating',
    publicOrigin: 'https://share-id.preview.example',
    edgeUrl: 'wss://share-id.preview.example/__verity/connector',
    pinHash: 'scrypt:salt:hash',
    connectorToken: 'connector',
    sessionSecret: 'session',
    connectorContainerName: 'verity-preview-share-id',
    connectorContainerId: null,
    expiresAt: new Date('2030-01-01T01:00:00Z'),
    revokedAt: null,
    failure: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as const;
  const store = {
    getDevServer: vi.fn(async () => devServer),
    getProject: vi.fn(async () => project),
    createPublicPreviewShare: vi.fn<EventStore['createPublicPreviewShare']>(async (input) => ({
      ...record,
      ...input,
    })),
    transitionPublicPreviewShare: vi.fn<EventStore['transitionPublicPreviewShare']>(
      async (_id, _from, state, patch = {}) => ({ ...record, ...patch, state }),
    ),
    getPublicPreviewShare: vi.fn<EventStore['getPublicPreviewShare']>(async () => record),
    listPublicPreviewShares: vi.fn<EventStore['listPublicPreviewShares']>(async () => []),
  };
  const inspect: ContainerInspect = {
    id: 'sandbox-id',
    running: true,
    labels: { 'verity.container-generation': 'generation-1' },
    networks: { [projectNetworkName('p1')]: {} },
    env: [] as string[],
    mountCount: 0,
    mounts: [],
    privileged: false,
    deviceCount: 0,
    capAdd: [],
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges:true'],
    readOnlyRootfs: true,
    runtime: 'runsc',
    user: 'dev',
  };
  const docker = {
    inspectContainer: vi.fn(async () => inspect),
    createContainer: vi.fn(async () => ({ id: 'connector-id', warnings: [] })),
    startContainer: vi.fn(async () => undefined),
    removeContainer: vi.fn(async () => undefined),
    containerLogs: vi.fn(async () => 'preview connector established\n'),
  };
  const edge = {
    isAvailable: vi.fn(() => true),
    create: vi.fn(async () => ({
      shareId: 'share-id',
      publicOrigin: 'https://share-id.preview.example',
      edgeUrl: 'wss://share-id.preview.example/__verity/connector',
      connectorToken: 'c'.repeat(32),
      sessionSecret: 's'.repeat(32),
      expiresAt: new Date('2030-01-01T01:00:00Z'),
    })),
    remove: vi.fn(async () => undefined),
  };
  const resolveConnectorImage = vi.fn<() => Promise<string | undefined>>(async () => digest);
  const isDevServerRunning = vi.fn(async () => true);
  const manager = new PreviewShareManager({
    store: store as unknown as EventStore,
    docker: docker as unknown as DockerClient,
    edge,
    resolveConnectorImage,
    dataVolume: 'verity-data',
    dataVolumeRoot: '/data',
    hostCloneRoot: '/data',
    isDevServerRunning,
    now: () => new Date('2030-01-01T00:00:00Z'),
    wait: vi.fn(async () => undefined),
  });
  return {
    manager,
    store,
    docker,
    edge,
    inspect,
    record,
    isDevServerRunning,
    resolveConnectorImage,
  };
}

describe('PreviewShareManager', () => {
  it('resolves the connector image only after edge authority is available', async () => {
    const { manager, edge, resolveConnectorImage } = fixture();
    edge.isAvailable.mockReturnValueOnce(false);
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow('Uplink is offline');
    expect(resolveConnectorImage).not.toHaveBeenCalled();
  });

  it('retries transient connector image resolution and caches a successful digest', async () => {
    const { manager, resolveConnectorImage, store } = fixture();
    resolveConnectorImage.mockResolvedValueOnce(undefined).mockResolvedValue(digest);
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow('temporarily unavailable');
    expect(resolveConnectorImage).toHaveBeenCalledOnce();
    await manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 });
    expect(resolveConnectorImage).toHaveBeenCalledTimes(2);
    store.listPublicPreviewShares.mockResolvedValueOnce([]);
    await manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 });
    expect(resolveConnectorImage).toHaveBeenCalledTimes(2);
  });
  it('creates edge then a hardened generation-bound connector and activates the share', async () => {
    const { manager, docker, edge, store } = fixture();
    const share = await manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 });
    expect(share.state).toBe('active');
    expect(store.createPublicPreviewShare.mock.calls[0]?.[0].id).toBe('share-id');
    expect(edge.create).toHaveBeenCalledOnce();
    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        image: digest,
        network: projectNetworkName('p1'),
        readOnlyRootfs: true,
        capDrop: ['ALL'],
        securityOpt: ['no-new-privileges:true'],
        env: expect.arrayContaining(['VERITY_PREVIEW_TARGET_ORIGIN=http://verity-project:3000']),
      }),
    );
    expect(store.transitionPublicPreviewShare).toHaveBeenLastCalledWith(
      expect.any(String),
      ['creating'],
      'active',
      { connectorContainerId: 'connector-id' },
    );
  });

  it('rolls edge and connector back if the sandbox generation changes', async () => {
    const { manager, docker, edge, store, inspect } = fixture();
    docker.inspectContainer
      .mockResolvedValueOnce(inspect)
      .mockResolvedValueOnce(inspect)
      .mockResolvedValueOnce({
        ...inspect,
        labels: { 'verity.container-generation': 'generation-2' },
      });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/generation changed/);
    expect(docker.removeContainer).toHaveBeenCalledWith('connector-id');
    expect(edge.remove).toHaveBeenCalledOnce();
    expect(store.transitionPublicPreviewShare).toHaveBeenLastCalledWith(
      expect.any(String),
      ['creating'],
      'failed',
      expect.objectContaining({ failure: expect.stringContaining('generation changed') }),
    );
  });

  it('rolls back when the started connector is not running', async () => {
    const { manager, docker, edge, inspect } = fixture();
    docker.inspectContainer
      .mockResolvedValueOnce(inspect)
      .mockResolvedValueOnce({ ...inspect, running: false });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow('connector exited before becoming ready');
    expect(docker.removeContainer).toHaveBeenCalledWith('connector-id');
    expect(edge.remove).toHaveBeenCalledOnce();
  });

  it('rolls back when connector readiness times out without the exact marker', async () => {
    const { manager, docker, edge } = fixture();
    docker.containerLogs.mockResolvedValue('connecting\n');
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow('readiness timed out');
    expect(docker.removeContainer).toHaveBeenCalledWith('connector-id');
    expect(edge.remove).toHaveBeenCalledOnce();
  });

  it('rolls back when the dev server changes concurrently with share creation', async () => {
    const { manager, docker, edge, store } = fixture();
    store.getDevServer
      .mockResolvedValueOnce(devServer)
      .mockResolvedValueOnce({ ...devServer, containerPort: '3001' });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/dev server changed/);
    expect(docker.removeContainer).toHaveBeenCalledWith('connector-id');
    expect(edge.remove).toHaveBeenCalledOnce();
    expect(store.transitionPublicPreviewShare).not.toHaveBeenCalledWith(
      expect.any(String),
      ['creating'],
      'active',
      expect.anything(),
    );
  });

  it('rolls back when the dev server stops during share creation', async () => {
    const { manager, docker, edge, store, isDevServerRunning } = fixture();
    isDevServerRunning.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/dev server stopped/);
    expect(docker.removeContainer).toHaveBeenCalledWith('connector-id');
    expect(edge.remove).toHaveBeenCalledOnce();
    expect(store.transitionPublicPreviewShare).not.toHaveBeenCalledWith(
      expect.any(String),
      ['creating'],
      'active',
      expect.anything(),
    );
  });

  it('blocks sandboxes carrying direct credentials before creating a share', async () => {
    const { manager, docker, edge, inspect } = fixture();
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      env: ['DOPPLER_TOKEN=secret'],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toBeInstanceOf(PreviewShareConflictError);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('fails closed when Docker mount metadata is unavailable', async () => {
    const { manager, docker, edge, inspect } = fixture();
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      mountCount: undefined,
      mounts: undefined,
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/mount metadata is incomplete/);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('fails closed when Docker security or environment metadata is unavailable', async () => {
    const { manager, docker, edge, inspect } = fixture();
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      env: undefined,
      privileged: undefined,
      deviceCount: undefined,
      capAdd: undefined,
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/security metadata is incomplete/);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('blocks a sandbox without the complete public-preview hardening contract', async () => {
    const { manager, docker, edge, inspect } = fixture();
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      readOnlyRootfs: false,
      runtime: 'runc',
      user: '0:0',
      capDrop: undefined,
      securityOpt: undefined,
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/public preview hardening/);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it.each(['0:1000', 'root:root'])('blocks root sandbox user %s', async (user) => {
    const { manager, docker, inspect } = fixture();
    docker.inspectContainer.mockResolvedValueOnce({ ...inspect, user });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/public preview hardening/);
  });

  it('allows read-only public Git signing material', async () => {
    const { manager, docker, inspect } = fixture();
    docker.inspectContainer.mockResolvedValue({
      ...inspect,
      mountCount: 3,
      mounts: [
        {
          type: 'bind',
          source: '/srv/verity/secrets/git/id_ed25519.pub',
          destination: '/home/dev/.ssh/id_ed25519.pub',
          readWrite: false,
        },
        {
          type: 'bind',
          source: '/srv/verity/secrets/git/known_hosts',
          destination: '/home/dev/.ssh/known_hosts',
          readWrite: false,
        },
        {
          type: 'bind',
          source: '/srv/verity/secrets/git/allowed_signers',
          destination: '/home/dev/.ssh/allowed_signers',
          readWrite: false,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).resolves.toMatchObject({ state: 'active' });
  });

  it('blocks unrecognized mounts even when their paths look harmless', async () => {
    const { manager, docker, edge, inspect } = fixture();
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      mountCount: 1,
      mounts: [
        {
          type: 'bind',
          source: '/srv/config/app.conf',
          destination: '/run/config/app.conf',
          readWrite: false,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/mounted credentials/);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('blocks mounted broker capabilities before creating a share', async () => {
    const { manager, docker, edge, inspect } = fixture();
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      env: [
        'VERITY_GH_TOKEN_URL=http://relay/internal/github/token',
        'VERITY_GH_TOKEN_CAPABILITY_FILE=/run/verity/gh-token-capability',
      ],
      mountCount: 1,
      mounts: [
        {
          type: 'bind',
          destination: '/run/verity/gh-token-capability',
          readWrite: false,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toBeInstanceOf(PreviewShareConflictError);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('blocks the provisioner Claude egress private-key projection', async () => {
    const { manager, docker, edge, inspect } = fixture();
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      env: ['VERITY_CLAUDE_EGRESS_KEY=/run/verity/claude-egress/client.key'],
      mountCount: 1,
      mounts: [
        {
          type: 'bind',
          source: '/srv/verity/secrets/claude-egress/client.key',
          destination: '/run/verity/claude-egress/client.key',
          readWrite: false,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toBeInstanceOf(PreviewShareConflictError);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('blocks mounted credential material before creating a share', async () => {
    const { manager, docker, edge, inspect } = fixture();
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      mountCount: 1,
      mounts: [
        {
          type: 'bind',
          source: '/srv/credentials/codex-auth.json',
          destination: '/home/dev/.codex/auth.json',
          readWrite: true,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/mounted credentials/);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('keeps a failed revocation nonterminal so reconciliation retries it', async () => {
    const { manager, docker, edge, store } = fixture();
    docker.removeContainer.mockRejectedValueOnce(new Error('Docker unavailable'));
    edge.remove.mockRejectedValueOnce(new Error('Kubernetes unavailable'));
    await expect(manager.stop('share-id')).rejects.toThrow(/revocation did not complete/);
    expect(store.transitionPublicPreviewShare).toHaveBeenCalledWith(
      'share-id',
      ['creating', 'active'],
      'revoking',
    );
    expect(store.transitionPublicPreviewShare).not.toHaveBeenCalledWith(
      'share-id',
      ['revoking'],
      'revoked',
      expect.anything(),
    );
  });

  it('blocks a broad direct-credential environment before any external mutation', async () => {
    const { manager, docker, edge, inspect } = fixture();
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      env: ['AWS_ACCESS_KEY_ID=AKIAEXAMPLE'],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toBeInstanceOf(PreviewShareConflictError);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('maps a concurrent live-share winner to a conflict before edge creation', async () => {
    const { manager, store, edge, record } = fixture();
    store.createPublicPreviewShare.mockRejectedValueOnce(new Error('unique violation'));
    store.listPublicPreviewShares.mockResolvedValueOnce([{ ...record, state: 'active' }]);
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toBeInstanceOf(PreviewShareConflictError);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('normalizes static paths before detecting an existing live share', async () => {
    const { manager, store, edge, record } = fixture();
    store.listPublicPreviewShares.mockResolvedValueOnce([
      {
        ...record,
        devServerId: null,
        targetPort: null,
        targetKind: 'static-folder',
        staticPath: 'dist',
        state: 'active',
      },
    ]);
    await expect(
      manager.create({ projectId: 'p1', staticPath: './dist', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toBeInstanceOf(PreviewShareConflictError);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('does not persist a share when Uplink creation fails', async () => {
    const { manager, edge, store } = fixture();
    edge.create.mockRejectedValueOnce(new Error('edge create failed'));
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow('edge create failed');
    expect(store.createPublicPreviewShare).not.toHaveBeenCalled();
  });

  it('persists a revoking recovery row when initial persistence and edge cleanup fail', async () => {
    const { manager, edge, store } = fixture();
    store.createPublicPreviewShare.mockRejectedValueOnce(new Error('database interrupted'));
    store.getPublicPreviewShare.mockResolvedValueOnce(undefined);
    edge.remove.mockRejectedValueOnce(new Error('Uplink offline'));

    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow('remote cleanup is queued for reconciliation');

    expect(store.createPublicPreviewShare).toHaveBeenCalledTimes(2);
    expect(store.transitionPublicPreviewShare).toHaveBeenCalledWith(
      'share-id',
      ['creating'],
      'revoking',
      { failure: 'database interrupted' },
    );
  });

  it('returns not found for an unknown dev server before requiring a project id', async () => {
    const { manager, store, edge } = fixture();
    store.getDevServer.mockResolvedValueOnce(undefined as unknown as typeof devServer);
    await expect(
      manager.create({ devServerId: 'missing', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toBeInstanceOf(PreviewShareNotFoundError);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('cleans up and does not persist when authority is lost after share.ready', async () => {
    const { manager, edge, store } = fixture();
    let available = true;
    edge.isAvailable.mockImplementation(() => available);
    edge.create.mockImplementationOnce(async () => {
      available = false;
      return {
        shareId: 'share-id',
        publicOrigin: 'https://share-id.preview.example',
        edgeUrl: 'wss://share-id.preview.example/__verity/connector',
        connectorToken: 'c'.repeat(32),
        sessionSecret: 's'.repeat(32),
        expiresAt: new Date('2030-01-01T01:00:00Z'),
      };
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow('authority was lost');
    expect(edge.remove).toHaveBeenCalledWith('share-id');
    expect(store.createPublicPreviewShare).not.toHaveBeenCalled();
  });

  it('removes a usable Uplink share when its returned binding is malformed', async () => {
    const { manager, edge, store } = fixture();
    edge.create.mockResolvedValueOnce({
      shareId: 'share-id',
      publicOrigin: 'https://share-id.preview.example',
      edgeUrl: 'wss://share-id.preview.example/__verity/connector',
      connectorToken: 'short',
      sessionSecret: 's'.repeat(32),
      expiresAt: new Date('2030-01-01T01:00:00Z'),
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow('invalid connector token');
    expect(edge.remove).toHaveBeenCalledWith('share-id');
    expect(store.createPublicPreviewShare).not.toHaveBeenCalled();
  });

  it('removes a bounded Uplink share when its returned id is invalid', async () => {
    const { manager, edge, store } = fixture();
    edge.create.mockResolvedValueOnce({
      shareId: 'INVALID/SHARE',
      publicOrigin: 'https://invalid.preview.example',
      edgeUrl: 'wss://invalid.preview.example/__verity/connector',
      connectorToken: 'c'.repeat(32),
      sessionSecret: 's'.repeat(32),
      expiresAt: new Date('2030-01-01T01:00:00Z'),
    });

    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow('invalid share id');
    expect(edge.remove).toHaveBeenCalledWith('INVALID/SHARE');
    expect(store.createPublicPreviewShare).not.toHaveBeenCalled();
  });

  it('marks disabled shares revoking before Docker cleanup and retries locally', async () => {
    const { manager, store, docker, edge, record } = fixture();
    store.listPublicPreviewShares.mockResolvedValueOnce([{ ...record, state: 'active' }]);
    docker.removeContainer.mockRejectedValueOnce(new Error('Docker unavailable'));
    await expect(manager.disableAll('lease expired')).rejects.toThrow(/cleanup retry/);
    expect(store.transitionPublicPreviewShare).toHaveBeenCalledWith(
      record.id,
      ['creating', 'active'],
      'revoking',
      expect.objectContaining({ failure: 'lease expired' }),
    );
    expect(store.transitionPublicPreviewShare).not.toHaveBeenCalledWith(
      record.id,
      ['revoking'],
      'revoked',
      expect.anything(),
    );

    docker.removeContainer.mockResolvedValueOnce(undefined);
    store.listPublicPreviewShares.mockResolvedValueOnce([
      { ...record, state: 'revoking', failure: 'lease expired' },
    ]);
    await manager.reconcile();
    expect(edge.remove).toHaveBeenCalledWith(record.id);
    expect(store.transitionPublicPreviewShare).toHaveBeenLastCalledWith(
      record.id,
      ['revoking'],
      'revoked',
      expect.objectContaining({ connectorContainerId: null }),
    );
  });

  it('keeps a normal revocation retryable when disconnect cleanup cannot remove the edge', async () => {
    const { manager, store, edge, record } = fixture();
    const revoking = { ...record, state: 'revoking' as const, failure: null };
    store.listPublicPreviewShares.mockResolvedValueOnce([revoking]);
    store.transitionPublicPreviewShare.mockResolvedValueOnce(undefined);
    store.getPublicPreviewShare.mockResolvedValueOnce(revoking);
    edge.remove.mockRejectedValueOnce(new Error('Uplink disconnected'));

    await expect(manager.disableAll('Uplink disconnected')).rejects.toThrow(/cleanup retry/);
    expect(edge.remove).toHaveBeenCalledWith(record.id);
    expect(store.transitionPublicPreviewShare).not.toHaveBeenCalledWith(
      record.id,
      ['revoking'],
      'revoked',
      expect.anything(),
    );
  });

  it('finishes an Uplink-expired share locally without removing the absent edge', async () => {
    const { manager, store, docker, edge, record } = fixture();
    const active = { ...record, state: 'active' as const, connectorContainerId: 'connector-id' };
    store.getPublicPreviewShare.mockResolvedValueOnce(active);
    store.transitionPublicPreviewShare.mockResolvedValueOnce({ ...active, state: 'revoking' });
    await manager.finishExpiredByUplink(record.id);
    expect(docker.removeContainer).toHaveBeenCalledWith('connector-id');
    expect(edge.remove).not.toHaveBeenCalled();
    expect(store.transitionPublicPreviewShare).toHaveBeenLastCalledWith(
      record.id,
      ['revoking'],
      'expired',
      expect.objectContaining({ connectorContainerId: null }),
    );
  });

  it('rejects root and hidden static publish paths before contacting Uplink', async () => {
    const { manager, edge } = fixture();
    await expect(
      manager.create({ projectId: 'p1', staticPath: '.', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toBeInstanceOf(PreviewShareInputError);
    for (const staticPath of ['', '..', '../dist', '/absolute']) {
      await expect(
        manager.create({ projectId: 'p1', staticPath, pin: '123456', ttlSeconds: 3600 }),
      ).rejects.toBeInstanceOf(PreviewShareInputError);
    }
    await expect(
      manager.create({
        projectId: 'p1',
        staticPath: 'public/.private',
        pin: '123456',
        ttlSeconds: 3600,
      }),
    ).rejects.toBeInstanceOf(PreviewShareInputError);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it.each(['', '.', '..', '../outside'])(
    'rejects unsafe static volume subpath %j',
    async (cloneDir) => {
      const { manager, store, edge } = fixture();
      store.getProject.mockResolvedValueOnce({ ...project, cloneDir } as typeof project);
      await expect(
        manager.create({ projectId: 'p1', staticPath: 'dist', pin: '123456', ttlSeconds: 3600 }),
      ).rejects.toBeInstanceOf(PreviewShareConflictError);
      expect(edge.create).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'file'])(
    'rejects a %s static publish directory before contacting Uplink',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'verity-preview-static-'));
      const clone = join(root, 'repo');
      await mkdir(clone);
      if (kind === 'file') await writeFile(join(clone, 'dist'), 'not a directory');
      const { manager, store, edge } = fixture();
      store.getProject.mockResolvedValueOnce({ ...project, cloneDir: 'repo' } as typeof project);
      const options = (
        manager as unknown as {
          options: { hostCloneRoot: string; dataVolumeRoot: string };
        }
      ).options;
      options.hostCloneRoot = root;
      options.dataVolumeRoot = root;
      await expect(
        manager.create({ projectId: 'p1', staticPath: 'dist', pin: '123456', ttlSeconds: 3600 }),
      ).rejects.toBeInstanceOf(PreviewShareConflictError);
      expect(edge.create).not.toHaveBeenCalled();
    },
  );

  it('rejects a symlink in an intermediate static publish path component', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-preview-static-'));
    const clone = join(root, 'repo');
    await mkdir(join(clone, 'real', 'dist'), { recursive: true });
    await symlink(join(clone, 'real'), join(clone, 'public'));
    const { manager, store, edge } = fixture();
    store.getProject.mockResolvedValueOnce({ ...project, cloneDir: 'repo' } as typeof project);
    const options = (
      manager as unknown as {
        options: { hostCloneRoot: string; dataVolumeRoot: string };
      }
    ).options;
    options.hostCloneRoot = root;
    options.dataVolumeRoot = root;
    await expect(
      manager.create({
        projectId: 'p1',
        staticPath: 'public/dist',
        pin: '123456',
        ttlSeconds: 3600,
      }),
    ).rejects.toBeInstanceOf(PreviewShareConflictError);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('revokes an active share when its dev server is no longer running', async () => {
    const { manager, store, isDevServerRunning, edge, record } = fixture();
    store.listPublicPreviewShares.mockResolvedValueOnce([{ ...record, state: 'active' }]);
    isDevServerRunning.mockResolvedValueOnce(false);
    await manager.reconcile();
    expect(edge.remove).toHaveBeenCalledWith(record.id);
  });

  it('revokes an active share when its connector is no longer running', async () => {
    const { manager, store, docker, edge, inspect, record } = fixture();
    store.listPublicPreviewShares.mockResolvedValueOnce([
      { ...record, state: 'active', connectorContainerId: 'connector-id' },
    ]);
    docker.inspectContainer
      .mockResolvedValueOnce(inspect)
      .mockResolvedValueOnce({ ...inspect, id: 'connector-id', running: false });
    await manager.reconcile();
    expect(edge.remove).toHaveBeenCalledWith(record.id);
  });

  it('revokes an active share when runtime status cannot be determined', async () => {
    const { manager, store, isDevServerRunning, edge, record } = fixture();
    store.listPublicPreviewShares.mockResolvedValueOnce([
      { ...record, state: 'active', connectorContainerId: 'connector-id' },
    ]);
    isDevServerRunning.mockRejectedValueOnce(new Error('runtime unavailable'));
    await manager.reconcile();
    expect(edge.remove).toHaveBeenCalledWith(record.id);
  });

  it('finishes cleanup after losing a concurrent revocation claim', async () => {
    const { manager, store, edge, record } = fixture();
    store.getPublicPreviewShare
      .mockResolvedValueOnce({
        ...record,
        state: 'active',
        connectorContainerId: 'connector-id',
      })
      .mockResolvedValueOnce({
        ...record,
        state: 'revoking',
        connectorContainerId: 'connector-id',
      });
    store.transitionPublicPreviewShare.mockResolvedValueOnce(undefined);
    await expect(manager.stop(record.id)).resolves.toBe(true);
    expect(edge.remove).toHaveBeenCalledWith(record.id);
  });

  it('fences project replacement until concurrent share creation finishes', async () => {
    const { manager, edge } = fixture();
    let finishEdge!: () => void;
    edge.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishEdge = () =>
            resolve({
              shareId: 'share-id',
              publicOrigin: 'https://share-id.preview.example',
              edgeUrl: 'wss://share-id.preview.example/__verity/connector',
              connectorToken: 'c'.repeat(32),
              sessionSecret: 's'.repeat(32),
              expiresAt: new Date('2030-01-01T01:00:00Z'),
            });
        }),
    );
    const creating = manager.create({
      devServerId: 'dev-1',
      pin: '123456',
      ttlSeconds: 3600,
    });
    await vi.waitFor(() => expect(edge.create).toHaveBeenCalled());

    const mutation = vi.fn(async () => undefined);
    const replacing = manager.withProjectMutation('p1', mutation);
    await Promise.resolve();
    expect(mutation).not.toHaveBeenCalled();

    finishEdge();
    await creating;
    await replacing;
    expect(mutation).toHaveBeenCalledOnce();
  });

  it('fences share creation until a dev-server mutation releases', async () => {
    const { manager, edge } = fixture();
    const release = await manager.beginDevServerMutation('dev-1');
    const creating = manager.create({
      devServerId: 'dev-1',
      pin: '123456',
      ttlSeconds: 3600,
    });
    await Promise.resolve();
    expect(edge.create).not.toHaveBeenCalled();

    release();
    await creating;
    expect(edge.create).toHaveBeenCalledOnce();
  });
});

describe('sweepOrphanedPreviewShares', () => {
  it('kills the connector and revokes every non-terminal share', async () => {
    const { store, docker, record } = fixture();
    store.listPublicPreviewShares.mockResolvedValueOnce([
      { ...record, state: 'active', connectorContainerId: 'connector-id' },
      { ...record, id: 'other', state: 'creating', connectorContainerName: 'verity-preview-other' },
      { ...record, id: 'done', state: 'revoked' },
    ]);
    const swept = await sweepOrphanedPreviewShares({
      store: store as unknown as EventStore,
      docker: docker as unknown as DockerClient,
      now: () => new Date('2030-01-01T00:00:00Z'),
    });
    expect(swept).toBe(2);
    expect(docker.removeContainer).toHaveBeenNthCalledWith(1, 'connector-id');
    expect(docker.removeContainer).toHaveBeenNthCalledWith(2, 'verity-preview-other');
    expect(store.transitionPublicPreviewShare.mock.calls.map(([id, , to]) => [id, to])).toEqual([
      ['share-id', 'revoked'],
      ['other', 'revoked'],
    ]);
    expect(store.transitionPublicPreviewShare.mock.calls[0]?.[3]).toEqual({
      connectorContainerId: null,
      revokedAt: new Date('2030-01-01T00:00:00Z'),
    });
  });

  it('closes out the remaining shares when one connector cannot be removed', async () => {
    const { store, docker, record } = fixture();
    store.listPublicPreviewShares.mockResolvedValueOnce([
      { ...record, state: 'active', connectorContainerId: 'stuck' },
      { ...record, id: 'other', state: 'active', connectorContainerId: 'connector-id' },
    ]);
    docker.removeContainer.mockRejectedValueOnce(new Error('daemon unreachable'));
    await expect(
      sweepOrphanedPreviewShares({
        store: store as unknown as EventStore,
        docker: docker as unknown as DockerClient,
      }),
    ).rejects.toThrow(AggregateError);
    expect(store.transitionPublicPreviewShare.mock.calls.map(([id]) => id)).toEqual(['other']);
  });
});
