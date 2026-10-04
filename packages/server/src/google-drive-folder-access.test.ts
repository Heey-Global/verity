import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerGoogleDriveRoutes } from './google-drive-routes.js';

afterEach(() => vi.unstubAllGlobals());
it('allows connecting a viewer folder read-only and refuses read/write without edit rights', async () => {
  const updateProjectSettings = vi.fn().mockResolvedValue(undefined);
  const eventStore = {
    getProject: vi.fn().mockResolvedValue({ id: 'p' }),
    getVeritySettings: vi.fn().mockResolvedValue({
      googleDriveClientId: 'client',
      googleDriveRefreshToken: 'refresh',
      googleGrantedScopes: ['https://www.googleapis.com/auth/drive'],
    }),
    updateProjectSettings,
    listSessions: vi.fn().mockResolvedValue([]),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('oauth2.googleapis.com')
              ? { access_token: 'token', expires_in: 3600 }
              : {
                  id: 'root',
                  name: 'Shared',
                  mimeType: 'application/vnd.google-apps.folder',
                  capabilities: { canEdit: false },
                },
          ),
        ),
    ),
  );
  const app = Fastify();
  registerGoogleDriveRoutes(app, { eventStore: eventStore as never });
  try {
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/projects/p/google-drive/folder',
          payload: { fileId: 'root' },
        })
      ).statusCode,
    ).toBe(200);
    expect(updateProjectSettings).toHaveBeenCalledWith('p', {
      googleDriveFolderId: 'root',
      googleDriveFolderName: 'Shared',
      googleDriveAccessMode: 'read-only',
    });
    updateProjectSettings.mockClear();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/projects/p/google-drive/folder',
          payload: { fileId: 'root', accessMode: 'read-write' },
        })
      ).statusCode,
    ).toBe(403);
    expect(updateProjectSettings).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
