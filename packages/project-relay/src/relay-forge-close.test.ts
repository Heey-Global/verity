import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { createBrokerRelayServer } from './relay.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'forge-close-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const sockets = new Set<Socket>();
  const servers: Server[] = [];
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
  };
  const upstream = createServer();
  servers.push(upstream);
  const socketPath = join(directory, 'broker.sock');
  await new Promise<void>((resolve) => upstream.listen(socketPath, resolve));
  let upstreamSocket: Socket | undefined;
  upstream.on('connect', (_request, socket) => {
    upstreamSocket = socket as Socket;
    track(upstreamSocket);
    socket.resume();
    socket.once('end', () => socket.end());
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  const relay = createBrokerRelayServer({ socketPath, forgeProxy: true });
  servers.push(relay);
  let downstreamSocket: Socket | undefined;
  relay.on('connection', (socket) => {
    downstreamSocket = socket;
    track(socket);
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const address = relay.address();
  if (!address || typeof address === 'string') throw new Error('Missing relay address');
  const client = await new Promise<Socket>((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'CONNECT',
      path: 'github.com:443',
    });
    outgoing.once('error', reject);
    outgoing.once('connect', (_response, socket) => {
      track(socket);
      resolve(socket);
    });
    outgoing.end();
  });
  if (!upstreamSocket || !downstreamSocket) throw new Error('Missing tunnel socket');
  return { client, upstream: upstreamSocket, downstream: downstreamSocket };
}

function receivedUntilClose(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('close', () => resolve(Buffer.concat(chunks)));
  });
}

// Clean upstream EOF must not discard TLS bytes already queued for the client.
it('drains queued downstream writes before closing a finished Forge tunnel', async () => {
  const h = await harness();
  const payload = Buffer.alloc(16 * 1024, 0x92);
  const received = receivedUntilClose(h.client);
  const write = h.downstream._write.bind(h.downstream);
  let release: (() => void) | undefined;
  // Hold an actual socket write in flight: unlike cork(), end() cannot flush it.
  const stalled = vi.spyOn(h.downstream, '_write').mockImplementation((chunk, encoding, done) => {
    release = () => {
      if (h.downstream.destroyed) done();
      else write(chunk, encoding, done);
    };
  });
  try {
    h.upstream.end(payload);
    await vi.waitFor(() => {
      expect(release).toBeDefined();
      expect(h.downstream.writableEnded).toBe(true);
    });
    release!();
    const response = await received;
    expect(response.length).toBe(payload.length);
    expect(response.equals(payload)).toBe(true);
  } finally {
    stalled.mockRestore();
  }
});

it('releases the upstream Forge tunnel when its client resets the connection', async () => {
  const h = await harness();
  const upstreamClosed = new Promise<void>((resolve) => h.upstream.once('close', resolve));
  h.client.resetAndDestroy();
  await upstreamClosed;
  expect(h.upstream.destroyed).toBe(true);
});

it('closes the client when the upstream Forge tunnel disappears', async () => {
  const h = await harness();
  const clientClosed = new Promise<void>((resolve) => h.client.once('close', resolve));
  h.client.resume();
  h.upstream.destroy();
  await clientClosed;
  await vi.waitFor(() => expect(h.downstream.destroyed).toBe(true));
});
