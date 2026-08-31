import { EventEmitter } from 'node:events';
import type { VeritySettingsPatch, EventStore } from '@verity/store';
import WebSocket from 'ws';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UplinkControlClient, UPLINK_CONTROL_URL } from './uplink-control-client.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];
  close = vi.fn((code?: number, reason?: string) => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason ?? ''));
  });
  ping = vi.fn();
  send(value: string, callback?: (error?: Error) => void): void {
    this.sent.push(value);
    callback?.();
  }
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }
  message(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }
}

function setup(
  options: {
    readError?: Error;
    settingsRead?: Promise<{ uplinkSubscriptionKey: string; uplinkInstallationId: null }>;
    pendingRemovals?: string[];
    disableFeatures?: (reason: string) => Promise<void>;
  } = {},
) {
  const socket = new FakeSocket();
  const settings = {
    uplinkSubscriptionKey: 'subscription-fixture',
    uplinkInstallationId: null,
  };
  const store = {
    getVeritySettings: vi.fn(async () => {
      if (options.readError) throw options.readError;
      if (options.settingsRead) return options.settingsRead;
      return settings;
    }),
    updateVeritySettings: vi.fn(async (patch: VeritySettingsPatch) => ({ ...settings, ...patch })),
    addPendingUplinkShareRemoval: vi.fn(async () => undefined),
    listPendingUplinkShareRemovals: vi.fn(async () => options.pendingRemovals ?? []),
    deletePendingUplinkShareRemoval: vi.fn(async () => undefined),
  };
  const disabled = vi.fn(options.disableFeatures ?? (async () => undefined));
  const expired = vi.fn(async () => undefined);
  const socketFactory = vi.fn(() => socket as unknown as WebSocket);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const client = new UplinkControlClient({
    url: UPLINK_CONTROL_URL,
    store: store as unknown as EventStore & typeof store,
    serverVersion: 'test',
    webSocketFactory: socketFactory,
    onFeaturesDisabled: disabled,
    onShareExpired: expired,
    log,
  });
  return { client, socket, socketFactory, store, settings, disabled, expired, log };
}

/** Brings a fixture to the state every share operation requires: connected,
 * welcomed, and granted the sharing entitlement. */
async function welcomed(
  fixture: ReturnType<typeof setup>,
  leaseMs = 60_000,
): Promise<ReturnType<typeof setup>> {
  fixture.client.start();
  await flush();
  fixture.socket.open();
  fixture.socket.message({
    type: 'welcome',
    installationId: 'installation-1',
    features: ['sharing'],
    leaseUntil: new Date(Date.now() + leaseMs).toISOString(),
  });
  await flush();
  return fixture;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('UplinkControlClient', () => {
  beforeEach(() => vi.useRealTimers());

  it('matches the deployed control path and requires TLS', () => {
    const url = new URL(UPLINK_CONTROL_URL);
    expect(url.protocol).toBe('wss:');
    expect(url.hostname).toBe('uplink.verity.build');
    expect(url.pathname).toBe('/control');
  });

  it('caps control-channel WebSocket frames at 64 KiB', async () => {
    const { client, socketFactory } = setup();
    client.start();
    await flush();
    expect(socketFactory).toHaveBeenCalledWith(UPLINK_CONTROL_URL, { maxPayload: 64 * 1024 });
    await client.stop();
  });

  it.each(['renewed', 'revoke', 'share.ready'])(
    'protocol-closes %s received before welcome',
    async (type) => {
      const { client, socket, disabled } = setup();
      client.start();
      await flush();
      socket.open();
      socket.message({
        type,
        ...(type === 'renewed'
          ? { features: ['sharing'], leaseUntil: new Date(Date.now() + 60_000).toISOString() }
          : {}),
      });
      await flush();
      expect(socket.close).toHaveBeenCalledWith(1002, 'invalid control message');
      expect(disabled).toHaveBeenCalledOnce();
      await client.stop();
    },
  );

  it('persists the assigned installation and fails closed when renewal removes sharing', async () => {
    const { client, socket, store, disabled } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    expect(client.isAvailable()).toBe(true);
    expect(store.updateVeritySettings).toHaveBeenCalledWith({
      uplinkInstallationId: 'installation-1',
    });
    const pending = client.create({ pinHash: 'hash', durationSeconds: 900 });
    const pendingAssertion = expect(pending).rejects.toThrow(
      'Uplink removed public preview entitlement',
    );
    socket.message({
      type: 'renewed',
      features: [],
      leaseUntil: new Date(Date.now() + 10 * 60 * 60_000).toISOString(),
    });
    await flush();
    expect(client.isAvailable()).toBe(false);
    await pendingAssertion;
    expect(disabled).toHaveBeenCalledWith('Uplink removed public preview entitlement');
    await client.stop();
  });

  it('does not revoke persisted shares during orderly process shutdown', async () => {
    const { client, socket, disabled } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    await client.stop();
    expect(disabled).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1000, 'server shutdown');
  });

  it('does revoke persisted shares when credentials are explicitly removed', async () => {
    const { client, socket, settings, disabled } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    settings.uplinkSubscriptionKey = '';
    client.refreshCredentials();
    await flush();
    expect(disabled).toHaveBeenCalledWith('Uplink credentials changed');
    await client.stop();
    expect(disabled).toHaveBeenCalledOnce();
  });

  it('runs persisted-share cleanup once when the first welcome omits sharing', async () => {
    const { client, socket, disabled } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: [],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    expect(disabled).toHaveBeenCalledOnce();
    expect(disabled).toHaveBeenCalledWith('Uplink did not grant public preview entitlement');
    socket.close(1006, 'lost');
    await flush();
    expect(disabled).toHaveBeenCalledOnce();
    await client.stop();
  });

  it('runs persisted-share cleanup once for a reject before welcome', async () => {
    const { client, socket, disabled } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({ type: 'reject', reason: 'revoked' });
    await flush();
    expect(disabled).toHaveBeenCalledOnce();
    expect(disabled).toHaveBeenCalledWith('revoked');
    await client.stop();
    expect(disabled).toHaveBeenCalledOnce();
  });

  it('closes and disables authority when async welcome persistence fails', async () => {
    const { client, socket, store, disabled } = setup();
    store.updateVeritySettings.mockRejectedValueOnce(new Error('write failed'));
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    expect(socket.close).toHaveBeenCalledWith(1002, 'invalid control message');
    expect(client.isAvailable()).toBe(false);
    expect(disabled).toHaveBeenCalledWith('invalid Uplink control message');
    await client.stop();
  });

  it('does not persist installation identity or start authority for an invalid lease', async () => {
    const { client, socket, store } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() - 1_000).toISOString(),
    });
    await flush();
    expect(client.isAvailable()).toBe(false);
    expect(store.updateVeritySettings).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1002, 'invalid lease');
    await client.stop();
  });

  it('replaces the renewal timer when a newer lease arrives', async () => {
    vi.useFakeTimers();
    const { client, socket } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 10_000).toISOString(),
    });
    await flush();
    socket.message({
      type: 'renewed',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 20_000).toISOString(),
    });
    await flush();
    vi.advanceTimersByTime(7_000);
    expect(socket.sent.map((value) => JSON.parse(value) as { type: string })).not.toContainEqual({
      type: 'renew',
    });
    vi.advanceTimersByTime(5_000);
    expect(socket.sent.map((value) => JSON.parse(value) as { type: string })).toContainEqual({
      type: 'renew',
    });
    await client.stop();
  });

  it('rejects pending share creation on disconnect', async () => {
    const { client, socket } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    const pending = client.create({ pinHash: 'hash', durationSeconds: 900 });
    socket.close(1006, 'lost');
    await expect(pending).rejects.toThrow('Uplink disconnected');
    await client.stop();
  });

  it('protocol-closes a mismatched response without consuming create cleanup correlation', async () => {
    const { client, socket } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    const creating = client.create({ pinHash: 'hash', durationSeconds: 900 });
    const creatingAssertion = expect(creating).rejects.toThrow('invalid Uplink control message');
    const createFrame = JSON.parse(socket.sent.at(-1)!) as { requestId: string };
    socket.message({ type: 'share.removed', requestId: createFrame.requestId });
    await flush();
    expect(socket.close).toHaveBeenCalledWith(1002, 'invalid control message');
    await creatingAssertion;
    // The close path tombstones the still-pending create, so a late ready on a
    // surviving transport can still be recognized rather than accepted.
    expect(
      (client as unknown as { abandonedCreates: Map<string, unknown> }).abandonedCreates.has(
        createFrame.requestId,
      ),
    ).toBe(true);
    await client.stop();
  });

  it.each(['share.removed', 'remove.failed'])(
    'protocol-closes %s with a mismatched share id and rejects cleanup',
    async (responseType) => {
      const { client, socket } = setup();
      client.start();
      await flush();
      socket.open();
      socket.message({
        type: 'welcome',
        installationId: 'installation-1',
        features: ['sharing'],
        leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      });
      await flush();
      const removing = client.remove('expected-share');
      const removingAssertion = expect(removing).rejects.toThrow('invalid Uplink control message');
      const removeFrame = JSON.parse(socket.sent.at(-1)!) as { requestId: string };
      socket.message({
        type: responseType,
        requestId: removeFrame.requestId,
        shareId: 'different-share',
        ...(responseType === 'remove.failed' ? { code: 'internal' } : {}),
      });
      await flush();
      expect(socket.close).toHaveBeenCalledWith(1002, 'invalid control message');
      await removingAssertion;
      await client.stop();
    },
  );

  it('revokes a late share.ready after its create request was abandoned', async () => {
    vi.useFakeTimers();
    const { client, socket, store } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 10 * 60 * 60_000).toISOString(),
    });
    await flush();

    const creating = client.create({ pinHash: 'hash', durationSeconds: 900 });
    const createFrame = JSON.parse(socket.sent.at(-1)!) as { requestId: string };
    socket.message({
      type: 'renewed',
      features: [],
      leaseUntil: new Date(Date.now() + 10 * 60 * 60_000).toISOString(),
    });
    await expect(creating).rejects.toThrow('removed public preview entitlement');
    // The tombstone must outlive the old five-minute window and the maximum
    // eight-hour share duration (the production TTL is nine hours).
    for (let elapsed = 0; elapsed < 6 * 60_000; elapsed += 15_000) {
      vi.advanceTimersByTime(15_000);
      socket.emit('pong');
    }
    socket.message({
      type: 'share.ready',
      requestId: createFrame.requestId,
      shareId: 'late-share',
    });
    await flush();
    expect(store.addPendingUplinkShareRemoval).toHaveBeenCalledWith('late-share');

    socket.message({
      type: 'renewed',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 9 * 60 * 60_000 - 1).toISOString(),
    });
    await flush();
    const removeFrame = JSON.parse(socket.sent.at(-1)!) as {
      type: string;
      requestId: string;
      shareId: string;
    };
    expect(removeFrame).toMatchObject({ type: 'share.remove', shareId: 'late-share' });
    socket.message({
      type: 'share.removed',
      requestId: removeFrame.requestId,
      shareId: 'late-share',
    });
    await flush();
    expect(store.deletePendingUplinkShareRemoval).toHaveBeenCalledWith('late-share');
    await client.stop();
  });

  it('consumes a late share.error for a timed-out create without disabling authority', async () => {
    vi.useFakeTimers();
    const { client, socket, disabled } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 10 * 60 * 60_000).toISOString(),
    });
    await flush();
    const creating = client.create({ pinHash: 'hash', durationSeconds: 900 });
    const creatingAssertion = expect(creating).rejects.toThrow('share.create timed out');
    const createFrame = JSON.parse(socket.sent.at(-1)!) as { requestId: string };
    for (let elapsed = 0; elapsed < 120_000; elapsed += 15_000) {
      await vi.advanceTimersByTimeAsync(15_000);
      socket.emit('pong');
    }
    await creatingAssertion;
    socket.message({
      type: 'share.error',
      requestId: createFrame.requestId,
      code: 'internal',
    });
    await flush();
    expect(client.isAvailable()).toBe(true);
    expect(socket.close).not.toHaveBeenCalled();
    expect(disabled).not.toHaveBeenCalled();
    await client.stop();
  });

  it('loads and removes a durable orphan after client restart', async () => {
    const { client, socket, store } = setup({ pendingRemovals: ['restart-orphan'] });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    const removeFrame = JSON.parse(socket.sent.at(-1)!) as {
      type: string;
      requestId: string;
      shareId: string;
    };
    expect(removeFrame).toMatchObject({ type: 'share.remove', shareId: 'restart-orphan' });
    socket.message({
      type: 'share.removed',
      requestId: removeFrame.requestId,
      shareId: 'restart-orphan',
    });
    await flush();
    expect(store.deletePendingUplinkShareRemoval).toHaveBeenCalledWith('restart-orphan');
    await client.stop();
  });

  it('dispatches share.expired and protocol-closes an unknown welcomed frame', async () => {
    const { client, socket, expired } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    socket.message({ type: 'share.expired', shareId: 'expired-share' });
    await flush();
    expect(expired).toHaveBeenCalledWith('expired-share');
    socket.message({ type: 'mystery' });
    await flush();
    expect(socket.close).toHaveBeenCalledWith(1002, 'invalid control message');
    await client.stop();
  });

  it('revokes a bounded raw share id when share.ready violates the id contract', async () => {
    const { client, socket } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    const creating = client.create({ pinHash: 'hash', durationSeconds: 900 });
    const creatingAssertion = expect(creating).rejects.toThrow('invalid share id');
    const createFrame = JSON.parse(socket.sent.at(-1)!) as { requestId: string };
    socket.message({
      type: 'share.ready',
      requestId: createFrame.requestId,
      shareId: 'INVALID/SHARE',
      publicOrigin: 'https://invalid.example',
      edgeUrl: 'wss://invalid.example/__verity/connector',
      connectorToken: 'c'.repeat(32),
      sessionSecret: 's'.repeat(32),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    const removeFrame = JSON.parse(socket.sent.at(-1)!) as {
      type: string;
      requestId: string;
      shareId: string;
    };
    expect(removeFrame).toMatchObject({ type: 'share.remove', shareId: 'INVALID/SHARE' });
    socket.message({
      type: 'share.removed',
      requestId: removeFrame.requestId,
      shareId: 'INVALID/SHARE',
    });
    await creatingAssertion;
    await client.stop();
  });

  it('revokes a valid raw share id when another binding field is malformed', async () => {
    const { client, socket } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    const creating = client.create({ pinHash: 'hash', durationSeconds: 900 });
    const creatingAssertion = expect(creating).rejects.toThrow('invalid Uplink publicOrigin');
    const createFrame = JSON.parse(socket.sent.at(-1)!) as { requestId: string };
    socket.message({
      type: 'share.ready',
      requestId: createFrame.requestId,
      shareId: 'valid-share',
      edgeUrl: 'wss://valid-share.example/__verity/connector',
      connectorToken: 'c'.repeat(32),
      sessionSecret: 's'.repeat(32),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    const removeFrame = JSON.parse(socket.sent.at(-1)!) as {
      type: string;
      requestId: string;
      shareId: string;
    };
    expect(removeFrame).toMatchObject({ type: 'share.remove', shareId: 'valid-share' });
    socket.message({
      type: 'share.removed',
      requestId: removeFrame.requestId,
      shareId: 'valid-share',
    });
    await creatingAssertion;
    await client.stop();
  });

  it.each([
    ['INVALID/SHARE', 'invalid share id'],
    ['valid-share', 'invalid Uplink publicOrigin'],
  ])(
    'durably retries malformed share %s after remove.failed and restart',
    async (shareId, expectedError) => {
      const first = setup();
      first.client.start();
      await flush();
      first.socket.open();
      first.socket.message({
        type: 'welcome',
        installationId: 'installation-1',
        features: ['sharing'],
        leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      });
      await flush();
      const creating = first.client.create({ pinHash: 'hash', durationSeconds: 900 });
      const creatingAssertion = expect(creating).rejects.toThrow(expectedError);
      const createFrame = JSON.parse(first.socket.sent.at(-1)!) as { requestId: string };
      first.socket.message({
        type: 'share.ready',
        requestId: createFrame.requestId,
        shareId,
        edgeUrl: 'wss://invalid.example/__verity/connector',
        connectorToken: 'c'.repeat(32),
        sessionSecret: 's'.repeat(32),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await flush();
      expect(first.store.addPendingUplinkShareRemoval).toHaveBeenCalledWith(shareId);
      const removeFrame = JSON.parse(first.socket.sent.at(-1)!) as { requestId: string };
      first.socket.message({
        type: 'remove.failed',
        requestId: removeFrame.requestId,
        shareId,
        code: 'internal',
      });
      await creatingAssertion;
      expect(first.store.deletePendingUplinkShareRemoval).not.toHaveBeenCalled();
      await first.client.stop();

      const restarted = setup({ pendingRemovals: [shareId] });
      restarted.client.start();
      await flush();
      restarted.socket.open();
      restarted.socket.message({
        type: 'welcome',
        installationId: 'installation-1',
        features: ['sharing'],
        leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      });
      await flush();
      expect(JSON.parse(restarted.socket.sent.at(-1)!)).toMatchObject({
        type: 'share.remove',
        shareId,
      });
      await restarted.client.stop();
    },
  );

  it('does not open a socket while encrypted settings cannot be read', async () => {
    vi.useFakeTimers();
    const { client, socket, store, disabled } = setup({ readError: new Error('sealed') });
    client.start();
    await flush();
    expect(store.getVeritySettings).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual([]);
    expect(disabled).toHaveBeenCalledWith('encrypted Uplink credentials are unavailable');
    await client.stop();
  });

  it('runs persisted-share cleanup immediately when no subscription key is configured', async () => {
    const { client, socket, store, disabled } = setup();
    store.getVeritySettings.mockResolvedValueOnce({
      uplinkSubscriptionKey: '',
      uplinkInstallationId: null,
    });
    client.start();
    await flush();
    expect(socket.sent).toEqual([]);
    expect(disabled).toHaveBeenCalledWith('Uplink subscription key is not configured');
    await client.stop();
    expect(disabled).toHaveBeenCalledOnce();
  });

  it('connects immediately when the first subscription key is configured', async () => {
    vi.useFakeTimers();
    const { client, socketFactory, settings } = setup();
    settings.uplinkSubscriptionKey = '';
    client.start();
    await flush();
    expect(socketFactory).not.toHaveBeenCalled();
    settings.uplinkSubscriptionKey = 'first-key';
    client.refreshCredentials();
    await vi.runOnlyPendingTimersAsync();
    await flush();
    expect(socketFactory).toHaveBeenCalledOnce();
    await client.stop();
  });

  it('does not expose renewed authority until slow loss cleanup completes', async () => {
    vi.useFakeTimers();
    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    const { client, socket } = setup({ disableFeatures: async () => cleanup });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    expect(client.isAvailable()).toBe(true);
    socket.close(1006, 'lost');
    client.refreshCredentials();
    await vi.runOnlyPendingTimersAsync();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    expect(client.isAvailable()).toBe(false);
    resolveCleanup();
    await flush();
    expect(client.isAvailable()).toBe(true);
    await client.stop();
  });

  it('retries failed authority-loss cleanup before accepting a later welcome', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { client, socket, settings, disabled } = setup({
      disableFeatures: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Docker unavailable');
      },
    });
    settings.uplinkSubscriptionKey = '';
    client.start();
    await flush();
    expect(disabled).toHaveBeenCalledOnce();
    settings.uplinkSubscriptionKey = 'restored-key';
    client.refreshCredentials();
    await vi.runOnlyPendingTimersAsync();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    expect(disabled).toHaveBeenCalledTimes(2);
    expect(client.isAvailable()).toBe(true);
    await client.stop();
  });

  it('allows cleanup to remove an existing edge through provisional control transport', async () => {
    vi.useFakeTimers();
    const refs: { client?: UplinkControlClient; socket?: FakeSocket } = {};
    let attempts = 0;
    const configured = setup({
      disableFeatures: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient cleanup failure');
        const removing = refs.client!.remove('existing-share');
        queueMicrotask(() => {
          const frame = JSON.parse(refs.socket!.sent.at(-1)!) as { requestId: string };
          refs.socket!.message({
            type: 'share.removed',
            requestId: frame.requestId,
            shareId: 'existing-share',
          });
        });
        await removing;
      },
    });
    const clientRef = configured.client;
    const socketRef = configured.socket;
    refs.client = clientRef;
    refs.socket = socketRef;
    clientRef.start();
    await flush();
    socketRef.open();
    socketRef.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    socketRef.close(1006, 'lost');
    // The fixture reuses one FakeSocket across reconnects; discard listeners
    // belonging to the closed transport before the factory returns it again.
    socketRef.removeAllListeners();
    clientRef.refreshCredentials();
    await vi.runOnlyPendingTimersAsync();
    socketRef.open();
    socketRef.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    await flush();
    await flush();
    expect(configured.store.addPendingUplinkShareRemoval).toHaveBeenCalledWith('existing-share');
    expect(configured.store.deletePendingUplinkShareRemoval).toHaveBeenCalledWith('existing-share');
    expect(clientRef.isAvailable()).toBe(true);
    await clientRef.stop();
  });

  it('processes renewed only after a delayed welcome persistence completes', async () => {
    let resolveWrite!: () => void;
    const write = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const { client, socket, store, disabled } = setup();
    store.updateVeritySettings.mockImplementationOnce(async (patch) => {
      await write;
      return {
        uplinkSubscriptionKey: 'subscription-fixture',
        uplinkInstallationId: patch.uplinkInstallationId ?? null,
      };
    });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    socket.message({
      type: 'renewed',
      features: [],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    expect(disabled).not.toHaveBeenCalled();
    expect(client.isAvailable()).toBe(false);
    resolveWrite();
    await flush();
    await flush();
    expect(disabled).toHaveBeenCalledWith('Uplink removed public preview entitlement');
    await client.stop();
  });

  // The subscription key travels in the first frame on this socket, so anything
  // short of an authenticated WSS endpoint would put it on the wire in clear text
  // or hand it to a URL-embedded credential the operator cannot see.
  it.each([
    'ws://uplink.verity.build/control',
    'https://uplink.verity.build/control',
    'wss://user:secret@uplink.verity.build/control',
    'wss://uplink.verity.build/control#fragment',
  ])('refuses %s as a control URL', (url) => {
    const { store } = setup();
    expect(
      () =>
        new UplinkControlClient({
          url,
          store: store as unknown as EventStore & typeof store,
          serverVersion: 'test',
        }),
    ).toThrow('Uplink control URL must be an authenticated WSS endpoint');
  });

  it('refuses to create a share before the Uplink has granted the entitlement', async () => {
    const { client, socket } = setup();
    client.start();
    await flush();
    socket.open();

    await expect(client.create({ pinHash: 'hash', durationSeconds: 900 })).rejects.toThrow(
      'public preview sharing is not enabled by the Uplink',
    );
    // Refused locally: nothing but the hello handshake reached the control plane.
    expect(socket.sent.map((value) => (JSON.parse(value) as { type: string }).type)).toEqual([
      'hello',
    ]);
    await client.stop();
  });

  // Order matters more than the failure: the removal is persisted BEFORE the
  // refusal, so a share created by a since-disconnected Uplink is still revoked
  // after a restart.
  it('persists the pending revocation before refusing to revoke while offline', async () => {
    const { client, socket, store } = setup();
    client.start();
    await flush();
    socket.open();

    await expect(client.remove('orphan-share')).rejects.toThrow(
      'cannot revoke preview while Uplink is unavailable',
    );
    expect(store.addPendingUplinkShareRemoval).toHaveBeenCalledWith('orphan-share');
    await client.stop();
  });

  it.each([
    { code: 'quota_exceeded', expected: 'Uplink refused public preview: quota_exceeded' },
    { code: undefined, expected: 'Uplink refused public preview: internal' },
  ])('surfaces a refused share as $expected', async ({ code, expected }) => {
    const { client, socket } = await welcomed(setup());
    const creating = client.create({ pinHash: 'hash', durationSeconds: 900 });
    const creatingAssertion = expect(creating).rejects.toThrow(expected);
    const createFrame = JSON.parse(socket.sent.at(-1)!) as { requestId: string };

    socket.message({
      type: 'share.error',
      requestId: createFrame.requestId,
      ...(code === undefined ? {} : { code }),
    });
    await creatingAssertion;
    // A refusal is not a protocol violation: authority survives it.
    expect(client.isAvailable()).toBe(true);
    await client.stop();
  });

  // An expiry the client cannot read means it cannot tell when the share dies, so
  // the binding is rejected — but the object exists at the edge and its id is the
  // only handle that can revoke it.
  it('revokes the share it cannot date instead of returning an unbounded binding', async () => {
    const { client, socket, store } = await welcomed(setup());
    const creating = client.create({ pinHash: 'hash', durationSeconds: 900 });
    const creatingAssertion = expect(creating).rejects.toThrow('invalid Uplink expiresAt');
    const createFrame = JSON.parse(socket.sent.at(-1)!) as { requestId: string };

    socket.message({
      type: 'share.ready',
      requestId: createFrame.requestId,
      shareId: 'undatable-share',
      publicOrigin: 'https://undatable.example',
      edgeUrl: 'wss://undatable.example/__verity/connector',
      connectorToken: 'c'.repeat(32),
      sessionSecret: 's'.repeat(32),
      expiresAt: 'whenever',
    });
    await flush();
    await creatingAssertion;
    expect(store.addPendingUplinkShareRemoval).toHaveBeenCalledWith('undatable-share');
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: 'share.remove',
      shareId: 'undatable-share',
    });
    await client.stop();
  });

  // A frame that is not a JSON object is not a protocol error inside the protocol —
  // it means the transport is not carrying the protocol at all, which is a different
  // close code from a well-formed frame the client refuses.
  it.each(['not json at all', '[1,2,3]', '"a string"', 'null'])(
    'closes the transport on a non-object control frame %j',
    async (raw) => {
      const { client, socket, disabled, log } = setup();
      client.start();
      await flush();
      socket.open();
      socket.emit('message', Buffer.from(raw));
      await flush();

      expect(socket.close).toHaveBeenCalledWith(1002, 'invalid control frame');
      expect(disabled).toHaveBeenCalledWith('invalid Uplink control frame');
      expect(log.warn).not.toHaveBeenCalled();
      await client.stop();
    },
  );

  it('protocol-closes a second welcome on one connection', async () => {
    const { client, socket, disabled } = await welcomed(setup());
    socket.message({
      type: 'welcome',
      installationId: 'installation-2',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();

    expect(socket.close).toHaveBeenCalledWith(1002, 'invalid control message');
    expect(disabled).toHaveBeenCalledWith('invalid Uplink control message');
    expect(client.isAvailable()).toBe(false);
    await client.stop();
  });

  // A revoked subscription must not be retried with the same key: the reconnect
  // loop would otherwise hammer the control plane with a credential it has been
  // told is dead. Only a credential change makes it try again.
  it('stops offering a key the Uplink revoked until the credentials change', async () => {
    vi.useFakeTimers();
    const { client, socket, socketFactory, disabled } = await welcomed(setup());
    socket.message({ type: 'revoke' });
    await flush();

    expect(disabled).toHaveBeenCalledWith('subscription revoked');
    expect(socket.close).toHaveBeenCalledWith(4003, 'revoked');
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(socketFactory).toHaveBeenCalledOnce();

    client.refreshCredentials();
    await vi.runOnlyPendingTimersAsync();
    await flush();
    expect(socketFactory).toHaveBeenCalledTimes(2);
    await client.stop();
  });

  it('drops authority when the lease it was given runs out', async () => {
    vi.useFakeTimers();
    const { client, socket, disabled } = await welcomed(setup(), 10_000);
    expect(client.isAvailable()).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    await flush();

    expect(socket.close).toHaveBeenCalledWith(4001, 'lease expired');
    expect(disabled).toHaveBeenCalledWith('Uplink lease expired');
    expect(client.isAvailable()).toBe(false);
    await client.stop();
  });

  it('closes a transport that stops answering pings', async () => {
    vi.useFakeTimers();
    const { client, socket } = await welcomed(setup(), 10 * 60 * 60_000);

    // Three unanswered pings are tolerated; the fourth beat gives up.
    for (let beat = 0; beat < 3; beat += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(socket.close).not.toHaveBeenCalled();
    }
    expect(socket.ping).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(socket.close).toHaveBeenCalledWith(4002, 'heartbeat timeout');
    expect(socket.ping).toHaveBeenCalledTimes(3);
    await client.stop();
  });

  // `ws` hands a frame over as a string, a Buffer, a list of Buffers or an
  // ArrayBuffer depending on how it arrived. All four are the same control frame.
  it('reads a control frame in every shape ws can deliver it', async () => {
    const { client, socket, expired } = await welcomed(setup());
    const frame = (shareId: string) => JSON.stringify({ type: 'share.expired', shareId });

    socket.emit('message', frame('string-share'));
    socket.emit('message', Buffer.from(frame('buffer-share')));
    socket.emit('message', [
      Buffer.from('{"type":"share.expired","shareId":"'),
      Buffer.from('fragmented-share"}'),
    ]);
    socket.emit('message', new TextEncoder().encode(frame('arraybuffer-share')).buffer);
    // One flush per frame: the four are processed in order through the message tail.
    for (let index = 0; index < 4; index += 1) await flush();

    expect(expired.mock.calls.flat()).toEqual([
      'string-share',
      'buffer-share',
      'fragmented-share',
      'arraybuffer-share',
    ]);
    await client.stop();
  });

  // A create whose request frame never left the process is still a create the
  // Uplink might have received; it has to be tombstoned like a timed-out one so a
  // late `share.ready` is recognized and revoked instead of accepted.
  it('tombstones a create whose request frame failed to send', async () => {
    const { client, socket } = await welcomed(setup());
    socket.send = (value: string, callback?: (error?: Error) => void): void => {
      socket.sent.push(value);
      callback?.(new Error('socket write failed'));
    };

    await expect(client.create({ pinHash: 'hash', durationSeconds: 900 })).rejects.toThrow(
      'socket write failed',
    );
    const createFrame = JSON.parse(socket.sent.at(-1)!) as { requestId: string };
    expect(
      (client as unknown as { abandonedCreates: Map<string, unknown> }).abandonedCreates.has(
        createFrame.requestId,
      ),
    ).toBe(true);
    await client.stop();
  });

  it('refuses to send a request over a transport that is no longer open', async () => {
    const { client, socket, store } = await welcomed(setup());
    // The socket is on its way out but `close` has not been delivered yet.
    socket.readyState = WebSocket.CLOSING;

    await expect(client.remove('closing-share')).rejects.toThrow('Uplink offline');
    expect(store.addPendingUplinkShareRemoval).toHaveBeenCalledWith('closing-share');
    expect(store.deletePendingUplinkShareRemoval).not.toHaveBeenCalled();
    await client.stop();
  });

  // The socket that opens after `stop` belongs to a client generation that no
  // longer exists. Sending hello on it would put the subscription key on a
  // connection nothing is watching.
  it('never sends the subscription key on a socket that opened after stop', async () => {
    const { client, socket } = setup();
    client.start();
    await flush();
    await client.stop();

    socket.open();
    await flush();

    expect(socket.close).toHaveBeenCalledWith(1000, 'stale connection');
    expect(socket.sent).toEqual([]);
  });

  it('logs a transport error instead of letting it escape the client', async () => {
    const { client, socket, log, disabled } = await welcomed(setup());
    const failure = new Error('read ECONNRESET');

    socket.emit('error', failure);
    await flush();

    expect(log.warn).toHaveBeenCalledWith({ error: failure }, 'Uplink connection error');
    // A transport hiccup is not an entitlement change; only the close that follows
    // one would be.
    expect(disabled).not.toHaveBeenCalled();
    await client.stop();
  });

  it('does not open a second control connection when start is called again', async () => {
    const { client, socketFactory } = await welcomed(setup());
    client.start();
    await flush();

    expect(socketFactory).toHaveBeenCalledOnce();
    await client.stop();
  });

  it('does not create a socket or send a key after stop wins a deferred settings read', async () => {
    let resolveSettings!: (value: {
      uplinkSubscriptionKey: string;
      uplinkInstallationId: null;
    }) => void;
    const settingsRead = new Promise<{
      uplinkSubscriptionKey: string;
      uplinkInstallationId: null;
    }>((resolve) => {
      resolveSettings = resolve;
    });
    const { client, socket } = setup({ settingsRead });
    client.start();
    await flush();
    await client.stop();
    resolveSettings({ uplinkSubscriptionKey: 'must-not-send', uplinkInstallationId: null });
    await flush();
    expect(socket.sent).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.CONNECTING);
  });
});
