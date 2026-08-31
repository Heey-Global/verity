import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PreviewShareConflictError,
  PreviewShareInputError,
  type PreviewShareManager,
  PreviewShareNotFoundError,
} from './preview-share-manager.js';

const createBody = z
  .object({
    pin: z.string().regex(/^\d{6,12}$/),
    ttlSeconds: z.number().int(),
  })
  .strict();
const devServerParams = z.object({ devServerId: z.string().min(1) });
const projectParams = z.object({ projectId: z.string().min(1) });
const shareParams = z.object({ shareId: z.string().min(1) });
const staticCreateBody = createBody.extend({
  staticPath: z.string().trim().min(1).max(1024),
});

export function registerPreviewShareRoutes(
  app: FastifyInstance,
  deps: { eventStore: EventStore; manager?: PreviewShareManager },
): void {
  app.post('/dev-servers/:devServerId/public-shares', async (request, reply) => {
    if (!deps.manager) {
      reply.code(503);
      return { error: 'public previews are not configured' };
    }
    try {
      const { devServerId } = devServerParams.parse(request.params);
      const body = createBody.parse(request.body);
      const share = await deps.manager.create({ devServerId, ...body });
      reply.code(201);
      return { share };
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof PreviewShareInputError) {
        reply.code(400);
        return { error: error.message };
      }
      if (error instanceof PreviewShareNotFoundError) {
        reply.code(404);
        return { error: error.message };
      }
      if (error instanceof PreviewShareConflictError) {
        reply.code(409);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.post('/projects/:projectId/public-static-shares', async (request, reply) => {
    if (!deps.manager) {
      reply.code(503);
      return { error: 'public previews are not configured' };
    }
    try {
      const { projectId } = projectParams.parse(request.params);
      const body = staticCreateBody.parse(request.body);
      const share = await deps.manager.create({ projectId, ...body });
      reply.code(201);
      return { share };
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof PreviewShareInputError) {
        reply.code(400);
        return { error: error.message };
      }
      if (error instanceof PreviewShareNotFoundError) {
        reply.code(404);
        return { error: error.message };
      }
      if (error instanceof PreviewShareConflictError) {
        reply.code(409);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.get('/projects/:projectId/public-shares', async (request, reply) => {
    if (!deps.manager) {
      reply.code(503);
      return { error: 'public previews are not configured' };
    }
    const { projectId } = projectParams.parse(request.params);
    if (!(await deps.eventStore.getProject(projectId))) {
      reply.code(404);
      return { error: 'project not found' };
    }
    return { shares: await deps.manager.list(projectId) };
  });

  app.delete('/public-shares/:shareId', async (request, reply) => {
    if (!deps.manager) {
      reply.code(503);
      return { error: 'public previews are not configured' };
    }
    const { shareId } = shareParams.parse(request.params);
    if (!(await deps.manager.stop(shareId))) {
      reply.code(404);
      return { error: 'public preview share not found' };
    }
    reply.code(204);
  });
}
