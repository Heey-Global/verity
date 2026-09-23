import type { ProjectSettingsRecord } from '@verity/store';

import {
  GoogleDriveError,
  createDriveFile,
  downloadDriveFile,
  exportDriveFile,
  getDriveFile,
  listDriveFiles,
  type DriveFile,
  type DriveFileList,
} from './google-drive.js';
import type { WorkspaceInvocationInput } from './google-workspace-tool-types.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const NATIVE_EXPORTS: Record<string, { mimeType: string; text: boolean }> = {
  'application/vnd.google-apps.document': { mimeType: 'text/markdown', text: true },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'text/csv', text: true },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    text: false,
  },
};

interface GoogleDriveAgentToolStore {
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
  get(token: string, fileId: string): Promise<DriveFile>;
  list(input: {
    accessToken: string;
    parentId?: string;
    query?: string;
    pageToken?: string;
    pageSize?: number;
  }): Promise<DriveFileList>;
  download(token: string, fileId: string): Promise<Uint8Array>;
  export(token: string, fileId: string, mimeType: string): Promise<Uint8Array>;
  create(
    token: string,
    input: { name: string; mimeType: string; parentId: string; bytes?: Buffer },
  ): Promise<DriveFile>;
}

export interface GoogleDriveAgentToolDeps {
  eventStore: GoogleDriveAgentToolStore;
  googleAccessToken: () => Promise<string | undefined>;
  drive?: GoogleDriveAgentApi;
}

type DriveRequest =
  | { action: 'list'; folderId?: string; pageToken?: string }
  | { action: 'search'; query: string; pageToken?: string }
  | { action: 'read'; fileId?: string; name?: string }
  | { action: 'select_workspace_file'; fileId?: string; name?: string }
  | {
      action: 'upload';
      name: string;
      mimeType: string;
      content: string;
      encoding?: 'utf8' | 'base64';
      folderId?: string;
    };

function parseRequest(value: unknown): DriveRequest {
  if (typeof value !== 'object' || value === null) throw new Error('Google Drive request required');
  const request = value as Record<string, unknown>;
  if (request.action === 'list') {
    if (request.folderId !== undefined && typeof request.folderId !== 'string') {
      throw new Error('folderId must be a string');
    }
    return request as DriveRequest;
  }
  if (request.action === 'search') {
    if (typeof request.query !== 'string' || request.query.trim().length === 0) {
      throw new Error('search requires a query');
    }
    return request as DriveRequest;
  }
  if (request.action === 'read' || request.action === 'select_workspace_file') {
    if (
      (typeof request.fileId !== 'string' || request.fileId.length === 0) &&
      (typeof request.name !== 'string' || request.name.trim().length === 0)
    ) {
      throw new Error(`${request.action} requires fileId or name`);
    }
    return request as DriveRequest;
  }
  if (request.action === 'upload') {
    if (
      typeof request.name !== 'string' ||
      request.name.trim().length === 0 ||
      typeof request.mimeType !== 'string' ||
      request.mimeType.trim().length === 0 ||
      typeof request.content !== 'string'
    )
      throw new Error('upload requires name, mimeType, and content');
    if (
      request.encoding !== undefined &&
      request.encoding !== 'utf8' &&
      request.encoding !== 'base64'
    )
      throw new Error('unsupported upload encoding');
    return request as DriveRequest;
  }
  throw new Error('Unsupported Google Drive action');
}

async function isWithinFolder(
  drive: Pick<GoogleDriveAgentApi, 'get'>,
  token: string,
  file: DriveFile,
  rootId: string,
): Promise<boolean> {
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
    get: getDriveFile,
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
      const rootId = (await deps.eventStore.getProjectSettings(input.projectId))
        ?.googleDriveFolderId;
      if (rootId === undefined || rootId === null) {
        throw new Error('No Google Drive folder is linked to this project');
      }
      const token = await deps.googleAccessToken();
      if (token === undefined) throw new Error('Google Drive is not connected');
      const request = parseRequest(input.request);
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
      if (request.action === 'upload') {
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
        return drive.create(token, {
          name: request.name.trim(),
          mimeType: request.mimeType.trim(),
          parentId: folder.id,
          bytes: Buffer.from(request.content, request.encoding ?? 'utf8'),
        });
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
      if (file.mimeType === FOLDER_MIME) throw new Error('A folder cannot be read as a file');
      const native = NATIVE_EXPORTS[file.mimeType];
      const bytes = native
        ? await drive.export(token, file.id, native.mimeType)
        : await drive.download(token, file.id);
      const text = native?.text === true || file.mimeType.startsWith('text/');
      return {
        file,
        mimeType: native?.mimeType ?? file.mimeType,
        encoding: text ? 'utf8' : 'base64',
        content: Buffer.from(bytes).toString(text ? 'utf8' : 'base64'),
      };
    },
  };
}
