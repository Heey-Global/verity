import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { createTestDb } from '@verity/store/testing';
import { registerProjectMemoryRoute } from './project-memory-route.js';
import { markInternalConnections } from './internal-listener.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';

it('returns an HTTP conflict for legacy memory appends after overview approval', async () => {
  const ctx = await createTestDb();
  const app = Fastify();
  try {
    await ctx.store.upsertProject({
      id: 'p',
      owner: 'test',
      repo: 'memory',
      containerName: 'memory',
      state: 'active',
    });
    await ctx.store.appendProjectMemory('p', 'Legacy note retained');
    const space = (await ctx.store.knowledge.getProjectSpace('p'))!;
    const overview = await ctx.store.knowledge.createDocument({
      folderId: space.wikiFolderId,
      title: 'Overview',
      bodyMarkdown: 'Approved orientation',
    });
    await ctx.store.knowledge.approveProjectOverview('p', overview.id, overview.currentRevisionId);
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
    registerProjectMemoryRoute(app, {
      store: ctx.store,
      capabilities: { resolve: async () => binding } as unknown as GhTokenCapabilityRegistry,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/project/memory',
      headers: { authorization: 'Bearer test-capability' },
      payload: { text: 'This must not become approved guidance' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toContain('approved Knowledge overview');
    expect((await ctx.store.getProjectSettingsRaw('p'))?.memory).toBe('Legacy note retained');
    expect((await ctx.store.knowledge.getProjectOverview('p'))?.bodyMarkdown).toBe(
      'Approved orientation',
    );
  } finally {
    await app.close();
    await ctx.close();
  }
});
