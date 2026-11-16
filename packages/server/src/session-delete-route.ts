import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { deletionDeadline, SessionDeletionDeadlineError } from './session-deletion.js';
import { sessionParams } from './session-route-schemas.js';

const deleteSessionQuery = z.object({
  force: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  // Deleted as done: keep the conversation for the project's Wiki maintenance.
  // Absent means no, so a client that never offered the choice keeps nothing.
  wiki: z
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
    options?: { keepForWiki: boolean },
  ) => Promise<unknown>;
}

/** Registers deletion of a session and its owned runtime resources. */
export function registerSessionDeleteRoute(
  app: FastifyInstance,
  deps: SessionDeleteRouteDeps,
): void {
  app.delete('/sessions/:id', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { force, wiki } = deleteSessionQuery.parse(request.query);
    const startedAt = Date.now();
    request.log.info(
      { sessionId: id, phase: 'request', outcome: 'started' },
      'verity: session delete phase',
    );
    let outcome = 'completed';
    try {
      return await deletionDeadline(
        deps.remove(request, reply, id, force, { keepForWiki: wiki }),
        15_000,
      );
    } catch (error) {
      outcome = error instanceof SessionDeletionDeadlineError ? 'deadline' : 'failed';
      if (!(error instanceof SessionDeletionDeadlineError)) throw error;
      reply.code(503).header('retry-after', '5');
      return { error: error.message };
    } finally {
      request.log.info(
        {
          sessionId: id,
          phase: 'request',
          outcome,
          statusCode: reply.statusCode,
          elapsedMs: Date.now() - startedAt,
        },
        'verity: session delete phase',
      );
    }
  });
}
