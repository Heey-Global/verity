import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '@verity/store/testing';
import { registerForgeConnectionRoutes } from './forge-connection-routes.js';
import { ForgejoRequestError, ForgejoTransport } from './forgejo-transport.js';
let ctx: TestDb;
const app = Fastify();
let user: string | undefined;
let connectionId: string;
beforeAll(async () => {
  ctx = await createTestDb();
  vi.spyOn(ctx.store, 'isActiveAdministrator').mockImplementation(async (id) => id === 'admin');
  app.addHook('onRequest', async (request) => {
    request.localUserId = user ?? null;
  });
  registerForgeConnectionRoutes(app, ctx.store);
  await app.ready();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await app.close();
  await ctx.close();
});
it('requires administrator access for metadata and credential mutation', async () => {
  for (const identity of [undefined, 'member']) {
    user = identity;
    expect((await app.inject('/connections')).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/connections', payload: {} })).statusCode,
    ).toBe(403);
  }
});
it('validates before persistence and never returns tokens', async () => {
  user = 'admin';
  const validate = vi.spyOn(ForgejoTransport.prototype, 'validate').mockResolvedValue();
  const response = await app.inject({
    method: 'POST',
    url: '/connections',
    payload: {
      baseUrl: 'https://forge.test/prefix',
      label: 'Forge',
      token: 'private-fixture',
    },
  });
  expect(response.statusCode).toBe(201);
  expect(validate).toHaveBeenCalledOnce();
  connectionId = response.json<{ id: string }>().id;
  expect(response.body).not.toContain('private-fixture');
  const listed = await app.inject('/connections');
  expect(listed.body).not.toContain('private-fixture');
  // Without the sandbox relay the app must not offer Forgejo project creation.
  expect(listed.json<{ forgejoProjectsAvailable: boolean }>().forgejoProjectsAvailable).toBe(false);
  validate.mockRejectedValueOnce(new Error('provider body contains private-fixture'));
  const failed = await app.inject({
    method: 'PATCH',
    url: `/connections/${connectionId}`,
    payload: { token: 'new-fixture' },
  });
  expect(failed.statusCode).toBe(422);
  expect(failed.body).not.toContain('private-fixture');
  expect((await ctx.store.forgeConnections.credentials(connectionId))?.personalToken).toBe(
    'private-fixture',
  );
  const rotated = await app.inject({
    method: 'PATCH',
    url: `/connections/${connectionId}`,
    payload: { token: 'rotated-fixture' },
  });
  expect(rotated.statusCode).toBe(200);
  expect((await ctx.store.forgeConnections.credentials(connectionId))?.personalToken).toBe(
    'rotated-fixture',
  );
});
it('protects connections referenced by projects', async () => {
  await ctx.store.createProject({
    id: 'bound',
    kind: 'forgejo',
    forgeConnectionId: connectionId,
    owner: 'owner',
    repo: 'repo',
    state: 'absent',
    containerName: 'bound',
  });
  expect(
    (await app.inject({ method: 'DELETE', url: `/connections/${connectionId}` })).statusCode,
  ).toBe(409);
  await ctx.store.deleteProject('bound');
  expect(
    (await app.inject({ method: 'DELETE', url: `/connections/${connectionId}` })).statusCode,
  ).toBe(204);
});

it('reports Forgejo project availability from the sandbox capability', async () => {
  const enabled = Fastify();
  enabled.addHook('onRequest', async (request) => {
    request.localUserId = 'admin';
  });
  registerForgeConnectionRoutes(enabled, ctx.store, undefined, true);
  await enabled.ready();
  try {
    const response = await enabled.inject('/connections');
    expect(response.json<{ forgejoProjectsAvailable: boolean }>().forgejoProjectsAvailable).toBe(
      true,
    );
  } finally {
    await enabled.close();
  }
});

it('explains scope failures without reflecting token values', async () => {
  user = 'admin';
  vi.spyOn(ForgejoTransport.prototype, 'validate').mockRejectedValueOnce(
    new ForgejoRequestError(403),
  );
  const response = await app.inject({
    method: 'POST',
    url: '/connections',
    payload: {
      baseUrl: 'https://forge.test',
      label: 'Restricted',
      token: 'never-reflect-this-token',
    },
  });
  expect(response.statusCode).toBe(422);
  expect(response.json()).toEqual({
    error: 'Forgejo connection validation failed: token lacks repository access or scope',
  });
  expect(response.body).not.toContain('never-reflect-this-token');
});
