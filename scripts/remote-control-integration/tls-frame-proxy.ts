import { once } from 'node:events';
import { createServer, connect, type TLSSocket } from 'node:tls';
import { FrameGate } from './frame-gate.ts';

export async function createFrameProxy(target: URL, tls: { key: Buffer; cert: Buffer }) {
  if (target.hostname !== '127.0.0.1' || target.protocol !== 'wss:')
    throw new Error('Loopback WSS required');
  const sockets = new Set<TLSSocket>();
  let gate: FrameGate | undefined;
  let incoming: TLSSocket | undefined;
  let outgoing: TLSSocket | undefined;
  let held = false;
  let aborted = false;
  let errorCount = 0;
  const server = createServer(tls, (client) => {
    if (gate) {
      client.destroy();
      return;
    }
    incoming = client;
    const upstream = connect({ host: target.hostname, port: Number(target.port), ca: tls.cert });
    outgoing = upstream;
    sockets.add(client);
    sockets.add(upstream);
    gate = new FrameGate(() => {
      held = true;
    });
    const fail = () => {
      errorCount++;
      client.destroy();
      upstream.destroy();
      gate?.destroy();
    };
    client.on('error', fail);
    upstream.on('error', fail);
    gate.on('error', fail);
    client.once('close', () => {
      sockets.delete(client);
      upstream.destroy();
      gate?.destroy();
    });
    upstream.once('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.pipe(gate).pipe(upstream);
    upstream.pipe(client);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No proxy port');
  return {
    dataURL: `wss://127.0.0.1:${address.port}${target.pathname}`,
    arm() {
      if (!gate) throw new Error('Core not attached');
      gate.arm();
    },
    release() {
      if (!held || aborted) throw new Error('No held frame');
      gate!.release();
    },
    abort() {
      aborted = true;
      incoming?.destroy();
      outgoing?.destroy();
      gate?.destroy();
    },
    snapshot() {
      return {
        held,
        aborted,
        intercepted: gate?.intercepted ?? 0,
        released: gate?.released ?? 0,
        missingBytes: gate?.missingBytes ?? 0,
        errorCount,
      };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      gate?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
