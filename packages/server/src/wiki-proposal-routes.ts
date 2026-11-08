import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { FileWriteError } from './session-file-write.js';
import { WikiProposalError, type WikiProposals } from './wiki-proposals.js';

const projectParams = z.object({ id: z.string().min(1).max(128) });
const proposalParams = projectParams.extend({ proposalId: z.string().uuid() });
/** Omitted paths decide every pending change of the proposal. */
const decideBody = z
  .object({ paths: z.array(z.string().min(1).max(512)).min(1).max(20).optional() })
  .strict()
  .default({});

/**
 * Review of proposed Wiki changes. Reading follows the Wiki's read access;
 * applying and rejecting follow its edit access (see paired-route-policy).
 */
export function registerWikiProposalRoutes(app: FastifyInstance, proposals: WikiProposals): void {
  void app.register((instance, _options, done) => {
    instance.setErrorHandler((error, _request, reply) => {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid request' });
      if (error instanceof WikiProposalError || error instanceof FileWriteError)
        return reply.code(error.status).send({ error: error.message });
      return reply.send(error);
    });
    instance.get('/projects/:id/knowledge/proposals', async (request) => {
      const { id } = projectParams.parse(request.params);
      return { proposals: await proposals.listOpen(id) };
    });
    instance.get('/projects/:id/knowledge/proposals/:proposalId', async (request) => {
      const { id, proposalId } = proposalParams.parse(request.params);
      return proposals.get(id, proposalId);
    });
    instance.post('/projects/:id/knowledge/proposals/:proposalId/apply', async (request) => {
      const { id, proposalId } = proposalParams.parse(request.params);
      const { paths } = decideBody.parse(request.body ?? {});
      return proposals.apply(id, proposalId, paths);
    });
    instance.post('/projects/:id/knowledge/proposals/:proposalId/reject', async (request) => {
      const { id, proposalId } = proposalParams.parse(request.params);
      const { paths } = decideBody.parse(request.body ?? {});
      return proposals.reject(id, proposalId, paths);
    });
    done();
  });
}
