import type { EventStore } from '@verity/store';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerSessionLinkRoutes } from './session-link-routes.js';

function appWithLinks() {
  const app = Fastify();
  registerSessionLinkRoutes(app, {
    getSession: async (id: string) => (id === 'a' ? { projectId: 'project-a' } : undefined),
    listProjects: async () => [{ id: 'project-b', repo: 'beta' }],
    listSessionLinks: async () => [
      { peerSessionId: 'b', peerProjectId: 'project-b', peerName: 'API work' },
    ],
  } as unknown as EventStore);
  return app;
}

it('lists the links a session holds for linked messaging', async () => {
  const app = appWithLinks();
  const listed = await app.inject({ method: 'GET', url: '/sessions/a/links' });
  expect(listed.json().links).toEqual([
    { sessionId: 'b', name: 'API work', projectId: 'project-b', projectName: 'beta' },
  ]);
  expect((await app.inject({ method: 'GET', url: '/sessions/missing/links' })).statusCode).toBe(
    404,
  );
  await app.close();
});

// Links now come only from coordination and inquiries. A surviving manual route
// would let a client create a link that no collaboration entry ever explains.
it.each([
  ['POST', '/sessions/a/links'],
  ['DELETE', '/sessions/a/links/b'],
] as const)('no longer serves manual linking: %s %s', async (method, url) => {
  const app = appWithLinks();
  const response = await app.inject({ method, url, payload: { targetSessionId: 'b' } });
  expect(response.statusCode).toBe(404);
  await app.close();
});
