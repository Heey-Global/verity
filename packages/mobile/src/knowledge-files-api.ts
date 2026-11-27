import { z } from 'zod';

import type { SessionFileRoot, TransportRequestInit } from './api.js';
import { uploadBodyWithMimeType } from './upload-body.js';

// Managing knowledge like files — a project's knowledge folder or Shared — plus
// the folder calls of a session's explorer and a project's Google Drive folder.
// `VerityClient` carries them as its own methods
// (docs/adr/0029-module-boundaries-and-file-size.md).

/** Which knowledge a call addresses: Shared, or one project's knowledge folder. */
export type KnowledgeFilesScope = { kind: 'shared' } | { kind: 'project'; projectId: string };

const linkCountSchema = z.object({ path: z.string(), links: z.number().int().nonnegative() });

const knowledgeRelocatedSchema = z.object({
  path: z.string(),
  warning: z.string().optional(),
  /** Wiki pages whose links were rewritten to follow the entry, with how many
   *  links. A server from before link keeping answers without it: none were. */
  linksUpdated: z.array(linkCountSchema).default([]),
});
/** A renamed or moved knowledge entry: its new path, and the Wiki pages kept linking to it. */
export type KnowledgeRelocated = z.infer<typeof knowledgeRelocatedSchema>;

const knowledgeBacklinksSchema = z.object({ pages: z.array(linkCountSchema) });
/** Wiki pages of the same scope that link to an entry, before it moves. */
export type KnowledgeBacklinks = z.infer<typeof knowledgeBacklinksSchema>;

const createdPathSchema = z.object({ path: z.string() });
const knowledgeUploadedSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
});
export type KnowledgeFileUploaded = z.infer<typeof knowledgeUploadedSchema>;

type Request = (path: string, init: TransportRequestInit) => Promise<Response>;

const isNotFound = (error: unknown) =>
  typeof error === 'object' && error !== null && 'status' in error && error.status === 404;

/** The scope's route base: `/knowledge/shared` or `/projects/:id/knowledge`. */
function scopeBase(scope: KnowledgeFilesScope): string {
  return scope.kind === 'shared'
    ? '/knowledge/shared'
    : `/projects/${encodeURIComponent(scope.projectId)}/knowledge`;
}

const json = (body: unknown): TransportRequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** The knowledge file calls, bound to the client's `request` and to the one it
 *  sends uploads through (which may use a transport of its own). */
export function knowledgeFilesClient(request: Request, upload: Request) {
  return {
    /** Delete a Wiki or Sources file or folder; library roots, decisions and
     *  the Sources import folders are refused (403). */
    deleteKnowledgeFile: async (scope: KnowledgeFilesScope, path: string): Promise<void> => {
      await request(`${scopeBase(scope)}/files?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
      });
    },

    /** Give an entry a new name in its folder; a taken name is refused (409). */
    renameKnowledgeFile: async (
      scope: KnowledgeFilesScope,
      path: string,
      name: string,
    ): Promise<KnowledgeRelocated> => {
      const response = await request(`${scopeBase(scope)}/files/rename`, json({ path, name }));
      return knowledgeRelocatedSchema.parse(await response.json());
    },

    /** Move a file or folder into `toPath`, a folder of the same area
     *  (`insights…` or `sources…`, never empty). */
    moveKnowledgeFile: async (
      scope: KnowledgeFilesScope,
      path: string,
      toPath: string,
    ): Promise<KnowledgeRelocated> => {
      const response = await request(`${scopeBase(scope)}/files/move`, json({ path, toPath }));
      return knowledgeRelocatedSchema.parse(await response.json());
    },

    /** Copy a picked file into a knowledge folder; an existing file is never replaced. */
    uploadKnowledgeFile: async (
      scope: KnowledgeFilesScope,
      file: { path: string; fileName: string; data: Blob },
    ): Promise<KnowledgeFileUploaded> => {
      // Percent-encoded explicitly, as `uploadSessionFile` does: React Native's
      // URLSearchParams polyfill must not decide how a name with an umlaut travels.
      const response = await upload(
        `${scopeBase(scope)}/files?path=${encodeURIComponent(file.path)}&fileName=${encodeURIComponent(file.fileName)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: uploadBodyWithMimeType(file.data),
        },
      );
      return knowledgeUploadedSchema.parse(await response.json());
    },

    /** Create an empty folder `name` inside `parent` (`insights`, `sources/…`). */
    createKnowledgeFileFolder: async (
      scope: KnowledgeFilesScope,
      parent: string,
      name: string,
    ): Promise<{ path: string }> => {
      const response = await request(`${scopeBase(scope)}/folders`, json({ path: parent, name }));
      return createdPathSchema.parse(await response.json());
    },

    /** Wiki pages that link to `path` (a page, folder or Source). */
    listKnowledgeBacklinks: async (
      scope: KnowledgeFilesScope,
      path: string,
    ): Promise<KnowledgeBacklinks> => {
      let response: Response;
      try {
        response = await request(
          `${scopeBase(scope)}/files/backlinks?path=${encodeURIComponent(path)}`,
          { method: 'GET' },
        );
      } catch (error) {
        // A server from before link keeping has no such route and rewrites no
        // links either: there is nothing to ask about, and the rename goes ahead.
        if (isNotFound(error)) return { pages: [] };
        throw error;
      }
      return knowledgeBacklinksSchema.parse(await response.json());
    },

    /** Create an empty folder in a session's explorer root (not drafts). */
    createSessionFolder: async (
      sessionId: string,
      root: Exclude<SessionFileRoot, 'drafts'>,
      parent: string,
      name: string,
    ): Promise<{ path: string }> => {
      const response = await request(
        `/sessions/${encodeURIComponent(sessionId)}/files/folders`,
        json({ root, path: parent, name }),
      );
      return createdPathSchema.parse(await response.json());
    },
  };
}

/** Folder creation and rename/move in a project's linked Google Drive folder. */
export function projectGoogleDriveFilesClient<File>(request: Request, fileSchema: z.ZodType<File>) {
  const driveFiles = (projectId: string, linkId: string) =>
    `/projects/${encodeURIComponent(projectId)}/google-drive/folders/${encodeURIComponent(linkId)}/files`;
  const fileResponse = z.object({ file: fileSchema });
  return {
    /** Create a folder in the linked folder, or in `parentId` inside it. */
    createProjectGoogleDriveFolder: async (
      projectId: string,
      linkId: string,
      folder: { parentId?: string; name: string },
    ): Promise<File> => {
      const response = await request(
        `${driveFiles(projectId, linkId)}/create`,
        json({ ...folder, kind: 'folder' }),
      );
      return fileResponse.parse(await response.json()).file;
    },

    /** Rename a file or folder and/or move it to `parentId`, against the version
     *  it was read at; a stale version is refused rather than overwritten. */
    updateProjectGoogleDriveFile: async (
      projectId: string,
      linkId: string,
      fileId: string,
      change: { expectedVersion: string; name?: string; parentId?: string },
    ): Promise<File> => {
      const response = await request(
        `${driveFiles(projectId, linkId)}/${encodeURIComponent(fileId)}`,
        { ...json({ ...change, confirmed: true }), method: 'PATCH' },
      );
      return fileResponse.parse(await response.json()).file;
    },
  };
}
