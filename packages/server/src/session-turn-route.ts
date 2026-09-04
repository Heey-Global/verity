import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface SessionTurnRouteDeps {
  dispatch: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** Registers submission of a new or steering turn to an existing session. */
export function registerSessionTurnRoute(app: FastifyInstance, deps: SessionTurnRouteDeps): void {
  app.post('/sessions/:id/turns', (request, reply) => deps.dispatch(request, reply));
}
