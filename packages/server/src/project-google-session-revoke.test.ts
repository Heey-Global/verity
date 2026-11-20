import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@verity/store/testing';
import { registerGmailRoutes } from './gmail-routes.js';
import { registerGoogleCalendarRoutes } from './google-calendar-routes.js';
import { registerGoogleContactsRoutes } from './google-contacts-routes.js';

/** Routes without a signed-in person act for the installation's administrator. */
const ADMIN = '00000000-0000-4000-8000-000000000001';

let ctx: TestDb;
const app = Fastify();
beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.store.upsertProject({
    id: 'p1',
    kind: 'local',
    owner: 'local',
    repo: 'test',
    containerName: 'test',
    state: 'active',
  });
  await ctx.store.createSession({
    sessionId: 's1',
    projectId: 'p1',
    worktree: '/wt',
    model: 'default',
  });
  registerGmailRoutes(app, { eventStore: ctx.store });
  registerGoogleCalendarRoutes(app, { eventStore: ctx.store });
  registerGoogleContactsRoutes(app, { eventStore: ctx.store });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});

it.each(['gmail', 'calendar', 'contacts'] as const)(
  'does not falsely report inherited %s access as revoked to older clients',
  async (service) => {
    const get =
      service === 'gmail'
        ? ctx.store.getSessionGmailConnection.bind(ctx.store)
        : service === 'calendar'
          ? ctx.store.getSessionCalendarConnection.bind(ctx.store)
          : ctx.store.getSessionContactsConnection.bind(ctx.store);
    const enable =
      service === 'gmail'
        ? ctx.store.enableSessionGmail.bind(ctx.store)
        : service === 'calendar'
          ? ctx.store.enableSessionCalendar.bind(ctx.store)
          : ctx.store.enableSessionContacts.bind(ctx.store);
    await enable('s1', 'me@example.test', ADMIN);
    expect(
      (await app.inject({ method: 'DELETE', url: `/sessions/s1/${service}` })).statusCode,
    ).toBe(204);
    expect(await get('s1', ADMIN)).toBeUndefined();

    await ctx.store.enableProjectGoogleConnection('p1', service, 'me@example.test', ADMIN);
    const inherited = await app.inject({ method: 'DELETE', url: `/sessions/s1/${service}` });
    expect(inherited.statusCode).toBe(409);
    expect(inherited.json()).toMatchObject({ error: expect.stringContaining('project settings') });
    expect(await get('s1', ADMIN)).toBeDefined();

    await enable('s1', 'me@example.test', ADMIN);
    expect(
      (await app.inject({ method: 'DELETE', url: `/sessions/s1/${service}` })).statusCode,
    ).toBe(409);
    expect(await get('s1', ADMIN)).toBeDefined();
    await ctx.store.disableProjectGoogleConnection('p1', service, ADMIN);
    expect(await get('s1', ADMIN)).toBeUndefined();
  },
);
