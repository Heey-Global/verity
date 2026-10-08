import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerGoogleContactsRoutes } from './google-contacts-routes.js';

function googleResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

describe('Contacts routes', () => {
  it('stores expanded Google consent and enables it only for an existing session', async () => {
    let settings = {
      googleDriveClientId: 'client',
      googleDriveRefreshToken: null as string | null,
      googleDriveAccountEmail: null as string | null,
      contactsAuthorized: false,
    };
    let connection: { sessionId: string; enabledAt: Date } | undefined;
    const store = {
      getVeritySettings: vi.fn(async () => settings),
      updateVeritySettings: vi.fn(async (patch: Partial<typeof settings>) => {
        settings = { ...settings, ...patch };
        return settings;
      }),
      getSession: vi.fn(async (id: string) => (id === 's1' ? { sessionId: id } : undefined)),
      getSessionContactsConnection: vi.fn(async () => connection),
      enableSessionContacts: vi.fn(async (sessionId: string) => {
        connection ??= { sessionId, enabledAt: new Date('2026-09-23T12:00:00.000Z') };
        return connection;
      }),
      disableSessionContacts: vi.fn(async () => {
        connection = undefined;
      }),
      clearSessionGmailConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionCalendarConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionContactsConnections: vi.fn(async () => {
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
            'https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/userinfo.email',
        }),
      )
      .mockResolvedValueOnce(googleResponse({ email: 'you@example.com' }));
    const app = Fastify();
    const onCredentialsChanged = vi.fn();
    registerGoogleContactsRoutes(app, {
      eventStore: store as never,
      googleClientId: 'client',
      fetch,
      onCredentialsChanged,
    });
    await app.ready();

    expect((await app.inject({ method: 'GET', url: '/sessions/s1/contacts' })).json()).toEqual({
      enabled: false,
      connected: false,
      clientId: 'client',
      accountEmail: null,
    });
    expect((await app.inject({ method: 'PUT', url: '/sessions/s1/contacts' })).statusCode).toBe(
      409,
    );
    const connected = await app.inject({
      method: 'POST',
      url: '/contacts/connect',
      payload: { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' },
    });
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toEqual({ connected: true, accountEmail: 'you@example.com' });
    expect(settings).toMatchObject({
      googleDriveRefreshToken: 'refresh',
      googleDriveAccountEmail: 'you@example.com',
      contactsAuthorized: true,
    });
    expect(onCredentialsChanged).toHaveBeenCalledOnce();

    const enabled = await app.inject({ method: 'PUT', url: '/sessions/s1/contacts' });
    expect(enabled.json()).toEqual({
      enabled: true,
      connected: true,
      clientId: 'client',
      accountEmail: 'you@example.com',
    });
    expect(
      (await app.inject({ method: 'PUT', url: '/sessions/missing/contacts' })).statusCode,
    ).toBe(404);

    expect((await app.inject({ method: 'DELETE', url: '/sessions/s1/contacts' })).statusCode).toBe(
      204,
    );
    await app.close();
  });

  it('rejects partial Contacts consent without persisting authorization', async () => {
    const updateVeritySettings = vi.fn();
    const store = {
      getVeritySettings: vi.fn(async () => ({
        googleDriveClientId: 'client',
        googleDriveRefreshToken: null,
        googleDriveAccountEmail: null,
        contactsAuthorized: false,
      })),
      updateVeritySettings,
      getSession: vi.fn(),
      getSessionContactsConnection: vi.fn(),
      enableSessionContacts: vi.fn(),
      disableSessionContacts: vi.fn(),
      clearSessionGmailConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionCalendarConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionContactsConnections: vi.fn(),
    };
    const app = Fastify();
    registerGoogleContactsRoutes(app, {
      eventStore: store as never,
      googleClientId: 'client',
      fetch: vi.fn().mockResolvedValue(
        googleResponse({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/contacts.readonly',
        }),
      ),
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/contacts/connect',
      payload: { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' },
    });
    expect(response.statusCode).toBe(400);
    expect(updateVeritySettings).not.toHaveBeenCalled();
    await app.close();
  });

  it('revokes existing session grants when Contacts changes accounts', async () => {
    const clearSessionContactsConnections = vi.fn().mockResolvedValue(undefined);
    const updateVeritySettings = vi.fn().mockResolvedValue(undefined);
    const store = {
      getVeritySettings: vi.fn(async () => ({
        googleDriveClientId: 'client',
        googleDriveRefreshToken: 'old-refresh',
        googleDriveAccountEmail: 'old@example.com',
        contactsAuthorized: true,
      })),
      updateVeritySettings,
      getSession: vi.fn(),
      getSessionContactsConnection: vi.fn(),
      enableSessionContacts: vi.fn(),
      disableSessionContacts: vi.fn(),
      clearSessionCalendarConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionContactsConnections,
      clearSessionGmailConnections: vi.fn().mockResolvedValue(undefined),
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        googleResponse({
          access_token: 'access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
          scope:
            'https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/userinfo.email',
        }),
      )
      .mockResolvedValueOnce(googleResponse({ email: 'new@example.com' }));
    const app = Fastify();
    registerGoogleContactsRoutes(app, {
      eventStore: store as never,
      googleClientId: 'client',
      fetch,
    });
    await app.ready();

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/contacts/connect',
          payload: { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' },
        })
      ).statusCode,
    ).toBe(200);
    expect(clearSessionContactsConnections).toHaveBeenCalledOnce();
    expect(store.clearSessionGmailConnections).toHaveBeenCalled();
    expect(updateVeritySettings).toHaveBeenCalledWith(
      expect.objectContaining({ googleDriveAccountEmail: 'new@example.com' }),
    );
    await app.close();
  });
  it('preserves Gmail and Contacts grants on same-account expanded consent', async () => {
    const clearSessionContactsConnections = vi.fn().mockResolvedValue(undefined);
    const updateVeritySettings = vi.fn().mockResolvedValue(undefined);
    const store = {
      getVeritySettings: vi.fn(async () => ({
        googleDriveClientId: 'client',
        googleDriveRefreshToken: 'old-refresh',
        googleDriveAccountEmail: 'old@example.com',
        contactsAuthorized: true,
      })),
      updateVeritySettings,
      getSession: vi.fn(),
      getSessionContactsConnection: vi.fn(),
      enableSessionContacts: vi.fn(),
      disableSessionContacts: vi.fn(),
      clearSessionCalendarConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionContactsConnections,
      clearSessionGmailConnections: vi.fn().mockResolvedValue(undefined),
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        googleResponse({
          access_token: 'access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
          scope:
            'https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.settings.basic',
        }),
      )
      .mockResolvedValueOnce(googleResponse({ email: 'old@example.com' }));
    const app = Fastify();
    registerGoogleContactsRoutes(app, {
      eventStore: store as never,
      googleClientId: 'client',
      fetch,
    });
    await app.ready();

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/contacts/connect',
          payload: { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' },
        })
      ).statusCode,
    ).toBe(200);
    expect(clearSessionContactsConnections).not.toHaveBeenCalled();
    expect(store.clearSessionGmailConnections).not.toHaveBeenCalled();
    expect(updateVeritySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        googleDriveAccountEmail: 'old@example.com',
        gmailAuthorized: true,
        contactsAuthorized: true,
      }),
    );
    await app.close();
  });
});
