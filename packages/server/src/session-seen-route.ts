import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { sessionParams } from './session-route-schemas.js';

const sessionSeenBody = z.object({
  eventCount: z.number().int().nonnegative(),
  counterVersion: z.string().optional(),
});

export interface SessionSeenRouteDeps {
  store: Pick<EventStore, 'setSessionSeen' | 'getSession' | 'getSessionEventStats'>;
}

/** Registers the monotonic per-session read marker used by overview unread state. */
export function registerSessionSeenRoute(app: FastifyInstance, deps: SessionSeenRouteDeps): void {
  app.patch('/sessions/:id/seen', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { eventCount, counterVersion } = sessionSeenBody.parse(request.body);
    const current = await deps.store.getSessionEventStats(id);
    // Pre-upgrade clients can hold all-event counts that would hide future messages.
    if (counterVersion !== 'dev-servers-excluded-v1' || eventCount > (current?.eventCount ?? 0)) {
      if (!(await deps.store.getSession(id))) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      reply.code(409);
      return {
        error:
          'session event counter incompatible; update the client and refresh before marking seen',
      };
    }
    const marked = await deps.store.setSessionSeen(id, eventCount);
    if (!marked) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    // Echo the resolved monotonic mark without loading the event log.
    const session = await deps.store.getSession(id);
    return { sessionId: id, lastSeenEventCount: session?.lastSeenEventCount ?? eventCount };
  });
}
