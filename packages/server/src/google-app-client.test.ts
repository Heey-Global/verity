import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGoogleDriveRoutes } from './google-drive-routes.js';
import { registerGmailRoutes } from './gmail-routes.js';
import { registerGoogleCalendarRoutes } from './google-calendar-routes.js';
import { registerGoogleContactsRoutes } from './google-contacts-routes.js';
import type { EventStore } from '@verity/store';

afterEach(() => vi.unstubAllGlobals());

describe('native Google client selection', () => {
  it.each([
    ['drive', registerGoogleDriveRoutes, '/google-drive/connect', '/google-drive/connection'],
    ['gmail', registerGmailRoutes, '/gmail/connect', '/sessions/s1/gmail'],
    ['calendar', registerGoogleCalendarRoutes, '/calendar/connect', '/sessions/s1/calendar'],
    ['contacts', registerGoogleContactsRoutes, '/contacts/connect', '/sessions/s1/contacts'],
  ] as const)(
    'selects the %s client without rewriting existing token ownership',
    async (_name, register, connect, connection) => {
      const app = Fastify();
      const updateVeritySettings = vi.fn();
      const store = {
        getVeritySettings: vi.fn(async () => ({
          googleDriveClientId: 'original',
          googleDriveRefreshToken: 'saved-token',
          googleGrantedScopes: [],
        })),
        getSession: vi.fn(async () => ({ sessionId: 's1' })),
        getSessionGmailConnection: vi.fn(),
        getSessionCalendarConnection: vi.fn(),
        getSessionContactsConnection: vi.fn(),
        clearSessionGmailConnections: vi.fn(),
        clearSessionCalendarConnections: vi.fn(),
        clearSessionContactsConnections: vi.fn(),
        updateVeritySettings,
      } as unknown as EventStore;
      const fetch = vi.fn(
        async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      );
      vi.stubGlobal('fetch', fetch);
      register(app, {
        eventStore: store,
        googleDriveClientId: 'production-client',
        googleClientId: 'production-client',
        stagingGoogleClientId: 'staging-client',
        fetch,
      });
      const read = (variant?: string) =>
        app.inject({
          url: connection,
          ...(variant ? { headers: { 'x-verity-app-variant': variant } } : {}),
        });
      expect((await read()).json().clientId).toBe('production-client');
      expect((await read('staging')).json().clientId).toBe('staging-client');
      expect((await read('unknown')).json().clientId).toBeNull();
      expect(updateVeritySettings).not.toHaveBeenCalled();
      const payload = {
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: 'scheme:/oauthredirect',
      };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: connect,
            headers: { 'x-verity-app-variant': 'staging' },
            payload,
          })
        ).statusCode,
      ).toBe(502);
      expect(fetch).toHaveBeenCalledOnce();
      const exchange = fetch.mock.calls[0] as unknown as [string, { body: string }];
      expect(new URLSearchParams(exchange[1].body).get('client_id')).toBe('staging-client');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: connect,
            headers: { 'x-verity-app-variant': 'arbitrary-client' },
            payload,
          })
        ).statusCode,
      ).toBe(400);
      expect(fetch).toHaveBeenCalledOnce();
      const scope = [
        'drive',
        'gmail.readonly',
        'gmail.compose',
        'gmail.settings.basic',
        'calendar.calendarlist.readonly',
        'calendar.events',
        'userinfo.email',
        'contacts.readonly',
      ]
        .map((value) => `https://www.googleapis.com/auth/${value}`)
        .join(' ');
      fetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: 'access',
              refresh_token: 'new-refresh',
              expires_in: 3600,
              scope,
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              email: 'account@example.test',
              emailAddress: 'account@example.test',
              user: { emailAddress: 'account@example.test' },
            }),
          ),
        );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: connect,
            headers: { 'x-verity-app-variant': 'staging' },
            payload,
          })
        ).statusCode,
      ).toBe(200);
      expect(updateVeritySettings).toHaveBeenCalledWith(
        expect.objectContaining({
          googleDriveClientId: 'staging-client',
          googleDriveRefreshToken: 'new-refresh',
        }),
      );
      await app.close();
    },
  );
});
