import { once } from 'node:events';
import { createServer } from 'node:http';
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

it('carries verified inner TLS through the remote connector to the managed Gateway', async () => {
  const backend = createServer((_request, response) => response.end('gateway-reached'));
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  closers.push(() => new Promise<void>((resolve) => backend.close(() => resolve())));
  const backendAddress = backend.address();
  if (!backendAddress || typeof backendAddress === 'string') throw new Error('no backend port');

  const ca = await createProjectEgressCa({ commonName: 'Remote control test CA' });
  const certificate = await issueGatewayServerCertificate(ca, { serverName: 'core.test' });
  const gateway = await startManagedGateway({
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
    { requestId: 'request_one', sessionId: 'session_one', decisionExpiresAt: Date.now() + 15_000 },
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
    JSON.stringify({ type: 'attached', sessionId: 'session_one', capability: 'remote-control-v1' }),
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

  const tls = connectTls({ socket: appSide, servername: 'core.test', ca: ca.caCertPem });
  closers.push(async () => {
    tls.destroy();
  });
  await once(tls, 'secureConnect');
  expect(tls.authorized).toBe(true);
  const chunks: Buffer[] = [];
  tls.on('data', (chunk: Buffer) => chunks.push(chunk));
  tls.write('GET /remote-smoke HTTP/1.1\r\nHost: core.test\r\nConnection: close\r\n\r\n');
  await vi.waitFor(() =>
    expect(Buffer.concat(chunks).toString('utf8')).toContain('gateway-reached'),
  );
});
