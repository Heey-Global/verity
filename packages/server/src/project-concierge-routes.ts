import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const projectParams = z.object({ id: z.string().min(1) });
const recreateContainerBody = z
  .object({
    confirmWarnings: z.boolean().optional(),
    forceRebuild: z.boolean().optional(),
  })
  .optional();

export function parseRecreateContainerBody(body: unknown): z.infer<typeof recreateContainerBody> {
  return recreateContainerBody.parse(body);
}

export interface ProjectConciergeRouteDeps {
  canRefreshToken: () => boolean;
  refreshToken: (
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
  ) => Promise<unknown>;
  canRecreateContainer: () => boolean;
  recreateContainer: (
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
  ) => Promise<unknown>;
}

/** Registers administrative project-token and container maintenance routes. */
export function registerProjectConciergeRoutes(
  app: FastifyInstance,
  deps: ProjectConciergeRouteDeps,
): void {
  app.post('/concierge/projects/:id/refresh-token', async (request, reply): Promise<unknown> => {
    if (!deps.canRefreshToken()) {
      reply.code(503);
      return { error: 'project token refresh is not configured' };
    }
    const { id } = projectParams.parse(request.params);
    return deps.refreshToken(request, reply, id);
  });

  app.post(
    '/concierge/projects/:id/recreate-container',
    async (request, reply): Promise<unknown> => {
      if (!deps.canRecreateContainer()) {
        reply.code(503);
        return { error: 'project container recreate is not configured' };
      }
      const { id } = projectParams.parse(request.params);
      return deps.recreateContainer(request, reply, id);
    },
  );
}
