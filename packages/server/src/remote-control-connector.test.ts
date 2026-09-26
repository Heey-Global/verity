import { EventEmitter } from 'node:events';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
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

async function fixture(connectLocal?: (host: string, port: number) => Socket): Promise<{
  reserve: ReturnType<typeof createRemoteConnectorPool>['reserve'];
  received: unknown[];
  peer: () => WebSocket;
  localConnections: () => number;
}> {
  let localConnections = 0;
  const local = createServer({ allowHalfOpen: true }, (socket) => {
    localConnections += 1;
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('end', () => socket.end());
  });
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
  open.add({ close: () => closeServer(local) });
  const address = local.address();
  if (!address || typeof address === 'string') throw new Error('no local address');
  const service = new WebSocketServer({ port: 0, host: '127.0.0.1' });
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
    dataUrl: 'wss://uplink.example/data',
    localHost: '127.0.0.1',
    localPort: address.port,
    webSocketFactory: () => new WebSocket(`ws://127.0.0.1:${serviceAddress.port}/data`),
    ...(connectLocal ? { connectLocal } : {}),
  });
  return {
    reserve: pool.reserve,
    received,
    peer: () => {
      if (!peer) throw new Error('no peer');
      return peer;
    },
    localConnections: () => localConnections,
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
    const f = await fixture();
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
    reservation.release('test complete');
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
    const f = await fixture(() => {
      queueMicrotask(() => fakeSocket.emit('connect'));
      return fakeSocket;
    });
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
