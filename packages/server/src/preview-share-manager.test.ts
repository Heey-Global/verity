import { sessionSandboxSpec } from './session-sandbox.js';
import type { ProjectRecord } from '@verity/store';
import { DockerError } from './docker.js';
import {
  STANDARD_MOUNTS,
  standardMountBind,
  standardDataMountPaths,
  publicSshBinds,
  GATEWAY_MOUNTS,
} from './sandbox-standard-mounts.js';
import { knowledgeSandboxBinds } from './knowledge-folder.js';
import type { EventStore } from '@verity/store';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerInspect, DockerClient } from './docker.js';
import { sandboxAgentSeedHostPath } from './self-update/agent-seed-stamp.js';
import {
  PreviewShareConflictError,
  PreviewShareInputError,
  PreviewShareManager,
  PreviewShareNotFoundError,
  type PreviewShareManagerOptions,
  sweepOrphanedPreviewShares,
} from './preview-share-manager.js';
import {
  codexGatewayConfig,
  openCodeSettingsConfig,
  materializeOpenCodeSettings,
  projectNetworkName,
  RUNNER_BROKER_CAPABILITIES,
} from './provisioner.js';

const digest = `ghcr.io/heey-global/verity/preview-connector@sha256:${'a'.repeat(64)}`;
const project = {
  id: 'p1',
  containerName: 'verity-project',
  state: 'active',
};
const devServer = { id: 'dev-1', projectId: 'p1', containerPort: '3000' };

function fixture(
  options: {
    inspectArtifact?: PreviewShareManagerOptions['inspectArtifact'];
    listArtifactDirectory?: PreviewShareManagerOptions['listArtifactDirectory'];
    agentSeedHostPath?: string | undefined;
    onShareEnded?: PreviewShareManagerOptions['onShareEnded'];
  } = {},
) {
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
    pin: '123456',
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
    listMovePreviewRestarts: vi.fn(async () => [] as { source_project_id: string }[]),
    listDevServers: vi.fn(async () => [{ ...devServer, previewSessionId: 'moving' }]),
    getDevServer: vi.fn(async () => devServer),
    getSession: vi.fn<EventStore['getSession']>(async () => undefined),
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
    capAdd: [...RUNNER_BROKER_CAPABILITIES],
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges:true'],
    readOnlyRootfs: false,
    runtime: 'runsc-project',
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
    create: vi.fn(async (input: { pinHash: string; durationSeconds: number }) => ({
      shareId: 'share-id',
      publicOrigin: 'https://share-id.preview.example',
      edgeUrl: 'wss://share-id.preview.example/__verity/connector',
      connectorToken: 'c'.repeat(32),
      sessionSecret: 's'.repeat(32),
      expiresAt: new Date(Date.UTC(2030, 0, 1) + input.durationSeconds * 1000),
    })),
    remove: vi.fn(async () => undefined),
  };
  const resolveConnectorImage = vi.fn<() => Promise<string | undefined>>(async () => digest);
  const isDevServerRunning = vi.fn(async () => true);
  const log = { info: vi.fn(), warn: vi.fn() };
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
    log,
    ...(options.inspectArtifact === undefined ? {} : { inspectArtifact: options.inspectArtifact }),
    ...(options.onShareEnded === undefined ? {} : { onShareEnded: options.onShareEnded }),
    ...(options.listArtifactDirectory === undefined
      ? {}
      : { listArtifactDirectory: options.listArtifactDirectory }),
    ...(options.agentSeedHostPath === undefined
      ? {}
      : { agentSeedHostPath: options.agentSeedHostPath }),
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
    log,
  };
}

describe('public preview duration and PIN policy', () => {
  it.each([
    ['1 hour', 3600, '123456'],
    ['24 hours', 86400, '123456'],
    ['7 days', 604800, '123456'],
    ['30 days', 2592000, '123456'],
  ])('creates a %s share', async (_label, ttlSeconds, pin) => {
    const { manager, edge } = fixture();
    await manager.create({ devServerId: 'dev-1', pin, ttlSeconds });
    expect(edge.create).toHaveBeenCalledWith({
      pinHash: expect.any(String),
      durationSeconds: ttlSeconds,
    });
  });

  it.each([900, 7200, 28800, 31 * 86400])('rejects unsupported duration %i', async (ttlSeconds) => {
    const { manager, edge } = fixture();
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456789012', ttlSeconds }),
    ).rejects.toThrow('TTL must be 1 hour, 24 hours, 7 days, or 30 days');
    expect(edge.create).not.toHaveBeenCalled();
  });

  it.each(['12345', '1234567', '123456789012', 'abcdef'])('rejects PIN %s', async (pin) => {
    const { manager, edge } = fixture();
    await expect(
      manager.create({ devServerId: 'dev-1', pin, ttlSeconds: 2592000 }),
    ).rejects.toThrow('PIN must contain exactly 6 digits');
    expect(edge.create).not.toHaveBeenCalled();
  });
});

/** A `performance.now()` that moves only when a test says so, so a step's
 * recorded duration is exactly the time that step was made to take. */
function manualClock() {
  let now = 0;
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => now);
  return {
    advance(milliseconds: number) {
      now += milliseconds;
    },
    restore: () => spy.mockRestore(),
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

describe('PreviewShareManager', () => {
  it('allows only one active static link per session even for a different folder', async () => {
    const { manager, store, edge, record } = fixture();
    store.getSession.mockResolvedValue({
      sessionId: 's1',
      projectId: 'p1',
      worktree: '/data/repo/sessions/s1',
      model: 'test',
      name: null,
      lastSeenEventCount: null,
    });
    store.listPublicPreviewShares.mockResolvedValueOnce([
      { ...record, devServerId: null, sessionId: 's1', staticPath: 'site/one', state: 'active' },
    ]);
    await expect(
      manager.create({ sessionId: 's1', staticPath: 'site/two', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow('target already has an active public share');
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('mounts the selected session worktree folder and records the session source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-preview-session-'));
    const worktree = join(root, 'repo', 'sessions', 's1');
    await mkdir(join(worktree, 'site', 'dist'), { recursive: true });
    await writeFile(join(worktree, 'site', 'dist', 'index.html'), 'index');
    await writeFile(join(worktree, 'site', 'dist', 'zoom-v2.html'), 'zoom');
    await writeFile(join(worktree, 'site', 'dist', '.secret'), 'hidden');
    await symlink('index.html', join(worktree, 'site', 'dist', 'linked.html'));
    await mkdir(join(worktree, '.private'));
    await symlink(join(worktree, '.private'), join(worktree, 'linked'));
    const { manager, store, docker } = fixture();
    store.getProject.mockResolvedValue({ ...project, cloneDir: 'repo' } as typeof project);
    store.getSession.mockResolvedValue({
      sessionId: 's1',
      projectId: 'p1',
      worktree,
      model: 'test',
      name: null,
      lastSeenEventCount: null,
    });
    const options = (
      manager as unknown as { options: { hostCloneRoot: string; dataVolumeRoot: string } }
    ).options;
    options.hostCloneRoot = root;
    options.dataVolumeRoot = root;
    await expect(manager.listStaticDirectories('p1', '', 's1')).resolves.toEqual(['site']);
    await expect(manager.listStaticDirectories('p1', 'site', 's1')).resolves.toEqual(['dist']);
    await expect(manager.listStaticEntries('p1', 'site/dist', 's1')).resolves.toEqual({
      directories: [],
      files: ['index.html', 'zoom-v2.html'],
    });
    await expect(manager.listStaticDirectories('p1', 'linked', 's1')).rejects.toThrow(/not safe/);
    await manager.create({
      sessionId: 's1',
      staticPath: 'site/dist',
      pin: '123456',
      ttlSeconds: 3600,
    });
    expect(store.createPublicPreviewShare).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', staticPath: 'site/dist' }),
    );
    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        user: '1000:1000',
        volumeMounts: [
          {
            volume: 'verity-data',
            subpath: 'repo/sessions/s1/site/dist',
            target: '/preview-workspace/public',
            readOnly: true,
          },
        ],
      }),
    );
  });
  it('mounts the session worktree root when it is selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-preview-session-root-'));
    const worktree = join(root, 'repo', 'sessions', 's1');
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, 'index.html'), '<h1>preview</h1>');
    const { manager, store, docker } = fixture();
    store.getProject.mockResolvedValue({ ...project, cloneDir: 'repo' } as typeof project);
    store.getSession.mockResolvedValue({
      sessionId: 's1',
      projectId: 'p1',
      worktree,
      model: 'test',
      name: null,
      lastSeenEventCount: null,
    });
    const options = (
      manager as unknown as {
        options: { hostCloneRoot: string; dataVolumeRoot: string };
      }
    ).options;
    options.hostCloneRoot = root;
    options.dataVolumeRoot = root;
    await manager.create({ sessionId: 's1', staticPath: '.', pin: '123456', ttlSeconds: 3600 });
    expect(store.createPublicPreviewShare).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', staticPath: '.' }),
    );
    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        user: '1000:1000',
        volumeMounts: [
          {
            volume: 'verity-data',
            subpath: 'repo/sessions/s1',
            target: '/preview-workspace/public',
            readOnly: true,
          },
        ],
      }),
    );
  });
  it('rejects a session worktree outside its project before contacting Uplink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-preview-outside-'));
    await mkdir(join(root, 'repo'), { recursive: true });
    const outside = join(root, 'other', 's1');
    await mkdir(join(outside, 'dist'), { recursive: true });
    const { manager, store, edge } = fixture();
    store.getProject.mockResolvedValue({ ...project, cloneDir: 'repo' } as typeof project);
    store.getSession.mockResolvedValue({
      sessionId: 's1',
      projectId: 'p1',
      worktree: outside,
      model: 'test',
      name: null,
      lastSeenEventCount: null,
    });
    const options = (
      manager as unknown as { options: { hostCloneRoot: string; dataVolumeRoot: string } }
    ).options;
    options.hostCloneRoot = root;
    options.dataVolumeRoot = root;
    await expect(
      manager.create({ sessionId: 's1', staticPath: 'dist', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow('outside the project checkout');
    expect(edge.create).not.toHaveBeenCalled();
  });
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

  it('keeps the PIN it was given and hands the Uplink only the hash', async () => {
    const { manager, store, edge } = fixture();
    await manager.create({ devServerId: 'dev-1', pin: '482913', ttlSeconds: 3600 });

    expect(store.createPublicPreviewShare).toHaveBeenCalledWith(
      expect.objectContaining({ pin: '482913' }),
    );
    // The Uplink verifies logins itself and must still never see the PIN.
    expect(JSON.stringify(edge.create.mock.calls)).not.toContain('482913');
  });

  it('lists the stored PIN so another device can show it again', async () => {
    const { manager, store } = fixture();
    store.listPublicPreviewShares.mockResolvedValueOnce([
      { ...(await store.getPublicPreviewShare('share-id'))!, state: 'active', pin: '482913' },
      { ...(await store.getPublicPreviewShare('share-id'))!, id: 'expired-share', pin: null },
    ]);
    expect((await manager.list('p1')).map((share) => share.pin)).toEqual(['482913']);
  });

  it('attributes the time a link takes to the step that spent it', async () => {
    const clock = manualClock();
    try {
      const { manager, edge, docker, log, resolveConnectorImage } = fixture();
      // Distinct durations per step, so a mark placed one step early or late
      // moves a number onto the wrong name instead of leaving the totals intact.
      resolveConnectorImage.mockImplementationOnce(async () => {
        clock.advance(300);
        return digest;
      });
      edge.create.mockImplementationOnce(async (input) => {
        clock.advance(4_000);
        return await fixture().edge.create(input);
      });
      docker.startContainer.mockImplementationOnce(async () => {
        clock.advance(700);
      });
      docker.containerLogs.mockImplementationOnce(async () => {
        clock.advance(2_500);
        return 'preview connector established\n';
      });

      await manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 });

      expect(log.info).toHaveBeenCalledWith(
        {
          shareId: 'share-id',
          targetKind: 'dev-server',
          phasesMs: {
            validate: 0,
            connectorImage: 300,
            pinHash: 0,
            uplinkCreate: 4_000,
            persist: 0,
            connectorStart: 700,
            connectorReady: 2_500,
            activate: 0,
          },
          totalMs: 7_500,
        },
        'public preview share created',
      );
      // Order is the point of the record: it is read as a timeline.
      const [fields] = log.info.mock.calls.at(-1)! as [{ phasesMs: object }];
      expect(Object.keys(fields.phasesMs)).toEqual([
        'validate',
        'connectorImage',
        'pinHash',
        'uplinkCreate',
        'persist',
        'connectorStart',
        'connectorReady',
        'activate',
      ]);
    } finally {
      clock.restore();
    }
  });

  it('names the last step a failed link completed', async () => {
    const { manager, docker, log } = fixture();
    docker.containerLogs.mockResolvedValue('connecting\n');

    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow('readiness timed out');

    // A readiness timeout is fifteen seconds of a spinner; the line has to say
    // it was the connector's edge connection and not the Uplink round trip.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ completedPhase: 'connectorStart', errorName: 'Error' }),
      'public preview share creation failed',
    );
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'public preview share created');
  });

  it('times the connector removal and the Uplink removal of a stop separately', async () => {
    const clock = manualClock();
    try {
      const { manager, docker, edge, log } = fixture();
      let releaseUplink!: () => void;
      // They run in parallel, so only separate numbers say which one the user
      // was waiting for. The Uplink is held open past the container removal.
      edge.remove.mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseUplink = () => {
              clock.advance(3_000);
              resolve(undefined);
            };
          }),
      );
      docker.removeContainer.mockImplementationOnce(async () => {
        // After a tick, as a real daemon call would: advanced synchronously it
        // would land before the Uplink half had even started its clock.
        await Promise.resolve();
        clock.advance(400);
      });

      const stopped = manager.stop('share-id');
      await flush();
      releaseUplink();
      await expect(stopped).resolves.toBe(true);

      expect(log.info).toHaveBeenCalledWith(
        {
          shareId: 'share-id',
          waitedForCreationMs: 0,
          connectorRemoveMs: 400,
          uplinkRemoveMs: 3_400,
          totalMs: 3_400,
        },
        'public preview share stopped',
      );
    } finally {
      clock.restore();
    }
  });

  it('removes the connector by name when its stored id is empty', async () => {
    const { manager, store, docker } = fixture();
    store.transitionPublicPreviewShare.mockImplementationOnce(async (_id, _from, state) => ({
      ...fixture().record,
      connectorContainerId: '',
      state,
    }));

    await expect(manager.stop('share-id')).resolves.toBe(true);
    expect(docker.removeContainer).toHaveBeenCalledWith('verity-preview-share-id');
  });

  it('logs an incomplete stop as a warning without a duration for the failed half', async () => {
    const { manager, docker, log } = fixture();
    docker.removeContainer.mockRejectedValueOnce(new Error('Docker unavailable'));

    await expect(manager.stop('share-id')).rejects.toThrow(/revocation did not complete/);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorRemoveMs: null, uplinkRemoveMs: expect.any(Number) }),
      'public preview share stop incomplete',
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

  it('blocks capabilities outside the runner broker profile', async () => {
    const { manager, docker, edge, inspect } = fixture();
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      capAdd: [...RUNNER_BROKER_CAPABILITIES, 'SYS_ADMIN'],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/security metadata is incomplete or privileged/);
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

  it('accepts the agent seed from the source the provisioner resolves', async () => {
    // Resolved through the same function server-main hands the provisioner, so a
    // layout change there (as `.current` was) cannot silently block every share.
    const agentSeedHostPath = sandboxAgentSeedHostPath({
      VERITY_AGENT_SEED_ROOT_HOST_PATH: '/srv/verity/seed-root',
    });
    expect(agentSeedHostPath).toBe('/srv/verity/seed-root/.current');
    const { manager, docker, inspect } = fixture({ agentSeedHostPath });
    docker.inspectContainer.mockResolvedValue({
      ...inspect,
      mountCount: 1,
      mounts: [
        {
          type: 'bind',
          source: agentSeedHostPath,
          destination: '/opt/agent-seed',
          readWrite: false,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).resolves.toMatchObject({ state: 'active' });
  });

  it.each([
    ['another source', '/srv/verity/secrets/.current', false],
    ['a writable seed', '/srv/verity/seed-root/.current', true],
  ])('rejects an agent seed mount from %s', async (_label, source, readWrite) => {
    const { manager, docker, edge, inspect } = fixture({
      agentSeedHostPath: '/srv/verity/seed-root/.current',
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      mountCount: 1,
      mounts: [{ type: 'bind', source, destination: '/opt/agent-seed', readWrite }],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/unsupported sandbox mount/);
    expect(edge.create).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('blocks unrecognized mounts even when their paths look harmless', async () => {
    const { manager, docker, edge, inspect } = fixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
    ).rejects.toThrow(/unsupported sandbox mount/);
    expect(edge.create).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      'verity: unsupported sandbox mount at "/run/config/app.conf"',
    );
    warning.mockRestore();
  });

  it('accepts only the project-scoped standard mounts with their expected access', async () => {
    const { manager, docker, store, inspect } = fixture();
    store.getProject.mockResolvedValue({ ...project, cloneDir: 'p1' } as typeof project);
    const mounts: NonNullable<ContainerInspect['mounts']> = [
      ['/knowledge', 'knowledge/p1', false],
      ['/knowledge/insights', 'knowledge/p1/insights', true],
      ['/knowledge/shared', 'knowledge/shared', false],
      ['/etc/resolv.conf', 'secrets/dns/resolv.p1.conf', false],
      ['/work/.git/config', 'p1/.git/config', false],
    ].map(([destination, subpath, readWrite]) => ({
      type: 'volume',
      name: 'verity-data',
      destination: String(destination),
      subpath: String(subpath),
      readWrite: readWrite === true,
    }));
    docker.inspectContainer.mockResolvedValue({ ...inspect, mountCount: mounts.length, mounts });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).resolves.toMatchObject({ state: 'active' });
  });

  it('rejects a standard mount redirected to another project', async () => {
    const { manager, docker, edge, inspect } = fixture();
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      mountCount: 1,
      mounts: [
        {
          type: 'volume',
          name: 'verity-data',
          subpath: 'knowledge/other',
          destination: '/knowledge',
          readWrite: false,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/unsupported sandbox mount/);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('rejects a writable shared knowledge mount', async () => {
    const { manager, docker, edge, inspect } = fixture();
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      mountCount: 1,
      mounts: [
        {
          type: 'volume',
          name: 'verity-data',
          subpath: 'knowledge/shared',
          destination: '/knowledge/shared',
          readWrite: true,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/unsupported sandbox mount/);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('allows the project-scoped GitHub broker capability with exact metadata', async () => {
    const inspectArtifact = vi.fn(async () => ({
      uid: 1000,
      gid: process.getgid?.() ?? 1000,
      mode: 0o600,
      kind: 'file' as const,
      contents: 'capability',
    }));
    const { manager, docker, inspect } = fixture({ inspectArtifact });
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      env: [
        'VERITY_GH_TOKEN_URL=http://relay/internal/github/token',
        'VERITY_GH_BROKER_CAPABILITY_FILE=/run/verity/gh-token-capability',
      ],
      mountCount: 1,
      mounts: [
        {
          type: 'volume',
          name: 'verity-data',
          source: '/var/lib/docker/volumes/verity-data/_data/secrets/git/gh_token_capability.p1',
          subpath: 'secrets/git/gh_token_capability.p1',
          destination: '/run/verity/gh-token-capability',
          readWrite: false,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).resolves.toMatchObject({ state: 'active' });
    expect(inspectArtifact).toHaveBeenCalledWith('/data/secrets/git/gh_token_capability.p1', false);
  });

  it('allows the agent-gateway identity only with its exact paths and permissions', async () => {
    const inspectArtifact = vi.fn(async (path: string) => ({
      uid: 1000,
      gid: path.endsWith('.key') ? 1101 : (process.getgid?.() ?? 1000),
      mode: path.endsWith('.key') ? 0o040 : 0o644,
      kind: 'file' as const,
      contents: path.endsWith('.key') ? 'private key' : 'certificate',
    }));
    const { manager, docker, inspect } = fixture({ inspectArtifact });
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      env: ['VERITY_AGENT_GATEWAY_CLIENT_KEY_FILE=/run/verity/claude-egress/client.key'],
      mountCount: 3,
      mounts: [
        ['egress_ca.p1.crt', '/run/verity/claude-egress/ca.crt'],
        ['egress_client.p1.crt', '/run/verity/claude-egress/client.crt'],
        ['egress_client.p1.key', '/run/verity/claude-egress/client.key'],
      ].map(([source, destination]) => ({
        type: 'volume',
        name: 'verity-data',
        source: `/var/lib/docker/volumes/verity-data/_data/secrets/claude-egress/${source}`,
        subpath: `secrets/claude-egress/${source}`,
        destination,
        readWrite: false,
      })),
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).resolves.toMatchObject({ state: 'active' });
    expect(inspectArtifact).toHaveBeenCalledWith(
      '/data/secrets/claude-egress/egress_client.p1.key',
      false,
    );
  });

  it('blocks a broker capability whose mode is broader than the provisioner contract', async () => {
    const { manager, docker, edge, inspect } = fixture({
      inspectArtifact: async () => ({
        uid: 1000,
        gid: process.getgid?.() ?? 1000,
        mode: 0o644,
        kind: 'file',
      }),
    });
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      env: ['VERITY_GH_BROKER_CAPABILITY_FILE=/run/verity/gh-token-capability'],
      mountCount: 1,
      mounts: [
        {
          type: 'volume',
          name: 'verity-data',
          source: '/var/lib/docker/volumes/verity-data/_data/secrets/git/gh_token_capability.p1',
          subpath: 'secrets/git/gh_token_capability.p1',
          destination: '/run/verity/gh-token-capability',
          readWrite: false,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/mounted credentials/);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('allows only server-generated Codex and OpenCode gateway configuration', async () => {
    const inspectArtifact = vi.fn(async (path: string) => {
      const common = { uid: 1000, gid: 1000 };
      if (path.endsWith('/opencode')) {
        return { ...common, mode: 0o755, kind: 'directory' as const };
      }
      if (path.endsWith('/opencode/opencode.json')) {
        return {
          ...common,
          mode: 0o644,
          kind: 'file' as const,
          contents: JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            autoupdate: false,
            permission: {
              read: { '/knowledge/**': 'allow' },
              external_directory: { '/knowledge/**': 'allow' },
            },
            provider: {
              verity: {
                npm: '@ai-sdk/openai-compatible',
                name: 'OpenAI-compatible',
                options: {
                  baseURL: 'http://127.0.0.1:47821/opencode',
                  apiKey: 'verity-opencode-gateway-placeholder-v1',
                },
                models: { 'model-a': { name: 'model-a' } },
              },
            },
          }),
        };
      }
      return {
        ...common,
        mode: 0o644,
        kind: 'file' as const,
        contents: codexGatewayConfig(47_821),
      };
    });
    const { manager, docker, inspect } = fixture({
      inspectArtifact,
      listArtifactDirectory: async () => ['opencode.json'],
    });
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      mountCount: 2,
      mounts: [
        {
          type: 'volume',
          name: 'verity-data',
          source: '/var/lib/docker/volumes/verity-data/_data/secrets/codex/config.toml',
          subpath: 'secrets/codex/config.toml',
          destination: '/run/verity/codex/config.toml',
          readWrite: false,
        },
        {
          type: 'volume',
          name: 'verity-data',
          source: '/var/lib/docker/volumes/verity-data/_data/secrets/opencode',
          subpath: 'secrets/opencode',
          destination: '/run/verity/opencode-config',
          readWrite: false,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).resolves.toMatchObject({ state: 'active' });
  });

  it('blocks provider credentials hidden in an otherwise valid gateway config mount', async () => {
    const { manager, docker, edge, inspect } = fixture({
      inspectArtifact: async (path) =>
        path.endsWith('/opencode')
          ? { uid: 1000, gid: 1000, mode: 0o755, kind: 'directory' }
          : {
              uid: 1000,
              gid: 1000,
              mode: 0o644,
              kind: 'file',
              contents: JSON.stringify({
                provider: { attacker: { options: { apiKey: 'provider-secret' } } },
              }),
            },
      listArtifactDirectory: async () => ['opencode.json'],
    });
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      mountCount: 1,
      mounts: [
        {
          type: 'volume',
          name: 'verity-data',
          subpath: 'secrets/opencode',
          destination: '/run/verity/opencode-config',
          readWrite: false,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/mounted credentials/);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('blocks additional files beside the validated OpenCode gateway config', async () => {
    const { manager, docker, edge, inspect } = fixture({
      inspectArtifact: async (path) =>
        path.endsWith('/opencode')
          ? { uid: 1000, gid: 1000, mode: 0o755, kind: 'directory' }
          : {
              uid: 1000,
              gid: 1000,
              mode: 0o644,
              kind: 'file',
              contents: JSON.stringify({ autoupdate: false }),
            },
      listArtifactDirectory: async () => ['auth.json', 'opencode.json'],
    });
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      mountCount: 1,
      mounts: [
        {
          type: 'volume',
          name: 'verity-data',
          subpath: 'secrets/opencode',
          destination: '/run/verity/opencode-config',
          readWrite: false,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/mounted credentials/);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('blocks credentials hidden in OpenCode model options', async () => {
    const { manager, docker, edge, inspect } = fixture({
      inspectArtifact: async (path) =>
        path.endsWith('/opencode')
          ? { uid: 1000, gid: 1000, mode: 0o755, kind: 'directory' }
          : {
              uid: 1000,
              gid: 1000,
              mode: 0o644,
              kind: 'file',
              contents: JSON.stringify({
                $schema: 'https://opencode.ai/config.json',
                autoupdate: false,
                provider: {
                  verity: {
                    npm: '@ai-sdk/openai-compatible',
                    name: 'OpenAI-compatible',
                    options: {
                      baseURL: 'http://127.0.0.1:47821/opencode',
                      apiKey: 'verity-opencode-gateway-placeholder-v1',
                    },
                    models: {
                      'model-a': { name: 'model-a', apiKey: 'provider-secret' },
                    },
                  },
                },
              }),
            },
      listArtifactDirectory: async () => ['opencode.json'],
    });
    docker.inspectContainer.mockResolvedValueOnce({
      ...inspect,
      mountCount: 1,
      mounts: [
        {
          type: 'volume',
          name: 'verity-data',
          subpath: 'secrets/opencode',
          destination: '/run/verity/opencode-config',
          readWrite: false,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/mounted credentials/);
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
      { revokedAt: new Date('2030-01-01T00:00:00Z') },
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

  it('shares only the selected static directory despite other sandbox mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-preview-static-'));
    await mkdir(join(root, 'repo', 'dist'), { recursive: true });
    const { manager, store, docker, inspect } = fixture();
    store.getProject.mockResolvedValue({ ...project, cloneDir: 'repo' } as typeof project);
    const options = (
      manager as unknown as {
        options: { hostCloneRoot: string; dataVolumeRoot: string };
      }
    ).options;
    options.hostCloneRoot = root;
    options.dataVolumeRoot = root;
    docker.inspectContainer.mockResolvedValue({
      ...inspect,
      mountCount: 1,
      mounts: [
        {
          type: 'bind',
          source: '/private/drive',
          destination: '/mnt/drive',
          readWrite: false,
        },
      ],
    });
    await expect(
      manager.create({ projectId: 'p1', staticPath: 'dist', pin: '123456', ttlSeconds: 3600 }),
    ).resolves.toMatchObject({ state: 'active' });
    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        volumeMounts: [
          {
            volume: 'verity-data',
            target: '/preview-workspace/public',
            subpath: 'repo/dist',
            readOnly: true,
          },
        ],
        env: expect.arrayContaining(['VERITY_PREVIEW_STATIC_PATH=public']),
      }),
    );
  });

  it('does not persist a share when Uplink creation fails', async () => {
    const { manager, edge, store } = fixture();
    edge.create.mockRejectedValueOnce(new Error('edge create failed'));
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow('Uplink could not create the preview');
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
      { failure: 'database interrupted', revokedAt: new Date('2030-01-01T00:00:00Z') },
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

  // A managed dev server with Local off stops once its last link ends; without
  // this notice an expired link would leave it running unnoticed.
  it('reports an ended managed link on Uplink expiry, revocation, and disabling', async () => {
    const onShareEnded = vi.fn();
    const { manager, store, record } = fixture({ onShareEnded });
    const active = {
      ...record,
      state: 'active' as const,
      connectorContainerId: 'connector-id',
      managedInstanceId: 'instance-1',
    };
    store.getPublicPreviewShare.mockResolvedValueOnce(active);
    store.transitionPublicPreviewShare.mockResolvedValueOnce({ ...active, state: 'revoking' });
    await manager.finishExpiredByUplink(record.id);
    expect(onShareEnded).toHaveBeenLastCalledWith({
      id: record.id,
      managedInstanceId: 'instance-1',
    });

    store.getPublicPreviewShare.mockResolvedValueOnce(active);
    store.transitionPublicPreviewShare.mockResolvedValueOnce({ ...active, state: 'revoking' });
    await manager.stop(record.id);
    expect(onShareEnded).toHaveBeenCalledTimes(2);

    // Losing the Uplink or Premium ends every link at once.
    store.listPublicPreviewShares.mockResolvedValueOnce([active]);
    store.transitionPublicPreviewShare.mockResolvedValueOnce({ ...active, state: 'revoking' });
    await manager.disableAll('lease expired');
    expect(onShareEnded).toHaveBeenCalledTimes(3);
  });

  it('preserves revocation intent time when delayed cleanup finishes', async () => {
    const { manager, store, record } = fixture();
    const began = new Date('2029-12-01T00:00:00Z');
    const active = { ...record, state: 'active' as const };
    store.getPublicPreviewShare.mockResolvedValueOnce(active);
    store.transitionPublicPreviewShare.mockResolvedValueOnce({
      ...active,
      state: 'revoking',
      revokedAt: began,
    });
    await manager.stop(record.id);
    expect(store.transitionPublicPreviewShare).toHaveBeenLastCalledWith(
      record.id,
      ['revoking'],
      expect.any(String),
      expect.objectContaining({ revokedAt: began }),
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

  it('revokes a session preview after its worktree is removed', async () => {
    const { manager, store, edge, record } = fixture();
    store.listPublicPreviewShares.mockResolvedValueOnce([
      {
        ...record,
        state: 'active',
        targetKind: 'static-folder',
        devServerId: null,
        targetPort: null,
        staticPath: 'dist',
        sessionId: 's1',
        connectorContainerId: 'connector-id',
      },
    ]);
    store.getSession.mockResolvedValueOnce(undefined);
    await manager.reconcile();
    expect(edge.remove).toHaveBeenCalledWith(record.id);
  });
  it('revokes a static session link before moving its worktree', async () => {
    const { manager, store, edge, record } = fixture();
    store.listPublicPreviewShares.mockResolvedValueOnce([
      {
        ...record,
        state: 'active',
        targetKind: 'static-folder',
        sessionId: 's1',
        devServerId: null,
        targetPort: null,
        staticPath: 'dist',
      },
    ]);
    await manager.revokeSessionShares('p1', 's1');
    expect(edge.remove).toHaveBeenCalledWith(record.id);
  });

  it('keeps a session preview only while the connector mounts that exact worktree folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-preview-reconcile-'));
    const worktree = join(root, 'repo', 'sessions', 's1');
    await mkdir(join(worktree, 'dist'), { recursive: true });
    const { manager, store, docker, edge, inspect, record } = fixture();
    store.getProject.mockResolvedValue({ ...project, cloneDir: 'repo' } as typeof project);
    store.getSession.mockResolvedValue({
      sessionId: 's1',
      projectId: 'p1',
      worktree,
      model: 'test',
      name: null,
      lastSeenEventCount: null,
    });
    const options = (
      manager as unknown as { options: { hostCloneRoot: string; dataVolumeRoot: string } }
    ).options;
    options.hostCloneRoot = root;
    options.dataVolumeRoot = root;
    const active = {
      ...record,
      state: 'active' as const,
      targetKind: 'static-folder' as const,
      devServerId: null,
      targetPort: null,
      staticPath: 'dist',
      sessionId: 's1',
      connectorContainerId: 'connector-id',
    };
    store.listPublicPreviewShares.mockResolvedValue([active]);
    const connector = {
      ...inspect,
      id: 'connector-id',
      mounts: [
        {
          type: 'volume',
          name: 'verity-data',
          subpath: 'repo/sessions/s1/dist',
          destination: '/preview-workspace/public',
          readWrite: false,
        },
      ],
    };
    docker.inspectContainer.mockResolvedValueOnce(inspect).mockResolvedValueOnce(connector);
    await manager.reconcile();
    expect(edge.remove).not.toHaveBeenCalled();

    docker.inspectContainer.mockResolvedValueOnce(inspect).mockResolvedValueOnce({
      ...connector,
      mounts: [{ ...connector.mounts[0], subpath: 'repo/sessions/other/dist' }],
    });
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
      {
        ...record,
        state: 'active',
        connectorContainerId: 'connector-id',
        managedInstanceId: 'managed-1',
      },
      { ...record, id: 'other', state: 'creating', connectorContainerName: 'verity-preview-other' },
      { ...record, id: 'done', state: 'revoked' },
    ]);
    const onShareEnded = vi.fn();
    const swept = await sweepOrphanedPreviewShares({
      store: store as unknown as EventStore,
      docker: docker as unknown as DockerClient,
      now: () => new Date('2030-01-01T00:00:00Z'),
      onShareEnded,
    });
    expect(swept).toBe(2);
    expect(onShareEnded).toHaveBeenCalledTimes(2);
    expect(onShareEnded).toHaveBeenCalledWith({
      id: record.id,
      managedInstanceId: 'managed-1',
    });
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

  it('preserves the original revocation time during orphan cleanup', async () => {
    const { store, docker, record } = fixture();
    const began = new Date('2029-12-01T00:00:00Z');
    store.listPublicPreviewShares.mockResolvedValueOnce([
      { ...record, state: 'revoking', revokedAt: began },
    ]);
    await sweepOrphanedPreviewShares({
      store: store as unknown as EventStore,
      docker: docker as unknown as DockerClient,
      now: () => new Date('2030-01-01T00:00:00Z'),
    });
    expect(store.transitionPublicPreviewShare).toHaveBeenLastCalledWith(
      record.id,
      ['creating', 'active', 'revoking'],
      'revoked',
      expect.objectContaining({ revokedAt: began }),
    );
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

it('refuses preview mutations while a move restart is pending and releases its fence', async () => {
  const { manager, store } = fixture();
  store.listMovePreviewRestarts.mockResolvedValueOnce([{ source_project_id: 'p1' }]);
  await expect(manager.beginDevServerMutation('dev-1')).rejects.toThrow('pending session move');
  const release = await manager.beginDevServerMutation('dev-1');
  release();
});
it('holds share creation while a session move changes its preview target', async () => {
  const { manager, edge } = fixture();
  const release = await manager.beginSessionMove('p1');
  const creating = manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 });
  await Promise.resolve();
  expect(edge.create).not.toHaveBeenCalled();
  release();
  await creating;
  expect(edge.create).toHaveBeenCalledOnce();
});

it('does not revoke public links just to validate a session move', async () => {
  const { manager } = fixture();
  const revoke = vi.spyOn(manager, 'stopDevServer').mockResolvedValue(undefined);
  const release = await manager.beginSessionMove('p1');
  try {
    expect(revoke).not.toHaveBeenCalled();
  } finally {
    release();
  }
});

describe('session port previews', () => {
  const session = {
    sessionId: 's1',
    projectId: 'p1',
    worktree: '/data/repo/sessions/s1',
    model: 'test',
    name: null,
    lastSeenEventCount: null,
  };
  const listener = (port: number, bind: 'any' | 'loopback', cwd = '/work/sessions/s1/web') => ({
    port,
    bind,
    pid: port,
    cwd,
    command: 'node /work/sessions/s1/node_modules/.bin/vite',
  });

  function portFixture(listeners: ReturnType<typeof listener>[]) {
    const setup = fixture();
    setup.store.getProject.mockResolvedValue({ ...project, cloneDir: 'repo' } as typeof project);
    setup.store.getSession.mockResolvedValue(session);
    const listListeningProcesses = vi.fn(async () => listeners);
    (
      setup.manager as unknown as {
        options: { listListeningProcesses: typeof listListeningProcesses };
      }
    ).options.listListeningProcesses = listListeningProcesses;
    return { ...setup, listListeningProcesses };
  }

  it('lists only what runs inside the session worktree, mapped into the sandbox', async () => {
    const { manager } = portFixture([
      listener(5173, 'any'),
      listener(6006, 'loopback', '/work/sessions/s1'),
      listener(4000, 'any', '/work/sessions/s2'),
    ]);

    await expect(manager.listSessionDevServers('s1')).resolves.toEqual([
      expect.objectContaining({ port: 5173, reachable: true, name: 'Vite', workdir: 'web' }),
      expect.objectContaining({ port: 6006, reachable: false, workdir: '.' }),
    ]);
  });

  it('reports nothing for a sandbox that is not running instead of failing', async () => {
    const { manager, docker, inspect, listListeningProcesses } = portFixture([
      listener(5173, 'any'),
    ]);
    docker.inspectContainer.mockResolvedValueOnce({ ...inspect, running: false });

    await expect(manager.listSessionDevServers('s1')).resolves.toEqual([]);
    expect(listListeningProcesses).not.toHaveBeenCalled();
  });

  it('reports no dev servers when an active project container has disappeared', async () => {
    const { manager, docker, listListeningProcesses } = portFixture([listener(5173, 'any')]);
    // A stale active project must not turn the session's discovery poll into a 500.
    docker.inspectContainer.mockRejectedValueOnce(
      new DockerError({ kind: 'container_not_found', id: project.containerName }),
    );

    await expect(manager.listSessionDevServers('s1')).resolves.toEqual([]);
    expect(listListeningProcesses).not.toHaveBeenCalled();
  });

  it('preserves infrastructure errors during dev server discovery', async () => {
    const { manager, docker, listListeningProcesses } = portFixture([]);
    const failure = new DockerError({ kind: 'network', cause: new Error('Docker unavailable') });
    docker.inspectContainer.mockRejectedValueOnce(failure);

    await expect(manager.listSessionDevServers('s1')).rejects.toBe(failure);
    expect(listListeningProcesses).not.toHaveBeenCalled();
  });

  it('allows the dependency volume produced by the private sandbox contract', async () => {
    const { manager, docker, inspect } = portFixture([listener(5173, 'any')]);
    const spec = sessionSandboxSpec(
      { ...inspect, image: 'sandbox:test' },
      { project: project as ProjectRecord, sessionId: 's1', worktree: '/private/s1' },
    );
    const dependency = spec.volumeMounts!.find((mount) => mount.target === '/work/node_modules')!;
    docker.inspectContainer.mockResolvedValue({
      ...inspect,
      mountCount: (inspect.mounts?.length ?? 0) + 1,
      labels: { ...inspect.labels, 'verity.session-id': 's1' },
      mounts: [
        ...(inspect.mounts ?? []),
        {
          type: 'volume',
          name: dependency.volume,
          destination: dependency.target,
          readWrite: true,
        },
      ],
    });
    await expect(
      manager.create({ sessionId: 's1', targetPort: 5173, pin: '123456', ttlSeconds: 3600 }),
    ).resolves.toBeDefined();
  });
  it('points the connector at the session port over the project network', async () => {
    const { manager, store, docker } = portFixture([listener(5173, 'any')]);

    await manager.create({ sessionId: 's1', targetPort: 5173, pin: '123456', ttlSeconds: 3600 });

    expect(store.createPublicPreviewShare).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        devServerId: null,
        staticPath: null,
        targetKind: 'dev-server',
        targetPort: 5173,
      }),
    );
    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.arrayContaining([
          `VERITY_PREVIEW_TARGET_ORIGIN=http://${project.containerName}:5173`,
        ]),
      }),
    );
  });

  // A loopback-only listener is invisible to the connector: the link would be
  // minted, billed against the Uplink and then answer nothing but errors.
  it('refuses a port that listens on loopback only before contacting the Uplink', async () => {
    const { manager, edge } = portFixture([listener(5173, 'loopback')]);

    await expect(
      manager.create({ sessionId: 's1', targetPort: 5173, pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toBeInstanceOf(PreviewShareConflictError);
    expect(edge.create).not.toHaveBeenCalled();
  });

  // A raw runner error would reach the phone as a 500 with docker output in it.
  it('reports a sandbox it cannot inspect as a conflict, not a server error', async () => {
    const { manager, edge, listListeningProcesses } = portFixture([]);
    listListeningProcesses.mockRejectedValue(new Error('docker exec: timed out'));

    await expect(
      manager.create({ sessionId: 's1', targetPort: 5173, pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toBeInstanceOf(PreviewShareConflictError);
    await expect(manager.listSessionDevServers('s1')).rejects.toBeInstanceOf(
      PreviewShareConflictError,
    );
    expect(edge.create).not.toHaveBeenCalled();
  });

  // The sheet opens on the Dev server tab; a 409 there would be a dead end.
  it('lists nothing where discovery is not wired instead of refusing', async () => {
    const { manager } = portFixture([listener(5173, 'any')]);
    (
      manager as unknown as { options: { listListeningProcesses?: unknown } }
    ).options.listListeningProcesses = undefined;

    await expect(manager.listSessionDevServers('s1')).resolves.toEqual([]);
  });

  it('shares a port next to the session folder link but only once per port', async () => {
    const { manager, store, edge, record } = portFixture([
      listener(5173, 'any'),
      listener(6006, 'any'),
    ]);
    const folder = {
      ...record,
      devServerId: null,
      targetPort: null,
      targetKind: 'static-folder' as const,
      sessionId: 's1',
      staticPath: 'site',
      state: 'active' as const,
    };
    const port = {
      ...record,
      devServerId: null,
      targetPort: 5173,
      targetKind: 'dev-server' as const,
      sessionId: 's1',
      staticPath: null,
      state: 'active' as const,
    };
    store.listPublicPreviewShares.mockResolvedValue([folder, port]);

    await expect(
      manager.create({ sessionId: 's1', targetPort: 5173, pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow('target already has an active public share');
    expect(edge.create).not.toHaveBeenCalled();

    await manager.create({ sessionId: 's1', targetPort: 6006, pin: '123456', ttlSeconds: 3600 });
    expect(edge.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a port without a session and a port combined with a folder', async () => {
    const { manager } = portFixture([listener(5173, 'any')]);

    await expect(
      manager.create({ projectId: 'p1', targetPort: 5173, pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toBeInstanceOf(PreviewShareInputError);
    await expect(
      manager.create({
        sessionId: 's1',
        targetPort: 5173,
        staticPath: 'site',
        pin: '123456',
        ttlSeconds: 3600,
      }),
    ).rejects.toBeInstanceOf(PreviewShareInputError);
  });

  it('revokes a port link only after the session stopped listening for the grace period', async () => {
    const { manager, store, docker, edge, inspect, record, listListeningProcesses } = portFixture([
      listener(5173, 'any'),
    ]);
    store.listPublicPreviewShares.mockResolvedValue([
      {
        ...record,
        devServerId: null,
        targetPort: 5173,
        targetKind: 'dev-server' as const,
        sessionId: 's1',
        staticPath: null,
        state: 'active' as const,
        connectorContainerId: 'connector-id',
      },
    ]);
    docker.inspectContainer.mockResolvedValue(inspect);

    let now = new Date('2030-01-01T00:00:00Z').getTime();
    (manager as unknown as { now: () => Date }).now = () => new Date(now);

    await manager.reconcile();
    expect(edge.remove).not.toHaveBeenCalled();

    // A restarting dev server is gone for a moment; its link and PIN must survive.
    listListeningProcesses.mockResolvedValue([]);
    await manager.reconcile();
    now += 60_000;
    listListeningProcesses.mockRejectedValueOnce(new Error('exec timed out'));
    await manager.reconcile();
    expect(edge.remove).not.toHaveBeenCalled();

    // Back before the grace ran out: the miss is forgotten, not carried forward.
    listListeningProcesses.mockResolvedValue([listener(5173, 'any')]);
    await manager.reconcile();
    now += 60_000;
    listListeningProcesses.mockResolvedValue([]);
    await manager.reconcile();
    expect(edge.remove).not.toHaveBeenCalled();

    now += 90_000;
    await manager.reconcile();
    expect(edge.remove).toHaveBeenCalledWith(record.id);
  });

  it('revokes immediately when another session takes over a shared port', async () => {
    const { manager, store, edge, record, listListeningProcesses } = portFixture([
      listener(5173, 'any'),
    ]);
    store.listPublicPreviewShares.mockResolvedValue([
      {
        ...record,
        devServerId: null,
        targetPort: 5173,
        targetKind: 'dev-server' as const,
        sessionId: 's1',
        staticPath: null,
        state: 'active' as const,
        connectorContainerId: 'connector-id',
      },
    ]);
    listListeningProcesses.mockResolvedValue([listener(5173, 'any', '/work/sessions/s2')]);

    await manager.reconcile();

    expect(edge.remove).toHaveBeenCalled();
  });
});

describe('shared sandbox mount contract', () => {
  it.each(['bind', 'volume'] as const)(
    'accepts provisioned standard mounts as %s mounts',
    async (type) => {
      const { manager, store, docker, inspect } = fixture({
        agentSeedHostPath: '/seed/releases/.current',
      });
      store.getProject.mockResolvedValue({ ...project, cloneDir: 'p1' } as typeof project);
      const paths = standardDataMountPaths('p1', 'p1');
      const dataBinds = [
        ...knowledgeSandboxBinds('/data', 'p1'),
        ...(['workspace', 'gitConfig', 'runner', 'dns'] as const).map((kind) =>
          standardMountBind(kind, join('/data', paths[kind])),
        ),
      ];
      const hostBinds = [
        standardMountBind('agentSeed', '/seed/releases/.current'),
        standardMountBind('disabledTokenScript', '/dev/null'),
      ];
      dataBinds.push(
        ...publicSshBinds('id_ed25519.pub', '/data/secrets/git/id_ed25519.pub', true),
        ...publicSshBinds('known_hosts', '/data/secrets/git/known_hosts', true),
        ...publicSshBinds('allowed_signers', '/data/secrets/git/allowed_signers', true),
      );
      const mounts = [...dataBinds, ...hostBinds].map((bind, index) => {
        const [source, destination, access] = bind.split(':');
        return type === 'volume' && index < dataBinds.length
          ? {
              type: 'volume',
              name: 'verity-data',
              source: '/var/lib/docker/volumes/verity-data/_data',
              subpath: source!.slice('/data/'.length),
              destination,
              readWrite: access !== 'ro',
            }
          : { type: 'bind', source, destination, readWrite: access !== 'ro' };
      });
      docker.inspectContainer.mockResolvedValue({ ...inspect, mounts, mountCount: mounts.length });
      await expect(
        manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
      ).resolves.toMatchObject({ state: 'active' });
    },
  );

  it.each([
    { name: 'other-volume', subpath: 'secrets/git/allowed_signers', readWrite: false },
    { name: 'verity-data', subpath: 'secrets/git/private-key', readWrite: false },
    { name: 'verity-data', subpath: 'secrets/git/allowed_signers', readWrite: true },
  ])('rejects mismatched public SSH volume metadata: %j', async (metadata) => {
    const { manager, docker, inspect, edge } = fixture();
    docker.inspectContainer.mockResolvedValue({
      ...inspect,
      mountCount: 1,
      mounts: [
        {
          type: 'volume',
          source: '/var/lib/docker/volumes/verity-data/_data',
          destination: '/home/dev/.ssh/allowed_signers',
          ...metadata,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/unsupported sandbox mount/);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('rejects a writable knowledge mount even when its source is correct', async () => {
    const { manager, docker, inspect, edge } = fixture();
    const paths = standardDataMountPaths('p1', 'p1');
    docker.inspectContainer.mockResolvedValue({
      ...inspect,
      mountCount: 1,
      mounts: [
        {
          type: 'bind',
          source: join('/data', paths.knowledge),
          destination: STANDARD_MOUNTS.knowledge.target,
          readWrite: true,
        },
      ],
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/unsupported sandbox mount/);
    expect(edge.create).not.toHaveBeenCalled();
  });
});

function gatewayPreviewFixture(
  kind: 'codex' | 'opencode',
  contents: string,
  extraFiles: Record<string, string> = {},
) {
  const spec = GATEWAY_MOUNTS[kind];
  const result = fixture({
    inspectArtifact: async (path) => {
      if (kind === 'opencode' && path.endsWith(`/${spec.subdir}`))
        return { uid: 1000, gid: 1000, mode: 0o755, kind: 'directory' };
      const filename = path.split('/').at(-1)!;
      return {
        uid: 1000,
        gid: 1000,
        mode: 0o644,
        kind: 'file',
        contents: filename === spec.filename ? contents : (extraFiles[filename] ?? ''),
      };
    },
    listArtifactDirectory: async () => [spec.filename, ...Object.keys(extraFiles)],
  });
  const subpath = `secrets/${spec.subdir}${kind === 'codex' ? `/${spec.filename}` : ''}`;
  result.docker.inspectContainer.mockResolvedValue({
    ...result.inspect,
    mountCount: 1,
    mounts: [
      {
        type: 'volume',
        name: 'verity-data',
        subpath,
        destination: kind === 'codex' ? `${spec.directory}/${spec.filename}` : spec.directory,
        readWrite: false,
      },
    ],
  });
  return result;
}

interface TestOpenCodeConfig {
  theme?: string;
  model?: string;
  permission?: unknown;
  provider: {
    verity: {
      options: Record<string, string | number>;
      models: Record<string, Record<string, unknown>>;
    };
    other?: { options: { apiKey: string } };
  };
}

function generatedOpenCodeConfig(): TestOpenCodeConfig {
  return JSON.parse(
    openCodeSettingsConfig({
      opencodeBaseUrl: 'https://provider.example/v1',
      opencodeApiKey: 'server-only-test-credential',
      opencodeModels: 'model-a',
    } as Parameters<typeof openCodeSettingsConfig>[0])!,
  ) as TestOpenCodeConfig;
}

describe('compatible gateway configuration', () => {
  it('accepts Codex comments, spacing and model preferences', async () => {
    const contents = `# Gateway configuration\nmodel = "model-a"\nmodel_reasoning_effort = "high"\n${codexGatewayConfig(47821).replaceAll(' = ', '  =  ')}\n# End\n`;
    const { manager } = gatewayPreviewFixture('codex', contents);
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).resolves.toMatchObject({ state: 'active' });
  });

  it.each([
    [
      'credential header',
      (value: string) => value.replace('verity-codex-gateway-placeholder-v1', 'actual-secret'),
    ],
    ['external endpoint', (value: string) => value.replace('127.0.0.1', 'provider.example')],
    ['extra auth setting', (value: string) => `${value}\napi_key = "actual-secret"`],
    [
      'duplicate endpoint',
      (value: string) => `${value}\nbase_url = "http://127.0.0.1:47821/codex"`,
    ],
    [
      'wrong TOML section',
      (value: string) =>
        value.replace('[model_providers.verity_gateway]\n', '') +
        '\n[model_providers.verity_gateway]',
    ],
  ])('rejects Codex %s', async (_label, change) => {
    const { manager, edge } = gatewayPreviewFixture('codex', change(codexGatewayConfig(47821)));
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/mounted credentials/);
    expect(edge.create).not.toHaveBeenCalled();
  });

  it('accepts OpenCode presentation settings, model metadata and its .gitignore', async () => {
    const config = generatedOpenCodeConfig();
    config.theme = 'system';
    config.model = 'verity/model-a';
    config.provider.verity.models['model-a'] = {
      name: 'Friendly model name',
      limit: { context: 100000, output: 1000 },
      cost: { input: 0, output: 0 },
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: true,
    };
    config.provider.verity.options.timeout = 60000;
    // Key order has no meaning in JSON, but the old equality check rejected it.
    config.permission = {
      external_directory: { '/knowledge/**': 'allow' },
      read: { '/knowledge/**': 'allow' },
    };
    const { manager } = gatewayPreviewFixture('opencode', JSON.stringify(config), {
      '.gitignore': 'node_modules\n*.log\n',
    });
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).resolves.toMatchObject({ state: 'active' });
  });

  it('accepts the provisioner fallback when no OpenCode provider is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-gateway-config-'));
    try {
      const directory = materializeOpenCodeSettings(undefined, root);
      const contents = await readFile(join(directory, GATEWAY_MOUNTS.opencode.filename), 'utf8');
      const { manager } = gatewayPreviewFixture('opencode', contents);
      await expect(
        manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
      ).resolves.toMatchObject({ state: 'active' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'provider key',
      (config: ReturnType<typeof generatedOpenCodeConfig>) => {
        config.provider.verity.options.apiKey = 'actual-secret';
      },
    ],
    [
      'extra provider',
      (config: ReturnType<typeof generatedOpenCodeConfig>) => {
        config.provider.other = { options: { apiKey: 'actual-secret' } };
      },
    ],
    [
      'nested credential',
      (config: ReturnType<typeof generatedOpenCodeConfig>) => {
        config.provider.verity.models['model-a']!.cost = { input: 0, apiKey: 'actual-secret' };
      },
    ],
    [
      'external endpoint',
      (config: ReturnType<typeof generatedOpenCodeConfig>) => {
        config.provider.verity.options.baseURL = 'https://provider.example/v1';
      },
    ],
  ])('rejects OpenCode %s with otherwise compatible additions', async (_label, change) => {
    const config = generatedOpenCodeConfig();
    config.theme = 'system';
    change(config);
    const { manager, edge } = gatewayPreviewFixture('opencode', JSON.stringify(config));
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/mounted credentials/);
    expect(edge.create).not.toHaveBeenCalled();
  });
});

describe('OpenCode ancillary file validation', () => {
  it.each([
    ['credential file', { 'auth.json': '{"apiKey":"actual-secret"}' }],
    ['credentials in .gitignore', { '.gitignore': 'apiKey = actual-secret' }],
    ['unrecognized file', { 'credentials.txt': 'actual-secret' }],
  ])('rejects %s beside a valid generated gateway config', async (_label, extraFiles) => {
    const { manager, edge } = gatewayPreviewFixture(
      'opencode',
      JSON.stringify(generatedOpenCodeConfig()),
      extraFiles,
    );
    await expect(
      manager.create({ devServerId: 'dev-1', pin: '123456', ttlSeconds: 3600 }),
    ).rejects.toThrow(/mounted credentials/);
    expect(edge.create).not.toHaveBeenCalled();
  });
});

describe('managed public links', () => {
  function managedFixture() {
    const f = fixture();
    let share: Awaited<ReturnType<EventStore['getPublicPreviewShare']>> = {
      ...f.record,
      devServerId: null,
      sessionId: 's1',
      managedInstanceId: 'instance-1',
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
      lastRunCommand: 'node server.mjs',
      lastRunWorkdir: '.',
      startedAt: null,
      accessStartedAt: null,
      lastRanAt: null,
    };
    let running = false;
    let tag = 'instance-1';
    const getInstance = vi.fn(async () => instance);
    const store = {
      ...f.store,
      managedDevServers: { getInstance },
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
    const docker = {
      ...f.docker,
      inspectContainer: vi.fn(async (id: string) =>
        id === 'verity-project'
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
      listListeningProcesses: async () =>
        running
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
      share: () => share!,
      run: (port = 41001, marker = 'instance-1') => {
        instance = { ...instance!, sandboxPort: port, state: 'running', desired: 'running' };
        running = true;
        tag = marker;
      },
      remove: () => {
        instance = undefined;
      },
    };
  }

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
