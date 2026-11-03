import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { EventStore } from '@verity/store';
import { registerProjectContextRoutes } from './project-context-routes.js';

it('requires project manage access and revision checks for both project context editors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verity-project-context-'));
  const app = Fastify();
  app.decorateRequest('localUserId', null);
  app.addHook('onRequest', async (request) => {
    const user = request.headers['x-test-user'];
    if (typeof user === 'string') request.localUserId = user;
  });
  const store = {
    isActiveAdministrator: async () => false,
    hasProjectPermission: async (user: string, id: string, permission: string) =>
      id === 'p' && (user === 'manager' || (user === 'reader' && permission === 'read')),
    getProject: async (id: string) => (id === 'p' ? { id } : undefined),
    getProjectSettingsRaw: async () => ({ memory: 'Legacy project fact' }),
    knowledge: { getProjectOverview: async () => null },
  } as unknown as EventStore;
  registerProjectContextRoutes(app, store, root);
  try {
    for (const kind of ['instructions', 'memory']) {
      const url = `/projects/p/${kind}`;
      expect((await app.inject(url)).statusCode).toBe(403);
      const read = await app.inject({ url, headers: { 'x-test-user': 'reader' } });
      expect(read.statusCode).toBe(200);
      const snapshot = read.json<{ revision: string }>();
      const payload = { revision: snapshot.revision, [kind]: 'New project context' };
      expect(
        (await app.inject({ method: 'PUT', url, headers: { 'x-test-user': 'reader' }, payload }))
          .statusCode,
      ).toBe(403);
      const saved = await app.inject({
        method: 'PUT',
        url,
        headers: { 'x-test-user': 'manager' },
        payload,
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ [kind]: 'New project context' });
      expect(
        (await app.inject({ method: 'PUT', url, headers: { 'x-test-user': 'manager' }, payload }))
          .statusCode,
      ).toBe(409);
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
