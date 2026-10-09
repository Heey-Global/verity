import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import { PreviewConnector, PreviewEdge, hashPreviewSecret } from './index.js';

// A renamed Core cookie must remain isolated from applications on sibling ports.
const coreCookie = /BROWSER_SESSION_COOKIE = '([^']+)'/.exec(
  readFileSync(new URL('../../server/src/auth.ts', import.meta.url), 'utf8'),
)![1]!;
const edges: PreviewEdge[] = [];
afterEach(async () => {
  await Promise.all(edges.splice(0).map((edge) => edge.close()));
});

function localEdge() {
  const edge = new PreviewEdge({
    shareId: 'local-test',
    accessMode: 'local-open',
    pinHash: `scrypt:${'a'.repeat(32)}:${'a'.repeat(64)}`,
    connectorTokenHash: hashPreviewSecret('connector'),
    sessionSecretHash: hashPreviewSecret('session'),
    publicOrigin: 'http://localhost:8100',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  edges.push(edge);
  return edge;
}

it('identifies the local edge without a PIN, cookie or connector', async () => {
  const port = await localEdge().listen(0, '127.0.0.1');
  const response = await fetch(`http://127.0.0.1:${port}/__verity/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ shareId: 'local-test' });
});

it('does not redirect local API requests to the public PIN page', async () => {
  const port = await localEdge().listen(0, '127.0.0.1');
  const response = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    redirect: 'manual',
  });
  expect(response.status).toBe(503);
  expect(response.headers.get('location')).toBeNull();
});

it('preserves target cookies and makes absolute target redirects relative for LAN clients', async () => {
  let targetOrigin = '';
  const receivedCookies: Array<string | undefined> = [];
  const cookies = [
    'app=new; Path=/; HttpOnly',
    'other=value; Path=/',
    ...Array.from(
      { length: 3 },
      (_, index) => `chunk${index}=${'a'.repeat(3500)}; Path=/; HttpOnly`,
    ),
  ];
  const target = createServer((request, response) => {
    receivedCookies.push(request.headers.cookie);
    if (request.url === '/chunked') {
      response.end('ok');
      return;
    }
    response.writeHead(302, {
      location: `${targetOrigin}/next`,
      'set-cookie': [
        ...cookies,
        `${coreCookie}=forged; Path=/; Secure; HttpOnly`,
        `${coreCookie}=; Path=/; Max-Age=0`,
      ],
    });
    response.end();
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  targetOrigin = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
  const port = await localEdge().listen(0, '127.0.0.1');
  const connector = new PreviewConnector({
    accessMode: 'local-open',
    edgeUrl: `ws://127.0.0.1:${port}/__verity/connector`,
    connectorToken: 'connector',
    targetOrigin,
  });
  try {
    await connector.connect();
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        cookie: `${coreCookie}=private; app=session; ${coreCookie}=duplicate`,
        host: `192.168.1.10:${port}`,
      },
      redirect: 'manual',
    });
    expect(receivedCookies[0]).toBe('app=session');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/next');
    expect(response.headers.getSetCookie()).toEqual(cookies);
    const next = await fetch(`http://127.0.0.1:${port}/chunked`, {
      headers: { cookie: cookies.map((cookie) => cookie.split(';')[0]).join('; ') },
    });
    expect(await next.text()).toBe('ok');
    expect(receivedCookies[1]).toBe(cookies.map((cookie) => cookie.split(';')[0]).join('; '));
    const onlyCore = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { cookie: `${coreCookie}=private` },
      redirect: 'manual',
    });
    expect(onlyCore.status).toBe(302);
    expect(receivedCookies[2]).toBeUndefined();
  } finally {
    connector.close();
    await new Promise<void>((resolve, reject) =>
      target.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

// Docker DNS names must pass startup validation before the connector can dial the local edge.
it('allows Docker edge addresses only for the explicit local mode', () => {
  const options = {
    edgeUrl: 'ws://verity-server:8100/__verity/connector',
    connectorToken: 'connector',
    targetOrigin: 'http://project-sandbox:3033',
  };
  expect(() => new PreviewConnector({ ...options, accessMode: 'local-open' })).not.toThrow();
  expect(() => new PreviewConnector(options)).toThrow('must use wss');
  expect(() => new PreviewConnector({ ...options, accessMode: 'pin' })).toThrow('must use wss');
});

it('does not forward Core login cookies in local WebSocket handshakes', async () => {
  const target = createServer();
  const sockets = new WebSocketServer({ server: target });
  sockets.on('connection', (socket, request) => {
    socket.send(request.headers.cookie ?? 'none');
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetPort = (target.address() as { port: number }).port;
  const port = await localEdge().listen(0, '127.0.0.1');
  const connector = new PreviewConnector({
    accessMode: 'local-open',
    edgeUrl: `ws://127.0.0.1:${port}/__verity/connector`,
    connectorToken: 'connector',
    targetOrigin: `http://127.0.0.1:${targetPort}`,
  });
  try {
    await connector.connect();
    for (const [cookie, expected] of [
      [`app=session; ${coreCookie}=private`, 'app=session'],
      [`${coreCookie}=private`, 'none'],
    ]) {
      const client = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { cookie } });
      try {
        const message = await new Promise<string>((resolve, reject) => {
          client.once('message', (data) =>
            resolve(
              (Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.from(data as ArrayBuffer)
              ).toString(),
            ),
          );
          client.once('error', reject);
        });
        expect(message).toBe(expected);
      } finally {
        client.terminate();
      }
    }
  } finally {
    connector.close();
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      target.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
