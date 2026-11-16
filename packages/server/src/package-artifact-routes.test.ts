import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrokerRelayServer } from '../../project-relay/src/relay.js';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { request, type Server, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { markInternalConnections } from './internal-listener.js';
import { registerPackageArtifactRoutes } from './package-artifact-routes.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { BrokeredHttpStreamTransport } from './brokered-http-stream.js';
import { createNpmInstallGrant, revokeNpmInstallGrant } from './package-install-grants.js';

const SANDBOX_USER = '00000000-0000-4000-8000-000000000001';
const binding = {
  projectId: 'p1',
  userId: SANDBOX_USER,
  projectDefault: true,
  containerGeneration: 'g1',
  owner: 'o',
  repo: 'r',
};
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function fixture(internal = true, live = true) {
  const app = Fastify();
  apps.push(app);
  const generation = new AbortController();
  if (internal) {
    const connections = new EventEmitter();
    markInternalConnections(
      connections as unknown as Server,
      binding,
      live ? generation.signal : undefined,
    );
    app.addHook('onRequest', async (request) => {
      connections.emit('connection', request.raw.socket);
    });
  }
  const resolve = vi.fn(async (token: string) => (token === 'good' ? binding : undefined));
  const transport = vi
    .fn<BrokeredHttpStreamTransport>()
    .mockImplementation(
      async () =>
        Object.assign(
          Readable.from([JSON.stringify({ name: 'example', versions: {}, 'dist-tags': {} })]),
          { statusCode: 200, headers: {} },
        ) as IncomingMessage,
    );
  registerPackageArtifactRoutes(app, {
    capabilities: { resolve } as unknown as GhTokenCapabilityRegistry,
    transport,
  });
  const get = (authorization = 'Bearer good', headers: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: '/internal/package-artifacts/npm/example',
      headers: { authorization, ...headers },
    });
  return { app, generation, resolve, transport, get };
}
it('requires socket identity, live generation and matching project capability', async () => {
  for (const f of [fixture(false), fixture(true, false)]) {
    expect((await f.get()).statusCode).toBe(401);
    expect(f.transport).not.toHaveBeenCalled();
  }
  const f = fixture();
  expect((await f.get('Bearer wrong')).statusCode).toBe(401);
  f.resolve.mockResolvedValueOnce({ ...binding, containerGeneration: 'old' });
  expect((await f.get()).statusCode).toBe(401);
  expect(f.transport).not.toHaveBeenCalled();
});
it('binds installation tokens to current capability authority and revokes completed receipts', async () => {
  const f = fixture();
  const token = createNpmInstallGrant({
    sourceToken: 'good',
    ...binding,
    sessionId: 's1',
    policy: { minimumAgeDays: 3, packages: new Set(), exceptions: new Set() },
  });
  expect((await f.get(`Bearer ${token}`)).statusCode).toBe(200);
  expect(f.resolve).toHaveBeenCalledWith('good');
  f.resolve.mockResolvedValueOnce(undefined);
  expect((await f.get(`Bearer ${token}`)).statusCode).toBe(401);
  revokeNpmInstallGrant(token);
  expect((await f.get(`Bearer ${token}`)).statusCode).toBe(401);
});
it('forwards audit requests authorized by an installation grant', async () => {
  const f = fixture();
  const token = createNpmInstallGrant({
    sourceToken: 'good',
    ...binding,
    sessionId: 's1',
    policy: { minimumAgeDays: 3, packages: new Set(), exceptions: new Set() },
  });
  f.transport.mockImplementation(
    async () =>
      Object.assign(Readable.from(['{}']), { statusCode: 200, headers: {} }) as IncomingMessage,
  );
  try {
    const response = await f.app.inject({
      method: 'POST',
      url: '/internal/package-artifacts/npm/-/npm/v1/security/advisories/bulk',
      headers: { authorization: `Bearer ${token}` },
      payload: { example: ['1.0.0'] },
    });
    expect(response.statusCode).toBe(200);
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.resolve).toHaveBeenCalledWith('good');
  } finally {
    revokeNpmInstallGrant(token);
  }
});

it('does not accept an installation token issued for a different generation', async () => {
  const f = fixture();
  const token = createNpmInstallGrant({
    sourceToken: 'good',
    ...binding,
    containerGeneration: 'old',
    sessionId: 's1',
    policy: { minimumAgeDays: 3, packages: new Set(), exceptions: new Set() },
  });
  expect((await f.get(`Bearer ${token}`)).statusCode).toBe(401);
  expect(f.transport).not.toHaveBeenCalled();
  revokeNpmInstallGrant(token);
});
it('expires installation tokens without creating durable project authority', async () => {
  const f = fixture();
  const token = createNpmInstallGrant({
    sourceToken: 'good',
    ...binding,
    sessionId: 's1',
    policy: { minimumAgeDays: 3, packages: new Set(), exceptions: new Set() },
  });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60_000 + 1);
  try {
    expect((await f.get(`Bearer ${token}`)).statusCode).toBe(401);
    expect(f.transport).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
    revokeNpmInstallGrant(token);
  }
});
it('accepts native npm bearer and pip Basic auth without forwarding either upstream', async () => {
  const f = fixture();
  expect((await f.get()).statusCode).toBe(200);
  expect((await f.get(`Basic ${Buffer.from('verity:good').toString('base64')}`)).statusCode).toBe(
    200,
  );
  expect(f.transport.mock.calls.every(([input]) => input.headers.authorization === undefined)).toBe(
    true,
  );
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/internal/package-artifacts/npm/example',
        headers: { authorization: 'Bearer good' },
      })
    ).statusCode,
  ).toBe(404);
});
it('rejects query and range paths and revocation during download', async () => {
  const f = fixture();
  expect((await f.get('Bearer good', { range: 'bytes=0-1' })).statusCode).toBe(400);
  expect(
    (
      await f.app.inject({
        method: 'GET',
        url: '/internal/package-artifacts/npm/example?url=https://evil.example',
        headers: { authorization: 'Bearer good' },
      })
    ).statusCode,
  ).toBe(400);
  f.transport.mockImplementationOnce(async () => {
    f.generation.abort();
    return Object.assign(Readable.from([]), { statusCode: 200, headers: {} }) as IncomingMessage;
  });
  expect((await f.get()).statusCode).toBe(401);
});

it('accepts bounded native gzip advisory requests without enabling publish or arbitrary POST', async () => {
  const { gzipSync } = await import('node:zlib');
  const f = fixture();
  f.transport.mockImplementation(
    async () =>
      Object.assign(Readable.from(['{}']), { statusCode: 200, headers: {} }) as IncomingMessage,
  );
  const path = '/internal/package-artifacts/npm/-/npm/v1/security/advisories/bulk';
  const compressed = gzipSync(Buffer.from('{"example":["1.0.0"]}'));
  const result = await f.app.inject({
    method: 'POST',
    url: path,
    headers: {
      authorization: 'Bearer good',
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    },
    payload: compressed,
  });
  expect(result.statusCode).toBe(200);
  expect(f.transport.mock.calls[0]?.[0].body).toEqual(Buffer.from('{"example":["1.0.0"]}'));
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: path,
        headers: { authorization: 'Bearer good' },
        payload: { example: ['a'.repeat(129)] },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: path,
        headers: {
          authorization: 'Bearer good',
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        },
        payload: gzipSync(Buffer.from('x'.repeat(65537))),
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await f.app.inject({
        method: 'PUT',
        url: '/internal/package-artifacts/npm/example',
        headers: { authorization: 'Bearer good' },
        payload: { publish: true },
      })
    ).statusCode,
  ).toBe(404);
  expect(f.transport).toHaveBeenCalledTimes(1);
});

it('aborts an active upstream request when capability revalidation stops answering', async () => {
  const f = fixture();
  f.resolve.mockImplementation(async () =>
    f.transport.mock.calls.length ? new Promise(() => {}) : binding,
  );
  f.transport.mockImplementation(
    ({ signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      ),
  );
  expect((await f.get()).statusCode).toBe(401);
});

it.each([
  { throughRelay: false, cancellation: 'revoke' },
  { throughRelay: true, cancellation: 'revoke' },
  { throughRelay: true, cancellation: 'stall' },
  { throughRelay: true, cancellation: 'generation' },
])(
  'revokes a buffered artifact with a slow client ($throughRelay, $cancellation)',
  async ({ throughRelay, cancellation }) => {
    const f = fixture();
    // Exceed the combined UNIX/TCP buffers too, so a relay cannot absorb the whole response.
    const archive = Buffer.alloc(12 * 1024 * 1024, 97);
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
    f.transport.mockImplementation(
      async ({ path }) =>
        Object.assign(
          Readable.from([
            path.endsWith('.tgz')
              ? archive
              : Buffer.from(
                  JSON.stringify({
                    name: 'example',
                    versions: {
                      '1.0.0': {
                        name: 'example',
                        version: '1.0.0',
                        dist: {
                          tarball: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
                          integrity,
                        },
                      },
                    },
                    'dist-tags': { latest: '1.0.0' },
                    time: { '1.0.0': '2020-01-01T00:00:00Z' },
                  }),
                ),
          ]),
          { statusCode: 200, headers: {} },
        ) as IncomingMessage,
    );
    const sockets: Socket[] = [];
    f.app.server.on('connection', (connected: Socket) => {
      sockets.push(connected);
    });
    const directory = await mkdtemp(join(tmpdir(), 'artifact-relay-'));
    let relay: Server | undefined;
    const relaySockets: Socket[] = [];
    let origin: string;
    if (throughRelay) {
      const socketPath = join(directory, 'broker.sock');
      await f.app.listen({ path: socketPath });
      relay = createBrokerRelayServer({ socketPath });
      relay.on('connection', (socket) => relaySockets.push(socket));
      await new Promise<void>((resolve) => relay!.listen(0, '127.0.0.1', resolve));
      const address = relay.address();
      if (!address || typeof address === 'string') throw new Error('Missing relay TCP address');
      origin = `http://127.0.0.1:${address.port}`;
    } else {
      origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
    }
    const clients: IncomingMessage[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        clients.push(
          await new Promise<IncomingMessage>((resolve, reject) => {
            const outgoing = request(
              new URL('/internal/package-artifacts/npm/example/-/example-1.0.0.tgz', origin),
              {
                headers: { authorization: 'Bearer good' },
              },
              (response) => {
                response.on('error', () => {});
                response.once('data', () => {
                  response.pause();
                  resolve(response);
                });
              },
            );
            outgoing.on('error', reject);
            outgoing.end();
          }),
        );
      }
      expect(clients.map((client) => client.statusCode)).toEqual([200, 200]);
      // Real backpressure keeps the valid response pending beyond broker buffering.
      await vi.waitFor(
        () => expect(sockets.every((socket) => socket.writableLength > 0)).toBe(true),
        { timeout: 1000, interval: 10 },
      );
      const activeSockets = [...sockets, ...relaySockets];
      const capacity = await new Promise<number | undefined>((resolve, reject) => {
        const outgoing = request(
          new URL('/internal/package-artifacts/npm/example', origin),
          {
            headers: { authorization: 'Bearer good' },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        outgoing.on('error', reject);
        outgoing.end();
      });
      expect(capacity).toBe(429);
      if (cancellation === 'generation') f.generation.abort();
      else if (cancellation === 'stall') f.resolve.mockImplementation(() => new Promise(() => {}));
      else f.resolve.mockResolvedValue(undefined);
      await vi.waitFor(() => expect(activeSockets.every((socket) => socket.destroyed)).toBe(true), {
        timeout: 1800,
      });
    } finally {
      for (const client of clients) client.destroy();
      for (const socket of sockets) socket.destroy();
      if (relay) {
        relay.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          relay.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await f.app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
