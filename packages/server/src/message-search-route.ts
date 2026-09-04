import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const messageSearchCursor = z
  .string()
  .max(1024)
  .transform((value, context): unknown => {
    try {
      return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch {
      context.addIssue({ code: 'custom', message: 'invalid search cursor' });
      return z.NEVER;
    }
  })
  .pipe(
    z.object({
      rank: z.number().finite().nonnegative(),
      createdAt: z.number().int().nonnegative(),
      id: z.number().int().positive(),
    }),
  );

const messageSearchQuery = z.object({
  q: z.string().trim().min(1),
  sessionId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  cursor: messageSearchCursor.optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export interface MessageSearchRouteDeps {
  eventStore: Pick<EventStore, 'searchMessages'>;
}

/** Registers full-text search across visible session messages. */
export function registerMessageSearchRoute(
  app: FastifyInstance,
  deps: MessageSearchRouteDeps,
): void {
  app.get('/search/messages', async (request) => {
    const query = messageSearchQuery.parse(request.query);
    const cursor = query.cursor;
    const limit = query.limit ?? 30;
    const items = await deps.eventStore.searchMessages({
      query: query.q,
      ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
      ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      limit,
    });
    const last = items.at(-1);
    const nextCursor =
      items.length === limit && last
        ? Buffer.from(
            JSON.stringify({ rank: last.rank, createdAt: last.createdAt, id: last.id }),
          ).toString('base64url')
        : null;
    return {
      items: items.map(({ rank, ...item }) => {
        void rank;
        return item;
      }),
      nextCursor,
    };
  });
}
