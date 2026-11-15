import Fastify from 'fastify';
import { createTestDb, type TestDb } from '@verity/store/testing';
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { registerGoogleAccountRoutes } from './google-account-routes.js';
import { registerGoogleConnectRoutes } from './google-connect-routes.js';

/** Routes without a signed-in person act for the installation's administrator. */
const ADMIN = '00000000-0000-4000-8000-000000000001';
const BOB = 'google-routes-bob';
const GMAIL_SCOPES = ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic'].map(
  (scope) => `https://www.googleapis.com/auth/${scope}`,
);
let ctx: TestDb;
const app = Fastify();
// `x-test-user` stands in for the paired-device bearer that sets `localUserId`.
app.decorateRequest('localUserId', null);
app.addHook('onRequest', async (request) => {
  const user = request.headers['x-test-user'];
  if (typeof user === 'string') request.localUserId = user;
});
beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.db.insertInto('users').values({ id: BOB, role: 'member', status: 'active' }).execute();
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
    ownerUserId: ADMIN,
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
    ownerUserId: ADMIN,
    email: 'oauth-one@example.test',
    clientId: 'client',
    refreshToken: 'original-one',
    scopes: [],
  });
  const two = await ctx.store.googleAccounts.save({
    ownerUserId: ADMIN,
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
      (await ctx.store.googleAccounts.effectiveAccess('account-api', 'gmail', ADMIN))?.account.id,
    ).toBe(one.id);
  } finally {
    await oauth.close();
  }
});

it("keeps each person's Google accounts out of another person's reach", async () => {
  const bobs = await ctx.store.googleAccounts.save({
    ownerUserId: BOB,
    email: 'bob@example.test',
    clientId: 'client',
    refreshToken: 'bob-refresh',
    scopes: GMAIL_SCOPES,
  });
  const asBob = { 'x-test-user': BOB };

  type Listed = { accounts: { id: string }[] };
  const adminList = (await app.inject({ method: 'GET', url: '/google/accounts' })).json<Listed>();
  expect(adminList.accounts.map((account) => account.id)).not.toContain(bobs.id);
  const bobList = (
    await app.inject({ method: 'GET', url: '/google/accounts', headers: asBob })
  ).json<Listed>();
  expect(bobList.accounts.map((account) => account.id)).toEqual([bobs.id]);

  // Renaming someone else's account must not succeed silently.
  const rename = await app.inject({
    method: 'PATCH',
    url: `/google/accounts/${bobs.id}`,
    payload: { displayName: 'Taken over' },
  });
  expect(rename.statusCode).toBe(404);
  expect((await ctx.store.googleAccounts.get(bobs.id))?.displayName).toBeNull();

  // Removing someone else's account must not delete their credentials.
  const removal = await app.inject({ method: 'DELETE', url: `/google/accounts/${bobs.id}` });
  expect(removal.statusCode).toBe(404);
  expect(await ctx.store.googleAccounts.get(bobs.id)).toBeDefined();

  // Pinning a chat to Bob's account would let the administrator's turns use his mailbox.
  const url = '/sessions/account-api/google/gmail';
  const pin = await app.inject({
    method: 'PUT',
    url,
    payload: { mode: 'account', accountId: bobs.id },
  });
  expect(pin.statusCode).toBe(409);
  expect(await ctx.store.googleAccounts.sessionAccess('account-api', 'gmail')).toEqual({
    mode: 'inherit',
  });

  const own = await app.inject({
    method: 'PUT',
    url,
    headers: asBob,
    payload: { mode: 'account', accountId: bobs.id },
  });
  expect(own.json()).toMatchObject({ enabled: true, source: 'session', accountId: bobs.id });
  // The chat's explicit account is Bob's; the administrator viewing it must not see it enabled.
  expect((await app.inject({ method: 'GET', url })).json()).toMatchObject({ enabled: false });
});
