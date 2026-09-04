import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { sessionParams } from './session-route-schemas.js';

const deleteSessionQuery = z.object({
  force: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export interface SessionDeleteRouteDeps {
  remove: (
    request: FastifyRequest,
    reply: FastifyReply,
    sessionId: string,
    force: boolean,
  ) => Promise<unknown>;
}

/** Registers deletion of a session and its owned runtime resources. */
export function registerSessionDeleteRoute(
  app: FastifyInstance,
  deps: SessionDeleteRouteDeps,
): void {
  app.delete('/sessions/:id', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { force } = deleteSessionQuery.parse(request.query);
    return deps.remove(request, reply, id, force);
  });
}
