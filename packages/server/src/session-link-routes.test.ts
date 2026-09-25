import type { EventStore } from '@verity/store';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerSessionLinkRoutes } from './session-link-routes.js';

it('links two project sessions and removes the link from either side', async () => {
  const sessions = new Map([
    ['a', { projectId: 'project-a' }],
    ['b', { projectId: 'project-b' }],
  ]);
  const projects = new Map([
    [
      'project-a',
      { id: 'project-a', repo: 'alpha', kind: 'github', state: 'active', hiddenAt: null },
    ],
    [
      'project-b',
      { id: 'project-b', repo: 'beta', kind: 'github', state: 'active', hiddenAt: null },
    ],
  ]);
  const createSessionLink = vi.fn(async () => true);
  const deleteSessionLink = vi.fn(async () => true);
  const app = Fastify();
  registerSessionLinkRoutes(app, {
    getSession: async (id: string) => sessions.get(id),
    getProject: async (id: string) => projects.get(id),
    listProjects: async () => [...projects.values()],
    createSessionLink,
    deleteSessionLink,
    listSessionLinks: async () => [
      { peerSessionId: 'b', peerProjectId: 'project-b', peerName: 'API work' },
    ],
  } as unknown as EventStore);

  const created = await app.inject({
    method: 'POST',
    url: '/sessions/a/links',
    payload: { targetSessionId: 'b' },
  });
  expect(created.statusCode).toBe(201);
  expect(createSessionLink).toHaveBeenCalledWith('a', 'b');

  const listed = await app.inject({ method: 'GET', url: '/sessions/a/links' });
  expect(listed.json().links).toEqual([
    { sessionId: 'b', name: 'API work', projectId: 'project-b', projectName: 'beta' },
  ]);

  const removed = await app.inject({ method: 'DELETE', url: '/sessions/b/links/a' });
  expect(removed.statusCode).toBe(200);
  expect(deleteSessionLink).toHaveBeenCalledWith('b', 'a');
  await app.close();
});
