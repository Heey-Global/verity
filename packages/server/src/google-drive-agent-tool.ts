import type { ProjectSettingsRecord } from '@verity/store';

import {
  GoogleDriveError,
  createDriveFile,
  downloadDriveFile,
  exportDriveFile,
  getDriveFileSnapshot,
  mutateDriveFile,
  listDriveFiles,
  type DriveFile,
  type DriveFileList,
} from './google-drive.js';
import type {
  WorkspaceInvocationInput,
  GoogleWorkspaceToolStore,
} from './google-workspace-tool-types.js';
import {
  googleDriveRequestSchema,
  googleDriveIsMutation,
  googleDriveNeedsApproval,
} from './google-drive-request.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const NATIVE_EXPORTS: Record<string, { mimeType: string; text: boolean }> = {
  'application/vnd.google-apps.document': { mimeType: 'text/markdown', text: true },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'text/csv', text: true },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    text: false,
  },
};

interface GoogleDriveAgentToolStore extends Pick<
  GoogleWorkspaceToolStore,
  'claimGoogleWorkspaceInvocation' | 'completeGoogleWorkspaceInvocation'
> {
  getCompletedGoogleWorkspaceInvocation?(
    input: WorkspaceInvocationInput,
  ): Promise<{ result: unknown } | undefined>;
  getVeritySettings?(): Promise<
    { googleDriveAccountEmail: string | null; googleDriveRefreshToken: string | null } | undefined
  >;
  getSession(sessionId: string): Promise<{ projectId: string | null } | undefined>;
  getProjectSettings(projectId: string): Promise<ProjectSettingsRecord | undefined>;
  setSessionWorkspaceFile(input: {
    sessionId: string;
    kind: 'slides' | 'docs' | 'sheets';
    fileId: string;
    name: string;
    webViewLink: string;
    revisionId: string | null;
  }): Promise<unknown>;
}

export interface GoogleDriveAgentApi {
  get(this: void, token: string, fileId: string): Promise<DriveFile>;
  list(input: {
    accessToken: string;
    parentId?: string;
    query?: string;
    pageToken?: string;
    pageSize?: number;
  }): Promise<DriveFileList>;
  download(token: string, fileId: string, opts?: { expectedVersion?: string }): Promise<Uint8Array>;
  mutate: typeof mutateDriveFile;
  export(token: string, fileId: string, mimeType: string): Promise<Uint8Array>;
  create(
    this: void,
    token: string,
    input: { name: string; mimeType: string; parentId: string; bytes?: Buffer },
  ): Promise<DriveFile>;
}

export interface GoogleDriveAgentToolDeps {
  eventStore: GoogleDriveAgentToolStore;
  googleAccessToken: () => Promise<string | undefined>;
  drive?: GoogleDriveAgentApi;
}

async function isWithinFolder(
  drive: Pick<GoogleDriveAgentApi, 'get'>,
  token: string,
  file: DriveFile,
  rootId: string,
): Promise<boolean> {
  if (file.trashed) return false;
  if (file.id === rootId) return true;
  const pending = [...(file.parents ?? [])];
  const visited = new Set<string>([file.id]);
  while (pending.length > 0 && visited.size <= 100) {
    const id = pending.pop()!;
    if (id === rootId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    let parent: DriveFile;
    try {
      parent = await drive.get(token, id);
    } catch (error) {
      if (
        error instanceof GoogleDriveError &&
        (error.reason === 'http_403' || error.reason === 'http_404')
      ) {
        return false;
      }
      throw error;
    }
    if (parent.trashed) return false;
    pending.push(...(parent.parents ?? []));
  }
  return false;
}

/** Resolve a file only when its parent chain reaches the folder linked to this project. */
async function resolveProjectDriveFile(input: {
  drive: Pick<GoogleDriveAgentApi, 'get' | 'list'>;
  token: string;
  rootId: string;
  fileId?: string;
  name?: string;
  mimeTypes?: readonly string[];
}): Promise<DriveFile> {
  let candidates: DriveFile[];
  if (input.fileId !== undefined) {
    candidates = [await input.drive.get(input.token, input.fileId)];
  } else {
    const name = input.name!.trim();
    candidates = [];
    let pageToken: string | undefined;
    const seenPageTokens = new Set<string>();
    do {
      const page = await input.drive.list({
        accessToken: input.token,
        query: name,
        pageSize: 100,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      candidates.push(
        ...page.files.filter(
          (file) => file.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0,
        ),
      );
      pageToken = page.nextPageToken;
      if (pageToken !== undefined && seenPageTokens.has(pageToken)) {
        throw new Error('Google Drive search returned a repeated page token');
      }
      if (pageToken !== undefined) seenPageTokens.add(pageToken);
    } while (pageToken !== undefined);
  }
  const allowed: DriveFile[] = [];
  for (const candidate of candidates) {
    if (
      (input.mimeTypes === undefined || input.mimeTypes.includes(candidate.mimeType)) &&
      (await isWithinFolder(input.drive, input.token, candidate, input.rootId))
    ) {
      allowed.push(candidate);
    }
  }
  if (allowed.length === 0)
    throw new Error('Google Drive file is outside the linked project folder');
  if (allowed.length > 1)
    throw new Error('More than one file with that name exists in the linked folder');
  return allowed[0]!;
}

export function createGoogleDriveAgentTool(deps: GoogleDriveAgentToolDeps): {
  invoke(input: WorkspaceInvocationInput): Promise<unknown>;
} {
  const drive: GoogleDriveAgentApi = deps.drive ?? {
    get: getDriveFileSnapshot,
    mutate: mutateDriveFile,
    list: listDriveFiles,
    download: downloadDriveFile,
    export: exportDriveFile,
    create: createDriveFile,
  };
  return {
    async invoke(input) {
      const session = await deps.eventStore.getSession(input.sessionId);
      if (session === undefined || session.projectId !== input.projectId) {
        throw new Error('Google Drive is restricted to the calling session');
      }
      const request = googleDriveRequestSchema.parse(input.request);
      const settings = await deps.eventStore.getProjectSettings(input.projectId);
      const rootId = settings?.googleDriveFolderId;
      const credential = await deps.eventStore.getVeritySettings?.();
      if (request.action !== 'read_document_url' && (rootId === undefined || rootId === null)) {
        throw new Error('No Google Drive folder is linked to this project');
      }
      const token = await deps.googleAccessToken();
      if (token === undefined) throw new Error('Google Drive is not connected');
      const mutation = googleDriveIsMutation(request);
      if (mutation && settings?.googleDriveAccessMode === 'read-only')
        throw new Error('This project has read-only Google Drive access');
      if (googleDriveNeedsApproval(request) && input.approvedByCard !== true)
        throw new Error('This Drive change requires explicit approval');
      const recheck = async () => {
        const callingSession = await deps.eventStore.getSession(input.sessionId);
        if (callingSession?.projectId !== input.projectId)
          throw new Error('The calling session changed projects during this operation');
        const current = await deps.eventStore.getProjectSettings(input.projectId);
        const account = await deps.eventStore.getVeritySettings?.();
        if (
          current?.googleDriveFolderId !== rootId ||
          (mutation && current?.googleDriveAccessMode === 'read-only')
        )
          throw new Error('Google Drive project access changed during this operation');
        if (
          credential &&
          (credential.googleDriveAccountEmail !== account?.googleDriveAccountEmail ||
            credential.googleDriveRefreshToken !== account?.googleDriveRefreshToken)
        )
          throw new Error('The connected Google account changed during this operation');
      };
      if (request.action === 'read_document_url') {
        await recheck();
        const file = await drive.get(token, new URL(request.url).pathname.split('/')[3]!);
        if (file.trashed || file.mimeType !== 'application/vnd.google-apps.document')
          throw new Error('The link must reference an available Google Docs document');
        const bytes = await drive.export(token, file.id, 'text/markdown');
        await recheck();
        return {
          file,
          mimeType: 'text/markdown',
          encoding: 'utf8',
          content: Buffer.from(bytes).toString('utf8'),
        };
      }
      // Other actions retain the linked-folder boundary.
      if (rootId === undefined || rootId === null)
        throw new Error('No Google Drive folder is linked to this project');
      if (mutation) {
        await recheck();
        const completed = await deps.eventStore.getCompletedGoogleWorkspaceInvocation?.(input);
        if (completed) return completed.result;
      }
      const perform = async (operation: () => Promise<unknown>) => {
        await recheck();
        const claim = await deps.eventStore.claimGoogleWorkspaceInvocation(input);
        if (claim.status === 'completed') return claim.result;
        if (claim.status === 'pending')
          throw new Error(
            'This Drive change may already have happened; inspect the file before retrying',
          );
        await recheck();
        const result = await operation();
        await deps.eventStore.completeGoogleWorkspaceInvocation(input.invocationId, result);
        return result;
      };
      if (request.action === 'capabilities')
        return {
          read: true,
          write: settings?.googleDriveAccessMode !== 'read-only',
          conditionalWrites: true,
          trash: 'recoverable',
          recursiveFolderTrash: true,
          nativeContentOverwrite: false,
          maxWriteBytes: 10_000_000,
        };
      if (request.action === 'list') {
        const folder =
          request.folderId === undefined
            ? await drive.get(token, rootId)
            : await resolveProjectDriveFile({
                drive,
                token,
                rootId,
                fileId: request.folderId,
                mimeTypes: [FOLDER_MIME],
              });
        return drive.list({
          accessToken: token,
          parentId: folder.id,
          ...(request.pageToken === undefined ? {} : { pageToken: request.pageToken }),
        });
      }
      if (request.action === 'search') {
        const page = await drive.list({
          accessToken: token,
          query: request.query,
          pageSize: 100,
          ...(request.pageToken === undefined ? {} : { pageToken: request.pageToken }),
        });
        const files: DriveFile[] = [];
        for (const file of page.files) {
          if (await isWithinFolder(drive, token, file, rootId)) files.push(file);
        }
        return { files, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
      }
      if (request.action === 'upload' || request.action === 'create_folder') {
        const folder =
          request.folderId === undefined
            ? await drive.get(token, rootId)
            : await resolveProjectDriveFile({
                drive,
                token,
                rootId,
                fileId: request.folderId,
                mimeTypes: [FOLDER_MIME],
              });
        if (folder.mimeType !== FOLDER_MIME || folder.trashed)
          throw new Error('Destination must be an available folder');
        if (
          request.action === 'upload' &&
          request.mimeType.trim().startsWith('application/vnd.google-apps.')
        )
          throw new Error('Use dedicated Workspace tools for native document contents');
        return perform(() =>
          drive.create(token, {
            name: request.name.trim(),
            mimeType: request.action === 'create_folder' ? FOLDER_MIME : request.mimeType.trim(),
            parentId: folder.id,
            ...(request.action === 'upload'
              ? { bytes: Buffer.from(request.content, request.encoding ?? 'utf8') }
              : {}),
          }),
        );
      }
      if (
        request.action === 'overwrite' ||
        request.action === 'rename' ||
        request.action === 'move' ||
        request.action === 'trash'
      ) {
        const file = await resolveProjectDriveFile({
          drive,
          token,
          rootId,
          fileId: request.fileId,
        });
        if (file.id === rootId) throw new Error('The linked project folder cannot be changed');
        if (file.trashed) throw new Error('This Drive file is already in the trash');
        if (file.name !== request.name)
          throw new Error('The Drive file name changed; read it again before approving');
        if (file.version !== request.expectedVersion)
          throw new Error('The Drive file changed; read it again before retrying');
        if (
          request.action === 'overwrite' &&
          file.mimeType.startsWith('application/vnd.google-apps.')
        )
          throw new Error(
            'Native files and folders cannot be overwritten; use Workspace content tools',
          );
        if (request.action === 'move') {
          const destination = await resolveProjectDriveFile({
            drive,
            token,
            rootId,
            fileId: request.folderId,
            mimeTypes: [FOLDER_MIME],
          });
          if (
            destination.id === file.id ||
            (await isWithinFolder(drive, token, destination, file.id))
          )
            throw new Error('A folder cannot be moved into itself or its descendants');
          if (destination.trashed) throw new Error('Destination is in the trash');
        }
        return perform(() =>
          drive.mutate(token, file.id, {
            expectedVersion: request.expectedVersion,
            ...(request.action === 'rename' ? { name: request.newName } : {}),
            ...(request.action === 'trash' ? { trashed: true } : {}),
            ...(request.action === 'overwrite'
              ? {
                  bytes: Buffer.from(request.content, request.encoding ?? 'utf8'),
                  mimeType: file.mimeType,
                }
              : {}),
            ...(request.action === 'move'
              ? {
                  addParentId: request.folderId,
                  ...(file.parents?.length ? { removeParentId: file.parents.join(',') } : {}),
                }
              : {}),
          }),
        );
      }
      if (request.action === 'select_workspace_file') {
        const file = await resolveProjectDriveFile({
          drive,
          token,
          rootId,
          ...(request.fileId === undefined ? {} : { fileId: request.fileId }),
          ...(request.name === undefined ? {} : { name: request.name }),
          mimeTypes: [
            'application/vnd.google-apps.presentation',
            'application/vnd.google-apps.document',
            'application/vnd.google-apps.spreadsheet',
          ],
        });
        const kind = file.mimeType.endsWith('.presentation')
          ? 'slides'
          : file.mimeType.endsWith('.document')
            ? 'docs'
            : 'sheets';
        await deps.eventStore.setSessionWorkspaceFile({
          sessionId: input.sessionId,
          kind,
          fileId: file.id,
          name: file.name,
          webViewLink:
            file.webViewLink ?? `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`,
          revisionId: null,
        });
        return { file, kind, selected: true };
      }
      const file = await resolveProjectDriveFile({
        drive,
        token,
        rootId,
        ...(request.fileId === undefined ? {} : { fileId: request.fileId }),
        ...(request.name === undefined ? {} : { name: request.name }),
      });
      const snapshot = await drive.get(token, file.id);
      if (!(await isWithinFolder(drive, token, snapshot, rootId)))
        throw new Error('Google Drive file is outside the linked project folder');
      await recheck();
      if (file.mimeType === FOLDER_MIME)
        return { file: snapshot, expectedVersion: snapshot.version };
      const native = NATIVE_EXPORTS[snapshot.mimeType];
      const bytes = native
        ? await drive.export(token, file.id, native.mimeType)
        : await drive.download(token, file.id, {
            ...(snapshot.version ? { expectedVersion: snapshot.version } : {}),
          });
      const text = native?.text === true || snapshot.mimeType.startsWith('text/');
      return {
        file: snapshot,
        expectedVersion: snapshot.version,
        mimeType: native?.mimeType ?? snapshot.mimeType,
        encoding: text ? 'utf8' : 'base64',
        content: Buffer.from(bytes).toString(text ? 'utf8' : 'base64'),
      };
    },
  };
}
