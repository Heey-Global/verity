import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { sessionParams } from './session-route-schemas.js';

const sessionSeenBody = z.object({ eventCount: z.number().int().nonnegative() });

export interface SessionSeenRouteDeps {
  store: Pick<EventStore, 'setSessionSeen' | 'getSession'>;
}

/** Registers the monotonic per-session read marker used by overview unread state. */
export function registerSessionSeenRoute(app: FastifyInstance, deps: SessionSeenRouteDeps): void {
  app.patch('/sessions/:id/seen', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { eventCount } = sessionSeenBody.parse(request.body);
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
