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

  it('revokes Gmail grants when Drive reconnects without Gmail signature scope', async () => {
    const clearSessionGmailConnections = vi.fn().mockResolvedValue(undefined);
    const updateVeritySettings = vi.fn().mockResolvedValue(undefined);
    const eventStore = {
      clearSessionGmailConnections,
      clearSessionContactsConnections: vi.fn().mockResolvedValue(undefined),
      clearSessionCalendarConnections: vi.fn().mockResolvedValue(undefined),
      updateVeritySettings,
      getVeritySettings: vi.fn().mockResolvedValue({
        googleDriveAccountEmail: 'old@example.test',
        gmailAuthorized: true,
      }),
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
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access',
            refresh_token: 'refresh',
            expires_in: 3600,
            scope:
              'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ user: { emailAddress: 'old@example.test' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetch);
    const app = Fastify();
    registerGoogleDriveRoutes(app, { eventStore, googleDriveClientId: 'client' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/google-drive/connect',
      payload: { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' },
    });

    expect(response.statusCode).toBe(200);
    expect(clearSessionGmailConnections).toHaveBeenCalledOnce();
    expect(eventStore.clearSessionCalendarConnections).toHaveBeenCalledOnce();
    expect(updateVeritySettings).toHaveBeenCalledWith(
      expect.objectContaining({ gmailAuthorized: false }),
    );
    vi.unstubAllGlobals();
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
