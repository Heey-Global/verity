import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';

import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import { markInternalConnections } from './internal-listener.js';
import { createMcpGatewayTokens } from './mcp-gateway-tokens.js';
import { CONTROL_PLANE_PROJECT_ID } from './control-plane-project.js';
import { registerProjectMemoryRoute } from './project-memory-route.js';

it('appends project memory through the authenticated overview writer', async () => {
  const app = Fastify();
  const binding = {
    projectId: 'p',
    containerGeneration: 'generation',
    owner: 'test',
    repo: 'memory',
  };
  const connections = new EventEmitter();
  markInternalConnections(connections as unknown as Server, binding);
  app.addHook('onRequest', async (request) => {
    connections.emit('connection', request.raw.socket);
  });
  const append = vi.fn().mockResolvedValue(24);
  registerProjectMemoryRoute(app, {
    append,
    capabilities: { resolve: async () => binding } as unknown as GhTokenCapabilityRegistry,
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/project/memory',
      headers: { authorization: 'Bearer test-capability' },
      payload: { text: 'Remember this' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, length: 24 });
    expect(append).toHaveBeenCalledWith('p', 'Remember this');
  } finally {
    await app.close();
  }
});

it.each(['internal', 'external', 'project'] as const)(
  'binds Control memory to the Control turn and refuses %s identity misuse',
  async (origin) => {
    const app = Fastify();
    if (origin !== 'external') {
      const connections = new EventEmitter();
      markInternalConnections(
        connections as unknown as Server,
        origin === 'project'
          ? { projectId: 'verity-control', containerGeneration: 'generation' }
          : undefined,
      );
      app.addHook('onRequest', async (request) => {
        connections.emit('connection', request.raw.socket);
      });
    }
    const tokens = createMcpGatewayTokens();
    const token = tokens.issue({
      projectId: CONTROL_PLANE_PROJECT_ID,
      sessionId: 's',
      turnId: 't',
    });
    const foreign = tokens.issue({ projectId: 'other', sessionId: 's2', turnId: 't2' });
    const append = vi.fn().mockResolvedValue(24);
    registerProjectMemoryRoute(app, {
      append,
      resolveControlCaller: async (input) => tokens.resolve(input),
    });
    const post = (
      bearer?: string,
      payload: Record<string, unknown> = { text: 'Remember this', projectId: 'other' },
    ) =>
      app.inject({
        method: 'POST',
        url: '/internal/control-plane/memory',
        ...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
        payload,
      });
    try {
      for (const invalid of [undefined, 'invalid', foreign]) {
        expect((await post(invalid)).statusCode).toBe(401);
      }
      const response = await post(token);
      expect(response.statusCode).toBe(origin === 'internal' ? 200 : 401);
      if (origin === 'internal') {
        expect(append).toHaveBeenCalledExactlyOnceWith(CONTROL_PLANE_PROJECT_ID, 'Remember this');
        expect((await post(token, { text: 42 })).statusCode).toBe(400);
        tokens.release({ projectId: CONTROL_PLANE_PROJECT_ID, token });
        expect((await post(token)).statusCode).toBe(401);
        expect(append).toHaveBeenCalledTimes(1);
      } else expect(append).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);
