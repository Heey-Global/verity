import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { viewerId } from './view-state-routes.js';

const sessionParams = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/),
});

const modelsQuery = z.object({ projectId: z.string().min(1).optional() });

export interface SessionReadRouteDeps {
  /** Every usable model, narrowed to a project's allowed agents when one is named. */
  /** Narrowed to the accounts that serve `viewer`'s own turns. */
  listModels: (projectId: string | undefined, viewer: string) => Promise<unknown>;
  /** The session as `viewer` sees it: read mark and dismissed Home items are theirs. */
  getSession: (sessionId: string, viewer: string) => Promise<unknown>;
  getGoogleStatus?: (sessionId: string, viewer: string | undefined) => Promise<unknown>;
}

/** Registers model discovery and the lightweight session-detail read. */
export function registerSessionReadRoutes(app: FastifyInstance, deps: SessionReadRouteDeps): void {
  app.get('/models', async (request): Promise<unknown> => {
    const { projectId } = modelsQuery.parse(request.query);
    return deps.listModels(projectId, viewerId(request));
  });

  if (deps.getGoogleStatus)
    app.get('/sessions/:id/google-status', async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      const status = await deps.getGoogleStatus!(id, viewerId(request));
      if (status === undefined)
        return reply.code(404).send({ error: 'Session status unavailable' });
      return status;
    });

  app.get('/sessions/:id', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const session = await deps.getSession(id, viewerId(request));
    if (session === undefined) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    return session;
  });
}
