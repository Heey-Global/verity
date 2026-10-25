import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerGoogleDriveRoutes } from './google-drive-routes.js';

describe('Google Drive connection routes', () => {
  it('revokes every session Gmail and Calendar grant when the shared Google account disconnects', async () => {
    const clearSessionGmailConnections = vi.fn().mockResolvedValue(undefined);
    const updateVeritySettings = vi.fn().mockResolvedValue(undefined);
    const eventStore = {
      clearSessionGmailConnections,
      clearSessionContactsConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionCalendarConnections: vi.fn().mockResolvedValue(undefined),
      updateVeritySettings,
      getVeritySettings: vi.fn(),
      getSession: vi.fn(),
      getSessionSlideDeck: vi.fn(),
      setSessionSlideDeck: vi.fn(),
      clearSessionSlideDeck: vi.fn(),
      listRecentGoogleSlideDeckFileIds: vi.fn(),
      getSessionWorkspaceFile: vi.fn(),
      setSessionWorkspaceFile: vi.fn(),
      clearSessionWorkspaceFile: vi.fn(),
      listRecentGoogleWorkspaceFileIds: vi.fn(),
      listSessions: vi.fn(),
      getProject: vi.fn(),
      getProjectSettings: vi.fn(),
      updateProjectSettings: vi.fn(),
    };
    const app = Fastify();
    registerGoogleDriveRoutes(app, { eventStore });
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/google-drive/disconnect' });

    expect(response.statusCode).toBe(200);
    expect(clearSessionGmailConnections).toHaveBeenCalledOnce();
    expect(eventStore.clearSessionCalendarConnections).toHaveBeenCalledOnce();
    expect(updateVeritySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        googleDriveRefreshToken: null,
        googleDriveAccountEmail: null,
        gmailAuthorized: false,
        calendarAuthorized: false,
      }),
    );
    await app.close();
  });

  it('does not advertise Drive for a Contacts-only Google credential', async () => {
    const app = Fastify();
    registerGoogleDriveRoutes(app, {
      eventStore: {
        getVeritySettings: vi.fn().mockResolvedValue({
          googleDriveRefreshToken: 'refresh',
          googleDriveClientId: 'client',
          googleDriveAccountEmail: 'me@example.test',
          googleGrantedScopes: ['https://www.googleapis.com/auth/contacts.readonly'],
        }),
      } as never,
    });
    const response = await app.inject({ method: 'GET', url: '/google-drive/connection' });
    expect(response.json()).toMatchObject({
      connected: false,
      accountEmail: null,
      scopes: ['https://www.googleapis.com/auth/contacts.readonly'],
    });
    await app.close();
  });
});
