import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { sessionParams } from './session-route-schemas.js';

const scrollDiagnosticBody = z.object({
  event: z.string().min(1).max(80),
  seq: z.number().int().nonnegative(),
  at: z.number().finite(),
  data: z
    .record(
      z.string().min(1).max(40),
      z.union([z.boolean(), z.number().finite(), z.string().max(80)]),
    )
    .superRefine((data, ctx) => {
      if (Object.keys(data).length > 32) {
        ctx.addIssue({ code: 'custom', message: 'too many diagnostic fields' });
      }
    }),
});

const historyQuery = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

type ScrollDiagnostic = z.infer<typeof scrollDiagnosticBody>;

export function parseScrollDiagnostic(input: unknown): ScrollDiagnostic {
  return scrollDiagnosticBody.parse(input);
}

export interface SessionHistoryRouteDeps {
  activity: (reply: FastifyReply, sessionId: string) => Promise<unknown>;
  recordScrollDiagnostic: (
    reply: FastifyReply,
    sessionId: string,
    body: unknown,
  ) => Promise<unknown>;
  history: (
    reply: FastifyReply,
    sessionId: string,
    limit: number | undefined,
    beforeSeq: number | undefined,
  ) => Promise<unknown>;
}

/** Registers live activity, bounded diagnostics, and backward-paginated history reads. */
export function registerSessionHistoryRoutes(
  app: FastifyInstance,
  deps: SessionHistoryRouteDeps,
): void {
  app.get('/sessions/:id/activity', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    return deps.activity(reply, id);
  });

  app.post(
    '/sessions/:id/debug/scroll',
    { bodyLimit: 4_096 },
    async (request, reply): Promise<unknown> => {
      const { id } = sessionParams.parse(request.params);
      return deps.recordScrollDiagnostic(reply, id, request.body);
    },
  );

  app.get('/sessions/:id/events', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { beforeSeq, limit } = historyQuery.parse(request.query);
    return deps.history(reply, id, limit, beforeSeq);
  });
}
