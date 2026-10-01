import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerGoogleCalendarRoutes } from './google-calendar-routes.js';

function googleResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

describe('Calendar routes', () => {
  it('stores expanded Google consent and enables it only for an existing session', async () => {
    let settings = {
      googleDriveClientId: 'client',
      googleDriveRefreshToken: null as string | null,
      googleDriveAccountEmail: null as string | null,
      calendarAuthorized: false,
    };
    let connection: { sessionId: string; enabledAt: Date } | undefined;
    const store = {
      getVeritySettings: vi.fn(async () => settings),
      updateVeritySettings: vi.fn(async (patch: Partial<typeof settings>) => {
        settings = { ...settings, ...patch };
        return settings;
      }),
      getSession: vi.fn(async (id: string) => (id === 's1' ? { sessionId: id } : undefined)),
      getSessionCalendarConnection: vi.fn(async () => connection),
      enableSessionCalendar: vi.fn(async (sessionId: string) => {
        connection ??= { sessionId, enabledAt: new Date('2026-09-23T12:00:00.000Z') };
        return connection;
      }),
      disableSessionCalendar: vi.fn(async () => {
        connection = undefined;
      }),
      clearSessionGmailConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionCalendarConnections: vi.fn(async () => {
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
            'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email',
        }),
      )
      .mockResolvedValueOnce(googleResponse({ email: 'you@example.com' }));
    const app = Fastify();
    const onCredentialsChanged = vi.fn();
    registerGoogleCalendarRoutes(app, {
      eventStore: store as never,
      googleClientId: 'client',
      fetch,
      onCredentialsChanged,
    });
    await app.ready();

    expect((await app.inject({ method: 'GET', url: '/sessions/s1/calendar' })).json()).toEqual({
      enabled: false,
      connected: false,
      clientId: 'client',
      accountEmail: null,
    });
    expect((await app.inject({ method: 'PUT', url: '/sessions/s1/calendar' })).statusCode).toBe(
      409,
    );
    const connected = await app.inject({
      method: 'POST',
      url: '/calendar/connect',
      payload: { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' },
    });
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toEqual({ connected: true, accountEmail: 'you@example.com' });
    expect(settings).toMatchObject({
      googleDriveRefreshToken: 'refresh',
      googleDriveAccountEmail: 'you@example.com',
      calendarAuthorized: true,
    });
    expect(onCredentialsChanged).toHaveBeenCalledOnce();

    const enabled = await app.inject({ method: 'PUT', url: '/sessions/s1/calendar' });
    expect(enabled.json()).toEqual({
      enabled: true,
      connected: true,
      clientId: 'client',
      accountEmail: 'you@example.com',
    });
    expect(
      (await app.inject({ method: 'PUT', url: '/sessions/missing/calendar' })).statusCode,
    ).toBe(404);

    expect((await app.inject({ method: 'DELETE', url: '/sessions/s1/calendar' })).statusCode).toBe(
      204,
    );
    await app.close();
  });

  it('rejects partial Calendar consent without persisting authorization', async () => {
    const updateVeritySettings = vi.fn();
    const store = {
      getVeritySettings: vi.fn(async () => ({
        googleDriveClientId: 'client',
        googleDriveRefreshToken: null,
        googleDriveAccountEmail: null,
        calendarAuthorized: false,
      })),
      updateVeritySettings,
      getSession: vi.fn(),
      getSessionCalendarConnection: vi.fn(),
      enableSessionCalendar: vi.fn(),
      disableSessionCalendar: vi.fn(),
      clearSessionGmailConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionCalendarConnections: vi.fn(),
    };
    const app = Fastify();
    registerGoogleCalendarRoutes(app, {
      eventStore: store as never,
      googleClientId: 'client',
      fetch: vi.fn().mockResolvedValue(
        googleResponse({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
        }),
      ),
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/calendar/connect',
      payload: { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' },
    });
    expect(response.statusCode).toBe(400);
    expect(updateVeritySettings).not.toHaveBeenCalled();
    await app.close();
  });

  it('revokes existing session grants when Calendar changes accounts', async () => {
    const clearSessionCalendarConnections = vi.fn().mockResolvedValue(undefined);
    const updateVeritySettings = vi.fn().mockResolvedValue(undefined);
    const store = {
      getVeritySettings: vi.fn(async () => ({
        googleDriveClientId: 'client',
        googleDriveRefreshToken: 'old-refresh',
        googleDriveAccountEmail: 'old@example.com',
        calendarAuthorized: true,
      })),
      updateVeritySettings,
      getSession: vi.fn(),
      getSessionCalendarConnection: vi.fn(),
      enableSessionCalendar: vi.fn(),
      disableSessionCalendar: vi.fn(),
      clearSessionCalendarConnections,
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
            'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email',
        }),
      )
      .mockResolvedValueOnce(googleResponse({ email: 'new@example.com' }));
    const app = Fastify();
    registerGoogleCalendarRoutes(app, {
      eventStore: store as never,
      googleClientId: 'client',
      fetch,
    });
    await app.ready();

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/calendar/connect',
          payload: { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' },
        })
      ).statusCode,
    ).toBe(200);
    expect(clearSessionCalendarConnections).toHaveBeenCalledOnce();
    expect(store.clearSessionGmailConnections).toHaveBeenCalled();
    expect(updateVeritySettings).toHaveBeenCalledWith(
      expect.objectContaining({ googleDriveAccountEmail: 'new@example.com' }),
    );
    await app.close();
  });
  it('preserves Gmail and Calendar grants on same-account expanded consent', async () => {
    const clearSessionCalendarConnections = vi.fn().mockResolvedValue(undefined);
    const updateVeritySettings = vi.fn().mockResolvedValue(undefined);
    const store = {
      getVeritySettings: vi.fn(async () => ({
        googleDriveClientId: 'client',
        googleDriveRefreshToken: 'old-refresh',
        googleDriveAccountEmail: 'old@example.com',
        calendarAuthorized: true,
      })),
      updateVeritySettings,
      getSession: vi.fn(),
      getSessionCalendarConnection: vi.fn(),
      enableSessionCalendar: vi.fn(),
      disableSessionCalendar: vi.fn(),
      clearSessionCalendarConnections,
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
            'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.settings.basic',
        }),
      )
      .mockResolvedValueOnce(googleResponse({ email: 'old@example.com' }));
    const app = Fastify();
    registerGoogleCalendarRoutes(app, {
      eventStore: store as never,
      googleClientId: 'client',
      fetch,
    });
    await app.ready();

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/calendar/connect',
          payload: { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' },
        })
      ).statusCode,
    ).toBe(200);
    expect(clearSessionCalendarConnections).not.toHaveBeenCalled();
    expect(store.clearSessionGmailConnections).not.toHaveBeenCalled();
    expect(updateVeritySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        googleDriveAccountEmail: 'old@example.com',
        gmailAuthorized: true,
        calendarAuthorized: true,
      }),
    );
    await app.close();
  });
});
