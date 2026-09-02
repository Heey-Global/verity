import type { EventStore, SealableSecretCipher, VeritySettingsRecord } from '@verity/store';
import { SealedError } from '@verity/store';
import rateLimitPlugin from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  GoogleDriveError,
  createCachedGoogleAccessToken,
  downloadDriveFile,
  exchangeGoogleAuthCode,
  exportDriveFile,
  getDriveAccountEmail,
  getDriveFile,
  listDriveFiles,
  planDriveImport,
  referenceDocFileName,
  type DriveFileList,
} from './google-drive.js';
import { ensureReferenceDirectory, writeReferenceDocFile } from './reference-docs.js';
import { sessionFilePath } from './session-files.js';

const sessionParams = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/),
});
const connectBody = z.object({
  code: z.string().trim().min(1).max(4096),
  codeVerifier: z.string().trim().min(1).max(256),
  redirectUri: z.string().trim().min(1).max(2048),
});
const filesQuery = z.object({
  parentId: z.string().trim().min(1).max(512).optional(),
  query: z.string().trim().min(1).max(200).optional(),
  sharedWithMe: z.enum(['true']).optional(),
  pageToken: z.string().trim().min(1).max(4096).optional(),
});
const importBody = z.object({ fileId: z.string().trim().min(1).max(512) });

type SettingsStore = Pick<EventStore, 'getVeritySettings' | 'updateVeritySettings'>;
interface GoogleDriveRouteDeps {
  eventStore: SettingsStore & Pick<EventStore, 'getSession'>;
  googleDriveClientId?: string;
  secretCipher?: SealableSecretCipher;
}

/** Google Drive PKCE connection, browsing, and reference-document import routes. */
export function registerGoogleDriveRoutes(app: FastifyInstance, deps: GoogleDriveRouteDeps): void {
  app.register(async (instance) => {
    await instance.register(rateLimitPlugin, { global: false });
    registerGoogleDriveRouteHandlers(instance, deps);
  });
}

function registerGoogleDriveRouteHandlers(app: FastifyInstance, deps: GoogleDriveRouteDeps): void {
  const resolveCredentials = async (): Promise<
    { clientId: string; refreshToken: string } | undefined
  > => {
    if (deps.secretCipher?.isSealed() === true) return undefined;
    let settings: VeritySettingsRecord | undefined;
    try {
      settings = await deps.eventStore.getVeritySettings();
    } catch (error) {
      if (error instanceof SealedError) return undefined;
      throw error;
    }
    const clientId = settings?.googleDriveClientId ?? '';
    const refreshToken = settings?.googleDriveRefreshToken ?? '';
    return clientId && refreshToken ? { clientId, refreshToken } : undefined;
  };
  const accessToken = createCachedGoogleAccessToken(resolveCredentials);
  app.post(
    '/google-drive/connect',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (deps.secretCipher?.isSealed() === true) throw new SealedError();
      const body = connectBody.parse(request.body);
      const clientId = deps.googleDriveClientId ?? '';
      if (!clientId) {
        reply.code(400);
        return { error: 'Google Drive is not configured on this server' };
      }
      let tokens;
      try {
        tokens = await exchangeGoogleAuthCode({ clientId, ...body });
      } catch (error) {
        const reason = error instanceof GoogleDriveError ? error.reason : 'exchange_failed';
        request.log.error({ reason }, 'verity: google drive code exchange failed');
        reply.code(502);
        return { error: `Google sign-in failed (${reason})` };
      }
      if (tokens.refreshToken === undefined) {
        reply.code(400);
        return {
          error: 'Google did not return a refresh token — reconnect and allow offline access',
        };
      }
      let accountEmail: string | undefined;
      try {
        accountEmail = await getDriveAccountEmail(tokens.accessToken);
      } catch {
        accountEmail = undefined;
      }
      await deps.eventStore.updateVeritySettings({
        googleDriveClientId: clientId,
        googleDriveRefreshToken: tokens.refreshToken,
        googleDriveAccountEmail: accountEmail ?? null,
      });
      return { connected: true as const, accountEmail: accountEmail ?? null };
    },
  );

  app.post('/google-drive/disconnect', async () => {
    if (deps.secretCipher?.isSealed() === true) throw new SealedError();
    await deps.eventStore.updateVeritySettings({
      googleDriveClientId: null,
      googleDriveRefreshToken: null,
      googleDriveAccountEmail: null,
    });
    return { connected: false as const };
  });

  app.get(
    '/google-drive/files',
    async (request, reply): Promise<DriveFileList | { error: string }> => {
      const query = filesQuery.parse(request.query);
      const token = await accessToken();
      if (token === undefined) {
        reply.code(409);
        return { error: 'Google Drive is not connected' };
      }
      try {
        return await listDriveFiles({
          accessToken: token,
          parentId: query.parentId,
          query: query.query,
          sharedWithMe: query.sharedWithMe === 'true',
          pageToken: query.pageToken,
        });
      } catch (error) {
        const reason = error instanceof GoogleDriveError ? error.reason : 'browse_failed';
        request.log.error({ reason }, 'verity: google drive browse failed');
        reply.code(502);
        return { error: `Could not list Google Drive files (${reason})` };
      }
    },
  );

  app.post('/sessions/:id/google-drive/import', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const { fileId } = importBody.parse(request.body);
    const session = await deps.eventStore.getSession(id);
    if (!session) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    const token = await accessToken();
    if (token === undefined) {
      reply.code(409);
      return { error: 'Google Drive is not connected' };
    }
    let file;
    try {
      file = await getDriveFile(token, fileId);
    } catch (error) {
      const reason = error instanceof GoogleDriveError ? error.reason : 'metadata_failed';
      reply.code(502);
      return { error: `Could not read the Google Drive file (${reason})` };
    }
    let plan;
    try {
      plan = planDriveImport(file.mimeType, file.name);
    } catch (error) {
      if (error instanceof GoogleDriveError && error.reason === 'not_importable') {
        reply.code(415);
        return { error: error.message };
      }
      throw error;
    }
    let bytes: Uint8Array;
    try {
      bytes =
        plan.kind === 'export' && plan.exportMimeType !== undefined
          ? await exportDriveFile(token, fileId, plan.exportMimeType)
          : await downloadDriveFile(token, fileId);
    } catch (error) {
      const reason = error instanceof GoogleDriveError ? error.reason : 'download_failed';
      reply.code(502);
      return { error: `Could not download the Google Drive file (${reason})` };
    }
    const fileName = referenceDocFileName(file.name, plan.extension, fileId);
    const referenceDir = await ensureReferenceDirectory(session.worktree);
    const path = `docs/reference/${fileName}`;
    sessionFilePath(session.worktree, path);
    await writeReferenceDocFile(referenceDir, fileName, bytes);
    return { path, name: file.name };
  });
}
