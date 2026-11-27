import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import type { EventStore } from '@verity/store';
import { afterEach, expect, it, vi } from 'vitest';
import { registerDependencyCapacityRoute } from './dependency-capacity-route.js';
import type { DependencyCapacity } from './dependency-capacity.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import { markInternalConnections } from './internal-listener.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const id = '11111111-1111-4111-8111-111111111111';
const binding = {
  projectId: 'project',
  userId: 'user',
  containerGeneration: 'generation',
  projectDefault: true,
  owner: 'o',
  repo: 'r',
};
const body = {
  version: 1,
  action: 'reserve',
  id,
  sessionId: 'session',
  kind: 'dependency-copy',
  bytes: 4096,
  inodes: 1,
};
const result = {
  version: 1,
  id,
  state: 'reserved',
  admitted: true,
  lockPath: `/run/verity-capacity-leases/${id}.lock`,
};
function fixture(internal = true) {
  const app = Fastify();
  apps.push(app);
  const generation = new AbortController();
  if (internal) {
    const connections = new EventEmitter();
    markInternalConnections(connections as unknown as Server, binding, generation.signal);
    app.addHook('onRequest', async (request) => {
      connections.emit('connection', request.raw.socket);
    });
  }
  const request = vi.fn<DependencyCapacity['request']>().mockResolvedValue({
    ...result,
    version: 1,
    state: 'reserved',
    reservedBytes: 4096,
    reservedInodes: 1,
  });
  registerDependencyCapacityRoute(app, {
    capacity: { request } as unknown as DependencyCapacity,
    capabilities: {
      resolve: async (token: string) => (token === 'good' ? binding : undefined),
    } as unknown as GhTokenCapabilityRegistry,
    store: {
      getSession: async (value: string) =>
        value === 'session'
          ? { sessionId: 'session', projectId: 'project' }
          : value === 'foreign'
            ? { sessionId: value, projectId: 'other' }
            : null,
    } as unknown as EventStore,
  });
  const post = (payload: Record<string, unknown> = body, token = 'good') =>
    app.inject({
      method: 'POST',
      url: '/internal/dependency-storage',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  return { app, generation, request, post };
}

it('binds capacity operations to both authenticated socket generation and the session project', async () => {
  const f = fixture();
  expect((await f.post()).statusCode).toBe(200);
  expect(f.request).toHaveBeenCalledWith(
    {
      projectId: 'project',
      userId: 'user',
      sessionId: 'session',
      containerGeneration: 'generation',
    },
    body,
  );
  expect((await f.post(body, 'bad')).statusCode).toBe(401);
  expect((await f.post({ ...body, sessionId: 'foreign' })).statusCode).toBe(404);
  expect((await fixture(false).post()).statusCode).toBe(401);
  expect(f.request).toHaveBeenCalledTimes(1);
});

it.each([
  { ...body, version: 2 },
  { ...body, bytes: Number.MAX_SAFE_INTEGER + 1 },
  { ...body, bytes: -1 },
  { ...body, projectId: 'spoofed' },
  { ...body, id: '../../escape' },
  { ...body, action: 'start' },
])('rejects malformed or widened protocol input before admission: %j', async (payload) => {
  const f = fixture();
  expect((await f.post(payload)).statusCode).toBe(400);
  expect(f.request).not.toHaveBeenCalled();
});

it('accepts a minimal versioned start frame', async () => {
  const f = fixture();
  expect((await f.post({ version: 1, action: 'start', id, sessionId: 'session' })).statusCode).toBe(
    200,
  );
  expect(f.request.mock.calls[0]?.[1]).toEqual({
    version: 1,
    action: 'start',
    id,
    sessionId: 'session',
  });
});

it('does not acknowledge a start after its generation was revoked during persistence', async () => {
  const f = fixture();
  let resolve!: (value: Awaited<ReturnType<DependencyCapacity['request']>>) => void;
  f.request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const response = f.post({ version: 1, action: 'start', id, sessionId: 'session' });
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
  f.generation.abort();
  resolve({ ...result, version: 1, state: 'started', reservedBytes: 4096, reservedInodes: 1 });
  expect((await response).statusCode).toBe(401);
});

it('names capacity refusals but never exposes arbitrary broker errors', async () => {
  const f = fixture();
  f.request.mockRejectedValueOnce(
    new Error('Dependency capacity start requires the original inherited broker lock.'),
  );
  expect((await f.post()).json()).toEqual({
    error: 'Dependency capacity start requires the original inherited broker lock.',
  });
  f.request.mockRejectedValueOnce(new Error('private credential detail'));
  expect((await f.post()).body).not.toContain('private credential detail');
});
