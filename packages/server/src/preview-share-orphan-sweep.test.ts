import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { UplinkControlClient } from './uplink-control-client.js';
import { GATEWAY_MOUNTS } from './sandbox-standard-mounts.js';
import type { EventStore, PublicPreviewShareRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerInspect, DockerClient } from './docker.js';
import {
  PreviewShareManager,
  type PreviewShareManagerOptions,
  sweepOrphanedPreviewShares,
} from './preview-share-manager.js';
import {
  openCodeSettingsConfig,
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
    securityOpt: ['no-new-privileges=true'],
    readOnlyRootfs: false,
    runtime: 'runsc-project',
    user: 'dev',
  };
  const docker = {
    inspectContainer: vi.fn<DockerClient['inspectContainer']>(async () => inspect),
    createContainer: vi.fn<DockerClient['createContainer']>(async () => ({
      id: 'connector-id',
      warnings: [],
    })),
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
    remove: vi.fn<(shareId: string) => Promise<void>>(async () => undefined),
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

function retainShare(
  f: Pick<ReturnType<typeof fixture>, 'store' | 'record'>,
  patch: Partial<PublicPreviewShareRecord> = {},
) {
  let current = { ...f.record, state: 'active', ...patch } as PublicPreviewShareRecord;
  f.store.listPublicPreviewShares.mockImplementation(async () => [current]);
  f.store.getPublicPreviewShare.mockImplementation(async () => current);
  f.store.transitionPublicPreviewShare.mockImplementation(async (_id, from, state, update = {}) => {
    if (!from.includes(current.state)) return undefined;
    current = { ...current, ...update, state };
    return current;
  });
  return () => current;
}

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

// Exercise the callback used by embedded.ts with the real client and manager:
// isolated reconnect mocks cannot detect an irreversible remote removal.
class ShareControlSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: { type: string; shareId?: string; requestId?: string }[] = [];
  ping = vi.fn();
  close = vi.fn((code: number, reason = '') => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  });
  terminate = vi.fn(() => this.close(1006));
  send(raw: string): void {
    const frame = JSON.parse(raw) as (typeof this.sent)[number];
    this.sent.push(frame);
    if (frame.type === 'share.remove') {
      queueMicrotask(() => this.message({ ...frame, type: 'share.removed' }));
    }
  }
  message(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }
  admit(leaseMs = 600_000, features = ['sharing']): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
    this.message({
      type: 'welcome',
      installationId: 'installation-1',
      features,
      capabilities: ['remote-control-v1'],
      channels: ['http', 'ws', 'remote'],
      handle: Buffer.alloc(16, 7).toString('base64url'),
      leaseUntil: new Date(Date.now() + leaseMs).toISOString(),
    });
  }
}

function sharingRecoveryFixture(remote = false) {
  const f = fixture();
  const current = retainShare(f, { connectorContainerId: 'connector-id' });
  const sockets: ShareControlSocket[] = [];
  const settings = {
    uplinkSubscriptionKey: 'subscription-fixture',
    uplinkInstallationId: 'installation-1',
    premiumRemoteAccessEnabled: remote,
  };
  const store = {
    ...f.store,
    getVeritySettings: vi.fn(async () => settings),
    updateVeritySettings: vi.fn(async () => settings),
    addPendingUplinkShareRemoval: vi.fn(async () => undefined),
    listPendingUplinkShareRemovals: vi.fn(async () => [] as string[]),
    deletePendingUplinkShareRemoval: vi.fn(async () => undefined),
  };
  const disabled = vi.fn((reason: string) => f.manager.disableAll(reason));
  const client = new UplinkControlClient({
    url: 'wss://uplink.example/control',
    store: store as unknown as EventStore & typeof store,
    serverVersion: 'test',
    offerRemoteControl: remote,
    reserveRemoteConnector: async () => 'unavailable',
    restoreShareIds: async () =>
      (await store.listPublicPreviewShares())
        .filter((share) => share.state === 'active' && share.expiresAt.getTime() > Date.now())
        .map((share) => share.id),
    onFeaturesDisabled: disabled,
    onShareExpired: (id) => f.manager.finishExpiredByUplink(id),
    webSocketFactory: () => {
      const socket = new ShareControlSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  f.edge.remove.mockImplementation((id) => client.remove(id));
  f.edge.isAvailable.mockImplementation(() => client.isAvailable());
  return { ...f, current, sockets, client, store, disabled };
}

async function settleControl(): Promise<void> {
  for (let index = 0; index < 100; index += 1) await Promise.resolve();
}

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
