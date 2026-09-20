import type { FastifyInstance } from 'fastify';
import { KnowledgeError, type KnowledgeStore } from '@verity/store';
import { z } from 'zod';

const projectParams = z.object({ id: z.string().min(1).max(128) });
const wikiJobBody = z
  .object({
    sourceDocumentIds: z.array(z.string().min(1).max(128)).max(100),
    kind: z.enum(['ingest', 'check', 'reconcile']),
    model: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type WikiJobRequest = z.infer<typeof wikiJobBody>;

export interface KnowledgeProjectRouteDeps {
  knowledge: KnowledgeStore;
  startWikiJob(projectId: string, input: WikiJobRequest): Promise<unknown>;
}

/** Management routes retain the normal paired-device authentication policy. */
export function registerKnowledgeProjectRoutes(
  app: FastifyInstance,
  deps: KnowledgeProjectRouteDeps,
): void {
  void app.register((instance, _options, done) => {
    instance.setErrorHandler((error, _request, reply) => {
      if (error instanceof z.ZodError)
        return reply.code(400).send({ error: 'Invalid knowledge request' });
      if (error instanceof KnowledgeError)
        return reply.code(error.statusCode).send({ error: error.message, code: error.code });
      throw error;
    });
    instance.get('/projects/:id/knowledge-space', async (request) => ({
      space: await deps.knowledge.getProjectSpace(projectParams.parse(request.params).id),
    }));
    instance.get('/projects/:id/knowledge-overview', async (request) => ({
      overview: await deps.knowledge.getProjectOverview(projectParams.parse(request.params).id),
    }));
    instance.put('/projects/:id/knowledge-overview', async (request) => {
      const body = z
        .object({
          documentId: z.string().min(1).max(128),
          expectedRevisionId: z.string().min(1).max(128),
        })
        .strict()
        .parse(request.body);
      const id = projectParams.parse(request.params).id;
      await deps.knowledge.approveProjectOverview(id, body.documentId, body.expectedRevisionId);
      return { overview: await deps.knowledge.getProjectOverview(id) };
    });
    instance.delete('/projects/:id/knowledge-overview', async (request) => {
      await deps.knowledge.clearProjectOverview(projectParams.parse(request.params).id);
      return { overview: null };
    });
    instance.post('/projects/:id/knowledge-wiki-jobs', async (request, reply) => {
      const job = await deps.startWikiJob(
        projectParams.parse(request.params).id,
        wikiJobBody.parse(request.body),
      );
      return reply.code(202).send({ job });
    });
    instance.get('/projects/:id/knowledge-wiki-jobs', async (request) => ({
      jobs: await deps.knowledge.listWikiJobs(projectParams.parse(request.params).id),
    }));
    instance.get('/knowledge/wiki-jobs/:id', async (request) => {
      const job = await deps.knowledge.getWikiJob(projectParams.parse(request.params).id);
      if (!job) throw new KnowledgeError('not_found');
      return { job };
    });
    done();
  });
}
