import { beforeEach, expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import type { DockerClient } from './docker.js';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { UplinkControlClientOptions } from './uplink-control-client.js';
import type { RemoteConnectorPoolOptions } from './remote-control-connector.js';
import { createEmbeddedUplink } from './embedded-uplink.js';

const { controlConstructor, poolConstructor, control, pool } = vi.hoisted(() => {
  const control = {
    remoteControlDescriptor: vi.fn(() => ({ enabled: true, installationId: 'installation' })),
  };
  const pool = { reserve: vi.fn() };
  return {
    control,
    pool,
    controlConstructor: vi.fn(function (options: UplinkControlClientOptions) {
      void options;
      return control;
    }),
    poolConstructor: vi.fn((options: RemoteConnectorPoolOptions) => {
      void options;
      return pool;
    }),
  };
});
vi.mock('./uplink-control-client.js', () => ({ UplinkControlClient: controlConstructor }));
vi.mock('./remote-control-connector.js', async (original) => ({
  ...(await original<typeof import('./remote-control-connector.js')>()),
  createRemoteConnectorPool: poolConstructor,
}));
beforeEach(() => {
  vi.clearAllMocks();
});

const publicPreviews: NonNullable<EmbeddedServerConfig['publicPreviews']> = {
  uplinkUrl: 'wss://uplink.example/control',
  serverVersion: 'test',
  resolveConnectorImage: async () => undefined,
};
const projectDocker = {} as DockerClient;
function store() {
  return {
    listPublicPreviewShares: vi.fn(async () => []),
    listAttendeeState: vi.fn(async () => []),
    lockPublicPreviewSharePin: vi.fn(async () => {}),
    projectTeam: { admitJoin: vi.fn(), rollbackJoinAdmission: vi.fn() },
  };
}
function options(): UplinkControlClientOptions {
  return controlConstructor.mock.calls[0]![0];
}

it('allocates the deferred logger and return path without enabling Uplink', () => {
  const getPreviewShareManager = vi.fn(() => undefined);
  const runtime = createEmbeddedUplink({
    config: {},
    eventStore: store() as unknown as EventStore,
    projectDocker,
    getPreviewShareManager,
  });
  expect(runtime.uplinkControl).toBeUndefined();
  expect(runtime.remoteConnector).toBeUndefined();
  expect(runtime.coordinatedRecording).toBeUndefined();
  expect(runtime.returnPath).toBeDefined();
  expect(runtime.uplinkLog).toHaveProperty('bind', expect.any(Function));
  expect(controlConstructor).not.toHaveBeenCalled();
  expect(poolConstructor).not.toHaveBeenCalled();
  expect(getPreviewShareManager).not.toHaveBeenCalled();
});

it('retains connector setup without creating the control client when Docker is absent', () => {
  const runtime = createEmbeddedUplink({
    config: {
      publicPreviews: {
        ...publicPreviews,
        remoteControl: { localHost: 'localhost', localPort: 443 },
      },
    },
    eventStore: store() as unknown as EventStore,
    projectDocker: undefined,
    getPreviewShareManager: () => undefined,
  });
  expect(runtime.remoteConnector).toBe(pool);
  expect(runtime.uplinkControl).toBeUndefined();
  expect(runtime.coordinatedRecording).toBeUndefined();
  expect(controlConstructor).not.toHaveBeenCalled();
});

it('offers team and coordinated recording only with the remote connector', () => {
  const runtime = createEmbeddedUplink({
    config: { publicPreviews },
    eventStore: store() as unknown as EventStore,
    projectDocker,
    getPreviewShareManager: () => undefined,
  });
  expect(runtime.uplinkControl).toBe(control);
  expect(options().offerTeam).toBe(false);
  expect(options().offerRemoteControl).toBeUndefined();
  expect(runtime.coordinatedRecording).toBeUndefined();
});

it('shares the logger and resolves preview callbacks after the manager is installed', async () => {
  const eventStore = store();
  const manager = {
    disableAll: vi.fn(async () => {}),
    finishExpiredByUplink: vi.fn(async () => {}),
  };
  const managers: { public?: typeof manager } = {};
  const runtime = createEmbeddedUplink({
    config: {
      publicPreviews: {
        ...publicPreviews,
        expectedInstallationId: 'expected',
        remoteControl: { localHost: 'localhost', localPort: 443 },
      },
    },
    eventStore: eventStore as unknown as EventStore,
    projectDocker,
    getPreviewShareManager: () => managers.public,
  });
  const client = options();
  const connector = poolConstructor.mock.calls[0]![0];
  expect(client.expectedInstallationId).toBe('expected');
  expect(client.offerTeam).toBe(true);
  expect(client.offerRemoteControl).toBe(true);
  expect(client.reserveRemoteConnector).toBe(pool.reserve);
  expect(client.log).toBe(runtime.uplinkLog);
  expect(connector.log).toBe(runtime.uplinkLog);
  expect(connector.dataUrl).toBe('wss://uplink.example/data');
  expect(connector.returnPathInstallation?.()).toBe('installation');
  expect(runtime.coordinatedRecording).toBeDefined();
  await client.onFeaturesDisabled?.('before');
  await client.onShareExpired?.('before');
  managers.public = manager;
  await client.onFeaturesDisabled?.('revoked');
  await client.onShareExpired?.('expired');
  await client.onSharePinLocked?.('locked');
  expect(manager.disableAll).toHaveBeenCalledExactlyOnceWith('revoked');
  expect(manager.finishExpiredByUplink).toHaveBeenCalledExactlyOnceWith('expired');
  expect(eventStore.lockPublicPreviewSharePin).toHaveBeenCalledExactlyOnceWith('locked');
});
