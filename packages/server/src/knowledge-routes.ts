import type { FastifyInstance } from 'fastify';
import { KnowledgeError, type KnowledgeStore } from '@verity/store';
import { z } from 'zod';

const id = z.string().min(1).max(128);
const params = z.object({ id });
const name = z.string().trim().min(1).max(160);
const bodyMarkdown = z.string().max(262_144);
const documentBody = z.object({ folderId: id, title: name, bodyMarkdown }).strict();
const editBody = z.object({ title: name, bodyMarkdown, expectedRevisionId: id }).strict();
const grantsBody = z
  .object({
    grants: z
      .array(z.object({ folderId: id, mode: z.enum(['read', 'read_write']) }).strict())
      .max(256),
  })
  .strict();

class KnowledgeCleanupPendingError extends Error {
  constructor() {
    super(
      'Access changes were saved. Some sessions are still stopping; cleanup will retry automatically.',
    );
  }
}

export interface KnowledgeRouteDeps {
  knowledge: KnowledgeStore;
  reconcileInvalidations(): Promise<void>;
  schedule?: (projectId: string, sourceDocumentIds: string[]) => Promise<void> | void;
  scheduleReconciliation?: (projectId: string) => Promise<void> | void;
  wakeMaintenance?: (projectId: string) => Promise<void> | void;
}

/** Operator routes use the server's default paired-device authentication gate. */
export function registerKnowledgeRoutes(app: FastifyInstance, deps: KnowledgeRouteDeps): void {
  const store = deps.knowledge;
  const reconcile = async (): Promise<void> => {
    try {
      await deps.reconcileInvalidations();
    } catch {
      throw new KnowledgeCleanupPendingError();
    }
  };
  // Encapsulation keeps knowledge errors from changing unrelated route behavior.
  void app.register((instance, _options, done) => {
    instance.setErrorHandler((error, _request, reply) => {
      if (error instanceof KnowledgeCleanupPendingError) {
        return reply.code(503).send({ error: error.message, code: 'knowledgeCleanupPending' });
      }
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid request' });
      if (error instanceof KnowledgeError) {
        return reply.code(error.statusCode).send({ error: error.message, code: error.code });
      }
      throw error;
    });
    instance.get('/knowledge/folders', async () => ({ folders: await store.listFolders() }));
    instance.post('/knowledge/folders', async (request) => ({
      folder: await store.createFolder(
        z.object({ name, parentId: id.nullable() }).strict().parse(request.body),
      ),
    }));
    instance.patch('/knowledge/folders/:id', async (request) => {
      const body = z
        .object({
          name: name.optional(),
          parentId: id.nullable().optional(),
          expectedPolicyToken: id.optional(),
        })
        .strict()
        .parse(request.body);
      if (body.parentId !== undefined && body.expectedPolicyToken === undefined)
        throw new KnowledgeError(
          'invalid',
          'Preview and confirm the access changes before moving a folder',
        );
      const folderId = params.parse(request.params).id;
      const previousSourceProject = await store.projectForSourceFolder(folderId);
      const folder = await store.updateFolder(folderId, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
        ...(body.expectedPolicyToken === undefined
          ? {}
          : { expectedPolicyToken: body.expectedPolicyToken }),
      });
      const nextSourceProject = await store.projectForSourceFolder(folder.id);
      if (previousSourceProject && previousSourceProject !== nextSourceProject)
        await deps.wakeMaintenance?.(previousSourceProject);
      if (nextSourceProject && nextSourceProject !== previousSourceProject)
        await deps.wakeMaintenance?.(nextSourceProject);
      await reconcile();
      return { folder };
    });
    instance.post('/knowledge/folders/:id/move-preview', async (request) => {
      const { parentId } = z.object({ parentId: id.nullable() }).strict().parse(request.body);
      return store.previewFolderMove(params.parse(request.params).id, parentId);
    });
    instance.post('/knowledge/documents/:id/move-preview', async (request) => {
      const { folderId } = z.object({ folderId: id }).strict().parse(request.body);
      return store.previewDocumentMove(params.parse(request.params).id, folderId);
    });
    instance.delete('/knowledge/folders/:id', async (request) => {
      const folderId = params.parse(request.params).id;
      const sourceProject = await store.projectForSourceFolder(folderId);
      await store.deleteFolder(folderId);
      if (sourceProject) await deps.wakeMaintenance?.(sourceProject);
      await reconcile();
      return { ok: true };
    });
    instance.get('/knowledge/documents', async (request) => {
      const query = z
        .object({
          folderId: id.optional(),
          query: z.string().max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .strict()
        .parse(request.query);
      return {
        documents: await store.listDocuments({
          ...(query.folderId === undefined ? {} : { folderId: query.folderId }),
          ...(query.query === undefined ? {} : { query: query.query }),
          ...(query.offset === undefined ? {} : { offset: query.offset }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        }),
      };
    });
    instance.get('/knowledge/documents/:id', async (request) => {
      const query = z.object({ revisionId: id.optional() }).strict().parse(request.query);
      return {
        document: await store.getDocument(params.parse(request.params).id, query.revisionId),
      };
    });
    const wakeMaintenance = async (document: { id: string; folderId: string }): Promise<void> => {
      const projectId = await store.projectForSourceFolder(document.folderId);
      if (projectId) await deps.schedule?.(projectId, [document.id]);
    };
    instance.post('/knowledge/documents', { bodyLimit: 2 * 1024 * 1024 }, async (request) => {
      const document = await store.createDocument(documentBody.parse(request.body));
      await wakeMaintenance(document);
      return { document };
    });
    instance.put('/knowledge/documents/:id', { bodyLimit: 2 * 1024 * 1024 }, async (request) => {
      const document = await store.updateDocument(
        params.parse(request.params).id,
        editBody.parse(request.body),
      );
      await wakeMaintenance(document);
      return { document };
    });
    instance.patch('/knowledge/documents/:id', async (request) => {
      const { folderId, expectedPolicyToken } = z
        .object({ folderId: id, expectedPolicyToken: id })
        .strict()
        .parse(request.body);
      const documentId = params.parse(request.params).id;
      const before = await store.getDocument(documentId);
      const previousSourceProject = await store.projectForSourceFolder(before.folderId);
      const document = await store.moveDocument(documentId, folderId, expectedPolicyToken);
      const nextSourceProject = await store.projectForSourceFolder(document.folderId);
      if (previousSourceProject && previousSourceProject !== nextSourceProject)
        await deps.scheduleReconciliation?.(previousSourceProject);
      if (nextSourceProject && nextSourceProject !== previousSourceProject)
        await deps.schedule?.(nextSourceProject, [document.id]);
      await reconcile();
      return { document };
    });
    instance.delete('/knowledge/documents/:id', async (request) => {
      const document = await store.getDocument(params.parse(request.params).id);
      const projectId = await store.projectForSourceFolder(document.folderId);
      await store.deleteDocument(document.id);
      if (projectId) await deps.scheduleReconciliation?.(projectId);
      await reconcile();
      return { ok: true };
    });
    instance.get('/knowledge/documents/:id/revisions', async (request) => {
      const query = z
        .object({
          offset: z.coerce.number().int().min(0).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .strict()
        .parse(request.query);
      return {
        revisions: await store.listRevisions(params.parse(request.params).id, {
          ...(query.offset === undefined ? {} : { offset: query.offset }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        }),
      };
    });
    instance.post('/knowledge/documents/:id/restore', async (request) => {
      const body = z
        .object({ revisionId: id, expectedRevisionId: id })
        .strict()
        .parse(request.body);
      const document = await store.restoreDocument(params.parse(request.params).id, body);
      await wakeMaintenance(document);
      return { document };
    });
    instance.get('/projects/:id/knowledge-grants', async (request) => ({
      grants: await store.getGrants(params.parse(request.params).id),
    }));
    instance.put('/projects/:id/knowledge-grants', async (request) => {
      const projectId = params.parse(request.params).id;
      await store.setGrants(projectId, grantsBody.parse(request.body).grants);
      await reconcile();
      return { grants: await store.getGrants(projectId) };
    });
    instance.get('/knowledge/export', async (request) => {
      const { folderId } = z.object({ folderId: id.optional() }).strict().parse(request.query);
      return { documents: await store.exportDocuments(folderId) };
    });
    instance.post('/knowledge/import', { bodyLimit: 2_500_000 }, async (request) => {
      const body = z
        .object({
          folderId: id,
          documents: z
            .array(z.object({ path: z.string().min(1).max(2048), bodyMarkdown }).strict())
            .min(1)
            .max(100),
        })
        .strict()
        .parse(request.body);
      const imported = await store.importDocuments(body.folderId, body.documents);
      const projectId = await store.projectForSourceFolder(body.folderId);
      if (projectId) await deps.wakeMaintenance?.(projectId);
      return { imported };
    });
    done();
  });
}
