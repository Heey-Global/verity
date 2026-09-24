// Test-only byte relay: no production admission, routing, or entitlement protocol.
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import https from 'node:https';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, createWebSocketStream } from 'ws';

/** @param {{ key: Buffer, cert: Buffer }} options */
export async function startFixture({ key, cert }) {
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  const stats = { tunnels: 0, bytes: 0, captured: Buffer.alloc(0) };
  /** @param {net.Socket} socket */
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const core = https.createServer({ key, cert }, (req, res) => {
    if (req.url === '/slow') return;
    if (req.method === 'POST' && req.url === '/echo') {
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        if (!Buffer.isBuffer(chunk)) return req.destroy();
        size += chunk.length;
        if (size > 256 * 1024) req.destroy();
        else chunks.push(chunk);
      });
      req.on('end', () => res.end(Buffer.concat(chunks)));
      return;
    }
    res.end('core-ok');
  });
  core.on('connection', track);
  core.on('clientError', (_error, socket) => socket.destroy());
  const echo = new WebSocketServer({ server: core, path: '/socket', maxPayload: 256 * 1024 });
  echo.on('connection', (ws) => {
    ws.on('error', () => {});
    ws.on('message', (data, binary) => ws.send(data, { binary }));
  });
  /** @param {https.Server} server @returns {Promise<number>} */
  const listen = (server) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string')
          return reject(new Error('Missing TCP address'));
        resolve(address.port);
      });
    });
  const corePort = await listen(core);
  const relay = https.createServer({ key, cert }, (_req, res) => {
    res.writeHead(404).end();
  });
  relay.on('connection', track);
  relay.on('clientError', (_error, socket) => socket.destroy());
  const tunnels = new WebSocketServer({ server: relay, path: '/tunnel', maxPayload: 64 * 1024 });
  tunnels.on('connection', (ws) => {
    stats.tunnels++;
    const target = track(net.connect({ host: '127.0.0.1', port: corePort }));
    const stream = createWebSocketStream(ws);
    const timeout = setTimeout(() => target.destroy(new Error('connect timeout')), 3000);
    target.once('connect', () => clearTimeout(timeout));
    const cleanup = () => {
      clearTimeout(timeout);
      target.destroy();
      stream.destroy();
      ws.terminate();
    };
    target.on('error', cleanup);
    stream.on('error', cleanup);
    ws.on('error', cleanup);
    target.on('close', cleanup);
    ws.on('close', cleanup);
    ws.prependListener('message', (data, binary) => {
      if (!binary || !Buffer.isBuffer(data)) return cleanup();
      stats.bytes += data.length;
      const room = 128 * 1024 - stats.captured.length;
      if (room > 0) stats.captured = Buffer.concat([stats.captured, data.subarray(0, room)]);
    });
    // Streams propagate backpressure; TCP reads are at most 64 KiB per chunk.
    stream.pipe(target).pipe(stream);
  });
  const relayPort = await listen(relay);
  return {
    corePort,
    relayPort,
    stats,
    async close() {
      for (const ws of tunnels.clients) ws.terminate();
      for (const ws of echo.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [core, relay].map((server) => new Promise((resolve) => server.close(resolve))),
      );
      tunnels.close();
      echo.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [keyPath, certPath] = process.argv.slice(2);
  if (!keyPath || !certPath) throw new Error('Usage: mock.mjs key.pem cert.pem');
  const fixture = await startFixture({
    key: await readFile(keyPath),
    cert: await readFile(certPath),
  });
  process.stdout.write(
    `${JSON.stringify({ corePort: fixture.corePort, relayPort: fixture.relayPort })}\n`,
  );
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void fixture.close());
}
