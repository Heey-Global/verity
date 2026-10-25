import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerGoogleCalendarRoutes } from './google-calendar-routes.js';

describe('Calendar routes', () => {
  it('enables legacy Calendar consent only for an existing session', async () => {
    let settings = {
      googleDriveClientId: 'client',
      googleDriveRefreshToken: null as string | null,
      googleDriveAccountEmail: null as string | null,
      calendarAuthorized: false,
    };
    let connection: { sessionId: string; enabledAt: Date } | undefined;
    const store = {
      getVeritySettings: vi.fn(async () => settings),
      updateVeritySettings: vi.fn(),
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
      clearSessionContactsConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionCalendarConnections: vi.fn(async () => {
        connection = undefined;
      }),
    };
    const app = Fastify();
    registerGoogleCalendarRoutes(app, { eventStore: store as never, googleClientId: 'client' });
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

    // A server upgraded from the single-account settings keeps serving that consent.
    settings = {
      ...settings,
      googleDriveRefreshToken: 'refresh',
      googleDriveAccountEmail: 'you@example.com',
      calendarAuthorized: true,
    };
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
    expect(store.updateVeritySettings).not.toHaveBeenCalled();
    await app.close();
  });
});
