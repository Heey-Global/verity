import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventStore, VeritySettingsPatch } from '@verity/store';
import { UplinkControlClient } from './uplink-control-client.js';
import { createRemoteConnectorPool } from './remote-control-connector.js';

interface ControlPeer {
  socket: WebSocket;
  received: Record<string, unknown>[];
}

const fixtures: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function fixture(options?: {
  reserveGate?: { started: () => void; ready: Promise<void> };
  dataSocket?: boolean;
}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test server address');
  const peers: ControlPeer[] = [];
  const dataPeers: ControlPeer[] = [];
  server.on('connection', (socket, request) => {
    const peer: ControlPeer = { socket, received: [] };
    (request.url === '/data' ? dataPeers : peers).push(peer);
    socket.on('message', (data) => {
      if (!Buffer.isBuffer(data)) throw new Error('unexpected test frame');
      peer.received.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
    });
  });
  const settings = {
    uplinkSubscriptionKey: 'test-subscription',
    uplinkInstallationId: null as string | null,
  };
  const store = {
    getVeritySettings: vi.fn(async () => settings),
    updateVeritySettings: vi.fn(async (patch: VeritySettingsPatch) => {
      if (patch.uplinkInstallationId !== undefined)
        settings.uplinkInstallationId = patch.uplinkInstallationId;
      return settings;
    }),
    addPendingUplinkShareRemoval: vi.fn(async () => undefined),
    listPendingUplinkShareRemovals: vi.fn(async () => []),
    deletePendingUplinkShareRemoval: vi.fn(async () => undefined),
  };
  const pool = createRemoteConnectorPool({
    dataUrl: 'wss://uplink.example/data',
    localHost: '127.0.0.1',
    localPort: 1,
    webSocketFactory: () => {
      if (options?.dataSocket) return new WebSocket(`ws://127.0.0.1:${address.port}/data`);
      throw new Error('ticketless admission must not open /data');
    },
  });
  const reservations: { closed?: Promise<void> }[] = [];
  const attachedSessions: string[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const client = new UplinkControlClient({
    log,
    url: 'wss://uplink.example/control',
    store: store as unknown as EventStore & typeof store,
    serverVersion: 'test',
    webSocketFactory: (_url, options) =>
      new WebSocket(`ws://127.0.0.1:${address.port}/control`, options),
    offerRemoteControl: true,
    reserveRemoteConnector: async (request, signal) => {
      options?.reserveGate?.started();
      await options?.reserveGate?.ready;
      const reservation = await pool.reserve(request, signal);
      if (typeof reservation !== 'string') {
        reservations.push(reservation);
        const attach = reservation.attach.bind(reservation);
        reservation.attach = async (ticket, expiresAt, attachSignal) => {
          await attach(ticket, expiresAt, attachSignal);
          attachedSessions.push(request.sessionId);
        };
      }
      return reservation;
    },
  });
  fixtures.push({
    close: async () => {
      await client.stop();
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
  client.start();
  return { peers, dataPeers, reservations, attachedSessions, client, log };
}

async function nextPeer(peers: ControlPeer[], index: number): Promise<ControlPeer> {
  await vi.waitFor(() => expect(peers[index]?.received[0]?.type).toBe('hello'), {
    timeout: 3_000,
  });
  return peers[index]!;
}

function request(peer: ControlPeer, sessionId: string, leaseMs = 60_000): void {
  peer.socket.send(
    JSON.stringify({
      type: 'welcome',
      installationId: 'installation-one',
      features: ['sharing', 'remote-control'],
      leaseUntil: new Date(Date.now() + leaseMs).toISOString(),
      capabilities: ['remote-control-v1'],
      channels: ['http', 'ws', 'remote'],
    }),
  );
  peer.socket.send(
    JSON.stringify({
      type: 'session.request',
      requestId: `request_${sessionId}`,
      sessionId,
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15_000,
    }),
  );
}

describe('real control socket with connector reservation', () => {
  it('distinguishes unavailable control from missing installation routing without logging credentials', async () => {
    const f = await fixture();
    f.client.remoteControlDescriptor();
    f.client.remoteControlDescriptor();
    expect(
      f.log.info.mock.calls.filter((call) => call[1] === 'remote control availability changed'),
    ).toEqual([
      [
        { stage: 'descriptor', state: 'control_unavailable' },
        'remote control availability changed',
      ],
    ]);
    const peer = await nextPeer(f.peers, 0);
    request(peer, 'diagnostic_session');
    await vi.waitFor(() =>
      expect(peer.received).toContainEqual({
        type: 'session.accept',
        sessionId: 'diagnostic_session',
      }),
    );
    f.client.remoteControlDescriptor();
    expect(f.log.info).toHaveBeenCalledWith(
      { stage: 'descriptor', state: 'installation_unavailable' },
      'remote control availability changed',
    );
    expect(JSON.stringify(f.log.info.mock.calls)).not.toContain('test-subscription');
  });
  it('accepts only after reservation and releases on cancellation', async () => {
    let beginReservation!: () => void;
    const reservationStarted = new Promise<void>((resolve) => {
      beginReservation = resolve;
    });
    let finishReservation!: () => void;
    const reservationReady = new Promise<void>((resolve) => {
      finishReservation = resolve;
    });
    const f = await fixture({
      reserveGate: { started: beginReservation, ready: reservationReady },
    });
    const peer = await nextPeer(f.peers, 0);
    expect(peer.received[0]).toMatchObject({ capabilities: ['remote-control-v1'] });
    request(peer, 'session_one');
    await reservationStarted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(peer.received.some((frame) => frame.type === 'session.accept')).toBe(false);
    finishReservation();
    await vi.waitFor(() =>
      expect(peer.received).toContainEqual({ type: 'session.accept', sessionId: 'session_one' }),
    );
    expect(f.reservations).toHaveLength(1);
    // Acceptance without a ticket otherwise leaves no evidence of which side stalled.
    expect(f.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'admission',
        requestId: 'request_session_one',
        sessionId: 'session_one',
      }),
      'remote session accepted; waiting for ticket',
    );
    peer.socket.send(
      JSON.stringify({ type: 'session.cancelled', sessionId: 'session_one', code: 'unavailable' }),
    );
    expect(f.reservations[0]?.closed).toBeInstanceOf(Promise);
    await f.reservations[0]!.closed;
  });

  it('releases the old reservation when the control socket is replaced', async () => {
    const f = await fixture();
    const first = await nextPeer(f.peers, 0);
    request(first, 'session_one');
    await vi.waitFor(() =>
      expect(first.received).toContainEqual({ type: 'session.accept', sessionId: 'session_one' }),
    );
    first.socket.close(4000, 'replaced');
    expect(f.reservations[0]?.closed).toBeInstanceOf(Promise);
    await f.reservations[0]!.closed;
    const second = await nextPeer(f.peers, 1);
    request(second, 'session_two');
    await vi.waitFor(() =>
      expect(second.received).toContainEqual({ type: 'session.accept', sessionId: 'session_two' }),
    );
    expect(f.reservations).toHaveLength(2);
  });

  it('attaches the installation ticket and waits for the data barrier', async () => {
    const f = await fixture({ dataSocket: true });
    const peer = await nextPeer(f.peers, 0);
    request(peer, 'session_one');
    await vi.waitFor(() =>
      expect(peer.received).toContainEqual({ type: 'session.accept', sessionId: 'session_one' }),
    );
    peer.socket.send(
      JSON.stringify({
        type: 'session.ticket',
        sessionId: 'session_one',
        ticket: 'installation_ticket',
        expiresAt: Date.now() + 60_000,
        capability: 'remote-control-v1',
      }),
    );
    await vi.waitFor(() =>
      expect(f.dataPeers[0]?.received).toContainEqual({
        type: 'attach',
        ticket: 'installation_ticket',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.attachedSessions).toHaveLength(0);
    f.dataPeers[0]!.socket.send(
      JSON.stringify({
        type: 'attached',
        sessionId: 'session_one',
        capability: 'remote-control-v1',
      }),
    );
    await vi.waitFor(() => expect(f.attachedSessions).toEqual(['session_one']));
    peer.socket.send(
      JSON.stringify({ type: 'session.cancelled', sessionId: 'session_one', code: 'cancelled' }),
    );
    expect(f.reservations[0]?.closed).toBeInstanceOf(Promise);
    await f.reservations[0]!.closed;
    await vi.waitFor(() => expect(f.dataPeers[0]?.socket.readyState).toBe(WebSocket.CLOSED));
  });

  it('keeps an attached session open past any wall-clock limit', async () => {
    // Only timeouts are faked: the control heartbeat interval and the real
    // sockets keep running, so the only thing the jump can end is a session
    // deadline. A cap here severs every stream the app has open - its live
    // event socket included - and shows up on the phone as a random drop.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const f = await fixture({ dataSocket: true });
    const peer = await nextPeer(f.peers, 0);
    request(peer, 'session_one', 2 * 60 * 60_000);
    await vi.waitFor(() =>
      expect(peer.received).toContainEqual({ type: 'session.accept', sessionId: 'session_one' }),
    );
    peer.socket.send(
      JSON.stringify({
        type: 'session.ticket',
        sessionId: 'session_one',
        ticket: 'installation_ticket',
        expiresAt: Date.now() + 60_000,
        capability: 'remote-control-v1',
      }),
    );
    await vi.waitFor(() => expect(f.dataPeers[0]?.received[0]?.type).toBe('attach'));
    f.dataPeers[0]!.socket.send(
      JSON.stringify({
        type: 'attached',
        sessionId: 'session_one',
        capability: 'remote-control-v1',
      }),
    );
    await vi.waitFor(() => expect(f.attachedSessions).toEqual(['session_one']));
    let closed = false;
    void f.reservations[0]!.closed!.then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(f.dataPeers[0]!.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('fails only the affected session on a late ticket', async () => {
    const f = await fixture({ dataSocket: true });
    const peer = await nextPeer(f.peers, 0);
    request(peer, 'session_one');
    await vi.waitFor(() =>
      expect(peer.received).toContainEqual({ type: 'session.accept', sessionId: 'session_one' }),
    );
    // A ticket for a session Core never accepted (or already released) must
    // not close the control socket: that would drop every other remote
    // session and all preview shares with it.
    peer.socket.send(
      JSON.stringify({
        type: 'session.ticket',
        sessionId: 'session_unknown',
        ticket: 'installation_ticket',
        expiresAt: Date.now() + 60_000,
        capability: 'remote-control-v1',
      }),
    );
    peer.socket.send(
      JSON.stringify({
        type: 'session.ticket',
        sessionId: 'session_one',
        ticket: 'installation_ticket',
        expiresAt: Date.now() - 1,
        capability: 'remote-control-v1',
      }),
    );
    await f.reservations[0]!.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(peer.socket.readyState).toBe(WebSocket.OPEN);
    expect(f.peers).toHaveLength(1);
  });
});
