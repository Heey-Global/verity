import Fastify, { type FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerGoogleConnectRoutes } from './google-connect-routes.js';
import {
  hasGoogleCalendarScopes,
  hasGoogleContactsScopes,
  hasGoogleDriveScopes,
  hasGoogleGmailScopes,
} from './google-oauth-scopes.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
const GMAIL = ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic'].map(scope);
const ALL = [
  scope('drive'),
  ...GMAIL,
  scope('calendar.calendarlist.readonly'),
  scope('calendar.events'),
  scope('contacts.readonly'),
  scope('userinfo.email'),
];
const payload = { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' };

interface GoogleReplies {
  scopes?: string[];
  refreshToken?: string | null;
  email?: string;
  subject?: string;
  userinfoStatus?: number;
}

/** Answers the token exchange and the identity lookup by URL, recording both. */
function googleFetch(replies: GoogleReplies = {}) {
  return vi.fn<(url: string, init?: { body?: unknown }) => Promise<Response>>(async (url) => {
    if (url === TOKEN_URL) {
      return new Response(
        JSON.stringify({
          access_token: 'access',
          expires_in: 3600,
          scope: (replies.scopes ?? ALL).join(' '),
          ...(replies.refreshToken === null
            ? {}
            : { refresh_token: replies.refreshToken ?? 'refresh' }),
        }),
      );
    }
    if (url === USERINFO_URL) {
      return new Response(
        JSON.stringify({
          email: replies.email ?? 'you@example.test',
          id: replies.subject ?? 'subject-you',
        }),
        { status: replies.userinfoStatus ?? 200 },
      );
    }
    throw new Error(`unexpected Google request ${url}`);
  });
}

let ctx: TestDb;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  ctx = await createTestDb();
});
beforeEach(async () => {
  for (const account of await ctx.store.googleAccounts.list())
    await ctx.store.googleAccounts.remove(account.id);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});
afterAll(async () => {
  await ctx.close();
});

async function connectApp(
  fetch: ReturnType<typeof googleFetch>,
  extra: Partial<Parameters<typeof registerGoogleConnectRoutes>[1]> = {},
) {
  app = Fastify();
  registerGoogleConnectRoutes(app, {
    eventStore: ctx.store,
    googleClientId: 'production-client',
    stagingGoogleClientId: 'staging-client',
    fetch,
    ...extra,
  });
  await app.ready();
  return app;
}

describe('POST /google/connect', () => {
  it('stores one account for every granted service and notifies credential holders', async () => {
    const fetch = googleFetch();
    const onCredentialsChanged = vi.fn();
    const server = await connectApp(fetch, { onCredentialsChanged });

    const response = await server.inject({ method: 'POST', url: '/google/connect', payload });

    expect(response.statusCode, response.body).toBe(200);
    const [account] = await ctx.store.googleAccounts.list();
    expect(response.json()).toEqual({
      connected: true,
      accountEmail: 'you@example.test',
      accountId: account!.id,
      scopes: ALL,
    });
    expect(account).toMatchObject({ email: 'you@example.test', subject: 'subject-you' });
    expect((await ctx.store.googleAccounts.credentials(account!.id))?.refreshToken).toBe('refresh');
    // Readers that predate the account registry still see the lone account.
    expect(await ctx.store.getVeritySettings()).toMatchObject({
      googleDriveClientId: 'production-client',
      googleDriveRefreshToken: 'refresh',
      googleDriveAccountEmail: 'you@example.test',
      gmailAuthorized: true,
      calendarAuthorized: true,
      contactsAuthorized: true,
    });
    expect(onCredentialsChanged).toHaveBeenCalledOnce();
  });

  it('keeps a partial consent instead of discarding the services the user did grant', async () => {
    const server = await connectApp(googleFetch({ scopes: [...GMAIL, scope('userinfo.email')] }));

    const response = await server.inject({ method: 'POST', url: '/google/connect', payload });

    expect(response.statusCode, response.body).toBe(200);
    const [account] = await ctx.store.googleAccounts.list();
    expect(response.json().scopes).toEqual(account!.scopes);
    expect(hasGoogleGmailScopes(account!.scopes)).toBe(true);
    expect(hasGoogleDriveScopes(account!.scopes)).toBe(false);
    expect(hasGoogleCalendarScopes(account!.scopes)).toBe(false);
    expect(hasGoogleContactsScopes(account!.scopes)).toBe(false);
    expect(await ctx.store.getVeritySettings()).toMatchObject({
      gmailAuthorized: true,
      calendarAuthorized: false,
      contactsAuthorized: false,
    });
  });

  // A lone editor scope is not a usable service: the app shows such an account as missing
  // everything, so storing it would leave an account that grants nothing.
  it.each([[[scope('userinfo.email')]], [[scope('userinfo.email'), scope('presentations')]]])(
    'rejects a consent that grants no complete Google service: %j',
    async (scopes) => {
      const onCredentialsChanged = vi.fn();
      const server = await connectApp(googleFetch({ scopes }), {
        onCredentialsChanged,
      });

      const response = await server.inject({ method: 'POST', url: '/google/connect', payload });

      expect(response.statusCode).toBe(400);
      expect(await ctx.store.googleAccounts.list()).toEqual([]);
      expect(onCredentialsChanged).not.toHaveBeenCalled();
    },
  );

  it('rejects a grant without a refresh token', async () => {
    const server = await connectApp(googleFetch({ refreshToken: null }));

    const response = await server.inject({ method: 'POST', url: '/google/connect', payload });

    expect(response.statusCode).toBe(400);
    expect(await ctx.store.googleAccounts.list()).toEqual([]);
  });

  it('refuses to reconnect a selected account as a different signed-in account', async () => {
    const selected = await ctx.store.googleAccounts.save({
      email: 'selected@example.test',
      clientId: 'production-client',
      refreshToken: 'original',
      scopes: ALL,
    });
    const server = await connectApp(googleFetch({ email: 'other@example.test' }));

    const response = await server.inject({
      method: 'POST',
      url: '/google/connect',
      payload: { ...payload, accountId: selected.id },
    });

    expect(response.statusCode).toBe(409);
    expect((await ctx.store.googleAccounts.list()).map((account) => account.id)).toEqual([
      selected.id,
    ]);
    expect((await ctx.store.googleAccounts.credentials(selected.id))?.refreshToken).toBe(
      'original',
    );
  });

  it.each([
    [undefined, 'production-client'],
    ['production', 'production-client'],
    ['staging', 'staging-client'],
  ])('exchanges the code with the client of app variant %s', async (variant, clientId) => {
    const fetch = googleFetch();
    const server = await connectApp(fetch);

    const response = await server.inject({
      method: 'POST',
      url: '/google/connect',
      ...(variant === undefined ? {} : { headers: { 'x-verity-app-variant': variant } }),
      payload,
    });

    expect(response.statusCode, response.body).toBe(200);
    const exchange = fetch.mock.calls.find(([url]) => url === TOKEN_URL);
    expect(new URLSearchParams(String(exchange?.[1]?.body)).get('client_id')).toBe(clientId);
    expect((await ctx.store.googleAccounts.list())[0]?.clientId).toBe(clientId);
  });

  it('never exchanges a code for an unknown app variant', async () => {
    const fetch = googleFetch();
    const server = await connectApp(fetch);

    const response = await server.inject({
      method: 'POST',
      url: '/google/connect',
      headers: { 'x-verity-app-variant': 'arbitrary-client' },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('touches neither Google nor the store while the secret store is sealed', async () => {
    const fetch = googleFetch();
    const server = await connectApp(fetch, { secretCipher: { isSealed: () => true } as never });

    const response = await server.inject({ method: 'POST', url: '/google/connect', payload });

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(fetch).not.toHaveBeenCalled();
    expect(await ctx.store.googleAccounts.list()).toEqual([]);
  });

  it('stores nothing when the signed-in identity cannot be verified', async () => {
    const onCredentialsChanged = vi.fn();
    const server = await connectApp(googleFetch({ userinfoStatus: 401 }), {
      onCredentialsChanged,
    });

    const response = await server.inject({ method: 'POST', url: '/google/connect', payload });

    expect(response.statusCode).toBe(502);
    expect(await ctx.store.googleAccounts.list()).toEqual([]);
    expect(onCredentialsChanged).not.toHaveBeenCalled();
  });
});
