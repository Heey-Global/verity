import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '@verity/store/testing';
import { registerProjectCollectionRoutes } from './project-collection-routes.js';
import { registerProjectGitHubLinkRoute } from './project-github-link-route.js';
let ctx: TestDb;
const app = Fastify();
let user = 'admin';
const link = vi.fn(() => Promise.resolve({ linked: true }));
beforeAll(async () => {
  ctx = await createTestDb();
  vi.spyOn(ctx.store, 'isActiveAdministrator').mockImplementation((id) =>
    Promise.resolve(id === 'admin'),
  );
  for (const id of ['first', 'second'])
    await ctx.store.forgeConnections.upsert({
      id,
      provider: 'forgejo',
      baseUrl: 'https://forge.test/prefix',
      label: id,
      personalToken: 'fixture',
      githubAppId: null,
      githubAppInstallationId: null,
      githubAppPrivateKey: null,
    });
  app.addHook('onRequest', (request) => {
    request.localUserId = user;
    return Promise.resolve();
  });
  registerProjectCollectionRoutes(app, {
    store: ctx.store,
    forgejoEnabled: true,
    listOverview: () => Promise.resolve([]),
    reorder: () => Promise.resolve([]),
    listAvailableRepositories: () => ctx.store.listProjects(),
    presentRepositories: (projects) => Promise.resolve(projects),
    localIdentityReservations: new Set(),
    githubTargetReservations: new Set(),
    isUniqueViolation: () => false,
  });
  registerProjectGitHubLinkRoute(app, { isAvailable: () => true, link });
  await app.ready();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await app.close();
  await ctx.close();
});
it('creates isolated projects for identical coordinates on two connections', async () => {
  const projects = [];
  for (const connectionId of ['first', 'second']) {
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { kind: 'forgejo', repo: 'owner/repo', connectionId },
    });
    expect(response.statusCode).toBe(201);
    projects.push(
      response.json<{
        project: { id: string; containerName: string; cloneDir: string; forgeConnectionId: string };
      }>().project,
    );
  }
  expect(projects[0]?.id).not.toBe(projects[1]?.id);
  expect(projects[0]?.containerName).not.toBe(projects[1]?.containerName);
  expect(projects[0]?.cloneDir).not.toBe(projects[1]?.cloneDir);
  expect(projects.map((project) => project.forgeConnectionId)).toEqual(['first', 'second']);
  expect((await app.inject('/github/repositories')).json()).toEqual([]);
});
it('requires administrator access and rejects foreign instance URLs or provider mismatches', async () => {
  user = 'member';
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/projects',
        payload: { repo: 'owner/private', connectionId: 'first' },
      })
    ).statusCode,
  ).toBe(403);
  user = 'admin';
  for (const payload of [
    { repo: 'https://other.test/prefix/owner/repo', connectionId: 'first' },
    { repo: 'owner/repo', kind: 'github', connectionId: 'first' },
  ])
    expect((await app.inject({ method: 'POST', url: '/projects', payload })).statusCode).toBe(400);
});
it('forwards the selected connection through generic linking and keeps the legacy route', async () => {
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/projects/local/link',
        payload: { repo: 'owner/repo', connectionId: 'first' },
      })
    ).statusCode,
  ).toBe(200);
  expect(link).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.anything(),
    'local',
    'owner/repo',
    'first',
  );
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/projects/local/link-github',
        payload: { repo: 'owner/repo' },
      })
    ).statusCode,
  ).toBe(200);
  expect(link).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.anything(),
    'local',
    'owner/repo',
  );
});
