import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerGmailRoutes } from './gmail-routes.js';

describe('Gmail routes', () => {
  it('enables legacy Gmail consent only for an existing session', async () => {
    let settings = {
      googleDriveClientId: 'client',
      googleDriveRefreshToken: null as string | null,
      googleDriveAccountEmail: null as string | null,
      gmailAuthorized: false,
    };
    let connection: { sessionId: string; enabledAt: Date } | undefined;
    const store = {
      getVeritySettings: vi.fn(async () => settings),
      updateVeritySettings: vi.fn(),
      getSession: vi.fn(async (id: string) => (id === 's1' ? { sessionId: id } : undefined)),
      getSessionGmailConnection: vi.fn(async () => connection),
      enableSessionGmail: vi.fn(async (sessionId: string) => {
        connection ??= { sessionId, enabledAt: new Date('2026-09-23T12:00:00.000Z') };
        return connection;
      }),
      disableSessionGmail: vi.fn(async () => {
        connection = undefined;
      }),
      clearSessionCalendarConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionContactsConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionGmailConnections: vi.fn(async () => {
        connection = undefined;
      }),
    };
    const app = Fastify();
    registerGmailRoutes(app, { eventStore: store as never, googleClientId: 'client' });
    await app.ready();

    expect((await app.inject({ method: 'GET', url: '/sessions/s1/gmail' })).json()).toEqual({
      enabled: false,
      connected: false,
      clientId: 'client',
      accountEmail: null,
    });
    expect((await app.inject({ method: 'PUT', url: '/sessions/s1/gmail' })).statusCode).toBe(409);

    // A server upgraded from the single-account settings keeps serving that consent.
    settings = {
      ...settings,
      googleDriveRefreshToken: 'refresh',
      googleDriveAccountEmail: 'you@example.com',
      gmailAuthorized: true,
    };
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
    expect(store.updateVeritySettings).not.toHaveBeenCalled();
    await app.close();
  });
});
