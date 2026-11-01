import {
  createServer,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ path: '', calls: [] as RequestOptions[] }));
vi.mock('node:http', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:http')>();
  return {
    ...original,
    request: (options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      io.calls.push(options);
      return original.request({ ...options, socketPath: io.path }, callback);
    },
  };
});
import { readEgressDocker, readEgressDockerObject } from './project-egress-docker-read.js';
const id = 'a'.repeat(64);
let handler: (response: ServerResponse) => void;
let directory: string;
const server = createServer((_request, response) => handler(response));
beforeEach(async () => {
  directory = await mkdtemp('/tmp/egress-read-');
  io.path = join(directory, 'docker.sock');
  io.calls.length = 0;
  handler = (response) => response.end(JSON.stringify({ Id: id }));
  server.listen(io.path);
  await once(server, 'listening');
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(directory, { recursive: true, force: true });
});
it('uses only the fixed host socket, versioned GET and exact object ID', async () => {
  expect(await readEgressDocker('container', 'inspect', id)).toBe(JSON.stringify([{ Id: id }]));
  expect(io.calls[0]).toMatchObject({
    socketPath: '/var/run/docker.sock',
    method: 'GET',
    path: `/v1.47/containers/${id}/json`,
    agent: false,
  });
});
it('rejects aliases, injected paths and mutation commands before opening a socket', async () => {
  for (const identity of ['project', 'a/../../version', 'a'.repeat(63)])
    await expect(readEgressDockerObject('container', identity)).rejects.toThrow('identity');
  await expect(readEgressDocker('container', 'start', id)).rejects.toThrow('Unsupported');
  expect(io.calls).toHaveLength(0);
});
it('rejects substituted IDs, bad JSON, redirects and unsupported API responses', async () => {
  for (const body of [JSON.stringify({ Id: 'b'.repeat(64) }), 'not json']) {
    handler = (response) => response.end(body);
    await expect(readEgressDockerObject('network', id)).rejects.toThrow();
  }
  for (const status of [301, 400, 404, 500]) {
    handler = (response) => {
      response.writeHead(status, { Location: 'http://untrusted.test' });
      response.end();
    };
    await expect(readEgressDockerObject('network', id)).rejects.toThrow('refused');
  }
});
it('bounds response size and total elapsed time even while bytes arrive', async () => {
  handler = (response) => response.end('x'.repeat(2 * 1024 * 1024 + 1));
  await expect(readEgressDockerObject('network', id)).rejects.toThrow('Oversized');
  handler = (response) => {
    response.writeHead(200);
    response.write('{');
    const timer = setInterval(() => response.write(' '), 20);
    response.on('close', () => clearInterval(timer));
  };
  await expect(readEgressDockerObject('network', id)).rejects.toThrow('timed out');
});
