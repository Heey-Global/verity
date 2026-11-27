import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { conditionalJsonRoute } from './conditional-json.js';

export interface SessionBranchReadRouteDeps {
  list: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** Registers the branch, pull-request, and local-merge summary for a session.
 * The open session reads it again on every `branches.changed` (ADR 0033); an
 * unchanged list answers `304`. */
export function registerSessionBranchReadRoute(
  app: FastifyInstance,
  deps: SessionBranchReadRouteDeps,
): void {
  app.get('/sessions/:id/branches', conditionalJsonRoute, (request, reply) =>
    deps.list(request, reply),
  );
}
