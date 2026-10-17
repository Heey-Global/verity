import { createGoogleAccountAccessToken } from './google-account-token.js';
import { googleAppClient } from './google-app-client.js';
import type { EventStore, SealableSecretCipher, VeritySettingsRecord } from '@verity/store';
import { chmod } from 'node:fs/promises';
import { SealedError } from '@verity/store';
import rateLimitPlugin from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  GoogleDriveError,
  createCachedGoogleAccessToken,
  downloadDriveFile,
  exportDriveFile,
  getDriveFile,
  listDriveFiles,
  listSharedDrives,
  planDriveImport,
  referenceDocFileName,
  type DriveFileList,
  type SharedDriveList,
} from './google-drive.js';
import { hasGoogleDriveScopes } from './google-oauth-scopes.js';
import { GoogleSlidesError, getSlidesPresentation } from './google-slides.js';
import { GoogleDocsError, getDocsDocumentMetadata } from './google-docs.js';
import { GoogleSheetsError, getSheetsSpreadsheet } from './google-sheets.js';
import { writeReferenceDocFile } from './reference-docs.js';
import { ensureProjectKnowledge, KNOWLEDGE_DOCUMENTS_DIR } from './knowledge-folder.js';
import { extractKnowledgeFile } from './knowledge-file-ingest.js';
import {
  assertDriveFileInLinkedFolder,
  registerProjectGoogleDriveRoutes,
} from './google-drive-project-routes.js';

const sessionParams = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/),
});
const filesQuery = z.object({
  accountId: z.string().min(1).optional(),
  parentId: z.string().trim().min(1).max(512).optional(),
  query: z.string().trim().min(1).max(200).optional(),
  sharedWithMe: z.enum(['true']).optional(),
  driveId: z.string().trim().min(1).max(512).optional(),
  pageToken: z.string().trim().min(1).max(4096).optional(),
  purpose: z.enum(['import', 'slides', 'workspace', 'folder']).optional(),
});
const importBody = z.object({
  folderLinkId: z.string().min(1).optional(),
  fileId: z.string().trim().min(1).max(512),
  accountId: z.string().min(1).optional(),
});
const projectParams = z.object({ id: z.string().trim().min(1).max(512) });
const SLIDES_PICKER_MIME_TYPES = [
  'application/vnd.google-apps.folder',
  'application/vnd.google-apps.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;
const WORKSPACE_PICKER_MIME_TYPES = [
  'application/vnd.google-apps.folder',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

type SettingsStore = Pick<EventStore, 'getVeritySettings' | 'updateVeritySettings'> &
  Partial<Pick<EventStore, 'googleAccounts'>>;
interface GoogleDriveRouteDeps {
  eventStore: SettingsStore &
    Pick<
      EventStore,
      | 'getSession'
      | 'getSessionSlideDeck'
      | 'setSessionSlideDeck'
      | 'clearSessionSlideDeck'
      | 'listRecentGoogleSlideDeckFileIds'
      | 'getSessionWorkspaceFile'
      | 'setSessionWorkspaceFile'
      | 'clearSessionWorkspaceFile'
      | 'listRecentGoogleWorkspaceFileIds'
      | 'clearSessionGmailConnections'
      | 'clearSessionCalendarConnections'
      | 'clearSessionContactsConnections'
      | 'getProject'
      | 'getProjectSettings'
      | 'updateProjectSettings'
      | 'listSessions'
    >;
  googleDriveClientId?: string;
  stagingGoogleClientId?: string;
  secretCipher?: SealableSecretCipher;
  dataRoot?: string;
  onCredentialsChanged?: () => void;
}

/** Google Drive PKCE connection, browsing, and reference-document import routes. */
export function registerGoogleDriveRoutes(app: FastifyInstance, deps: GoogleDriveRouteDeps): void {
  app.register(async (instance) => {
    await instance.register(rateLimitPlugin, { global: false });
    registerGoogleDriveRouteHandlers(instance, deps);
  });
}

function registerGoogleDriveRouteHandlers(app: FastifyInstance, deps: GoogleDriveRouteDeps): void {
  const clearProjectWorkspaceFiles = async (projectId: string): Promise<void> => {
    const sessions = await deps.eventStore.listSessions();
    await Promise.all(
      sessions
        .filter((session) => session.projectId === projectId)
        .map((session) => deps.eventStore.clearSessionWorkspaceFile(session.sessionId)),
    );
  };
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
    return clientId && refreshToken && hasGoogleDriveScopes(settings?.googleGrantedScopes)
      ? { clientId, refreshToken }
      : undefined;
  };
  const accessToken = deps.eventStore.googleAccounts
    ? createGoogleAccountAccessToken(
        { googleAccounts: deps.eventStore.googleAccounts },
        {
          isSealed: () => deps.secretCipher?.isSealed() === true,
          acceptAccount: (account) => hasGoogleDriveScopes(account.scopes),
        },
      )
    : Object.assign(async () => legacyAccessToken(), {
        invalidate: () => legacyAccessToken.invalidate(),
      });
  const legacyAccessToken = createCachedGoogleAccessToken(resolveCredentials);
  registerProjectGoogleDriveRoutes(app, {
    getLinkedFolder: async (projectId, folderId) => {
      if (deps.eventStore.googleAccounts) {
        const links = await deps.eventStore.googleAccounts.folders(projectId);
        const link =
          links.find((candidate) => candidate.id === folderId) ??
          (links.length === 1 && links[0]?.folderId === folderId ? links[0] : undefined);
        return link ? { ...link, linkId: link.id } : undefined;
      }
      const settings = await deps.eventStore.getProjectSettings(projectId);
      return settings?.googleDriveFolderId === folderId && settings.googleDriveFolderName
        ? {
            projectId,
            folderId,
            name: settings.googleDriveFolderName,
            accessMode: settings.googleDriveAccessMode,
          }
        : undefined;
    },
    googleAccessToken: accessToken,
    googleAccountIdentity: async (accountId) => {
      if (deps.eventStore.googleAccounts && accountId) {
        const account = await deps.eventStore.googleAccounts.get(accountId);
        return account ? `${account.id}:${account.credentialVersion}` : undefined;
      }
      const credentials = await resolveCredentials();
      return credentials ? JSON.stringify(credentials) : undefined;
    },
    ...(deps.dataRoot === undefined ? {} : { dataRoot: deps.dataRoot }),
  });
  app.get('/google-drive/connection', async (request) => {
    const settings =
      deps.secretCipher?.isSealed() === true
        ? undefined
        : await deps.eventStore.getVeritySettings();
    const accounts = await deps.eventStore.googleAccounts?.list();
    const eligible = accounts?.filter((account) => hasGoogleDriveScopes(account.scopes));
    const connected = eligible
      ? eligible.length > 0
      : Boolean(settings?.googleDriveRefreshToken?.trim()) &&
        hasGoogleDriveScopes(settings?.googleGrantedScopes);
    return {
      connected,
      clientId:
        googleAppClient(request, deps.googleDriveClientId, deps.stagingGoogleClientId) ??
        (request.headers['x-verity-app-variant'] === undefined
          ? settings?.googleDriveClientId
          : null) ??
        null,
      accountEmail: eligible
        ? eligible.length === 1
          ? eligible[0]!.email
          : null
        : connected
          ? (settings?.googleDriveAccountEmail ?? null)
          : null,
      scopes: accounts
        ? [...new Set(accounts.flatMap((account) => account.scopes))]
        : (settings?.googleGrantedScopes ?? []),
    };
  });
  app.post('/google-drive/disconnect', async (_request, reply) => {
    if (deps.secretCipher?.isSealed() === true) throw new SealedError();
    if (deps.eventStore.googleAccounts) {
      const accounts = await deps.eventStore.googleAccounts.list();
      if (accounts.length > 1)
        return reply.code(409).send({ error: 'Choose the Google account to disconnect' });
      if (accounts[0]) await deps.eventStore.googleAccounts.remove(accounts[0].id);
    }
    await deps.eventStore.clearSessionGmailConnections();
    await deps.eventStore.clearSessionCalendarConnections();
    await deps.eventStore.clearSessionContactsConnections();
    await deps.eventStore.updateVeritySettings({
      googleDriveClientId: null,
      googleDriveRefreshToken: null,
      googleDriveAccountEmail: null,
      gmailAuthorized: false,
      calendarAuthorized: false,
      contactsAuthorized: false,
      googleGrantedScopes: [],
    });
    accessToken.invalidate();
    deps.onCredentialsChanged?.();
    return { connected: false as const };
  });

  app.get(
    '/google-drive/files',
    async (request, reply): Promise<DriveFileList | { error: string }> => {
      const query = filesQuery.parse(request.query);
      const token = await accessToken(query.accountId);
      if (token === undefined) {
        reply.code(409);
        return { error: 'Google Drive is not connected' };
      }
      try {
        const page = await listDriveFiles({
          accessToken: token,
          parentId: query.parentId,
          query: query.query,
          sharedWithMe: query.sharedWithMe === 'true',
          driveId: query.driveId,
          pageToken: query.pageToken,
          ...(query.purpose === 'slides' ||
          query.purpose === 'workspace' ||
          query.purpose === 'folder'
            ? {
                mimeTypes:
                  query.purpose === 'folder'
                    ? ['application/vnd.google-apps.folder']
                    : query.purpose === 'workspace'
                      ? WORKSPACE_PICKER_MIME_TYPES
                      : SLIDES_PICKER_MIME_TYPES,
              }
            : {}),
        });
        if (
          (query.purpose !== 'slides' && query.purpose !== 'workspace') ||
          query.parentId !== undefined ||
          query.query !== undefined ||
          query.sharedWithMe !== undefined ||
          query.driveId !== undefined ||
          query.pageToken !== undefined
        ) {
          return page;
        }
        const recentIds =
          query.purpose === 'workspace'
            ? await deps.eventStore.listRecentGoogleWorkspaceFileIds(
                8,
                query.accountId ?? (await deps.eventStore.googleAccounts?.list())?.[0]?.id,
              )
            : await deps.eventStore.listRecentGoogleSlideDeckFileIds(
                8,
                query.accountId ?? (await deps.eventStore.googleAccounts?.list())?.[0]?.id,
              );
        const pickerMimeTypes: readonly string[] =
          query.purpose === 'workspace' ? WORKSPACE_PICKER_MIME_TYPES : SLIDES_PICKER_MIME_TYPES;
        const recent = (
          await Promise.all(
            recentIds.map((fileId) => getDriveFile(token, fileId).catch(() => undefined)),
          )
        ).filter(
          (file): file is NonNullable<typeof file> =>
            file !== undefined && pickerMimeTypes.includes(file.mimeType),
        );
        const recentSet = new Set(recent.map((file) => file.id));
        return {
          ...page,
          files: [...recent, ...page.files.filter((file) => !recentSet.has(file.id))],
        };
      } catch (error) {
        const reason = error instanceof GoogleDriveError ? error.reason : 'browse_failed';
        request.log.error({ reason }, 'verity: google drive browse failed');
        reply.code(502);
        return { error: `Could not list Google Drive files (${reason})` };
      }
    },
  );

  app.get(
    '/google-drive/drives',
    async (request, reply): Promise<SharedDriveList | { error: string }> => {
      const query = z
        .object({
          pageToken: z.string().trim().min(1).max(4096).optional(),
          accountId: z.string().min(1).optional(),
        })
        .parse(request.query);
      const token = await accessToken(query.accountId);
      if (token === undefined) {
        reply.code(409);
        return { error: 'Google Drive is not connected' };
      }
      try {
        return await listSharedDrives({
          accessToken: token,
          ...(query.pageToken ? { pageToken: query.pageToken } : {}),
        });
      } catch (error) {
        const reason = error instanceof GoogleDriveError ? error.reason : 'list_failed';
        reply.code(502);
        return { error: `Could not list shared drives (${reason})` };
      }
    },
  );

  app.get('/projects/:id/google-drive/folders', async (request, reply) => {
    const { id } = projectParams.parse(request.params);
    if (!(await deps.eventStore.getProject(id)))
      return reply.code(404).send({ error: 'Project not found' });
    return { folders: (await deps.eventStore.googleAccounts?.folders(id)) ?? [] };
  });
  app.delete('/projects/:id/google-drive/folders/:linkId', async (request, reply) => {
    const { id, linkId } = projectParams
      .extend({ linkId: z.string().min(1) })
      .parse(request.params);
    if (!(await deps.eventStore.getProject(id)))
      return reply.code(404).send({ error: 'Project not found' });
    await deps.eventStore.googleAccounts?.unlinkFolder(id, linkId);
    return reply.code(204).send();
  });

  app.put('/projects/:id/google-drive/folder', async (request, reply) => {
    const { id } = projectParams.parse(request.params);
    const { fileId, accessMode, accountId } = importBody
      .extend({ accessMode: z.enum(['read-only', 'read-write']).default('read-only') })
      .parse(request.body);
    if ((await deps.eventStore.getProject(id)) === undefined) {
      reply.code(404);
      return { error: `project ${id} not found` };
    }
    const accounts = await deps.eventStore.googleAccounts?.list();
    const selected = accountId
      ? accounts?.find((candidate) => candidate.id === accountId)
      : accounts?.length === 1
        ? accounts[0]
        : undefined;
    if (accounts && !selected) return reply.code(409).send({ error: 'Select a Google account' });
    if (!accountId && deps.eventStore.googleAccounts) {
      const links = await deps.eventStore.googleAccounts.folders(id);
      if (links.length > 1 || links.some((link) => link.folderId !== fileId))
        return reply
          .code(409)
          .send({ error: 'Select an account explicitly to add or update a folder' });
    }
    const token = await accessToken(selected?.id ?? accountId);
    if (token === undefined) {
      reply.code(409);
      return { error: 'Google Drive is not connected' };
    }
    try {
      const folder = await getDriveFile(token, fileId);
      if (folder.mimeType !== 'application/vnd.google-apps.folder') {
        reply.code(415);
        return { error: 'Choose a Google Drive folder' };
      }
      if (accessMode === 'read-write' && folder.canEdit !== true) {
        reply.code(403);
        return { error: 'You need edit access to connect this folder' };
      }
      if (deps.eventStore.googleAccounts) {
        const current = selected
          ? await deps.eventStore.googleAccounts.get(selected.id)
          : undefined;
        if (!selected || !current || current.credentialVersion !== selected.credentialVersion)
          return reply.code(409).send({ error: 'Google account changed during folder selection' });
        const link = await deps.eventStore.googleAccounts.linkFolder({
          projectId: id,
          accountId: selected.id,
          folderId: folder.id,
          name: folder.name,
          accessMode,
        });
        return { folder: { id: folder.id, name: folder.name }, linkId: link.id };
      }
      await deps.eventStore.updateProjectSettings(id, {
        googleDriveFolderId: folder.id,
        googleDriveFolderName: folder.name,
        googleDriveAccessMode: accessMode,
      });
      await clearProjectWorkspaceFiles(id);
      return { folder: { id: folder.id, name: folder.name } };
    } catch (error) {
      const reason = error instanceof GoogleDriveError ? error.reason : 'metadata_failed';
      reply.code(502);
      return { error: `Could not connect the Google Drive folder (${reason})` };
    }
  });

  app.delete('/projects/:id/google-drive/folder', async (request, reply) => {
    const { id } = projectParams.parse(request.params);
    if ((await deps.eventStore.getProject(id)) === undefined) {
      reply.code(404);
      return { error: `project ${id} not found` };
    }
    if (deps.eventStore.googleAccounts) {
      const links = await deps.eventStore.googleAccounts.folders(id);
      if (links.length > 1)
        return reply.code(409).send({ error: 'Select the folder link to disconnect' });
      if (links[0]) await deps.eventStore.googleAccounts.unlinkFolder(id, links[0].id);
    }
    await deps.eventStore.updateProjectSettings(id, {
      googleDriveFolderId: null,
      googleDriveFolderName: null,
    });
    await clearProjectWorkspaceFiles(id);
    reply.code(204);
  });

  app.get('/sessions/:id/google-workspace/file', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    if ((await deps.eventStore.getSession(id)) === undefined) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    return { file: (await deps.eventStore.getSessionWorkspaceFile(id)) ?? null };
  });

  const assignmentBinding = async (
    sessionId: string,
    accountId?: string,
    folderLinkId?: string,
  ) => {
    if (!deps.eventStore.googleAccounts) return undefined;
    const accounts = await deps.eventStore.googleAccounts.list();
    const account = accountId
      ? accounts.find((item) => item.id === accountId)
      : accounts.length === 1
        ? accounts[0]
        : undefined;
    if (!account || !hasGoogleDriveScopes(account.scopes)) return undefined;
    const session = await deps.eventStore.getSession(sessionId);
    const links = session?.projectId
      ? await deps.eventStore.googleAccounts.folders(session.projectId)
      : [];
    // Omitting the binding must not turn a folder's read-only grant into editing access.
    if (!folderLinkId && links.some((item) => item.accountId === account.id)) return undefined;
    const link =
      folderLinkId && session?.projectId
        ? links.find((item) => item.id === folderLinkId)
        : undefined;
    if (folderLinkId && (!link || link.accountId !== account.id)) return undefined;
    return { account, link, projectId: session?.projectId };
  };
  const verifyAssignmentBinding = async (
    sessionId: string,
    binding: Awaited<ReturnType<typeof assignmentBinding>>,
    token: string,
    fileId: string,
  ) => {
    if (!binding) return;
    if (binding.link) await assertDriveFileInLinkedFolder(token, binding.link.folderId, fileId);
    const current = await assignmentBinding(sessionId, binding.account.id, binding.link?.id);
    if (
      !current ||
      current.account.credentialVersion !== binding.account.credentialVersion ||
      current.projectId !== binding.projectId ||
      current.link?.revision !== binding.link?.revision
    )
      throw new Error('Google account or folder access changed during assignment');
  };

  app.put('/sessions/:id/google-workspace/file', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const { fileId, accountId, folderLinkId } = importBody.parse(request.body);
    if ((await deps.eventStore.getSession(id)) === undefined) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    const binding = await assignmentBinding(id, accountId, folderLinkId);
    if (deps.eventStore.googleAccounts && !binding)
      return reply.code(409).send({ error: 'Choose an available Google account and folder' });
    const selectedAccount = binding?.account;
    const token = await accessToken(selectedAccount?.id ?? accountId);
    if (token === undefined) {
      reply.code(409);
      return { error: 'Google Drive is not connected' };
    }
    try {
      const driveFile = await getDriveFile(token, fileId);
      const kind =
        driveFile.mimeType === 'application/vnd.google-apps.presentation'
          ? 'slides'
          : driveFile.mimeType === 'application/vnd.google-apps.document'
            ? 'docs'
            : driveFile.mimeType === 'application/vnd.google-apps.spreadsheet'
              ? 'sheets'
              : undefined;
      if (kind === undefined) {
        reply.code(415);
        return { error: 'Only native Google Slides, Docs, and Sheets files can be assigned' };
      }
      const requiredScope =
        kind === 'slides' ? 'presentations' : kind === 'docs' ? 'documents' : 'spreadsheets';
      const settings = await deps.eventStore.getVeritySettings();
      const scopes = selectedAccount?.scopes ?? settings?.googleGrantedScopes;
      if (
        !scopes?.some((granted) => granted === `https://www.googleapis.com/auth/${requiredScope}`)
      ) {
        reply.code(409);
        return { error: 'Reconnect Google Drive to grant Workspace editing access' };
      }
      if (driveFile.canEdit !== true) {
        reply.code(403);
        return { error: 'You need edit access to assign this Google Workspace file' };
      }
      let name = driveFile.name;
      let revisionId: string | null = null;
      let canonicalId = fileId;
      if (kind === 'slides') {
        const presentation = await getSlidesPresentation(token, fileId);
        canonicalId = presentation.presentationId;
        name = presentation.title;
        revisionId = presentation.revisionId;
      } else if (kind === 'docs') {
        const document = await getDocsDocumentMetadata(token, fileId);
        canonicalId = document.documentId;
        name = document.title;
        revisionId = document.revisionId;
      } else {
        const spreadsheet = await getSheetsSpreadsheet(token, fileId);
        canonicalId = spreadsheet.spreadsheetId;
        name = spreadsheet.title;
      }
      const path =
        kind === 'slides' ? 'presentation' : kind === 'docs' ? 'document' : 'spreadsheets';
      await verifyAssignmentBinding(id, binding, token, fileId);
      const file = await deps.eventStore.setSessionWorkspaceFile({
        accountId: selectedAccount?.id ?? null,
        folderLinkId: folderLinkId ?? null,
        sessionId: id,
        kind,
        fileId: canonicalId,
        name,
        webViewLink: `https://docs.google.com/${path}/d/${encodeURIComponent(canonicalId)}/edit`,
        revisionId,
      });
      return { file };
    } catch (error) {
      const reason =
        error instanceof GoogleSlidesError ||
        error instanceof GoogleDocsError ||
        error instanceof GoogleSheetsError
          ? error.reason
          : 'assignment_failed';
      if (reason.startsWith('http_403')) {
        reply.code(409);
        return { error: 'Reconnect Google Drive to grant Workspace editing access' };
      }
      reply.code(reason.startsWith('http_400') ? 415 : 502);
      return { error: `Could not assign this Google Workspace file (${reason})` };
    }
  });

  app.delete('/sessions/:id/google-workspace/file', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    if ((await deps.eventStore.getSession(id)) === undefined) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    await deps.eventStore.clearSessionWorkspaceFile(id);
    reply.code(204);
  });

  app.get('/sessions/:id/google-slides/deck', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const session = await deps.eventStore.getSession(id);
    if (session === undefined) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    return { deck: (await deps.eventStore.getSessionSlideDeck(id)) ?? null };
  });

  app.put('/sessions/:id/google-slides/deck', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const { fileId, accountId, folderLinkId } = importBody.parse(request.body);
    if ((await deps.eventStore.getSession(id)) === undefined) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    const binding = await assignmentBinding(id, accountId, folderLinkId);
    if (deps.eventStore.googleAccounts && !binding)
      return reply.code(409).send({ error: 'Choose an available Google account and folder' });
    const selectedAccount = binding?.account;
    const token = await accessToken(selectedAccount?.id ?? accountId);
    if (token === undefined) {
      reply.code(409);
      return { error: 'Google Drive is not connected' };
    }
    try {
      const file = await getDriveFile(token, fileId);
      if (file.mimeType !== 'application/vnd.google-apps.presentation') {
        reply.code(415);
        return { error: 'Only native Google Slides presentations can be assigned' };
      }
      if (file.canEdit !== true) {
        reply.code(403);
        return { error: 'You need edit access to assign this Google Slides deck' };
      }
      const settings = await deps.eventStore.getVeritySettings();
      const scopes = selectedAccount?.scopes ?? settings?.googleGrantedScopes;
      if (!scopes?.some((granted) => granted === 'https://www.googleapis.com/auth/presentations')) {
        reply.code(409);
        return { error: 'Reconnect Google Drive to grant presentation editing access' };
      }
      const presentation = await getSlidesPresentation(token, fileId);
      await verifyAssignmentBinding(id, binding, token, fileId);
      const deck = await deps.eventStore.setSessionSlideDeck({
        accountId: selectedAccount?.id ?? null,
        folderLinkId: folderLinkId ?? null,
        sessionId: id,
        fileId: presentation.presentationId,
        name: presentation.title,
        webViewLink: `https://docs.google.com/presentation/d/${encodeURIComponent(presentation.presentationId)}/edit`,
        revisionId: presentation.revisionId,
      });
      return { deck };
    } catch (error) {
      const reason = error instanceof GoogleSlidesError ? error.reason : 'assignment_failed';
      if (reason.startsWith('http_403')) {
        reply.code(403);
        return {
          error: 'Reconnect Google Drive to grant presentation editing access',
        };
      }
      reply.code(reason.startsWith('http_400') ? 415 : 502);
      return { error: `Could not assign this Google Slides deck (${reason})` };
    }
  });

  app.delete('/sessions/:id/google-slides/deck', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    if ((await deps.eventStore.getSession(id)) === undefined) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    await deps.eventStore.clearSessionSlideDeck(id);
    reply.code(204);
  });

  app.post('/sessions/:id/google-drive/import', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const { fileId, accountId, folderLinkId } = importBody.parse(request.body);
    const session = await deps.eventStore.getSession(id);
    if (!session) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    if (!session.projectId || !deps.dataRoot) {
      reply.code(409);
      return { error: 'Google Drive knowledge import requires a project session' };
    }
    const binding = await assignmentBinding(id, accountId, folderLinkId);
    if (deps.eventStore.googleAccounts && !binding)
      return reply.code(409).send({ error: 'Choose an available Google account and folder' });
    const token = await accessToken(binding?.account.id ?? accountId);
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
    await verifyAssignmentBinding(id, binding, token, fileId);
    const fileName = referenceDocFileName(file.name, plan.extension, fileId);
    const root = await ensureProjectKnowledge(deps.dataRoot, session.projectId);
    const importsDir = `${root}/${KNOWLEDGE_DOCUMENTS_DIR}`;
    const path = `${KNOWLEDGE_DOCUMENTS_DIR}/${fileName}`;
    await writeReferenceDocFile(importsDir, fileName, bytes);
    await chmod(`${importsDir}/${fileName}`, 0o644);
    await extractKnowledgeFile(root, path);
    return { root: 'knowledge', path, name: file.name };
  });
}
