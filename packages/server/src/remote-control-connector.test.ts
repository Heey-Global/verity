import { EventEmitter } from 'node:events';
import { createConnection, createServer, type Server as NetServer, type Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteConnectorPool, remoteDataUrlForControl } from './remote-control-connector.js';
import type { RemoteConnectorReservation } from './uplink-control-client.js';

const open = new Set<{ close: () => Promise<void> }>();
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...open].map((resource) => resource.close()));
  open.clear();
});

async function fixture(
  connectLocal?: (host: string, port: number) => Socket,
  serviceOptions: { autoPong?: boolean } = {},
  log?: Pick<Console, 'info' | 'warn'>,
): Promise<{
  reserve: ReturnType<typeof createRemoteConnectorPool>['reserve'];
  recentStreams: ReturnType<typeof createRemoteConnectorPool>['recentStreams'];
  received: unknown[];
  peer: () => WebSocket;
  localConnections: () => number;
  localCloses: () => number;
}> {
  let localConnections = 0;
  let localCloses = 0;
  const local = createServer({ allowHalfOpen: true }, (socket) => {
    localConnections += 1;
    socket.on('close', () => (localCloses += 1));
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('end', () => socket.end());
  });
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
  open.add({ close: () => closeServer(local) });
  const address = local.address();
  if (!address || typeof address === 'string') throw new Error('no local address');
  const service = new WebSocketServer({ port: 0, host: '127.0.0.1', ...serviceOptions });
  await new Promise<void>((resolve) => service.once('listening', resolve));
  open.add({
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of service.clients) client.terminate();
        service.close(() => resolve());
      }),
  });
  const serviceAddress = service.address();
  if (!serviceAddress || typeof serviceAddress === 'string') throw new Error('no service address');
  const received: unknown[] = [];
  let peer: WebSocket | undefined;
  service.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (data) => {
      if (!Buffer.isBuffer(data)) throw new Error('unexpected test frame');
      received.push(JSON.parse(data.toString('utf8')));
    });
  });
  const pool = createRemoteConnectorPool({
    ...(log ? { log } : {}),
    dataUrl: 'wss://uplink.example/data',
    localHost: '127.0.0.1',
    localPort: address.port,
    webSocketFactory: () => new WebSocket(`ws://127.0.0.1:${serviceAddress.port}/data`),
    ...(connectLocal ? { connectLocal } : {}),
  });
  return {
    reserve: pool.reserve,
    recentStreams: pool.recentStreams,
    received,
    peer: () => {
      if (!peer) throw new Error('no peer');
      return peer;
    },
    localConnections: () => localConnections,
    localCloses: () => localCloses,
  };
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function reserve(
  f: Awaited<ReturnType<typeof fixture>>,
  sessionId = 'session_one',
): Promise<RemoteConnectorReservation> {
  const result = await f.reserve(
    { requestId: 'request_one', sessionId, decisionExpiresAt: Date.now() + 15_000 },
    new AbortController().signal,
  );
  if (typeof result === 'string') throw new Error(result);
  return result;
}

describe('remote control connector', () => {
  it('derives data attachment from the authenticated control origin', () => {
    expect(remoteDataUrlForControl('wss://uplink.example/control')).toBe(
      'wss://uplink.example/data',
    );
    expect(() => remoteDataUrlForControl('ws://uplink.example/control')).toThrow();
    expect(() => remoteDataUrlForControl('wss://uplink.example/control?target=other')).toThrow();
  });
  it('attaches a ticket before forwarding opaque bytes to the fixed local TLS ingress', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const f = await fixture(undefined, {}, log);
    const reservation = await reserve(f);
    const attached = reservation.attach(
      'installation_ticket',
      Date.now() + 30_000,
      new AbortController().signal,
    );
    await vi.waitFor(() =>
      expect(f.received).toEqual([{ type: 'attach', ticket: 'installation_ticket' }]),
    );
    expect(f.localConnections()).toBe(0);
    f.peer().send(
      JSON.stringify({
        type: 'attached',
        sessionId: 'session_one',
        capability: 'remote-control-v1',
      }),
    );
    await attached;
    f.peer().send(
      JSON.stringify({ type: 'stream.open', streamId: 'stream_one', channel: 'remote', meta: {} }),
    );
    f.peer().send(
      JSON.stringify({ type: 'stream.data', streamId: 'stream_one', seq: 0, payload: 'AQID' }),
    );
    f.peer().send(JSON.stringify({ type: 'stream.end', streamId: 'stream_one' }));
    await vi.waitFor(() =>
      expect(f.received).toContainEqual({
        type: 'stream.data',
        streamId: 'stream_one',
        seq: 0,
        payload: 'AQID',
      }),
    );
    await vi.waitFor(() =>
      expect(f.received).toContainEqual({ type: 'stream.end', streamId: 'stream_one' }),
    );
    expect(f.localConnections()).toBe(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'local_ingress',
        sessionId: 'session_one',
        streamId: 'stream_one',
        localPort: expect.any(Number),
      }),
      'remote connector reached local TLS ingress',
    );
    // A connected socket alone hides a one-way relay or a failed write.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: 'stream_one',
        reason: 'complete',
        receivedFromAppBytes: 3,
        writtenToLocalBytes: 3,
        receivedFromLocalBytes: 3,
        sentToUplinkBytes: 3,
      }),
      'remote connector stream ended',
    );
    expect(
      log.info.mock.calls.filter(([, message]) => message === 'remote connector first bytes'),
    ).toHaveLength(4);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('installation_ticket');
    // The phone's diagnostics screen reads this instead of the server log.
    expect(f.recentStreams()).toEqual([
      expect.objectContaining({
        sessionId: 'session_one',
        streamId: 'stream_o',
        receivedFromAppBytes: 3,
        writtenToLocalBytes: 3,
        receivedFromLocalBytes: 3,
        sentToUplinkBytes: 3,
        firstLocalReplyMs: expect.any(Number),
        state: 'complete',
      }),
    ]);
    expect(JSON.stringify(f.recentStreams())).not.toContain('installation_ticket');
    reservation.release('test complete');
  });

  it('lists a live stream that Core has not answered before any ended one', async () => {
    // An ingress that accepts the bytes and never answers.
    const swallowed: Socket[] = [];
    const silent = createServer({ allowHalfOpen: true }, (socket) => swallowed.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    open.add({
      close: () => {
        for (const socket of swallowed) socket.destroy();
        return closeServer(silent);
      },
    });
    const silentAddress = silent.address();
    if (!silentAddress || typeof silentAddress === 'string') throw new Error('no address');
    const f = await fixture(() =>
      createConnection({ host: '127.0.0.1', port: silentAddress.port, allowHalfOpen: true }),
    );
    const reservation = await reserve(f);
    const attached = reservation.attach(
      'ticket',
      Date.now() + 30_000,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.peer().send(
      JSON.stringify({
        type: 'attached',
        sessionId: 'session_one',
        capability: 'remote-control-v1',
      }),
    );
    await attached;
    f.peer().send(
      JSON.stringify({ type: 'stream.open', streamId: 'stalled_one', channel: 'remote', meta: {} }),
    );
    f.peer().send(
      JSON.stringify({ type: 'stream.data', streamId: 'stalled_one', seq: 0, payload: 'AQID' }),
    );
    await vi.waitFor(() =>
      expect(f.recentStreams()).toEqual([
        expect.objectContaining({
          streamId: 'stalled_',
          receivedFromAppBytes: 3,
          writtenToLocalBytes: 3,
          state: 'open',
        }),
      ]),
    );
    // A request the ingress swallowed shows as bytes in and nothing back.
    expect(f.recentStreams()[0]).toMatchObject({
      firstLocalReplyMs: null,
      receivedFromLocalBytes: 0,
    });
    reservation.release('test complete');
    await vi.waitFor(() => expect(f.recentStreams()[0]?.state).toBe('session_ended'));
  });

  it('bounds the stream list however many streams are live', async () => {
    const f = await fixture();
    const reservations: RemoteConnectorReservation[] = [];
    for (const sessionId of ['session_a', 'session_b', 'session_c']) {
      const reservation = await reserve(f, sessionId);
      const attached = reservation.attach(
        'ticket',
        Date.now() + 30_000,
        new AbortController().signal,
      );
      await vi.waitFor(() =>
        expect(
          f.received.filter((frame) => (frame as { type: string }).type === 'attach'),
        ).toHaveLength(reservations.length + 1),
      );
      f.peer().send(
        JSON.stringify({ type: 'attached', sessionId, capability: 'remote-control-v1' }),
      );
      await attached;
      for (let index = 0; index < 8; index += 1) {
        f.peer().send(
          JSON.stringify({
            type: 'stream.open',
            streamId: `${sessionId}_${String(index)}`,
            channel: 'remote',
            meta: {},
          }),
        );
      }
      reservations.push(reservation);
    }
    // 24 live streams; the app's schema admits at most 16 and would otherwise
    // drop the whole diagnostics response, status fields included.
    await vi.waitFor(() => expect(f.localConnections()).toBe(24));
    const listed = f.recentStreams();
    expect(listed).toHaveLength(8);
    expect(listed.every((record) => record.state === 'open')).toBe(true);
    // The stream the user just tested is the newest; the oldest sessions' streams go.
    expect(listed.map((record) => record.sessionId)).toEqual(Array(8).fill('session_c'));
    for (const reservation of reservations) reservation.release('test complete');
  });

  it('rejects data before the attachment barrier and never opens the local ingress', async () => {
    const f = await fixture();
    const reservation = await reserve(f);
    const attached = reservation.attach(
      'installation_ticket',
      Date.now() + 30_000,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.peer().send(
      JSON.stringify({ type: 'stream.open', streamId: 'stream_one', channel: 'remote', meta: {} }),
    );
    await expect(attached).rejects.toThrow('invalid remote frame');
    expect(f.localConnections()).toBe(0);
  });

  it('rejects an app-selected destination in stream metadata', async () => {
    const f = await fixture();
    const reservation = await reserve(f);
    const attached = reservation.attach(
      'installation_ticket',
      Date.now() + 30_000,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.peer().send(
      JSON.stringify({
        type: 'attached',
        sessionId: 'session_one',
        capability: 'remote-control-v1',
      }),
    );
    await attached;
    f.peer().send(
      JSON.stringify({
        type: 'stream.open',
        streamId: 'stream_one',
        channel: 'remote',
        meta: { host: 'elsewhere' },
      }),
    );
    await reservation.closed;
    expect(f.localConnections()).toBe(0);
  });

  it('keeps other streams alive when frames arrive after a local capacity reset', async () => {
    const f = await fixture();
    const reservation = await reserve(f);
    const attached = reservation.attach(
      'installation_ticket',
      Date.now() + 30_000,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.peer().send(
      JSON.stringify({
        type: 'attached',
        sessionId: 'session_one',
        capability: 'remote-control-v1',
      }),
    );
    await attached;
    for (let index = 0; index < 9; index += 1)
      f.peer().send(
        JSON.stringify({
          type: 'stream.open',
          streamId: `stream_${index}`,
          channel: 'remote',
          meta: {},
        }),
      );
    await vi.waitFor(() =>
      expect(f.received).toContainEqual({
        type: 'stream.reset',
        streamId: 'stream_8',
        code: 'concurrency_limit',
      }),
    );
    f.peer().send(
      JSON.stringify({ type: 'stream.data', streamId: 'stream_8', seq: 0, payload: 'AQID' }),
    );
    f.peer().send(
      JSON.stringify({ type: 'stream.data', streamId: 'stream_0', seq: 0, payload: 'AQID' }),
    );
    await vi.waitFor(() =>
      expect(f.received).toContainEqual({
        type: 'stream.data',
        streamId: 'stream_0',
        seq: 0,
        payload: 'AQID',
      }),
    );
    expect(f.peer().readyState).toBe(WebSocket.OPEN);
    reservation.release('test complete');
  });

  it('keeps the data socket alive when a retired peer-reset stream receives a late frame', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const f = await fixture(undefined, {}, log);
    const reservation = await reserve(f);
    const attached = reservation.attach(
      'installation_ticket',
      Date.now() + 30_000,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.peer().send(
      JSON.stringify({
        type: 'attached',
        sessionId: 'session_one',
        capability: 'remote-control-v1',
      }),
    );
    await attached;
    f.peer().send(
      JSON.stringify({ type: 'stream.open', streamId: 'stream_one', channel: 'remote', meta: {} }),
    );
    await vi.waitFor(() => expect(f.localConnections()).toBe(1));
    f.peer().send(
      JSON.stringify({ type: 'stream.reset', streamId: 'stream_one', code: 'upstream_error' }),
    );
    f.peer().send(JSON.stringify({ type: 'stream.end', streamId: 'stream_one' }));
    f.peer().send(
      JSON.stringify({ type: 'stream.reset', streamId: 'stream_one', code: 'protocol_error' }),
    );
    f.peer().send(
      JSON.stringify({ type: 'stream.open', streamId: 'stream_two', channel: 'remote', meta: {} }),
    );
    f.peer().send(
      JSON.stringify({ type: 'stream.data', streamId: 'stream_two', seq: 0, payload: 'AQID' }),
    );
    await vi.waitFor(() =>
      expect(f.received).toContainEqual({
        type: 'stream.data',
        streamId: 'stream_two',
        seq: 0,
        payload: 'AQID',
      }),
    );
    expect(f.peer().readyState).toBe(WebSocket.OPEN);
    expect(
      log.info.mock.calls.filter(([, message]) => message === 'remote connector stream ended'),
    ).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'peer_reset:upstream_error' }),
      'remote connector stream ended',
    );
    reservation.release('test complete');
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'stream_two', reason: 'session_ended' }),
      'remote connector stream ended',
    );
  });

  it('keeps the data socket alive when a reset follows both stream ends', async () => {
    const f = await fixture();
    const reservation = await reserve(f);
    const attached = reservation.attach(
      'installation_ticket',
      Date.now() + 30_000,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.peer().send(
      JSON.stringify({
        type: 'attached',
        sessionId: 'session_one',
        capability: 'remote-control-v1',
      }),
    );
    await attached;
    f.peer().send(
      JSON.stringify({ type: 'stream.open', streamId: 'stream_one', channel: 'remote', meta: {} }),
    );
    f.peer().send(JSON.stringify({ type: 'stream.end', streamId: 'stream_one' }));
    await vi.waitFor(() =>
      expect(f.received).toContainEqual({ type: 'stream.end', streamId: 'stream_one' }),
    );
    await vi.waitFor(() => expect(f.localCloses()).toBe(1));
    f.peer().send(
      JSON.stringify({ type: 'stream.reset', streamId: 'stream_one', code: 'upstream_error' }),
    );
    f.peer().send(
      JSON.stringify({ type: 'stream.open', streamId: 'stream_two', channel: 'remote', meta: {} }),
    );
    f.peer().send(
      JSON.stringify({ type: 'stream.data', streamId: 'stream_two', seq: 0, payload: 'AQID' }),
    );
    await vi.waitFor(() =>
      expect(f.received).toContainEqual({
        type: 'stream.data',
        streamId: 'stream_two',
        seq: 0,
        payload: 'AQID',
      }),
    );
    expect(f.peer().readyState).toBe(WebSocket.OPEN);
    reservation.release('test complete');
  });

  it('times out a blocked local write despite empty incoming frames', async () => {
    let writeStarted!: () => void;
    const wrote = new Promise<void>((resolve) => (writeStarted = resolve));
    const fakeSocket = Object.assign(new EventEmitter(), {
      write: vi.fn(() => {
        writeStarted();
        return false;
      }),
      end: vi.fn(),
      destroy: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      writableFinished: false,
      writableLength: 1,
    }) as unknown as Socket;
    const log = { info: vi.fn(), warn: vi.fn() };
    const f = await fixture(
      () => {
        queueMicrotask(() => fakeSocket.emit('connect'));
        return fakeSocket;
      },
      {},
      log,
    );
    const reservation = await reserve(f);
    const attached = reservation.attach(
      'installation_ticket',
      Date.now() + 30_000,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.peer().send(
      JSON.stringify({
        type: 'attached',
        sessionId: 'session_one',
        capability: 'remote-control-v1',
      }),
    );
    await attached;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    f.peer().send(
      JSON.stringify({ type: 'stream.open', streamId: 'stream_one', channel: 'remote', meta: {} }),
    );
    f.peer().send(
      JSON.stringify({ type: 'stream.data', streamId: 'stream_one', seq: 0, payload: 'AQID' }),
    );
    await wrote;
    await vi.advanceTimersByTimeAsync(15_000);
    f.peer().send(
      JSON.stringify({ type: 'stream.data', streamId: 'stream_one', seq: 1, payload: '' }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(15_001);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.received).toContainEqual({
      type: 'stream.reset',
      streamId: 'stream_one',
      code: 'timeout',
    });
    // Receiving a frame must not masquerade as a completed local socket write.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'local_reset:timeout',
        receivedFromAppBytes: 3,
        writtenToLocalBytes: 0,
        receivedFromLocalBytes: 0,
        sentToUplinkBytes: 0,
      }),
      'remote connector stream ended',
    );
    reservation.release('test complete');
  });

  it('ends an attached session whose data socket stops answering pings', async () => {
    // Without the heartbeat a half-open /data socket keeps its reservation
    // and local sockets forever now that attached sessions have no deadline.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true });
    const f = await fixture(undefined, { autoPong: false });
    const reservation = await reserve(f);
    const attached = reservation.attach(
      'installation_ticket',
      Date.now() + 30_000,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.peer().send(
      JSON.stringify({
        type: 'attached',
        sessionId: 'session_one',
        capability: 'remote-control-v1',
      }),
    );
    await attached;
    let closed = false;
    void reservation.closed!.then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await reservation.closed;
  });

  it('keeps an attached session whose data socket answers pings', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true });
    const f = await fixture();
    const reservation = await reserve(f);
    const attached = reservation.attach(
      'installation_ticket',
      Date.now() + 30_000,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.peer().send(
      JSON.stringify({
        type: 'attached',
        sessionId: 'session_one',
        capability: 'remote-control-v1',
      }),
    );
    await attached;
    let closed = false;
    void reservation.closed!.then(() => {
      closed = true;
    });
    for (let tick = 0; tick < 12; tick += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      // Real pong delivery over the loopback socket.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(closed).toBe(false);
    reservation.release('test complete');
  });

  it('bounds reservations and frees capacity on release', async () => {
    const f = await fixture();
    const reservations = await Promise.all(
      Array.from({ length: 4 }, (_, index) => reserve(f, `session_${index}`)),
    );
    expect(
      await f.reserve(
        { requestId: 'extra', sessionId: 'extra', decisionExpiresAt: Date.now() + 15_000 },
        new AbortController().signal,
      ),
    ).toBe('limit_reached');
    reservations[0]?.release('test release');
    expect(
      typeof (await f.reserve(
        { requestId: 'extra', sessionId: 'extra', decisionExpiresAt: Date.now() + 15_000 },
        new AbortController().signal,
      )),
    ).toBe('object');
    for (const reservation of reservations) reservation.release('test complete');
  });
});
