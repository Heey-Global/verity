import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerSessionFileRoutes, type SessionFileRouteDeps } from './session-file-routes.js';

it('normalizes Wiki and Raw Sources aliases without changing write protection', async () => {
  const app = Fastify();
  const write = vi.fn(async () => ({ ok: true }));
  const deps: SessionFileRouteDeps = {
    resolveRoot: async (_session, root) => `/knowledge/${root}`,
    list: async (_reply, target) => ({ root: target.root }),
    upload: async () => undefined,
    history: async () => undefined,
    content: async () => undefined,
    download: async () => undefined,
    remove: async () => undefined,
    move: async () => undefined,
    write,
  };
  registerSessionFileRoutes(app, deps);
  try {
    for (const [alias, expected] of [
      ['wiki', 'documents'],
      ['documents', 'documents'],
      ['raw-sources', 'sources'],
      ['sources', 'sources'],
    ]) {
      const result = await app.inject(`/sessions/s/files?root=${alias}`);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ root: expected });
    }
    const result = await app.inject({
      method: 'PUT',
      url: '/sessions/s/files/content',
      payload: {
        root: 'raw-sources',
        path: 'original.md',
        content: 'overwrite',
        expectedVersion: null,
      },
    });
    expect(result.statusCode).toBe(403);
    expect(write).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
