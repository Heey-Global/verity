import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface SessionBranchReadRouteDeps {
  list: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** Registers the branch, pull-request, and local-merge summary for a session. */
export function registerSessionBranchReadRoute(
  app: FastifyInstance,
  deps: SessionBranchReadRouteDeps,
): void {
  app.get('/sessions/:id/branches', (request, reply) => deps.list(request, reply));
}
