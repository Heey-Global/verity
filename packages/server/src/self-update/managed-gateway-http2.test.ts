import { once } from 'node:events';
import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
  type RequestListener,
} from 'node:http';
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createProjectEgressCa, issueGatewayServerCertificate } from '../claude-egress-ca.js';
import { verifyManagedBrowserOrigin } from '../managed-browser-origin.js';
import { startManagedGateway, type ManagedGatewayRuntime } from './managed-gateway.js';

const closers: (() => Promise<void>)[] = [];
let tls: { key: string; cert: string };
let ca: string;
beforeAll(async () => {
  const authority = await createProjectEgressCa({ commonName: 'HTTP2 gateway test CA' });
  const certificate = await issueGatewayServerCertificate(authority, { serverName: 'core.local' });
  tls = { key: certificate.keyPem, cert: certificate.certPem };
  ca = authority.caCertPem;
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function setup(
  handler: RequestListener,
  timeout = 1_000,
): Promise<{
  runtime: ManagedGatewayRuntime;
  session: ClientHttp2Session;
  port: number;
  backend: ReturnType<typeof createServer>;
}> {
  const backend = createServer(handler);
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const port = (backend.address() as { port: number }).port;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        backend.closeAllConnections();
        backend.close(() => resolve());
      }),
  );
  const runtime = await startManagedGateway({
    publicPort: 0,
    internalPort: 0,
    tls,
    backend: { host: '127.0.0.1', publicPort: port, internalPort: port },
    allowedBackendHosts: ['127.0.0.1'],
    requestTimeoutMs: timeout,
    clientIdentitySecret: Buffer.alloc(32, 9),
  });
  closers.push(() => runtime.close());
  const session = connect(`https://127.0.0.1:${runtime.publicPort}`, {
    ca,
    servername: 'core.local',
  });
  session.on('error', () => undefined);
  await Promise.all([once(session, 'connect'), once(session, 'remoteSettings')]);
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        if (session.closed || session.destroyed) return resolve();
        session.once('close', resolve);
        session.destroy();
      }),
  );
  return { runtime, session, port, backend };
}

function read(session: ClientHttp2Session, path: string, headers: Record<string, string> = {}) {
  const stream = session.request({ ':path': path, ...headers });
  const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
    let status = 0;
    const chunks: Buffer[] = [];
    stream.once('response', (response) => {
      status = Number(response[':status']);
    });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve({ status, body: Buffer.concat(chunks).toString() }));
  });
  stream.end();
  return { stream, result };
}

describe('public gateway HTTP/2', () => {
  it('negotiates h2 with bounded settings and preserves automatic HTTP/1.1 fallback', async () => {
    const { runtime, session } = await setup((_request, response) => response.end('ok'));
    expect(session.alpnProtocol).toBe('h2');
    expect(session.remoteSettings.maxConcurrentStreams).toBe(16);
    expect(session.remoteSettings.maxHeaderListSize).toBe(16 * 1024);
    expect(session.remoteSettings.enableConnectProtocol).not.toBe(true);
    expect(await read(session, '/').result).toEqual({ status: 200, body: 'ok' });
    const response = await new Promise<string>((resolve, reject) => {
      httpsRequest(
        {
          host: '127.0.0.1',
          port: runtime.publicPort,
          ca,
          servername: 'core.local',
        },
        (incoming) => {
          expect(incoming.httpVersion).toBe('1.1');
          incoming.setEncoding('utf8');
          let body = '';
          incoming.on('data', (chunk: string) => {
            body += chunk;
          });
          incoming.once('end', () => resolve(body));
        },
      )
        .once('error', reject)
        .end();
    });
    expect(response).toBe('ok');
  });

  it('completes a fast stream while more than four slow reads remain held', async () => {
    const held: ServerResponse[] = [];
    let admitted!: () => void;
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const { session } = await setup((request, response) => {
      if (request.url === '/fast') return response.end('fast');
      held.push(response);
      if (held.length === 6) admitted();
    });
    const slow = Array.from({ length: 6 }, (_, index) => read(session, `/slow/${index}`));
    await ready;
    expect(await read(session, '/fast').result).toEqual({ status: 200, body: 'fast' });
    expect(held.every((response) => !response.writableEnded)).toBe(true);
    for (const response of held) response.end('slow');
    expect(await Promise.all(slow.map((item) => item.result))).toHaveLength(6);
  });

  it('signs authority before backend rewriting and rejects an inconsistent Host', async () => {
    let received: IncomingHttpHeaders | undefined;
    const { session, port } = await setup((request, response) => {
      received = request.headers;
      response.setHeader('connection', 'close');
      response.end('ok');
    });
    const result = await read(session, '/identity', {
      ':authority': 'core.local:9443',
      'x-verity-managed-client': 'spoofed',
      'x-verity-managed-browser-origin': 'spoofed',
      'x-forwarded-host': 'evil.local',
    }).result;
    expect(result.status).toBe(200);
    expect(received?.host).toBe(`127.0.0.1:${port}`);
    expect(Object.keys(received ?? {}).some((key) => key.startsWith(':'))).toBe(false);
    expect(received?.['x-verity-managed-client']).not.toBe('spoofed');
    expect(
      verifyManagedBrowserOrigin(
        Buffer.alloc(32, 9),
        received?.['x-verity-managed-browser-origin'],
        { method: 'GET', url: '/identity' },
      ),
    ).toBe('https://core.local:9443');
    expect(
      (await read(session, '/', { ':authority': 'core.local', host: 'evil.local' }).result).status,
    ).toBe(400);
  });

  it('cancels one upstream on reset without closing its sibling stream', async () => {
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { session } = await setup((request, response) => {
      if (request.url !== '/held') return response.end('sibling');
      response.once('close', cancelled);
      response.write('first');
      started();
    });
    const held = read(session, '/held');
    await start;
    held.stream.close(constants.NGHTTP2_CANCEL);
    await cancellation;
    expect(await read(session, '/sibling').result).toEqual({ status: 200, body: 'sibling' });
    expect(session.destroyed).toBe(false);
  });

  it('streams request and response bodies without buffering until upload completion', async () => {
    const { session } = await setup((request, response) => request.pipe(response));
    const stream = session.request({ ':path': '/echo', ':method': 'POST' });
    const first = once(stream, 'data');
    stream.write('first');
    expect(String((await first)[0])).toBe('first');
    const remaining: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => remaining.push(chunk));
    const ended = once(stream, 'end');
    stream.end('last');
    await ended;
    expect(Buffer.concat(remaining).toString()).toBe('last');
  });

  it('rejects unsupported CONNECT while keeping ordinary streams usable', async () => {
    const { session } = await setup((_request, response) => response.end('ok'));
    const stream = session.request({ ':method': 'CONNECT', ':authority': 'core.local:443' });
    const response = once(stream, 'response');
    stream.resume();
    stream.end();
    expect(Number((await response)[0][':status'])).toBeGreaterThanOrEqual(400);
    expect((await read(session, '/').result).status).toBe(200);
  });

  it('serves protocol-valid maintenance and reuses an idle session after backend switching', async () => {
    const { runtime, session } = await setup((_request, response) => response.end('ok'));
    const replacement = await setup((_request, response) => response.end('replacement'));
    expect((await read(session, '/').result).status).toBe(200);
    runtime.enterMaintenance();
    expect((await read(session, '/').result).status).toBe(503);
    await runtime.drain(100);
    runtime.switchBackend({
      host: '127.0.0.1',
      publicPort: replacement.port,
      internalPort: replacement.port,
    });
    runtime.leaveMaintenance();
    expect(await read(session, '/').result).toEqual({ status: 200, body: 'replacement' });
  });

  it('returns upstream timeout errors without losing the multiplexed session', async () => {
    const { session } = await setup((request, response) => {
      if (request.url !== '/timeout') response.end('ok');
    }, 50);
    expect((await read(session, '/timeout').result).status).toBe(502);
    expect((await read(session, '/').result).status).toBe(200);
  });

  it('cancels admitted work at the drain deadline while retaining the session', async () => {
    let admitted!: () => void;
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const { runtime, session } = await setup((request, response) => {
      if (request.url !== '/held') return response.end('ok');
      response.write('started');
      admitted();
    });
    const held = read(session, '/held');
    await ready;
    const closed = once(held.stream, 'close');
    runtime.enterMaintenance();
    expect((await runtime.drain(0)).forced).toBeGreaterThan(0);
    await closed;
    runtime.leaveMaintenance();
    expect((await read(session, '/').result).status).toBe(200);
  });

  it('preserves classic upgrades over negotiated HTTP/1.1 on the TLS listener', async () => {
    const { runtime, backend } = await setup((_request, response) => response.end('ok'));
    backend.on('upgrade', (_request, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
      socket.pipe(socket);
    });
    const socket = tlsConnect({
      host: '127.0.0.1',
      port: runtime.publicPort,
      ca,
      servername: 'core.local',
      ALPNProtocols: ['http/1.1'],
    });
    socket.on('error', () => undefined);
    await once(socket, 'secureConnect');
    expect(socket.alpnProtocol).toBe('http/1.1');
    const response = once(socket, 'data');
    socket.write(
      'GET /socket HTTP/1.1\r\nHost: core.local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
    expect(String((await response)[0])).toContain('101 Switching Protocols');
    const echoed = once(socket, 'data');
    socket.write('echo');
    expect(String((await echoed)[0])).toBe('echo');
    socket.destroy();
  });
});
