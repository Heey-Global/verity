import type { FastifyInstance } from 'fastify';

/** Retired endpoint: capabilities can only authorize broker-mediated requests. */
export function registerGitHubTokenRoute(app: FastifyInstance): void {
  app.post('/internal/github/token', async (_request, reply) => {
    return reply.code(410).send({ error: 'Token issuance removed; use the forge proxy' });
  });
}
