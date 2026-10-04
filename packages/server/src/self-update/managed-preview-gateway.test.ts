import { createServer, get } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { startManagedGateway } from './managed-gateway.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function target(host: string, port = 0) {
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(`${host}:${req.headers.host}:${req.url}`);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (_req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n',
    );
    socket.pipe(socket);
  });
  server.listen(port, host);
  await once(server, 'listening');
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as { port: number }).port;
}
function request(port: number) {
  return new Promise<string>((resolve, reject) => {
    get(
      {
        agent: false,
        host: '127.0.0.1',
        port,
        path: '/api?x=1',
        headers: { host: `laptop.local:${port}` },
      },
      (response) => {
        try {
          expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
          expect(response.headers['x-content-type-options']).toBe('nosniff');
        } catch (error) {
          response.resume();
          reject(new Error('Preview response headers were not preserved', { cause: error }));
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve(body));
      },
    ).on('error', reject);
  });
}

it('routes local previews to the selected generation preserving HTTP origin and websocket bytes', async () => {
  const port = await target('127.0.0.2');
  await target('127.0.0.3', port);
  const gateway = await startManagedGateway({
    publicPort: 0,
    internalPort: 0,
    publicHost: '127.0.0.1',
    localPreviewPorts: [port],
    backend: { host: '127.0.0.2', publicPort: port, internalPort: port },
    allowedBackendHosts: ['127.0.0.2', '127.0.0.3'],
  });
  closers.push(() => gateway.close());
  expect(await request(port)).toBe(`127.0.0.2:laptop.local:${port}:/api?x=1`);
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  await once(socket, 'connect');
  socket.write(
    'GET /socket HTTP/1.1\r\nHost: laptop.local\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n',
  );
  expect(String((await once(socket, 'data'))[0])).toContain('101 Switching Protocols');
  socket.write('preview-ws-data');
  expect(String((await once(socket, 'data'))[0])).toBe('preview-ws-data');
  gateway.enterMaintenance();
  const active = gateway.status().upgradedConnections;
  expect(active).toBeGreaterThanOrEqual(1);
  expect(await gateway.drain(0)).toEqual({ forced: active });
  gateway.switchBackend({ host: '127.0.0.3', publicPort: port, internalPort: port });
  gateway.leaveMaintenance();
  expect(await request(port)).toBe(`127.0.0.3:laptop.local:${port}:/api?x=1`);
});

it('closes already opened listeners if a preview port is unavailable', async () => {
  const occupied = await target('127.0.0.1');
  await expect(
    startManagedGateway({
      publicPort: 0,
      internalPort: 0,
      localPreviewPorts: [occupied],
      backend: { host: '127.0.0.1', publicPort: occupied, internalPort: occupied },
      allowedBackendHosts: ['127.0.0.1'],
    }),
  ).rejects.toMatchObject({ code: 'EADDRINUSE' });
});
