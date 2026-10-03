import Fastify from 'fastify';
import { createTestDb, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { registerProjectGoogleRoutes } from './project-google-routes.js';
let ctx: TestDb;
const app = Fastify();
beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.store.upsertProject({
    id: 'google-route-p',
    owner: 'local',
    repo: 'test',
    containerName: 'test',
    state: 'active',
  });
  registerProjectGoogleRoutes(app, ctx.store);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});
it('requires service consent before allowing explicit project access', async () => {
  const url = '/projects/google-route-p/google/gmail';
  expect(
    (await app.inject({ method: 'PUT', url: '/projects/google-route-p/google/unknown' }))
      .statusCode,
  ).toBe(400);
  expect((await app.inject({ method: 'PUT', url })).statusCode).toBe(409);
  await ctx.store.updateVeritySettings({
    googleDriveAccountEmail: 'me@example.test',
    googleDriveRefreshToken: 'test-refresh',
    gmailAuthorized: true,
    googleGrantedScopes: ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic'].map(
      (scope) => `https://www.googleapis.com/auth/${scope}`,
    ),
  });
  expect((await app.inject({ method: 'GET', url })).json()).toMatchObject({
    enabled: false,
    connected: true,
  });
  expect((await app.inject({ method: 'PUT', url })).json()).toMatchObject({ enabled: true });
  expect((await app.inject({ method: 'GET', url })).json()).toMatchObject({ enabled: true });
  expect(
    (await app.inject({ method: 'PUT', url: '/projects/google-route-p/google/contacts' }))
      .statusCode,
  ).toBe(409);
  await app.inject({ method: 'DELETE', url });
  expect((await app.inject({ method: 'GET', url })).json()).toMatchObject({ enabled: false });
  expect(
    (await app.inject({ method: 'PUT', url: '/projects/missing/google/gmail' })).statusCode,
  ).toBe(404);
});
