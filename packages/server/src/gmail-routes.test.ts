import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerGmailRoutes } from './gmail-routes.js';

function googleResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

describe('Gmail routes', () => {
  it('stores expanded Google consent and enables it only for an existing session', async () => {
    let settings = {
      googleDriveClientId: 'client',
      googleDriveRefreshToken: null as string | null,
      googleDriveAccountEmail: null as string | null,
      gmailAuthorized: false,
    };
    let connection: { sessionId: string; enabledAt: Date } | undefined;
    const store = {
      getVeritySettings: vi.fn(async () => settings),
      updateVeritySettings: vi.fn(async (patch: Partial<typeof settings>) => {
        settings = { ...settings, ...patch };
        return settings;
      }),
      getSession: vi.fn(async (id: string) => (id === 's1' ? { sessionId: id } : undefined)),
      getSessionGmailConnection: vi.fn(async () => connection),
      enableSessionGmail: vi.fn(async (sessionId: string) => {
        connection ??= { sessionId, enabledAt: new Date('2026-09-23T12:00:00.000Z') };
        return connection;
      }),
      disableSessionGmail: vi.fn(async () => {
        connection = undefined;
      }),
      clearSessionContactsConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionCalendarConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionGmailConnections: vi.fn(async () => {
        connection = undefined;
      }),
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        googleResponse({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          scope:
            'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.settings.basic',
        }),
      )
      .mockResolvedValueOnce(googleResponse({ emailAddress: 'you@example.com' }));
    const app = Fastify();
    const onCredentialsChanged = vi.fn();
    registerGmailRoutes(app, {
      eventStore: store as never,
      googleClientId: 'client',
      fetch,
      onCredentialsChanged,
    });
    await app.ready();

    expect((await app.inject({ method: 'GET', url: '/sessions/s1/gmail' })).json()).toEqual({
      enabled: false,
      connected: false,
      clientId: 'client',
      accountEmail: null,
    });
    expect((await app.inject({ method: 'PUT', url: '/sessions/s1/gmail' })).statusCode).toBe(409);
    const connected = await app.inject({
      method: 'POST',
      url: '/gmail/connect',
      payload: { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' },
    });
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toEqual({ connected: true, accountEmail: 'you@example.com' });
    expect(settings).toMatchObject({
      googleDriveRefreshToken: 'refresh',
      googleDriveAccountEmail: 'you@example.com',
      gmailAuthorized: true,
    });
    expect(onCredentialsChanged).toHaveBeenCalledOnce();

    const enabled = await app.inject({ method: 'PUT', url: '/sessions/s1/gmail' });
    expect(enabled.json()).toEqual({
      enabled: true,
      connected: true,
      clientId: 'client',
      accountEmail: 'you@example.com',
    });
    expect((await app.inject({ method: 'PUT', url: '/sessions/missing/gmail' })).statusCode).toBe(
      404,
    );

    expect((await app.inject({ method: 'DELETE', url: '/sessions/s1/gmail' })).statusCode).toBe(
      204,
    );
    await app.close();
  });

  it('rejects partial Gmail consent without persisting authorization', async () => {
    const updateVeritySettings = vi.fn();
    const store = {
      getVeritySettings: vi.fn(async () => ({
        googleDriveClientId: 'client',
        googleDriveRefreshToken: null,
        googleDriveAccountEmail: null,
        gmailAuthorized: false,
      })),
      updateVeritySettings,
      getSession: vi.fn(),
      getSessionGmailConnection: vi.fn(),
      enableSessionGmail: vi.fn(),
      disableSessionGmail: vi.fn(),
      clearSessionGmailConnections: vi.fn(),
    };
    const app = Fastify();
    registerGmailRoutes(app, {
      eventStore: store as never,
      googleClientId: 'client',
      fetch: vi.fn().mockResolvedValue(
        googleResponse({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
        }),
      ),
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/gmail/connect',
      payload: { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' },
    });
    expect(response.statusCode).toBe(400);
    expect(updateVeritySettings).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    {
      name: 'preserves Calendar grants on same-account expanded consent',
      email: 'old@example.com',
      calendarScopes: true,
      clear: false,
    },
    {
      name: 'revokes Calendar grants when its scopes are absent',
      email: 'old@example.com',
      calendarScopes: false,
      clear: true,
    },
    {
      name: 'revokes both session grants on account switch',
      email: 'new@example.com',
      calendarScopes: true,
      clear: true,
    },
  ])('$name', async ({ email, calendarScopes, clear }) => {
    const clearSessionGmailConnections = vi.fn().mockResolvedValue(undefined);
    const updateVeritySettings = vi.fn().mockResolvedValue(undefined);
    const store = {
      getVeritySettings: vi.fn(async () => ({
        googleDriveClientId: 'client',
        googleDriveRefreshToken: 'old-refresh',
        googleDriveAccountEmail: 'old@example.com',
        gmailAuthorized: true,
      })),
      updateVeritySettings,
      getSession: vi.fn(),
      getSessionGmailConnection: vi.fn(),
      enableSessionGmail: vi.fn(),
      disableSessionGmail: vi.fn(),
      clearSessionGmailConnections,
      clearSessionContactsConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionCalendarConnections: vi.fn().mockResolvedValue(undefined),
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        googleResponse({
          access_token: 'access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
          scope:
            'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.settings.basic' +
            (calendarScopes
              ? ' https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events'
              : ''),
        }),
      )
      .mockResolvedValueOnce(googleResponse({ emailAddress: email }));
    const app = Fastify();
    registerGmailRoutes(app, { eventStore: store as never, googleClientId: 'client', fetch });
    await app.ready();

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gmail/connect',
          payload: { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' },
        })
      ).statusCode,
    ).toBe(200);
    expect(clearSessionGmailConnections).toHaveBeenCalledTimes(email === 'old@example.com' ? 0 : 1);
    expect(store.clearSessionCalendarConnections).toHaveBeenCalledTimes(clear ? 1 : 0);
    expect(updateVeritySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        googleDriveAccountEmail: email,
        calendarAuthorized: calendarScopes,
      }),
    );
    await app.close();
  });
});
