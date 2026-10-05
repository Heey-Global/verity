import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import type { EventStore } from '@verity/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import { markInternalConnections } from './internal-listener.js';
import {
  ManagedDevServerError,
  type ManagedDevServerManager,
  type ManagedServerView,
} from './managed-dev-server-manager.js';
import {
  describeForAgent,
  registerManagedDevServerAgentRoute,
  registerManagedDevServerRoutes,
} from './managed-dev-server-routes.js';

const binding = { projectId: 'p1', containerGeneration: 'g1', owner: 'o', repo: 'r' };
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function view(
  instance: Partial<NonNullable<ManagedServerView['instance']>> | null,
): ManagedServerView {
  return {
    id: 'srv',
    name: 'Curtis Demo',
    command: 'node server.mjs --port {port}',
    workdir: '.',
    approved: true,
    instance:
      instance === null
        ? null
        : {
            id: 'inst',
            localShareId: 'local-share',
            localOn: true,
            sessionId: 's1',
            state: 'running',
            desired: 'running',
            detail: null,
            url: null,
            awaitingApproval: false,
            restartToApply: false,
            startedAt: null,
            sandboxPort: 41000,
            ...instance,
          },
    elsewhere: [],
  };
}

function agentApp(manager: Partial<ManagedDevServerManager>, internal = true) {
  const app = Fastify();
  apps.push(app);
  if (internal) {
    const connections = new EventEmitter();
    markInternalConnections(connections as unknown as Server, binding);
    app.addHook('onRequest', async (request) => {
      connections.emit('connection', request.raw.socket);
    });
  }
  registerManagedDevServerAgentRoute(app, {
    manager: manager as ManagedDevServerManager,
    capabilities: {
      resolve: async (token: string) => (token === 'good' ? binding : undefined),
    } as unknown as GhTokenCapabilityRegistry,
    eventStore: {
      getSession: async (id: string) =>
        id === 's1' ? { projectId: 'p1' } : id === 'foreign' ? { projectId: 'p2' } : undefined,
    } as unknown as EventStore,
  });
  return app;
}

const post = (app: FastifyInstance, payload: unknown, token = 'good') =>
  app.inject({
    method: 'POST',
    url: '/internal/dev-servers',
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });

describe('verity-dev-server broker route', () => {
  // The capability binds the sandbox to its project; a wrong token or a request
  // from outside the project socket must not reach the manager at all.
  it('rejects a bad capability and a connection outside the project socket', async () => {
    const start = vi.fn();
    expect(
      (await post(agentApp({ start }), { action: 'start', sessionId: 's1', name: 'x' }, 'bad'))
        .statusCode,
    ).toBe(401);
    expect(
      (await post(agentApp({ start }, false), { action: 'start', sessionId: 's1', name: 'x' }))
        .statusCode,
    ).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });

  // The session id is attribution only. One project's sandbox must not drive
  // servers of another project's session.
  it('refuses a session of another project', async () => {
    const start = vi.fn();
    const response = await post(agentApp({ start }), {
      action: 'start',
      sessionId: 'foreign',
      name: 'x',
    });
    expect(response.statusCode).toBe(404);
    expect(start).not.toHaveBeenCalled();
  });

  it('starts as the agent, never as the operator', async () => {
    const start = vi.fn(async () => view({ state: 'starting' }));
    const response = await post(agentApp({ start }), {
      action: 'start',
      sessionId: 's1',
      name: 'Curtis Demo',
    });
    expect(response.json()).toEqual({ server: 'Curtis Demo: starting' });
    expect(start).toHaveBeenCalledWith('s1', 'Curtis Demo', 'agent');
  });

  it('turns manager errors into their status codes', async () => {
    const add = vi.fn(async () => {
      throw new ManagedDevServerError('a server named like "Web" already exists', 409);
    });
    const response = await post(agentApp({ add }), {
      action: 'add',
      sessionId: 's1',
      name: 'Web',
      command: 'vite',
    });
    expect(response.statusCode).toBe(409);
    expect(
      (await post(agentApp({ add }), { action: 'add', sessionId: 's1', name: 'Web' })).statusCode,
    ).toBe(400);
  });
});

describe('agent status line', () => {
  // The agent repeats this to the operator; it names the network address or the
  // next step, never a port inside the sandbox.
  it('reports address, pending approval, or crash with a log hint', () => {
    expect(describeForAgent(view({ url: 'http://verity.local:8104' }))).toBe(
      'Curtis Demo: running at http://verity.local:8104',
    );
    expect(describeForAgent(view({ url: 'http://localhost:8104' }))).toBe(
      'Curtis Demo: running on port 8104 of your Verity server. Open it from the Preview button.',
    );
    expect(describeForAgent(view({ awaitingApproval: true }))).toBe(
      'Curtis Demo: running, not shared yet: tap Open on network in the Preview list',
    );
    expect(
      describeForAgent(view({ state: 'crashed', detail: 'The server exited with code 1' })),
    ).toBe(
      'Curtis Demo: crashed. The server exited with code 1 Read the output with: verity-dev-server logs "Curtis Demo"',
    );
    expect(describeForAgent(view(null))).toBe('Curtis Demo: stopped');
  });
});

describe('Preview sheet routes', () => {
  it('starts as the operator and maps an unapproved start to 409', async () => {
    const app = Fastify();
    apps.push(app);
    const start = vi.fn(async () => {
      throw new ManagedDevServerError('Review and approve the command first', 409);
    });
    registerManagedDevServerRoutes(app, {
      manager: { start } as unknown as ManagedDevServerManager,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/s1/managed-dev-servers/srv/start',
    });
    expect(response.statusCode).toBe(409);
    expect(start).toHaveBeenCalledWith('s1', 'srv', 'operator', { local: undefined });
  });

  // Shared online alone starts the server without a network address; the route
  // must pass that through rather than drop it.
  it('passes the Local switch state through start and the local route', async () => {
    const app = Fastify();
    apps.push(app);
    const start = vi.fn(async () => view({}));
    const setLocal = vi.fn(async () => view({}));
    registerManagedDevServerRoutes(app, {
      manager: { start, setLocal } as unknown as ManagedDevServerManager,
    });
    await app.inject({
      method: 'POST',
      url: '/sessions/s1/managed-dev-servers/srv/start',
      payload: { local: false },
    });
    expect(start).toHaveBeenCalledWith('s1', 'srv', 'operator', { local: false });
    const off = await app.inject({
      method: 'POST',
      url: '/sessions/s1/managed-dev-servers/srv/local',
      payload: { on: false },
    });
    expect(off.statusCode).toBe(200);
    expect(setLocal).toHaveBeenCalledWith('s1', 'srv', false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/sessions/s1/managed-dev-servers/srv/local',
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
  });

  it('approves only with the command and subdirectory the app showed', async () => {
    const app = Fastify();
    apps.push(app);
    const approve = vi.fn(async () => []);
    registerManagedDevServerRoutes(app, {
      manager: { approve } as unknown as ManagedDevServerManager,
    });
    const url = '/sessions/s1/managed-dev-servers/srv/approve';
    expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(400);
    await app.inject({
      method: 'POST',
      url,
      payload: { command: 'node server.mjs', workdir: '.' },
    });
    expect(approve).toHaveBeenCalledWith('s1', 'srv', { command: 'node server.mjs', workdir: '.' });
  });
});
