import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { Server, IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { markInternalConnections } from './internal-listener.js';
import { registerPackageArtifactRoutes } from './package-artifact-routes.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { BrokeredHttpStreamTransport } from './brokered-http-stream.js';
const binding = { projectId: 'p1', containerGeneration: 'g1', owner: 'o', repo: 'r' };
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
