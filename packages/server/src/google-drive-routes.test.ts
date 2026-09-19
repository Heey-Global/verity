import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerGoogleDriveRoutes } from './google-drive-routes.js';

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['google-workspace/file', 'application/vnd.google-apps.document', 'docs'],
  ['google-workspace/file', 'application/vnd.google-apps.spreadsheet', 'sheets'],
  ['google-workspace/file', 'application/vnd.google-apps.presentation', 'slides'],
  ['google-slides/deck', 'application/vnd.google-apps.presentation', 'slides'],
])('preserves the Google rejection for %s (%s)', async (route, mimeType, service) => {
  const app = Fastify();
  const save = vi.fn();
  const store = {
    getSession: async () => ({ id: 'session' }),
    getVeritySettings: async () => ({
      googleDriveClientId: 'client',
      googleDriveRefreshToken: 'refresh',
    }),
    setSessionWorkspaceFile: save,
    setSessionSlideDeck: save,
  } as unknown as Parameters<typeof registerGoogleDriveRoutes>[1]['eventStore'];
  let reason = 'SERVICE_DISABLED';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('https://oauth2.googleapis.com/')) {
        return Response.json({ access_token: 'access', expires_in: 3600, token_type: 'Bearer' });
      }
      if (url.startsWith('https://www.googleapis.com/drive/')) {
        return Response.json({
          id: 'file',
          name: 'File',
          mimeType,
          capabilities: { canEdit: true },
        });
      }
      expect(url).toContain(`${service}.googleapis.com`);
      return Response.json(
        {
          error: {
            status: 'PERMISSION_DENIED',
            message: 'private upstream detail',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason,
                domain: 'googleapis.com',
              },
            ],
          },
        },
        { status: 403 },
      );
    }),
  );
  registerGoogleDriveRoutes(app, { eventStore: store });
  try {
    // A generic 403 used to send API setup failures into an endless consent loop.
    const request = () =>
      app.inject({ method: 'PUT', url: `/sessions/session/${route}`, payload: { fileId: 'file' } });
    const disabled = await request();
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json().error).toMatch(/Google Cloud/);
    expect(disabled.json().error).not.toMatch(/^Reconnect Google Drive/);
    expect(disabled.body).not.toContain('private upstream detail');
    reason = 'ACCESS_TOKEN_SCOPE_INSUFFICIENT';
    const scopes = await request();
    expect(scopes.statusCode).toBe(403);
    expect(scopes.json().error).toBe(
      `Reconnect Google Drive to grant ${route.includes('workspace') ? 'Workspace' : 'presentation'} editing access`,
    );
    reason = 'OTHER_PERMISSION_FAILURE';
    const denied = await request();
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('Reconnect');
    expect(save).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
