import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '@verity/store/testing';
import { sessionGoogleStatus } from './session-google-status.js';
import { registerGmailRoutes } from './gmail-routes.js';
import { registerGoogleCalendarRoutes } from './google-calendar-routes.js';
import { registerGoogleContactsRoutes } from './google-contacts-routes.js';
import { registerSessionReadRoutes } from './session-read-routes.js';

let ctx: TestDb;
const app = Fastify();
beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.store.createSession({ sessionId: 'status', worktree: '/status', model: 'test' });
  registerGmailRoutes(app, { eventStore: ctx.store });
  registerGoogleCalendarRoutes(app, { eventStore: ctx.store });
  registerGoogleContactsRoutes(app, { eventStore: ctx.store });
  registerSessionReadRoutes(app, {
    listModels: async () => ({}),
    getSession: async (id) =>
      (await ctx.store.getSession(id))
        ? { googleStatus: await sessionGoogleStatus(ctx.store, id) }
        : undefined,
    getGoogleStatus: async (id) =>
      (await ctx.store.getSession(id)) ? sessionGoogleStatus(ctx.store, id) : undefined,
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});

it('matches effective service routes and preserves documents without tokens or Google requests', async () => {
  const account = await ctx.store.googleAccounts.save({
    email: 'status@example.test',
    clientId: 'client',
    refreshToken: 'never-export-this',
    scopes: [
      'gmail.readonly',
      'gmail.compose',
      'gmail.settings.basic',
      'calendar.calendarlist.readonly',
      'calendar.events',
      'contacts.readonly',
    ].map((s) => 'https://www.googleapis.com/auth/' + s),
  });
  await ctx.store.googleAccounts.setSessionAccess('status', 'gmail', {
    mode: 'account',
    accountId: account.id,
  });
  await ctx.store.googleAccounts.setSessionAccess('status', 'calendar', { mode: 'disabled' });
  await ctx.store.setSessionWorkspaceFile({
    sessionId: 'status',
    kind: 'docs',
    fileId: 'doc',
    name: 'Working doc',
    webViewLink: 'https://docs.google.com/document/d/doc',
  });
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Unexpected provider call'));
  const credentials = vi
    .spyOn(ctx.store.googleAccounts, 'credentials')
    .mockRejectedValue(new Error('Unexpected credential access'));
  try {
    const detail = (await app.inject('/sessions/status')).json();
    const compact = (await app.inject('/sessions/status/google-status')).json();
    expect(compact).toEqual(detail.googleStatus);
    expect(compact.workspaceFile.name).toBe('Working doc');
    for (const service of ['gmail', 'calendar', 'contacts']) {
      const separate = (await app.inject(`/sessions/status/${service}`)).json();
      const presentation = { ...separate };
      delete presentation.clientId;
      expect(compact[service]).toMatchObject(presentation);
    }
    expect(compact.gmail).toMatchObject({ enabled: true, source: 'session' });
    expect(compact.calendar).toMatchObject({ enabled: false, mode: 'disabled' });
    expect(JSON.stringify(compact)).not.toContain('never-export-this');
    expect(fetch).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    credentials.mockRestore();
  }
});

it('rejects missing sessions and leaves legacy stores on the compatibility path', async () => {
  expect((await app.inject('/sessions/missing/google-status')).statusCode).toBe(404);
  expect(
    await sessionGoogleStatus({ googleAccounts: undefined } as never, 'status'),
  ).toBeUndefined();
});

it('resolves project inheritance, session overrides and account removal from local state', async () => {
  await ctx.store.createProject({
    id: 'status-project',
    kind: 'local',
    owner: '__local__',
    repo: 'status',
    cloneDir: 'status',
    containerName: 'status',
    state: 'active',
  });
  await ctx.store.createSession({
    sessionId: 'inherited',
    projectId: 'status-project',
    worktree: '/inherited',
    model: 'test',
  });
  const account = await ctx.store.googleAccounts.save({
    email: 'inherited@example.test',
    clientId: 'client',
    refreshToken: 'local-only',
    scopes: ['https://www.googleapis.com/auth/contacts.readonly'],
  });
  await ctx.store.googleAccounts.setProjectAccess('status-project', 'contacts', account.id);
  expect((await sessionGoogleStatus(ctx.store, 'inherited'))?.contacts).toMatchObject({
    enabled: true,
    source: 'project',
    mode: 'inherit',
    accountId: account.id,
  });
  await ctx.store.googleAccounts.setSessionAccess('inherited', 'contacts', { mode: 'disabled' });
  expect((await sessionGoogleStatus(ctx.store, 'inherited'))?.contacts.enabled).toBe(false);
  await ctx.store.googleAccounts.setSessionAccess('inherited', 'contacts', { mode: 'inherit' });
  await ctx.store.googleAccounts.remove(account.id);
  expect((await sessionGoogleStatus(ctx.store, 'inherited'))?.contacts.enabled).toBe(false);
});
