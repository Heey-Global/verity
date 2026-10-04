import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LocalPreviewManager } from './local-preview-manager.js';
import {
  PreviewShareConflictError,
  PreviewShareInputError,
  PreviewShareNotFoundError,
} from './preview-share-manager.js';
const params = z.object({ sessionId: z.string().min(1) });
const body = z
  .object({
    targetPort: z.number().int().min(1).max(65535).optional(),
    staticPath: z.string().trim().min(1).max(1024).optional(),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(30 * 86400)
      .optional(),
  })
  .strict()
  .refine(
    (value) => (value.targetPort !== undefined) !== (value.staticPath !== undefined),
    'choose a port or static folder',
  );
export function registerLocalPreviewRoutes(
  app: FastifyInstance,
  deps: {
    eventStore: EventStore;
    manager?: LocalPreviewManager;
    publicSharing?: () =>
      | Promise<'available' | 'premium-required' | 'unavailable'>
      | 'available'
      | 'premium-required'
      | 'unavailable';
  },
): void {
  app.get('/preview-capabilities', async () => ({
    publicSharing: (await deps.publicSharing?.()) ?? 'premium-required',
  }));
  app.get('/sessions/:sessionId/local-shares', async (request, reply) => {
    const { sessionId } = params.parse(request.params);
    if (!(await deps.eventStore.getSession(sessionId)))
      return reply.code(404).send({ error: 'session not found' });
    return { shares: deps.manager?.list(sessionId) ?? [] };
  });
  app.post('/sessions/:sessionId/local-shares', async (request, reply) => {
    if (!deps.manager)
      return reply.code(503).send({ error: 'local preview runtime is unavailable' });
    try {
      const { sessionId } = params.parse(request.params);
      const share = await deps.manager.create(sessionId, body.parse(request.body));
      return reply.code(201).send({ share });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof PreviewShareInputError)
        return reply.code(400).send({ error: error.message });
      if (error instanceof PreviewShareNotFoundError)
        return reply.code(404).send({ error: error.message });
      if (error instanceof PreviewShareConflictError)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
  app.delete('/local-shares/:shareId', async (request, reply) => {
    const { shareId } = z.object({ shareId: z.string().min(1) }).parse(request.params);
    if (!deps.manager || !(await deps.manager.stop(shareId)))
      return reply.code(404).send({ error: 'local preview not found' });
    return reply.code(204).send();
  });
}
