import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerGoogleDriveRoutes } from './google-drive-routes.js';
import { registerGmailRoutes } from './gmail-routes.js';
import { registerGoogleCalendarRoutes } from './google-calendar-routes.js';
import { registerGoogleContactsRoutes } from './google-contacts-routes.js';
import type { EventStore } from '@verity/store';

describe('native Google client selection', () => {
  it.each([
    ['drive', registerGoogleDriveRoutes, '/google-drive/connection'],
    ['gmail', registerGmailRoutes, '/sessions/s1/gmail'],
    ['calendar', registerGoogleCalendarRoutes, '/sessions/s1/calendar'],
    ['contacts', registerGoogleContactsRoutes, '/sessions/s1/contacts'],
  ] as const)(
    'selects the %s client without rewriting existing token ownership',
    async (_name, register, connection) => {
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
      register(app, {
        eventStore: store,
        googleDriveClientId: 'production-client',
        googleClientId: 'production-client',
        stagingGoogleClientId: 'staging-client',
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
      await app.close();
    },
  );
});
