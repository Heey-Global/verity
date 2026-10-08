import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const orderBody = z.object({
  projectId: z.string().min(1).nullable(),
  ids: z.array(z.string().min(1)).max(10000),
});

/** Overview metadata uses the same operator authorization as session rename. */
export function registerSessionOrderRoute(
  app: FastifyInstance,
  deps: { store: Pick<EventStore, 'reorderSessions'> },
): void {
  app.patch('/sessions/order', async (request, reply) => {
    const parsed = orderBody.safeParse(request.body);
    if (!parsed.success || new Set(parsed.data.ids).size !== parsed.data.ids.length) {
      return reply.code(400).send({ error: 'Invalid session order' });
    }
    try {
      return { ids: await deps.store.reorderSessions(parsed.data.projectId, parsed.data.ids) };
    } catch (error) {
      if (error instanceof Error && error.message === 'Project not found')
        return reply.code(404).send({ error: error.message });
      if (error instanceof Error && error.message === 'Session belongs to another project')
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
}
