import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  startProjectClaudeUnixListener,
  type ProjectClaudeUnixListener,
} from './project-claude-unix-listener.js';

const UID = process.getuid?.() ?? 0;
const GID = process.getgid?.() ?? 0;
const identity = { projectId: 'p1', containerGeneration: 'generation-1' };

let gateway: Server | undefined;
const gatewaySockets = new Set<Socket>();
let listener: ProjectClaudeUnixListener | undefined;
let root: string | undefined;

afterEach(async () => {
  await listener?.close().catch(() => undefined);
  listener = undefined;
  if (gateway !== undefined) {
    for (const socket of gatewaySockets) socket.destroy();
    gatewaySockets.clear();
    await new Promise<void>((resolve) => gateway!.close(() => resolve()));
    gateway = undefined;
  }
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function echoGateway(): Promise<number> {
  gateway = createServer((socket) => socket.pipe(socket));
  trackGatewaySockets(gateway);
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const address = gateway.address();
  if (address === null || typeof address === 'string') throw new Error('missing gateway address');
  return address.port;
}

function trackGatewaySockets(server: Server): void {
  server.on('connection', (socket) => {
    gatewaySockets.add(socket);
    socket.once('close', () => gatewaySockets.delete(socket));
  });
}

/**
 * Wait for `event` on a client socket the listener is expected to tear down.
 *
 * Not `events.once`: that helper attaches its OWN 'error' listener and rejects the
 * returned promise with it. Every wait below is on a socket the listener kills with
 * `destroy()`, which RSTs the peer, so the client can emit `ECONNRESET` a tick
 * BEFORE 'close' — the expected outcome of an abrupt close, yet it rejected the
 * wait with a bare `read ECONNRESET`. The ordering is load-dependent, so it only
 * ever lost the race on a busy CI runner. A per-socket `on('error')` handler does
 * NOT help: `events.once` rejects off its own listener regardless.
 *
 * Closing before the awaited event still fails, but with a message that names the
 * event instead of surfacing the reset, and without hanging until the test timeout.
 */
function waitForEvent(socket: Socket, event: 'close' | 'connect' | 'data'): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(event, () => resolve());
    if (event !== 'close') {
      socket.once('close', () => reject(new Error(`socket closed before '${event}'`)));
    }
  });
}

function socketCall(path: string, body: string): Promise<{ body: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path }, () => socket.write(body));
    socket.once('data', (chunk: Buffer) => resolve({ body: chunk.toString(), socket }));
    socket.once('error', reject);
  });
}

describe('project Claude Unix listener', () => {
  it('byte-forwards to only the configured gateway and applies relay-only permissions', async () => {
    const port = await echoGateway();
    root = mkdtempSync(join(tmpdir(), 'verity-claude-uds-'));
    listener = await startProjectClaudeUnixListener({
      socketRoot: root,
      identity,
      ownerUid: UID,
      relayGid: GID,
      gatewayHost: '127.0.0.1',
      gatewayPort: port,
    });
    const result = await socketCall(listener.socketPath, 'opaque-mtls-record');
    result.socket.destroy();
    expect(result.body).toBe('opaque-mtls-record');
    expect(statSync(listener.socketPath).mode & 0o777).toBe(0o660);
    expect(statSync(listener.socketPath)).toMatchObject({ uid: UID, gid: GID });
  });

  it('preserves the upstream response after the downstream half-closes', async () => {
    gateway = createServer({ allowHalfOpen: true }, (socket) => {
      socket.once('end', () => socket.end('response-after-fin'));
      socket.resume();
    });
    trackGatewaySockets(gateway);
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    if (address === null || typeof address === 'string') throw new Error('missing gateway address');
    root = mkdtempSync(join(tmpdir(), 'verity-claude-uds-half-close-'));
    listener = await startProjectClaudeUnixListener({
      socketRoot: root,
      identity,
      ownerUid: UID,
      relayGid: GID,
      gatewayHost: '127.0.0.1',
      gatewayPort: address.port,
    });

    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = createConnection({ path: listener!.socketPath, allowHalfOpen: true }, () => {
        socket.end('request-before-fin');
      });
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('end', () => resolve(Buffer.concat(chunks).toString()));
      socket.once('error', reject);
    });
    expect(body).toBe('response-after-fin');
  });

  it('continues forwarding downstream bytes after the upstream half-closes', async () => {
    let gatewayBody = '';
    gateway = createServer({ allowHalfOpen: true }, (socket) => {
      socket.on('data', (chunk: Buffer) => {
        gatewayBody += chunk.toString();
      });
      socket.end('upstream-fin');
    });
    trackGatewaySockets(gateway);
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    if (address === null || typeof address === 'string') throw new Error('missing gateway address');
    root = mkdtempSync(join(tmpdir(), 'verity-claude-uds-reverse-half-close-'));
    listener = await startProjectClaudeUnixListener({
      socketRoot: root,
      identity,
      ownerUid: UID,
      relayGid: GID,
      gatewayHost: '127.0.0.1',
      gatewayPort: address.port,
    });

    const response = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = createConnection({ path: listener!.socketPath, allowHalfOpen: true });
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('end', () => {
        socket.end('bytes-after-upstream-fin');
        resolve(Buffer.concat(chunks).toString());
      });
      socket.once('error', reject);
    });
    await vi.waitFor(() => expect(gatewayBody).toBe('bytes-after-upstream-fin'));
    expect(response).toBe('upstream-fin');
  });

  it('refuses a second listener for the same active project generation', async () => {
    const port = await echoGateway();
    root = mkdtempSync(join(tmpdir(), 'verity-claude-uds-active-'));
    const options = {
      socketRoot: root,
      identity,
      ownerUid: UID,
      relayGid: GID,
      gatewayHost: '127.0.0.1',
      gatewayPort: port,
    };
    listener = await startProjectClaudeUnixListener(options);
    await expect(startProjectClaudeUnixListener(options)).rejects.toThrow('already active');
  });

  it('refuses an untrusted root and a hostile socket path', async () => {
    const port = await echoGateway();
    root = mkdtempSync(join(tmpdir(), 'verity-claude-uds-hostile-'));
    chmodSync(root, 0o777);
    await expect(
      startProjectClaudeUnixListener({
        socketRoot: root,
        identity,
        ownerUid: UID,
        relayGid: GID,
        gatewayHost: '127.0.0.1',
        gatewayPort: port,
      }),
    ).rejects.toThrow('trusted socket root');

    chmodSync(root, 0o700);
    listener = await startProjectClaudeUnixListener({
      socketRoot: root,
      identity,
      ownerUid: UID,
      relayGid: GID,
      gatewayHost: '127.0.0.1',
      gatewayPort: port,
    });
    const socketPath = listener.socketPath;
    await listener.close();
    listener = undefined;
    writeFileSync(socketPath, 'hostile');
    await expect(
      startProjectClaudeUnixListener({
        socketRoot: root,
        identity,
        ownerUid: UID,
        relayGid: GID,
        gatewayHost: '127.0.0.1',
        gatewayPort: port,
      }),
    ).rejects.toThrow('non-socket path');
  });

  it('destroys held downstream connections during teardown', async () => {
    const port = await echoGateway();
    root = mkdtempSync(join(tmpdir(), 'verity-claude-uds-close-'));
    listener = await startProjectClaudeUnixListener({
      socketRoot: root,
      identity,
      ownerUid: UID,
      relayGid: GID,
      gatewayHost: '127.0.0.1',
      gatewayPort: port,
    });
    const result = await socketCall(listener.socketPath, 'held');
    const closed = waitForEvent(result.socket, 'close');
    await listener.close();
    listener = undefined;
    await closed;
    expect(result.socket.destroyed).toBe(true);
  });

  it('rejects connections above the project limit without opening another upstream', async () => {
    const port = await echoGateway();
    let upstreamConnections = 0;
    gateway!.on('connection', () => {
      upstreamConnections += 1;
    });
    root = mkdtempSync(join(tmpdir(), 'verity-claude-uds-limit-'));
    listener = await startProjectClaudeUnixListener({
      socketRoot: root,
      identity,
      ownerUid: UID,
      relayGid: GID,
      gatewayHost: '127.0.0.1',
      gatewayPort: port,
      maxConnections: 1,
    });
    const first = await socketCall(listener.socketPath, 'first');
    const second = createConnection({ path: listener.socketPath });
    second.on('error', () => undefined);
    const secondClosed = waitForEvent(second, 'close');
    await secondClosed;
    expect(upstreamConnections).toBe(1);
    first.socket.destroy();
  });

  it('closes the downstream when the fixed upstream refuses the connection', async () => {
    gateway = createServer();
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    if (address === null || typeof address === 'string') throw new Error('missing gateway address');
    const refusedPort = address.port;
    gateway.close();
    await once(gateway, 'close');
    gateway = undefined;

    root = mkdtempSync(join(tmpdir(), 'verity-claude-uds-refused-'));
    listener = await startProjectClaudeUnixListener({
      socketRoot: root,
      identity,
      ownerUid: UID,
      relayGid: GID,
      gatewayHost: '127.0.0.1',
      gatewayPort: refusedPort,
    });
    const downstream = createConnection({ path: listener.socketPath });
    downstream.on('error', () => undefined);
    await waitForEvent(downstream, 'close');
    expect(downstream.destroyed).toBe(true);
  });

  it('times out a connection that opens but never carries application bytes', async () => {
    gateway = createServer({ allowHalfOpen: true });
    trackGatewaySockets(gateway);
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    if (address === null || typeof address === 'string') throw new Error('missing gateway address');
    root = mkdtempSync(join(tmpdir(), 'verity-claude-uds-idle-'));
    listener = await startProjectClaudeUnixListener({
      socketRoot: root,
      identity,
      ownerUid: UID,
      relayGid: GID,
      gatewayHost: '127.0.0.1',
      gatewayPort: address.port,
      idleTimeoutMs: 20,
    });

    const downstream = createConnection({ path: listener.socketPath });
    downstream.on('error', () => undefined);
    await waitForEvent(downstream, 'connect');
    await waitForEvent(downstream, 'close');
    expect(downstream.destroyed).toBe(true);
  });

  // A model is silent for long stretches by nature — a slow first token, a large
  // context, a tool call computed upstream. Killing the pair on that silence
  // surfaced as "502 upstream unavailable" before the first byte and "connection
  // closed mid-response" during the stream. Once a byte has crossed, the peer has
  // proven itself and the stream may go quiet for as long as it needs.
  it('keeps a stream alive through a silence longer than the idle timeout', async () => {
    gateway = createServer((socket) => {
      socket.on('data', () => socket.write('first'));
    });
    trackGatewaySockets(gateway);
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    if (address === null || typeof address === 'string') throw new Error('missing gateway address');
    root = mkdtempSync(join(tmpdir(), 'verity-claude-uds-quiet-'));
    listener = await startProjectClaudeUnixListener({
      socketRoot: root,
      identity,
      ownerUid: UID,
      relayGid: GID,
      gatewayHost: '127.0.0.1',
      gatewayPort: address.port,
      idleTimeoutMs: 20,
    });

    const downstream = createConnection({ path: listener.socketPath });
    downstream.on('error', () => undefined);
    downstream.write('hello');
    await waitForEvent(downstream, 'data');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(downstream.destroyed).toBe(false);
    downstream.destroy();
  });

  it('times out when downstream traffic arrives but the gateway never connects', async () => {
    const stalled = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    }) as unknown as Socket;
    root = mkdtempSync(join(tmpdir(), 'verity-claude-uds-stalled-upstream-'));
    listener = await startProjectClaudeUnixListener({
      socketRoot: root,
      identity,
      ownerUid: UID,
      relayGid: GID,
      gatewayHost: '127.0.0.1',
      gatewayPort: 1,
      idleTimeoutMs: 20,
      upstreamFactory: () => stalled,
    });

    const downstream = createConnection({ path: listener.socketPath });
    downstream.on('error', () => undefined);
    await waitForEvent(downstream, 'connect');
    const closed = waitForEvent(downstream, 'close');
    downstream.write('hello');
    await new Promise((resolve) => setTimeout(resolve, 10));
    downstream.write('again');
    await closed;
    expect(downstream.destroyed).toBe(true);
  });

  it('fails closed on a post-listen server error and remains safe to close', async () => {
    const port = await echoGateway();
    root = mkdtempSync(join(tmpdir(), 'verity-claude-uds-runtime-error-'));
    let transport: Server | undefined;
    const onRuntimeError = vi.fn();
    listener = await startProjectClaudeUnixListener({
      socketRoot: root,
      identity,
      ownerUid: UID,
      relayGid: GID,
      gatewayHost: '127.0.0.1',
      gatewayPort: port,
      onRuntimeError,
      serverFactory: (accept) => {
        transport = createServer({ allowHalfOpen: true }, accept);
        return transport;
      },
    });
    const held = await socketCall(listener.socketPath, 'held');
    const heldClosed = waitForEvent(held.socket, 'close');
    const transportClosed = new Promise<void>((resolve) => transport!.once('close', resolve));
    const failure = new Error('injected runtime failure');

    transport!.emit('error', failure);
    await Promise.all([heldClosed, transportClosed]);
    expect(onRuntimeError).toHaveBeenCalledOnce();
    expect(onRuntimeError).toHaveBeenCalledWith(failure);
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = createConnection({ path: listener!.socketPath });
        socket.once('connect', () => reject(new Error('listener accepted after runtime failure')));
        socket.once('error', () => resolve());
      }),
    ).resolves.toBeUndefined();
    await expect(listener.close()).resolves.toBeUndefined();
    listener = undefined;
  });
});
