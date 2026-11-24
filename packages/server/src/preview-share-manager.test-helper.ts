import type { EventStore } from '@verity/store';
import { vi } from 'vitest';
import type { ContainerInspect, DockerClient } from './docker.js';
import { PreviewShareManager, type PreviewShareManagerOptions } from './preview-share-manager.js';
import { projectNetworkName, RUNNER_BROKER_CAPABILITIES } from './provisioner.js';

export const digest = `ghcr.io/heey-global/verity/preview-connector@sha256:${'a'.repeat(64)}`;

export const project = {
  id: 'p1',
  containerName: 'verity-project',
  state: 'active',
};

export const devServer = { id: 'dev-1', projectId: 'p1', containerPort: '3000' };

export function fixture(
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
  const log = { info: vi.fn<Console['info']>(), warn: vi.fn<Console['warn']>() };
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
