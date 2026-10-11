import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect as connectHttp2 } from 'node:http2';
import { connect as connectTls } from 'node:tls';
import { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { createProjectEgressCa, issueGatewayServerCertificate } from './claude-egress-ca.js';
import { createRemoteConnectorPool } from './remote-control-connector.js';
import { startManagedGateway } from './self-update/managed-gateway.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

it.each(['http/1.1', 'h2'])(
  'carries verified %s inner TLS through the remote connector to the managed Gateway',
  async (protocol) => {
    const backend = createServer((_request, response) => response.end('gateway-reached'));
    backend.listen(0, '127.0.0.1');
    await once(backend, 'listening');
    closers.push(() => new Promise<void>((resolve) => backend.close(() => resolve())));
    const backendAddress = backend.address();
    if (!backendAddress || typeof backendAddress === 'string') throw new Error('no backend port');

    const ca = await createProjectEgressCa({ commonName: 'Remote control test CA' });
    const certificate = await issueGatewayServerCertificate(ca, { serverName: 'core.test' });
    const log = vi.fn<(event: Record<string, string | number>) => void>();
    const gateway = await startManagedGateway({
      log,
      publicPort: 0,
      internalPort: 0,
      tls: { key: certificate.keyPem, cert: certificate.certPem },
      backend: {
        host: '127.0.0.1',
        publicPort: backendAddress.port,
        internalPort: backendAddress.port,
      },
      allowedBackendHosts: ['127.0.0.1'],
    });
    closers.push(() => gateway.close());

    const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(relay, 'listening');
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of relay.clients) client.terminate();
          relay.close(() => resolve());
        }),
    );
    const relayAddress = relay.address();
    if (!relayAddress || typeof relayAddress === 'string') throw new Error('no relay port');
    let peer: WebSocket | undefined;
    const received: Record<string, unknown>[] = [];
    relay.on('connection', (socket) => {
      peer = socket;
      socket.on('message', (data) => {
        if (!Buffer.isBuffer(data)) throw new Error('unexpected relay frame');
        received.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
      });
    });

    const pool = createRemoteConnectorPool({
      dataUrl: 'wss://uplink.example/data',
      localHost: '127.0.0.1',
      localPort: gateway.publicPort,
      webSocketFactory: () => new WebSocket(`ws://127.0.0.1:${relayAddress.port}/data`),
    });
    const reservation = await pool.reserve(
      {
        requestId: 'request_one',
        sessionId: 'session_one',
        decisionExpiresAt: Date.now() + 15_000,
      },
      new AbortController().signal,
    );
    if (typeof reservation === 'string') throw new Error(reservation);
    closers.push(async () => reservation.release('test complete'));
    const attached = reservation.attach(
      'installation_ticket',
      Date.now() + 30_000,
      new AbortController().signal,
    );
    await vi.waitFor(() =>
      expect(received).toContainEqual({ type: 'attach', ticket: 'installation_ticket' }),
    );
    peer!.send(
      JSON.stringify({
        type: 'attached',
        sessionId: 'session_one',
        capability: 'remote-control-v1',
      }),
    );
    await attached;

    let outgoingSeq = 0;
    const streamId = 'stream_one';
    const appSide = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        peer!.send(
          JSON.stringify({
            type: 'stream.data',
            streamId,
            seq: outgoingSeq++,
            payload: chunk.toString('base64'),
          }),
          callback,
        );
      },
    });
    closers.push(async () => {
      appSide.destroy();
    });
    peer!.on('message', (data) => {
      if (!Buffer.isBuffer(data)) return;
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (frame.type === 'stream.data' && frame.streamId === streamId)
        appSide.push(Buffer.from(frame.payload as string, 'base64'));
      if (frame.type === 'stream.end' && frame.streamId === streamId) appSide.push(null);
    });
    peer!.send(JSON.stringify({ type: 'stream.open', streamId, channel: 'remote', meta: {} }));

    const tls = connectTls({
      socket: appSide,
      servername: 'core.test',
      ca: ca.caCertPem,
      ALPNProtocols: [protocol],
    });
    closers.push(async () => {
      tls.destroy();
    });
    await once(tls, 'secureConnect');
    expect(tls.authorized).toBe(true);
    expect(tls.alpnProtocol).toBe(protocol);
    const chunks: Buffer[] = [];
    if (protocol === 'h2') {
      const session = connectHttp2('https://core.test', { createConnection: () => tls });
      closers.push(async () => {
        session.destroy();
      });
      const request = session.request({ ':path': '/healthz?private-query' });
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.end();
      await once(request, 'end');
      expect(Buffer.concat(chunks).toString('utf8')).toBe('gateway-reached');
    } else {
      tls.on('data', (chunk: Buffer) => chunks.push(chunk));
      tls.write(
        'GET /healthz?private-query HTTP/1.1\r\nHost: core.test\r\nConnection: close\r\n\r\n',
      );
      await vi.waitFor(() =>
        expect(Buffer.concat(chunks).toString('utf8')).toContain('gateway-reached'),
      );
    }
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'gateway.health_probe',
          action: 'completed',
          status: 200,
        }),
      ),
    );
    const events = log.mock.calls.map(([event]) => event);
    const secure = events.find(
      (event) => event.event === 'gateway.tls' && event.action === 'secure',
    );
    expect(secure).toBeDefined();
    expect(events.filter((event) => event.event === 'gateway.health_probe')).toEqual([
      expect.objectContaining({ action: 'received', connection: secure!.connection }),
      expect.objectContaining({ action: 'completed', connection: secure!.connection, status: 200 }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /private-query|core\.test|127\.0\.0\.1|installation_ticket/,
    );
  },
);

it('reports failed TLS without exposing peer data or OpenSSL error text', async () => {
  const ca = await createProjectEgressCa({ commonName: 'Remote control test CA' });
  const certificate = await issueGatewayServerCertificate(ca, { serverName: 'core.test' });
  const log = vi.fn<(event: Record<string, string | number>) => void>();
  const gateway = await startManagedGateway({
    log,
    tls: { key: certificate.keyPem, cert: certificate.certPem },
    publicPort: 0,
    internalPort: 0,
    backend: { host: '127.0.0.1', publicPort: 1, internalPort: 1 },
    allowedBackendHosts: ['127.0.0.1'],
  });
  closers.push(() => gateway.close());
  const { connect } = await import('node:net');
  const socket = connect(gateway.publicPort, '127.0.0.1');
  socket.on('error', () => undefined);
  closers.push(async () => {
    socket.destroy();
  });
  await once(socket, 'connect');
  const peerPort = socket.localPort;
  socket.write('GET /secret-path HTTP/1.1\r\nAuthorization: Bearer secret-value\r\n\r\n');
  await vi.waitFor(() =>
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'gateway.tls',
        action: 'failed',
        reason: 'plaintext_http',
        peerPort,
      }),
    ),
  );
  const events = log.mock.calls.map(([event]) => event);
  expect(events.some((event) => event.action === 'secure')).toBe(false);
  expect(JSON.stringify(events)).not.toMatch(/secret-path|secret-value|127\.0\.0\.1|SSL|HTTP/);
});
