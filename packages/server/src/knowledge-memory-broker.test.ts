import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';

import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import { markInternalConnections } from './internal-listener.js';
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
