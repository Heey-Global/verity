import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { PreviewConnector, PreviewEdge, hashPreviewSecret } from './index.js';

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
  const target = createServer((request, response) => {
    expect(request.headers.cookie).toBe('app=session');
    response.writeHead(302, {
      location: `${targetOrigin}/next`,
      'set-cookie': ['app=new; Path=/; HttpOnly', 'other=value; Path=/'],
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
      headers: { cookie: 'app=session', host: `192.168.1.10:${port}` },
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/next');
    expect(response.headers.getSetCookie()).toEqual([
      'app=new; Path=/; HttpOnly',
      'other=value; Path=/',
    ]);
  } finally {
    await connector.close();
    await new Promise<void>((resolve, reject) =>
      target.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
