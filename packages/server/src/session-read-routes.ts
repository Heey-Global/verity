import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const sessionParams = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/),
});

const modelsQuery = z.object({ projectId: z.string().min(1).optional() });

export interface SessionReadRouteDeps {
  /** Every usable model, narrowed to a project's allowed agents when one is named. */
  listModels: (projectId?: string) => Promise<unknown>;
  getSession: (sessionId: string) => Promise<unknown>;
}

/** Registers model discovery and the lightweight session-detail read. */
export function registerSessionReadRoutes(app: FastifyInstance, deps: SessionReadRouteDeps): void {
  app.get('/models', async (request): Promise<unknown> => {
    const { projectId } = modelsQuery.parse(request.query);
    return deps.listModels(projectId);
  });

  app.get('/sessions/:id', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const session = await deps.getSession(id);
    if (session === undefined) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    return session;
  });
}
