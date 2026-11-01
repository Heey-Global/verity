import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { readProjectEgressDocker } from './project-egress-docker-read.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function daemon(reply: (socket: Socket, request: string) => void) {
  const directory = await mkdtemp('/tmp/egress-read-');
  const socketPath = `${directory}/docker.sock`;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', (chunk) => reply(socket, chunk.toString()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return socketPath;
}
const id = 'a'.repeat(64);
it.each([
  [['container', 'inspect', id], `/containers/${id}/json`, [{ Id: id }]],
  [['inspect', id], `/containers/${id}/json`, [{ Id: id }]],
  [['network', 'inspect', id], `/networks/${id}`, [{ Id: id }]],
  [
    ['image', 'inspect', 'example/repo@sha256:abc'],
    '/images/example%2Frepo%40sha256%3Aabc/json',
    [{ Id: id }],
  ],
  [['volume', 'inspect', 'data'], '/volumes/data', [{ Id: id }]],
  [['info', '--format', '{{json .}}'], '/info', { Id: id }],
  [['info', '--format', '{{json .Runtimes}}'], '/info', { runsc: {} }],
])('reads only the expected daemon route for %j', async (args, path, expected) => {
  const socketPath = await daemon((socket, request) => {
    expect(request.split('\r\n')[0]).toBe(`GET ${path} HTTP/1.1`);
    socket.end(
      'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n' +
        JSON.stringify({ Id: id, Runtimes: { runsc: {} } }),
    );
  });
  const reply = JSON.parse((await readProjectEgressDocker(args, socketPath))!);
  // CLI shape is retained so the existing validators see every original field.
  if (args.at(-1) === '{{json .Runtimes}}') expect(reply).toEqual(expected);
  else expect(Array.isArray(expected) ? reply[0] : reply).toMatchObject({ Id: id });
});
it.each([
  ['HTTP failure', 'HTTP/1.1 500 Error\r\nContent-Length: 2\r\n\r\n{}'],
  ['malformed JSON', 'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{'],
  ['non-object JSON', 'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n[]'],
  ['truncated body', 'HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n{}'],
  [
    'oversized body',
    'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n' + ' '.repeat(2 * 1024 * 1024 + 1),
  ],
])('rejects %s without returning inspection data', async (_name, response) => {
  const socketPath = await daemon((socket) => socket.end(response));
  await expect(readProjectEgressDocker(['inspect', id], socketPath)).rejects.toThrow();
});
it('rejects invalid UTF-8 instead of replacing daemon fields', async () => {
  const socketPath = await daemon((socket) =>
    socket.end(
      Buffer.concat([
        Buffer.from('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{"Id":"'),
        Buffer.from([255]),
        Buffer.from('"}'),
      ]),
    ),
  );
  await expect(readProjectEgressDocker(['inspect', id], socketPath)).rejects.toThrow();
});
it('bounds the entire read even while the daemon keeps sending bytes', async () => {
  const socketPath = await daemon((socket) => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n');
    const timer = setInterval(() => socket.write(' '), 5);
    socket.once('close', () => clearInterval(timer));
  });
  await expect(readProjectEgressDocker(['inspect', id], socketPath, 50)).rejects.toThrow(
    'timed out',
  );
});
it('does not translate mutations, flags or unregistered container names into reads', async () => {
  for (const args of [
    ['container', 'start', id],
    ['inspect', '../info'],
    ['inspect', id, '--format', 'anything'],
  ])
    expect(await readProjectEgressDocker(args, '/missing.sock')).toBeUndefined();
});
