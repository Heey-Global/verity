import { chmod } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  GoogleDriveError,
  createDriveFile,
  deleteDriveFile,
  downloadDriveFile,
  exportDriveFile,
  getDriveFile,
  listDriveFiles,
  planDriveImport,
  referenceDocFileName,
  updateDriveFile,
  type DriveFile,
} from './google-drive.js';
import { ensureProjectKnowledge, KNOWLEDGE_DOCUMENTS_DIR } from './knowledge-folder.js';
import { extractKnowledgeFile } from './knowledge-file-ingest.js';
import { writeReferenceDocFile } from './reference-docs.js';

const params = z.object({ id: z.string().min(1), folderId: z.string().min(1) });
const fileParams = params.extend({ fileId: z.string().min(1) });
const listQuery = z.object({
  parentId: z.string().min(1).optional(),
  pageToken: z.string().min(1).optional(),
});
const createBody = z.object({
  parentId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(255),
  kind: z.enum(['folder', 'docs', 'sheets', 'slides']),
});
const updateBody = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    parentId: z.string().min(1).optional(),
  })
  .refine((body) => body.name !== undefined || body.parentId !== undefined);
const uploadQuery = z.object({
  parentId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(255),
});

export interface ProjectGoogleDriveFolder {
  projectId: string;
  folderId: string;
  name: string;
}

export interface ProjectGoogleDriveRouteDeps {
  getLinkedFolder(
    projectId: string,
    folderId: string,
  ): Promise<ProjectGoogleDriveFolder | undefined>;
  googleAccessToken(): Promise<string | undefined>;
  dataRoot?: string;
}

export class GoogleDriveFolderAuthorityError extends Error {}

/** Prove that a file is the linked root or has it in its current parent chain. */
export async function assertDriveFileInLinkedFolder(
  accessToken: string,
  linkedFolderId: string,
  fileId: string,
  seen = new Set<string>(),
  getFile: (accessToken: string, fileId: string) => Promise<DriveFile> = getDriveFile,
): Promise<DriveFile> {
  if (seen.has(fileId)) throw new GoogleDriveFolderAuthorityError('cyclic Google Drive ancestry');
  seen.add(fileId);
  const file = await getFile(accessToken, fileId);
  if (file.id === linkedFolderId) return file;
  for (const parentId of file.parents ?? []) {
    try {
      await assertDriveFileInLinkedFolder(accessToken, linkedFolderId, parentId, seen, getFile);
      return file;
    } catch (error) {
      if (!(error instanceof GoogleDriveFolderAuthorityError)) throw error;
    }
  }
  throw new GoogleDriveFolderAuthorityError('Google Drive file is outside the linked folder');
}

async function bytesFromRequest(request: FastifyRequest, maxBytes = 50_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const body = request.body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  if (body === undefined || body === null || !(Symbol.asyncIterator in Object(body))) {
    throw new GoogleDriveError('upload body is unavailable', 'malformed');
  }
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new GoogleDriveError('Google Drive file is too large', 'too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

const NATIVE_MIME = {
  folder: 'application/vnd.google-apps.folder',
  docs: 'application/vnd.google-apps.document',
  sheets: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation',
} as const;

/** Project-scoped Drive explorer and mutations. Every target is ancestry-checked. */
export function registerProjectGoogleDriveRoutes(
  app: FastifyInstance,
  deps: ProjectGoogleDriveRouteDeps,
): void {
  const context = async (projectId: string, folderId: string) => {
    const [folder, accessToken] = await Promise.all([
      deps.getLinkedFolder(projectId, folderId),
      deps.googleAccessToken(),
    ]);
    return folder && accessToken ? { folder, accessToken } : undefined;
  };

  app.get('/projects/:id/google-drive/folders/:folderId/files', async (request, reply) => {
    const { id, folderId } = params.parse(request.params);
    const query = listQuery.parse(request.query);
    const value = await context(id, folderId);
    if (!value) return reply.code(404).send({ error: 'linked Google Drive folder not found' });
    const parentId = query.parentId ?? folderId;
    try {
      await assertDriveFileInLinkedFolder(value.accessToken, folderId, parentId);
      return listDriveFiles({
        accessToken: value.accessToken,
        parentId,
        pageToken: query.pageToken,
      });
    } catch (error) {
      if (error instanceof GoogleDriveFolderAuthorityError)
        return reply.code(403).send({ error: error.message });
      throw error;
    }
  });

  app.post('/projects/:id/google-drive/folders/:folderId/files/create', async (request, reply) => {
    const { id, folderId } = params.parse(request.params);
    const body = createBody.parse(request.body);
    const value = await context(id, folderId);
    if (!value) return reply.code(404).send({ error: 'linked Google Drive folder not found' });
    const parentId = body.parentId ?? folderId;
    await assertDriveFileInLinkedFolder(value.accessToken, folderId, parentId);
    return {
      file: await createDriveFile(value.accessToken, {
        name: body.name,
        mimeType: NATIVE_MIME[body.kind],
        parentId,
      }),
    };
  });

  app.post('/projects/:id/google-drive/folders/:folderId/files/upload', async (request, reply) => {
    const { id, folderId } = params.parse(request.params);
    const query = uploadQuery.parse(request.query);
    const value = await context(id, folderId);
    if (!value) return reply.code(404).send({ error: 'linked Google Drive folder not found' });
    const parentId = query.parentId ?? folderId;
    await assertDriveFileInLinkedFolder(value.accessToken, folderId, parentId);
    const bytes = await bytesFromRequest(request);
    return {
      file: await createDriveFile(value.accessToken, {
        name: query.name,
        mimeType: query.mimeType,
        parentId,
        bytes,
      }),
    };
  });

  app.patch(
    '/projects/:id/google-drive/folders/:folderId/files/:fileId',
    async (request, reply) => {
      const { id, folderId, fileId } = fileParams.parse(request.params);
      const body = updateBody.parse(request.body);
      const value = await context(id, folderId);
      if (!value) return reply.code(404).send({ error: 'linked Google Drive folder not found' });
      const file = await assertDriveFileInLinkedFolder(value.accessToken, folderId, fileId);
      if (file.id === folderId)
        return reply.code(403).send({ error: 'the linked folder cannot be changed here' });
      if (body.parentId)
        await assertDriveFileInLinkedFolder(value.accessToken, folderId, body.parentId);
      return {
        file: await updateDriveFile(value.accessToken, fileId, {
          ...(body.name ? { name: body.name } : {}),
          ...(body.parentId && body.parentId !== file.parents?.[0]
            ? {
                addParentId: body.parentId,
                ...(file.parents?.[0] ? { removeParentId: file.parents[0] } : {}),
              }
            : {}),
        }),
      };
    },
  );

  app.delete(
    '/projects/:id/google-drive/folders/:folderId/files/:fileId',
    async (request, reply) => {
      const { id, folderId, fileId } = fileParams.parse(request.params);
      const value = await context(id, folderId);
      if (!value) return reply.code(404).send({ error: 'linked Google Drive folder not found' });
      const file = await assertDriveFileInLinkedFolder(value.accessToken, folderId, fileId);
      if (file.id === folderId)
        return reply.code(403).send({ error: 'the linked folder cannot be deleted here' });
      await deleteDriveFile(value.accessToken, fileId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/projects/:id/google-drive/folders/:folderId/files/:fileId/download',
    async (request, reply) => {
      const { id, folderId, fileId } = fileParams.parse(request.params);
      const value = await context(id, folderId);
      if (!value) return reply.code(404).send({ error: 'linked Google Drive folder not found' });
      const file = await assertDriveFileInLinkedFolder(value.accessToken, folderId, fileId);
      const plan = planDriveImport(file.mimeType, file.name);
      const bytes =
        plan.kind === 'export' && plan.exportMimeType
          ? await exportDriveFile(value.accessToken, fileId, plan.exportMimeType)
          : await downloadDriveFile(value.accessToken, fileId);
      reply.header('content-type', plan.exportMimeType ?? file.mimeType);
      return reply.send(Buffer.from(bytes));
    },
  );

  app.post(
    '/projects/:id/google-drive/folders/:folderId/files/:fileId/import',
    async (request, reply) => {
      const { id, folderId, fileId } = fileParams.parse(request.params);
      if (!deps.dataRoot)
        return reply.code(503).send({ error: 'Knowledge storage is unavailable' });
      const value = await context(id, folderId);
      if (!value) return reply.code(404).send({ error: 'linked Google Drive folder not found' });
      const file = await assertDriveFileInLinkedFolder(value.accessToken, folderId, fileId);
      const plan = planDriveImport(file.mimeType, file.name);
      const bytes =
        plan.kind === 'export' && plan.exportMimeType
          ? await exportDriveFile(value.accessToken, fileId, plan.exportMimeType)
          : await downloadDriveFile(value.accessToken, fileId);
      const fileName = referenceDocFileName(file.name, plan.extension, fileId);
      const root = await ensureProjectKnowledge(deps.dataRoot, id);
      const importsDir = `${root}/${KNOWLEDGE_DOCUMENTS_DIR}`;
      await writeReferenceDocFile(importsDir, fileName, bytes);
      await chmod(`${importsDir}/${fileName}`, 0o644);
      await extractKnowledgeFile(root, `${KNOWLEDGE_DOCUMENTS_DIR}/${fileName}`);
      return { path: `${KNOWLEDGE_DOCUMENTS_DIR}/${fileName}`, fileName };
    },
  );
}
