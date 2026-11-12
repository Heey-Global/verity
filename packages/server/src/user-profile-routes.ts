import type { FastifyInstance } from 'fastify';
import type { UserProfileStore } from '@verity/store';
import { z } from 'zod';
import './fastify-augmentation.js';

const update = z.object({ displayName: z.string().max(400) }).strict();

/** No user id is accepted from the request; pairing resolves the person. */
export function registerUserProfileRoutes(
  app: FastifyInstance,
  store: Pick<UserProfileStore, 'read' | 'setDisplayName'>,
): void {
  app.get('/me/profile', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!request.localUserId) return reply.code(401).send({ error: 'User identity required' });
    const profile = await store.read(request.localUserId);
    if (!profile) return reply.code(401).send({ error: 'User identity required' });
    return profile;
  });
  app.put('/me/profile', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!request.localUserId) return reply.code(401).send({ error: 'User identity required' });
    const input = update.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Invalid profile' });
    try {
      return await store.setDisplayName(request.localUserId, input.data.displayName);
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });
}
