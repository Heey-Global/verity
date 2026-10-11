// Test-only byte relay: no production admission, routing, or entitlement protocol.
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, createWebSocketStream } from 'ws';

/** @param {{ key: Buffer, cert: Buffer, protocol?: "h1" | "h2" }} options */
export async function startFixture({ key, cert, protocol = 'h1' }) {
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  const stats = { tunnels: 0, bytes: 0, captured: Buffer.alloc(0) };
  /** @param {net.Socket} socket */
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  /** @param {import('node:http').IncomingMessage | http2.Http2ServerRequest} req
   * @param {import('node:http').ServerResponse | http2.Http2ServerResponse} res */
  const handleCore = (req, res) => {
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
  };
  const core =
    protocol === 'h2'
      ? http2.createSecureServer({ key, cert, allowHTTP1: true }, handleCore)
      : https.createServer({ key, cert }, handleCore);
  core.on('connection', track);
  /** @param {Error} _error @param {import('node:stream').Duplex} socket */
  const closeClientError = (_error, socket) => {
    socket.destroy();
  };
  core.on('clientError', closeClientError);
  const echo = new WebSocketServer({
    server: /** @type {https.Server} */ (core),
    path: '/socket',
    maxPayload: 256 * 1024,
  });
  echo.on('connection', (ws) => {
    ws.on('error', () => {});
    ws.on('message', (data, binary) => ws.send(data, { binary }));
  });
  /** @param {net.Server} server @returns {Promise<number>} */
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
  const tunnels = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const data = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024 });
  relay.on('upgrade', (request, socket, head) => {
    const server = request.url === '/tunnel' ? tunnels : request.url === '/data' ? data : null;
    if (!server) return socket.destroy();
    server.handleUpgrade(request, socket, head, (ws) => server.emit('connection', ws));
  });
  // Test-only fixed routing: exercise the production app's JSON framing without admission credentials.
  data.on('connection', (ws) => {
    /** @type {Map<string, { socket: net.Socket, incoming: number, outgoing: number }>} */
    const streams = new Map();
    let attached = false;
    const send = (frame) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(frame));
    };
    ws.on('error', () => {});
    ws.on('close', () => {
      for (const stream of streams.values()) stream.socket.destroy();
      streams.clear();
    });
    ws.on('message', (raw, binary) => {
      try {
        if (binary || !Buffer.isBuffer(raw)) throw new Error('binary frame');
        /** @type {unknown} */
        const parsed = JSON.parse(raw.toString());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('frame');
        const frame = /** @type {Record<string, unknown>} */ (parsed);
        if (!attached) {
          if (frame.type !== 'attach' || frame.ticket !== 'fixture-ticket')
            throw new Error('attach');
          attached = true;
          send({ type: 'attached', sessionId: 'fixture-session', capability: 'remote-control-v1' });
          return;
        }
        const id = frame.streamId;
        if (typeof id !== 'string') throw new Error('stream id');
        if (frame.type === 'stream.open') {
          if (streams.has(id) || streams.size >= 8) throw new Error('stream limit');
          const socket = track(
            net.connect({ host: '127.0.0.1', port: corePort, allowHalfOpen: true }),
          );
          const stream = { socket, incoming: 0, outgoing: 0 };
          streams.set(id, stream);
          socket.on('data', (chunk) => {
            for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
              send({
                type: 'stream.data',
                streamId: id,
                seq: stream.outgoing++,
                payload: chunk.subarray(offset, offset + 64 * 1024).toString('base64'),
              });
            }
          });
          socket.on('end', () => send({ type: 'stream.end', streamId: id }));
          socket.on('error', () =>
            send({ type: 'stream.reset', streamId: id, code: 'upstream_error' }),
          );
          socket.on('close', () => streams.delete(id));
          return;
        }
        const stream = streams.get(id);
        if (!stream) return;
        if (
          frame.type === 'stream.data' &&
          typeof frame.payload === 'string' &&
          frame.seq === stream.incoming++
        ) {
          stream.socket.write(Buffer.from(frame.payload, 'base64'));
        } else if (frame.type === 'stream.end') stream.socket.end();
        else if (frame.type === 'stream.reset') stream.socket.destroy();
        else throw new Error('frame');
      } catch {
        ws.close(1002);
      }
    });
  });
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
      for (const ws of data.clients) ws.terminate();
      for (const ws of echo.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [core, relay].map((server) => new Promise((resolve) => server.close(resolve))),
      );
      tunnels.close();
      data.close();
      echo.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [keyPath, certPath, protocol = 'h1'] = process.argv.slice(2);
  if (protocol !== 'h1' && protocol !== 'h2') throw new Error('Invalid fixture protocol');
  if (!keyPath || !certPath) throw new Error('Usage: mock.mjs key.pem cert.pem');
  const fixture = await startFixture({
    key: await readFile(keyPath),
    cert: await readFile(certPath),
    protocol,
  });
  process.stdout.write(
    `${JSON.stringify({ corePort: fixture.corePort, relayPort: fixture.relayPort })}\n`,
  );
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void fixture.close());
}
