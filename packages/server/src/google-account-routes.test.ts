import Fastify from 'fastify';
import { createTestDb, type TestDb } from '@verity/store/testing';
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { registerGoogleAccountRoutes } from './google-account-routes.js';
import { registerGoogleConnectRoutes } from './google-connect-routes.js';
let ctx: TestDb;
const app = Fastify();
beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.store.createSession({
    sessionId: 'account-api',
    worktree: '/account-api',
    model: 'test',
  });
  registerGoogleAccountRoutes(app, ctx.store);
  await app.ready();
});
beforeEach(async () => {
  await ctx.store.googleAccounts.setSessionAccess('account-api', 'gmail', { mode: 'inherit' });
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});
it('never exposes tokens and applies chat-only exceptions', async () => {
  const account = await ctx.store.googleAccounts.save({
    email: 'api@example.com',
    clientId: 'client',
    refreshToken: 'hidden-refresh',
    scopes: ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic'].map(
      (scope) => `https://www.googleapis.com/auth/${scope}`,
    ),
  });
  const listed = await app.inject({ method: 'GET', url: '/google/accounts' });
  expect(listed.body).not.toContain('hidden-refresh');
  expect(listed.json().accounts).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: account.id })]),
  );
  const url = '/sessions/account-api/google/gmail';
  expect((await app.inject({ method: 'GET', url })).json()).toMatchObject({
    mode: 'inherit',
    enabled: false,
  });
  expect(
    (
      await app.inject({ method: 'PUT', url, payload: { mode: 'account', accountId: account.id } })
    ).json(),
  ).toMatchObject({ enabled: true, source: 'session', accountId: account.id });
  expect(
    (await app.inject({ method: 'PUT', url, payload: { mode: 'disabled' } })).json(),
  ).toMatchObject({ enabled: false, mode: 'disabled' });
  expect(
    (await app.inject({ method: 'PUT', url, payload: { mode: 'account', accountId: 'missing' } }))
      .statusCode,
  ).toBe(409);
  expect(
    (await app.inject({ method: 'PUT', url, payload: { mode: 'inherit' } })).json(),
  ).toMatchObject({ mode: 'inherit', enabled: false });
});

it('rejects mismatched OAuth upgrades without replacing either account or grant', async () => {
  const one = await ctx.store.googleAccounts.save({
    email: 'oauth-one@example.test',
    clientId: 'client',
    refreshToken: 'original-one',
    scopes: [],
  });
  const two = await ctx.store.googleAccounts.save({
    email: 'oauth-two@example.test',
    clientId: 'client',
    refreshToken: 'original-two',
    scopes: [],
  });
  await ctx.store.googleAccounts.setSessionAccess('account-api', 'gmail', {
    mode: 'account',
    accountId: one.id,
  });
  const oauth = Fastify();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'access',
          refresh_token: 'replacement',
          expires_in: 3600,
          scope: ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic']
            .map((scope) => 'https://www.googleapis.com/auth/' + scope)
            .join(' '),
        }),
      ),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ email: two.email, id: 'subject-two' })));
  registerGoogleConnectRoutes(oauth, { eventStore: ctx.store, googleClientId: 'client', fetch });
  try {
    const response = await oauth.inject({
      method: 'POST',
      url: '/google/connect',
      payload: {
        accountId: one.id,
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: 'verity://oauth',
      },
    });
    expect(response.statusCode).toBe(409);
    expect((await ctx.store.googleAccounts.credentials(one.id))?.refreshToken).toBe('original-one');
    expect((await ctx.store.googleAccounts.credentials(two.id))?.refreshToken).toBe('original-two');
    expect(
      (await ctx.store.googleAccounts.effectiveAccess('account-api', 'gmail'))?.account.id,
    ).toBe(one.id);
  } finally {
    await oauth.close();
  }
});
