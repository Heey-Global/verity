import { EventEmitter } from 'node:events';
import type { VeritySettingsPatch, EventStore } from '@verity/store';
import WebSocket from 'ws';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOSE_TIMEOUT_MS,
  RECONNECT_CAPACITY_MS,
  RECONNECT_MAX_MS,
  UplinkControlClient,
  UPLINK_CONTROL_URL,
  type RemoteConnectorRequest,
  type RemoteConnectorReservation,
} from './uplink-control-client.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];
  close = vi.fn((code?: number, reason?: string) => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason ?? ''));
  });
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1006, Buffer.alloc(0));
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
    installationId?: string;
    offerRemoteControl?: boolean;
    reserveRemoteConnector?: (
      request: RemoteConnectorRequest,
      signal: AbortSignal,
    ) => Promise<RemoteConnectorReservation | 'unavailable' | 'limit_reached'>;
  } = {},
) {
  const socket = new FakeSocket();
  const settings: { uplinkSubscriptionKey: string; uplinkInstallationId: string | null } = {
    uplinkSubscriptionKey: 'subscription-fixture',
    uplinkInstallationId: options.installationId ?? null,
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
    ...(options.offerRemoteControl !== undefined
      ? { offerRemoteControl: options.offerRemoteControl }
      : {}),
    ...(options.reserveRemoteConnector
      ? { reserveRemoteConnector: options.reserveRemoteConnector }
      : {}),
    log,
  });
  return { client, socket, socketFactory, store, settings, disabled, expired, log };
}

/** Like `setup`, but mints a fresh socket per dial. The shared-socket fixture
 * cannot show a reconnect: its socket stays CLOSED, so a second dial would be
 * indistinguishable from none at all. */
function setupReconnecting(
  options: {
    disableFeatures?: (reason: string) => Promise<void>;
    offerRemoteControl?: boolean;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const settings = {
    uplinkSubscriptionKey: 'subscription-fixture',
    uplinkInstallationId: null,
  };
  const store = {
    getVeritySettings: vi.fn(async () => settings),
    updateVeritySettings: vi.fn(async (patch: VeritySettingsPatch) => ({ ...settings, ...patch })),
    addPendingUplinkShareRemoval: vi.fn(async () => undefined),
    listPendingUplinkShareRemovals: vi.fn(async () => []),
    deletePendingUplinkShareRemoval: vi.fn(async () => undefined),
  };
  const disabled = vi.fn(options.disableFeatures ?? (async () => undefined));
  const socketFactory = vi.fn(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const client = new UplinkControlClient({
    url: UPLINK_CONTROL_URL,
    store: store as unknown as EventStore & typeof store,
    serverVersion: 'test',
    webSocketFactory: socketFactory,
    onFeaturesDisabled: disabled,
    ...(options.offerRemoteControl !== undefined
      ? { offerRemoteControl: options.offerRemoteControl }
      : {}),
    log,
  });
  return { client, sockets, socketFactory, store, disabled, log };
}

/** Window used by the back-off ceiling guards, long enough that the doubling
 * has saturated for most of it. */
const CEILING_WINDOW_MS = RECONNECT_MAX_MS * 60;
/** Dials the ordinary ceiling must produce across that window, halved for the
 * jitter and for the dials lost to the doubling on the way up. The capacity
 * ceiling is an order of magnitude below this, so the two never overlap. */
const SATURATED_DIALS = CEILING_WINDOW_MS / RECONNECT_MAX_MS / 2;

/** Counts how often the client redials across a window in which every dial
 * fails, which is what makes the back-off *ceiling* observable: a single
 * reconnect only ever shows the current delay, and that delay starts at its
 * floor no matter which ceiling is in force. */
async function dialsWhileFailing(sockets: FakeSocket[], windowMs: number): Promise<number> {
  const before = sockets.length;
  const step = RECONNECT_MAX_MS / 2;
  for (let elapsed = 0; elapsed < windowMs; elapsed += step) {
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.CLOSED) socket.close(1006, '');
    }
    await flush();
    await vi.advanceTimersByTimeAsync(step);
  }
  return sockets.length - before;
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

  it('offers remote negotiation only when the RC-B probe is enabled', async () => {
    const defaultFixture = setup();
    defaultFixture.client.start();
    await flush();
    defaultFixture.socket.open();
    const defaultHello = JSON.parse(defaultFixture.socket.sent[0]!) as Record<string, unknown>;
    expect(defaultHello).not.toHaveProperty('capabilities');
    expect(defaultHello).not.toHaveProperty('channels');
    await defaultFixture.client.stop();

    const probe = setup({ offerRemoteControl: true });
    probe.client.start();
    await flush();
    probe.socket.open();
    const hello = JSON.parse(probe.socket.sent[0]!) as Record<string, unknown>;
    expect(hello.capabilities).toEqual(['remote-control-v1']);
    expect(hello.channels).toEqual(['http', 'ws', 'remote']);
    await probe.client.stop();
  });

  it('rejects a remote request before the welcome completes', async () => {
    const { client, socket } = setup({ offerRemoteControl: true });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'session.request',
      requestId: 'request_example',
      sessionId: 'session_example',
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15_000,
    });
    await vi.waitFor(() =>
      expect(socket.close).toHaveBeenCalledWith(1002, 'invalid control message'),
    );
    expect(socket.sent.some((raw) => raw.includes('session.refuse'))).toBe(false);
    await client.stop();
  });

  it('refuses a negotiated personal session while no connector is wired', async () => {
    const { client, socket } = setup({ offerRemoteControl: true });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['remote-control'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      capabilities: ['remote-control-v1'],
      channels: ['http', 'ws', 'remote'],
    });
    await flush();
    socket.message({
      type: 'session.request',
      requestId: 'request_example',
      sessionId: 'session_example',
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15_000,
    });
    await flush();
    expect(socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)).toContainEqual({
      type: 'session.refuse',
      sessionId: 'session_example',
      code: 'unavailable',
    });
    expect(socket.sent.some((raw) => raw.includes('session.accept'))).toBe(false);
    expect(socket.sent.some((raw) => raw.includes('session.ticket'))).toBe(false);
    await client.stop();
  });

  it('accepts only after a connector reservation and releases it on cancellation', async () => {
    let completeReservation!: (value: RemoteConnectorReservation) => void;
    const reservation = { attach: vi.fn(async () => undefined), release: vi.fn() };
    const reserveRemoteConnector = vi.fn(
      () => new Promise<RemoteConnectorReservation>((resolve) => (completeReservation = resolve)),
    );
    const { client, socket } = setup({ offerRemoteControl: true, reserveRemoteConnector });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['remote-control'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      capabilities: ['remote-control-v1'],
      channels: ['http', 'ws', 'remote'],
    });
    await flush();
    socket.message({
      type: 'session.request',
      requestId: 'request_example',
      sessionId: 'session_example',
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15_000,
    });
    await flush();
    expect(socket.sent.some((raw) => raw.includes('session.accept'))).toBe(false);
    completeReservation(reservation);
    await vi.waitFor(() =>
      expect(socket.sent.some((raw) => raw.includes('session.accept'))).toBe(true),
    );
    socket.message({
      type: 'session.ticket',
      sessionId: 'session_example',
      ticket: 'ticket_example',
      expiresAt: Date.now() + 60_000,
      capability: 'remote-control-v1',
    });
    await vi.waitFor(() =>
      expect(reservation.attach).toHaveBeenCalledWith(
        'ticket_example',
        expect.any(Number),
        expect.any(AbortSignal),
      ),
    );
    socket.message({ type: 'session.cancelled', sessionId: 'session_example', code: 'cancelled' });
    await vi.waitFor(() => expect(reservation.release).toHaveBeenCalledTimes(1));
    await client.stop();
  });

  it('does not accept a reservation that completes after cancellation', async () => {
    let completeReservation!: (value: RemoteConnectorReservation) => void;
    const reservation = { attach: vi.fn(async () => undefined), release: vi.fn() };
    const { client, socket } = setup({
      offerRemoteControl: true,
      reserveRemoteConnector: () =>
        new Promise<RemoteConnectorReservation>((resolve) => (completeReservation = resolve)),
    });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['remote-control'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      capabilities: ['remote-control-v1'],
      channels: ['http', 'ws', 'remote'],
    });
    await flush();
    socket.message({
      type: 'session.request',
      requestId: 'request_example',
      sessionId: 'session_example',
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15_000,
    });
    await flush();
    socket.message({ type: 'session.cancelled', sessionId: 'session_example', code: 'cancelled' });
    await flush();
    completeReservation(reservation);
    await vi.waitFor(() => expect(reservation.release).toHaveBeenCalledTimes(1));
    expect(socket.sent.some((raw) => raw.includes('session.accept'))).toBe(false);
    expect(reservation.attach).not.toHaveBeenCalled();
    await client.stop();
  });

  it('does not release a replacement when an old reservation finishes late', async () => {
    const completions: Array<(value: RemoteConnectorReservation) => void> = [];
    const reserveRemoteConnector = vi.fn(
      () => new Promise<RemoteConnectorReservation>((resolve) => completions.push(resolve)),
    );
    const first = { attach: vi.fn(async () => undefined), release: vi.fn() };
    const replacement = { attach: vi.fn(async () => undefined), release: vi.fn() };
    const { client, socket } = setup({ offerRemoteControl: true, reserveRemoteConnector });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['remote-control'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      capabilities: ['remote-control-v1'],
      channels: ['http', 'ws', 'remote'],
    });
    await flush();
    const request = {
      type: 'session.request',
      requestId: 'request_example',
      sessionId: 'session_example',
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15_000,
    };
    socket.message(request);
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    socket.message({ type: 'session.cancelled', sessionId: 'session_example', code: 'cancelled' });
    await flush();
    socket.message({ ...request, requestId: 'request_retry' });
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    completions[0]!(first);
    await vi.waitFor(() => expect(first.release).toHaveBeenCalledTimes(1));
    completions[1]!(replacement);
    await vi.waitFor(() =>
      expect(socket.sent.some((raw) => raw.includes('session.accept'))).toBe(true),
    );
    expect(replacement.release).not.toHaveBeenCalled();
    await client.stop();
    expect(replacement.release).toHaveBeenCalledTimes(1);
  });

  it('refuses when connector capacity does not resolve before the decision deadline', async () => {
    vi.useFakeTimers();
    let completeReservation!: (value: RemoteConnectorReservation) => void;
    const reservation = { attach: vi.fn(async () => undefined), release: vi.fn() };
    const { client, socket } = setup({
      offerRemoteControl: true,
      reserveRemoteConnector: () =>
        new Promise<RemoteConnectorReservation>((resolve) => (completeReservation = resolve)),
    });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['remote-control'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      capabilities: ['remote-control-v1'],
      channels: ['http', 'ws', 'remote'],
    });
    await flush();
    socket.message({
      type: 'session.request',
      requestId: 'request_example',
      sessionId: 'session_example',
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15_000,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)).toContainEqual({
      type: 'session.refuse',
      sessionId: 'session_example',
      code: 'unavailable',
    });
    completeReservation(reservation);
    await flush();
    expect(reservation.release).toHaveBeenCalledTimes(1);
    expect(socket.sent.some((raw) => raw.includes('session.accept'))).toBe(false);
    await client.stop();
    vi.useRealTimers();
  });

  it('bounds a far-future ticket expiry timer without immediate teardown', async () => {
    vi.useFakeTimers();
    const reservation = {
      attach: vi.fn(() => new Promise<void>(() => undefined)),
      release: vi.fn(),
    };
    const { client, socket } = setup({
      offerRemoteControl: true,
      reserveRemoteConnector: async () => reservation,
    });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['remote-control'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      capabilities: ['remote-control-v1'],
      channels: ['http', 'ws', 'remote'],
    });
    await flush();
    socket.message({
      type: 'session.request',
      requestId: 'request_example',
      sessionId: 'session_example',
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15_000,
    });
    await flush();
    socket.message({
      type: 'session.ticket',
      sessionId: 'session_example',
      ticket: 'ticket_example',
      expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
      capability: 'remote-control-v1',
    });
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(reservation.attach).toHaveBeenCalledTimes(1);
    expect(reservation.release).not.toHaveBeenCalled();
    await client.stop();
    vi.useRealTimers();
  });

  it.each([
    { capabilities: undefined, channels: undefined },
    { capabilities: ['remote-control-v1'], channels: ['http', 'ws'] },
    { capabilities: ['remote-control-v1'], channels: ['http', 'ws', 'remote'], features: [] },
  ])('rejects remote session traffic without full selection and entitlement', async (selection) => {
    const { client, socket } = setup({ offerRemoteControl: true });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: selection.features ?? ['remote-control'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      ...(selection.capabilities ? { capabilities: selection.capabilities } : {}),
      ...(selection.channels ? { channels: selection.channels } : {}),
    });
    await flush();
    socket.message({
      type: 'session.request',
      requestId: 'request_example',
      sessionId: 'session_example',
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15_000,
    });
    await flush();
    await vi.waitFor(() =>
      expect(socket.close).toHaveBeenCalledWith(1002, 'invalid control message'),
    );
    await client.stop();
  });

  it.each([
    { capabilities: ['remote-control-v1', 'remote-control-v1'] },
    { channels: [] },
    { channels: ['remote\n'] },
  ])('rejects malformed welcome negotiation', async (badFields) => {
    const { client, socket } = setup({ offerRemoteControl: true });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['remote-control'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      capabilities: ['remote-control-v1'],
      channels: ['http', 'ws', 'remote'],
      ...badFields,
    });
    await flush();
    await vi.waitFor(() =>
      expect(socket.close).toHaveBeenCalledWith(1002, 'invalid control message'),
    );
    await client.stop();
  });

  it('rejects malformed session fields before any decision', async () => {
    const { client, socket } = setup({ offerRemoteControl: true });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['remote-control'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      capabilities: ['remote-control-v1'],
      channels: ['http', 'ws', 'remote'],
    });
    await flush();
    socket.message({
      type: 'session.request',
      requestId: 'request_example\n',
      sessionId: 'session_example',
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15_000,
    });
    await flush();
    await vi.waitFor(() =>
      expect(socket.close).toHaveBeenCalledWith(1002, 'invalid control message'),
    );
    expect(socket.sent.some((raw) => raw.includes('session.refuse'))).toBe(false);
    await client.stop();
  });

  it.each([
    { decisionExpiresAt: 'tomorrow' },
    { decisionExpiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { unexpected: true },
  ])('rejects malformed session request shape', async (badFields) => {
    const { client, socket } = setup({ offerRemoteControl: true });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['remote-control'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      capabilities: ['remote-control-v1'],
      channels: ['http', 'ws', 'remote'],
    });
    await flush();
    socket.message({
      type: 'session.request',
      requestId: 'request_example',
      sessionId: 'session_example',
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15_000,
      ...badFields,
    });
    await vi.waitFor(() =>
      expect(socket.close).toHaveBeenCalledWith(1002, 'invalid control message'),
    );
    expect(socket.sent.some((raw) => raw.includes('session.refuse'))).toBe(false);
    await client.stop();
  });

  it('fences remote requests after renewal removes the entitlement', async () => {
    const { client, socket } = setup({ offerRemoteControl: true });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['remote-control'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      capabilities: ['remote-control-v1'],
      channels: ['http', 'ws', 'remote'],
    });
    await flush();
    socket.message({
      type: 'renewed',
      features: [],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    socket.message({
      type: 'session.request',
      requestId: 'request_example',
      sessionId: 'session_example',
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15_000,
    });
    await vi.waitFor(() =>
      expect(socket.close).toHaveBeenCalledWith(1002, 'invalid control message'),
    );
    expect(socket.sent.some((raw) => raw.includes('session.refuse'))).toBe(false);
    await client.stop();
  });

  it('rejects an oversized session frame before refusing admission', async () => {
    const { client, socket } = setup({ offerRemoteControl: true });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['remote-control'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      capabilities: ['remote-control-v1'],
      channels: ['http', 'ws', 'remote'],
    });
    await flush();
    const request = JSON.stringify({
      type: 'session.request',
      requestId: 'request_example',
      sessionId: 'session_example',
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15_000,
    });
    socket.emit('message', Buffer.from(request + ' '.repeat(16_384)));
    await vi.waitFor(() =>
      expect(socket.close).toHaveBeenCalledWith(1002, 'invalid control message'),
    );
    expect(socket.sent.some((raw) => raw.includes('session.refuse'))).toBe(false);
    await client.stop();
  });

  it('does not carry remote negotiation across a control reconnect', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setupReconnecting({ offerRemoteControl: true });
    client.start();
    await flush();
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['remote-control'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      capabilities: ['remote-control-v1'],
      channels: ['http', 'ws', 'remote'],
    });
    await flush();
    sockets[0]!.close(1006, 'lost');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['remote-control'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    sockets[1]!.message({
      type: 'session.request',
      requestId: 'request_example',
      sessionId: 'session_example',
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15_000,
    });
    await flush();
    await vi.waitFor(() =>
      expect(sockets[1]!.close).toHaveBeenCalledWith(1002, 'invalid control message'),
    );
    await client.stop();
  });

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

  it('logs renewal requests and the lease returned by renewed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T06:00:00.000Z'));
    const fixture = setup();
    const { client, socket, log } = fixture;
    await welcomed(fixture, 10_000);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'renew' });
    expect(log.info).toHaveBeenCalledWith(
      { leaseUntil: '2026-09-22T06:00:10.000Z' },
      'requesting Uplink lease renewal',
    );

    socket.message({
      type: 'renewed',
      features: ['sharing'],
      leaseUntil: '2026-09-22T06:01:00.000Z',
    });
    await flush();
    expect(log.info).toHaveBeenCalledWith(
      { leaseUntil: '2026-09-22T06:01:00.000Z', features: ['sharing'] },
      'Uplink lease renewed',
    );
    await client.stop();
  });

  it('redials and terminates a control socket whose lease-expiry close stalls', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T06:00:00.000Z'));
    const { client, sockets, socketFactory, log } = setupReconnecting();
    client.start();
    await flush();
    const expiredSocket = sockets[0]!;
    expiredSocket.open();
    expiredSocket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: '2026-09-22T06:00:10.000Z',
    });
    await flush();
    // Model the production failure: close enters CLOSING but never emits close.
    expiredSocket.close.mockImplementation(() => {
      expiredSocket.readyState = WebSocket.CLOSING;
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.isAvailable()).toBe(false);
    expect(expiredSocket.close).toHaveBeenCalledWith(4001, 'lease expired');
    expect(log.warn).toHaveBeenCalledWith(
      { leaseUntil: '2026-09-22T06:00:10.000Z' },
      'Uplink lease expired',
    );

    // Reconnection does not wait for either close or forced termination.
    await vi.advanceTimersByTimeAsync(CLOSE_TIMEOUT_MS - 1);
    expect(socketFactory).toHaveBeenCalledTimes(2);
    expect(expiredSocket.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expiredSocket.terminate).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      { code: 4001, reason: 'lease expired', readyState: WebSocket.CLOSING },
      'terminating stalled Uplink close handshake',
    );

    // A delayed close from the retired transport cannot schedule another dial.
    expiredSocket.emit('close', 4001, Buffer.from('lease expired'));
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);
    expect(socketFactory).toHaveBeenCalledTimes(2);
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

  /**
   * The two reject classes differ only in whether the installation may try
   * again, and the difference is invisible in a single connection: both close
   * the socket and both disable sharing. What separates them is what happens
   * on the timer afterwards, which is what these two guards watch.
   *
   * Getting this wrong is silent in both directions. Treating a capacity
   * refusal as terminal strands the installation until someone restarts it,
   * long after the far end has room again; treating an identity refusal as
   * temporary redials forever against an answer that cannot change — and
   * against an Uplink that allocates per connection, each of those dials costs
   * something.
   */
  it('keeps dialling after a capacity refusal, on the slower schedule', async () => {
    vi.useFakeTimers();
    const { client, socketFactory, sockets, disabled } = setupReconnecting();
    client.start();
    await flush();
    sockets[0]!.open();
    sockets[0]!.message({ type: 'reject', reason: 'limit_reached' });
    await flush();

    expect(disabled).toHaveBeenCalledWith('limit_reached');
    // Still quiet at the ordinary ceiling: a capacity refusal must not be
    // retried on the same schedule as a dropped connection.
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);
    expect(socketFactory).toHaveBeenCalledTimes(1);

    // Dialled again once the slower schedule comes round, with no operator
    // action: capacity freed on the far end has to be noticed on its own.
    await vi.advanceTimersByTimeAsync(RECONNECT_CAPACITY_MS * 1.5);
    expect(socketFactory).toHaveBeenCalledTimes(2);
    await client.stop();
  });

  it('returns to the ordinary schedule once a welcome lands', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setupReconnecting();
    client.start();
    await flush();
    sockets[0]!.open();
    sockets[0]!.message({ type: 'reject', reason: 'limit_reached' });
    await flush();
    await vi.advanceTimersByTimeAsync(RECONNECT_CAPACITY_MS * 1.5);

    sockets[1]!.open();
    sockets[1]!.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    await flush();

    // The slow schedule belongs to the refusal, not to the installation. An
    // admission that leaves it in place makes every later network blip cost
    // five minutes of downtime, which nothing in the logs would explain.
    //
    // Counting dials over a window is the only way to see this: the welcome
    // also resets the *delay* to its floor, so the first reconnect after a
    // drop is prompt either way. The ceiling only shows itself once the
    // back-off has doubled its way up to it.
    const dials = await dialsWhileFailing(sockets, CEILING_WINDOW_MS);
    expect(dials).toBeGreaterThan(SATURATED_DIALS);
    await client.stop();
  });

  it('does not inherit a capacity back-off across a stop and start', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setupReconnecting();
    client.start();
    await flush();
    sockets[0]!.open();
    sockets[0]!.message({ type: 'reject', reason: 'limit_reached' });
    await flush();
    await client.stop();

    // Restarting is an operator asking for a fresh attempt - most often right
    // after changing something they expect to have fixed it. Carrying the old
    // refusal's schedule over means the first evidence either way is minutes
    // away, and it looks like nothing happened.
    client.start();
    await flush();
    const dials = await dialsWhileFailing(sockets, CEILING_WINDOW_MS);
    expect(dials).toBeGreaterThan(SATURATED_DIALS);
    await client.stop();
  });

  it('clamps a refusal reason before pinning it into the app-facing message', async () => {
    vi.useFakeTimers();
    const { client, sockets, disabled } = setupReconnecting();
    client.start();
    await flush();
    sockets[0]!.open();
    // `revoke` is the refusal that carries free text: the reject reasons that
    // are held are exact tokens, so only this path can store an arbitrary
    // string. It is held until the credentials change, so whatever arrives
    // here is what the app shows for as long as that lasts - and the frame
    // limit alone permits tens of kilobytes of it.
    //
    // It has to be welcomed first. A revoke before a welcome is a protocol
    // violation, and the parser's own short message would be the thing
    // measured instead of the stored reason.
    sockets[0]!.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    await flush();
    disabled.mockClear();
    sockets[0]!.message({ type: 'revoke', reason: 'x'.repeat(50_000) });
    await flush();

    const surfaced = String(disabled.mock.calls.at(0)?.[0] ?? '');
    expect(surfaced).toMatch(/^x+…$/);
    expect(surfaced.length).toBeLessThan(250);
    await client.stop();
  });

  it('strips control characters out of a refusal reason', async () => {
    const { client, socket, disabled, log } = await welcomed(setup());
    disabled.mockClear();
    log.warn.mockClear();
    // A reason carrying its own line breaks forges a record: pasted into a log
    // it reads as several entries, one of which nobody wrote. The far end
    // chooses this string, so the bound belongs on this side of the frame.
    socket.message({ type: 'revoke', reason: 'revoked\nUplink: all clear ' });
    await flush();

    const surfaced = String(disabled.mock.calls.at(0)?.[0] ?? '');
    expect(surfaced).not.toMatch(/\p{C}/u);
    expect(surfaced).toContain('revoked');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.not.stringMatching(/\p{C}/u) }),
      'Uplink withdrew this installation',
    );
    await client.stop();
  });

  it('keeps a multi-byte refusal reason intact when it clamps it', async () => {
    vi.useFakeTimers();
    const { client, sockets, disabled } = setupReconnecting();
    client.start();
    await flush();
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    await flush();
    disabled.mockClear();
    // An emoji is a surrogate pair. Clamping by code unit lands between its
    // halves and emits a lone surrogate, which reaches the app as a
    // replacement character and reads there as corrupted data rather than as
    // a truncated message.
    //
    // The leading character matters: with pairs alone the cut lands on an even
    // index, which is a pair boundary, and a code-unit slice would pass by
    // luck. One BMP character ahead of them shifts every boundary by one.
    sockets[0]!.message({ type: 'revoke', reason: `x${'🛰'.repeat(400)}` });
    await flush();

    const surfaced = String(disabled.mock.calls.at(0)?.[0] ?? '');
    // With the `u` flag a well-formed pair is one code point outside this
    // range, so the class matches only an unpaired half.
    expect(surfaced).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(surfaced).toMatch(/^x🛰+…$/u);
    await client.stop();
  });

  it('never hands a close reason to ws that ws would throw on', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setupReconnecting();
    client.start();
    await flush();
    sockets[0]!.open();
    sockets[0]!.message({ type: 'reject', reason: 'capacity: '.repeat(40) });
    await flush();

    // Over 123 bytes `ws` throws a RangeError out of close(). Thrown from the
    // frame handler it is caught by the parser's catch, which reports a refusal
    // we parsed perfectly as an unparseable frame and closes 1002 instead of
    // 4003 - destroying the one log line that names why sharing stopped.
    const [, reason] = sockets[0]!.close.mock.calls.at(-1) ?? [];
    expect(Buffer.byteLength(String(reason))).toBeLessThanOrEqual(123);
    expect(sockets[0]!.close).not.toHaveBeenCalledWith(1002, expect.anything());
    await client.stop();
  });

  it('keeps reporting a refusal it has stopped dialling on', async () => {
    vi.useFakeTimers();
    const { client, sockets, log } = setupReconnecting();
    client.start();
    await flush();
    sockets[0]!.open();
    sockets[0]!.message({ type: 'reject', reason: 'unknown_key' });
    await flush();
    log.warn.mockClear();

    // The incident this change exists for ran 13 days. An installation that
    // has given up must not look like one that is fine: if the only record is
    // the single refusal at the moment it happened, whoever looks later sees
    // an idle client and no reason.
    await vi.advanceTimersByTimeAsync(RECONNECT_CAPACITY_MS * 2.5);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unknown_key' }),
      'not dialling the Uplink: this key was refused',
    );
    await client.stop();
  });

  it.each(['unknown_key', 'revoked', 'expired'])(
    'stops dialling after the identity refusal %s and surfaces it verbatim',
    async (reason) => {
      vi.useFakeTimers();
      const { client, socketFactory, sockets, disabled } = setupReconnecting();
      client.start();
      await flush();
      sockets[0]!.open();
      sockets[0]!.message({ type: 'reject', reason });
      await flush();

      // Verbatim, per the protocol: three of these four are not about the key,
      // and a message naming the key sends the reader to the wrong setting.
      expect(disabled).toHaveBeenCalledWith(reason);
      await vi.advanceTimersByTimeAsync(RECONNECT_CAPACITY_MS * 4);
      expect(socketFactory).toHaveBeenCalledTimes(1);
      await client.stop();
    },
  );

  it('reports the stored identity reason each time it declines to dial', async () => {
    vi.useFakeTimers();
    // A local cleanup that keeps failing is the one state in which authority
    // loss is announced more than once — which is what makes the reason used by
    // the "do not dial again" branch observable at all. Without it the first
    // announcement wins and the branch's own string never leaves the process.
    const { client, sockets, disabled } = setupReconnecting({
      disableFeatures: async () => {
        throw new Error('local cleanup failed');
      },
    });
    client.start();
    await flush();
    sockets[0]!.open();
    sockets[0]!.message({ type: 'reject', reason: 'expired' });
    await flush();

    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);
    // The Uplink said the subscription expired. Reporting "the key was
    // rejected" here would send whoever reads it to re-enter a key that is
    // perfectly valid.
    expect(disabled).toHaveBeenLastCalledWith('expired');
    await client.stop();
  });

  it.each([
    // A reason added to the service after this version shipped. Defaulting to
    // terminal would strand every installation that had not been updated yet.
    'region_unavailable',
    // Named, but still not this installation's standing: a mixed-version fleet
    // or a rolled-back deployment answers differently on the next dial, and the
    // upgrade that would fix it from this side restarts the process anyway.
    'protocol_unsupported',
  ])('treats the reject reason %s as capacity, not as terminal', async (reason) => {
    vi.useFakeTimers();
    const { client, socketFactory, sockets } = setupReconnecting();
    client.start();
    await flush();
    sockets[0]!.open();
    sockets[0]!.message({ type: 'reject', reason });
    await flush();

    await vi.advanceTimersByTimeAsync(RECONNECT_CAPACITY_MS * 1.5);
    expect(socketFactory).toHaveBeenCalledTimes(2);
    await client.stop();
  });

  it('keeps the subscription key out of every line it logs', async () => {
    // Serialized the way a transport renders it, so a key nested anywhere in
    // the payload counts. Errors are rendered rather than stringified, because
    // `JSON.stringify` turns one into `{}` and would hide a key sitting in its
    // message - the shape every `{ error }` line here arrives in.
    const render = (call: unknown[]): string => {
      // Per call, not per suite: the client logs the same store and the same
      // settings object from several call sites, and a `seen` shared across
      // renders would collapse every line after the first that reached one into
      // `[circular]` - scanning nothing while still reporting a pass.
      const seen = new WeakSet<object>();
      return call
        .map((argument) =>
          JSON.stringify(argument, (_key, value: unknown) => {
            if (value instanceof Error) return `${value.name}: ${value.message} ${value.stack}`;
            if (typeof value !== 'object' || value === null) return value;
            if (seen.has(value)) return '[circular]';
            seen.add(value);
            return value;
          }),
        )
        .join(' ');
    };

    const refused = setup();
    refused.client.start();
    await flush();
    refused.socket.open();
    refused.socket.emit('error', new Error(`connect ECONNREFUSED ${UPLINK_CONTROL_URL}`));
    refused.socket.message({ type: 'reject', reason: 'limit_reached' });
    await flush();

    const admitted = setup();
    admitted.client.start();
    await flush();
    admitted.socket.open();
    admitted.socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    admitted.socket.message({ type: 'revoke', reason: 'subscription revoked' });
    await flush();

    // Every path this client was given logging for: the handshake, a transport
    // error, a refusal, a withdrawal, an admission, and the closes those cause.
    const logged = [refused.log, admitted.log].flatMap((log) => [
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
      ...log.error.mock.calls,
    ]);
    expect(logged.length).toBeGreaterThan(6);

    // Read off the fixture rather than restated: a `setup` that stopped putting
    // this key on the wire would leave a restated literal asserting that lines
    // do not contain a string nothing ever had.
    const key = refused.settings.uplinkSubscriptionKey;
    expect(admitted.settings.uplinkSubscriptionKey).toBe(key);
    // The key is in play at all: the client authenticates with it, so a line
    // carrying it is a live possibility rather than a hypothetical one.
    expect(admitted.socket.sent.join(' ')).toContain(key);
    // And `render` would find it: a renderer that quietly produced `undefined`
    // for the shape these lines arrive in would pass the loop below forever.
    expect(render([{ frame: { auth: { subscriptionKey: key } } }])).toContain(key);

    for (const call of logged) {
      // The embedded boot hands this client a logger that writes to stderr
      // until the Fastify one exists, which puts those lines past pino's
      // redaction. That holds only while nothing here carries a credential, and
      // a reading of the call sites is one added line from being out of date.
      expect(render(call)).not.toContain(key);
    }
    await refused.client.stop();
    await admitted.client.stop();
  });

  it('records the close code, close reason, and whether it was ever admitted', async () => {
    const { client, socket, log } = setup();
    client.start();
    await flush();
    socket.open();
    socket.message({ type: 'reject', reason: 'limit_reached' });
    await flush();

    // The frame type belongs in the record too: a close code alone cannot say
    // whether the refusal was the handshake or a later withdrawal, because the
    // two sides of this protocol number their close codes independently.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        frameType: 'reject',
        reason: 'limit_reached',
        identityReject: false,
        welcomed: false,
      }),
      'Uplink refused the control connection',
    );
    // `welcomed: false` is the line that distinguishes "never admitted" from
    // "was up and dropped" — the distinction this incident class turns on.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 4003, reason: 'limit_reached', welcomed: false }),
      'Uplink control connection closed',
    );
    await client.stop();
  });

  it('reports whether the handshake carried an installation id', async () => {
    const { client, socket, log, store } = setup();
    client.start();
    await flush();
    socket.open();
    // Nothing was ever welcomed, so there is no id to send: every attempt looks
    // new to the far end, and that is the state worth seeing from this side.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ identified: false }),
      'Uplink control handshake started',
    );

    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    expect(store.updateVeritySettings).toHaveBeenCalledWith({
      uplinkInstallationId: 'installation-1',
    });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 'installation-1', firstEver: true }),
      'Uplink admitted this installation',
    );
    await client.stop();
  });

  it('does not report a re-admitted installation as a new one', async () => {
    const { client, socket, log } = setup({ installationId: 'installation-1' });
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

    // A server that keeps reappearing as a brand-new installation is what
    // exhausts an installation cap. If every admission logs firstEver the
    // difference between that and an ordinary reconnect is invisible, and the
    // logs agree with whichever theory is read into them.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 'installation-1', firstEver: false }),
      'Uplink admitted this installation',
    );
    await client.stop();
  });

  it('records an admission that replaced the stored installation id', async () => {
    const { client, socket, log } = setup({ installationId: 'installation-1' });
    client.start();
    await flush();
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-2',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();

    // This is the shape that exhausts an installation cap: the far end mints a
    // fresh id on each admission, consuming a slot every time, while this side
    // overwrites its stored id and carries on believing it is one installation.
    // Without the previous id in the record the whole sequence reads as a
    // series of ordinary reconnects.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 'installation-2',
        previousInstallationId: 'installation-1',
        firstEver: false,
        idChanged: true,
      }),
      'Uplink admitted this installation',
    );
    await client.stop();
  });

  it('reports a local failure when async welcome persistence fails', async () => {
    const { client, socket, store, disabled, log } = setup();
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
    expect(socket.close).toHaveBeenCalledWith(1011, 'local welcome processing failed');
    expect(client.isAvailable()).toBe(false);
    expect(disabled).toHaveBeenCalledWith('failed to accept Uplink welcome');
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error), frameType: 'welcome' }),
      'failed to accept Uplink welcome',
    );
    await client.stop();
  });

  it('records the admission even when persisting the installation id fails', async () => {
    const { client, socket, store, log } = setup();
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

    // A write that fails leaves the id unstored, so the next handshake
    // introduces itself as a stranger and consumes another slot against the
    // installation cap. If the record is written only after the write
    // succeeds, that loop leaves nothing behind but repeated refusals with no
    // trace of what rotated.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 'installation-1', firstEver: true }),
      'Uplink admitted this installation',
    );
    await client.stop();
  });

  it('persists an admitted installation before retrying failed local cleanup', async () => {
    let rejectCleanup!: (error: Error) => void;
    const cleanup = new Promise<void>((_resolve, reject) => {
      rejectCleanup = reject;
    });
    const { client, socket, store, settings } = setup({ disableFeatures: async () => cleanup });
    settings.uplinkSubscriptionKey = '';
    client.start();
    await flush();
    settings.uplinkSubscriptionKey = 'restored-key';
    client.refreshCredentials();
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.open();
    socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();

    // Admission has happened remotely at this point. Even though accepting
    // authority remains blocked on local cleanup, the next hello must identify
    // this installation instead of consuming another slot.
    expect(store.updateVeritySettings).toHaveBeenCalledWith({
      uplinkInstallationId: 'installation-1',
    });
    expect(client.isAvailable()).toBe(false);

    rejectCleanup(new Error('local cleanup failed'));
    await flush();
    expect(socket.close).toHaveBeenCalledWith(1011, 'local welcome processing failed');
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
      // Not reported as a refused frame: the transport is not carrying the
      // protocol, which the close code already says. The connection-close log
      // below is a different record and is expected.
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'invalid Uplink control message',
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: 1002, welcomed: false }),
        'Uplink control connection closed',
      );
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
