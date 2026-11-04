import type { FastifyInstance } from 'fastify';
import { ContextConflictError, type UserContextStore } from '@verity/store';
import { z } from 'zod';
import './fastify-augmentation.js';

const replacement = z
  .object({
    revision: z.number().int().nonnegative(),
    instructions: z.string().max(12_000),
    memory: z.string().max(8_000),
  })
  .strict();

/** No user id is accepted from the request; pairing resolves the private owner. */
export function registerUserContextRoutes(app: FastifyInstance, store: UserContextStore): void {
  app.get('/me/context', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!request.localUserId) return reply.code(401).send({ error: 'User identity required' });
    return store.read(request.localUserId);
  });
  app.put('/me/context', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!request.localUserId) return reply.code(401).send({ error: 'User identity required' });
    const input = replacement.safeParse(request.body);
    if (!input.success)
      return reply
        .code(400)
        .send({ error: 'Invalid personal context or character limit exceeded' });
    try {
      return await store.replace(request.localUserId, input.data.revision, input.data);
    } catch (error) {
      if (error instanceof ContextConflictError)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
}
