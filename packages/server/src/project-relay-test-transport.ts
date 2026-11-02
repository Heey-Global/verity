/** Real TCP-to-UDS relay hop for the gateway authorization suites. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { createClaudeRelayServer } from '../../project-relay/src/relay.js';

export async function listenTestModelRelay(
  server: Server,
): Promise<{ port: number; close(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'relay-auth-'));
  const path = join(directory, 'gateway.sock');
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const relay = createClaudeRelayServer(path);
  const sockets = new Set<Socket>();
  relay.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const address = relay.address();
  if (!address || typeof address === 'string') throw new Error('Relay did not bind');
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
