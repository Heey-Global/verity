import type { LocalPreviewManager } from './local-preview-manager.js';
import type { ListenerDiscovery } from './listener-discovery.js';
import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PreviewShareConflictError,
  PreviewShareInputError,
  type PreviewShareManager,
  PreviewShareNotFoundError,
  PreviewShareUpstreamError,
} from './preview-share-manager.js';

const createBody = z
  .object({
    pin: z.string().regex(/^\d{6}$/),
    ttlSeconds: z.number().int(),
  })
  .strict();
const projectParams = z.object({ projectId: z.string().min(1) });
const sessionParams = z.object({ sessionId: z.string().min(1) });
const shareParams = z.object({ shareId: z.string().min(1) });
const staticCreateBody = createBody.extend({
  staticPath: z.string().trim().min(1).max(1024),
});
const portCreateBody = createBody.extend({
  targetPort: z.number().int().min(1).max(65_535),
  managedInstanceId: z.string().min(1).optional(),
});

export function registerPreviewShareRoutes(
  app: FastifyInstance,
  deps: {
    eventStore: EventStore;
    manager?: PreviewShareManager;
    listenerDiscovery?: ListenerDiscovery;
    localManager?: LocalPreviewManager;
  },
): void {
  app.get('/sessions/:sessionId/public-static-directories', async (request, reply) => {
    const browser = deps.localManager ?? deps.manager;
    if (!browser) {
      reply.code(503);
      return { error: 'preview runtime is not configured' };
    }
    try {
      const { sessionId } = sessionParams.parse(request.params);
      const session = await deps.eventStore.getSession(sessionId);
      if (!session?.projectId) throw new PreviewShareNotFoundError('project session not found');
      const { path } = z.object({ path: z.string().optional().default('') }).parse(request.query);
      return await browser.listStaticEntries(session.projectId, path, sessionId);
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

  app.post('/sessions/:sessionId/public-static-shares', async (request, reply) => {
    if (!deps.manager) {
      reply.code(503);
      return { error: 'public previews are not configured' };
    }
    try {
      const { sessionId } = sessionParams.parse(request.params);
      const body = staticCreateBody.parse(request.body);
      const share = await deps.manager.create({ sessionId, ...body });
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
      if (error instanceof PreviewShareUpstreamError) {
        reply.code(502);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.get('/sessions/:sessionId/dev-servers', async (request, reply) => {
    if (!deps.listenerDiscovery && !deps.manager) {
      reply.code(503);
      return { error: 'listener discovery is not configured' };
    }
    try {
      const { sessionId } = sessionParams.parse(request.params);
      return {
        devServers: await (deps.listenerDiscovery ?? deps.manager!).listSessionDevServers(
          sessionId,
        ),
      };
    } catch (error) {
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

  app.post('/sessions/:sessionId/public-port-shares', async (request, reply) => {
    if (!deps.manager) {
      reply.code(503);
      return { error: 'public previews are not configured' };
    }
    try {
      const { sessionId } = sessionParams.parse(request.params);
      const body = portCreateBody.parse(request.body);
      const share = await deps.manager.create({ sessionId, ...body });
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
      if (error instanceof PreviewShareUpstreamError) {
        reply.code(502);
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
      if (error instanceof PreviewShareUpstreamError) {
        reply.code(502);
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
