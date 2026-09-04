import { PermissionDecisionInProgressError, type Conductor } from '@verity/session';
import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { sessionParams } from './session-route-schemas.js';

const cancelBody = z.object({ force: z.boolean().optional() }).optional();
const permissionParams = sessionParams.extend({ toolUseId: z.string().min(1) });
const queuedItemParams = sessionParams.extend({ itemId: z.string().min(1) });
const permissionDecisionBody = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    scope: z.enum(['once', 'session', 'project', 'forever']).optional(),
  }),
  z.object({ behavior: z.literal('deny'), message: z.string().min(1).optional() }),
]);

export interface SessionControlRouteDeps {
  store: Pick<EventStore, 'getSession'>;
  conductor: Pick<
    Conductor,
    'stopSession' | 'releaseUnconfirmedTermination' | 'decidePermission' | 'dequeue'
  >;
  cancelMeetingJobs: (sessionId: string) => boolean;
  permissionResolved?: (sessionId: string, toolUseId: string) => void;
}

/** Registers stop, permission-decision, and queued-turn retraction controls. */
export function registerSessionControlRoutes(
  app: FastifyInstance,
  deps: SessionControlRouteDeps,
): void {
  app.post('/sessions/:id/cancel', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const body = cancelBody.parse(request.body ?? {});
    const session = await deps.store.getSession(id);
    if (!session) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    const meetingCancelled = deps.cancelMeetingJobs(id);
    const { droppedQueued, cancelled } = await deps.conductor.stopSession(id);
    // Force release follows the ordinary stop so queue draining and graceful
    // cancellation always get their chance first.
    const forceReleased =
      body?.force === true ? await deps.conductor.releaseUnconfirmedTermination(id) : false;
    return {
      sessionId: id,
      cancelled: cancelled || meetingCancelled,
      forceReleased,
      droppedQueued,
    };
  });

  app.post('/sessions/:id/permissions/:toolUseId', async (request, reply): Promise<unknown> => {
    const { id, toolUseId } = permissionParams.parse(request.params);
    const body = permissionDecisionBody.parse(request.body);
    const session = await deps.store.getSession(id);
    if (!session) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    const decision =
      body.behavior === 'allow'
        ? {
            behavior: 'allow' as const,
            ...(body.updatedInput !== undefined ? { updatedInput: body.updatedInput } : {}),
          }
        : { behavior: 'deny' as const, message: body.message ?? 'Denied by the operator.' };
    let scopeSaved: boolean | undefined;
    let decided: boolean;
    try {
      decided =
        body.behavior === 'allow' && body.scope !== undefined
          ? await deps.conductor.decidePermission(id, toolUseId, decision, {
              scope: body.scope,
              onScopeSaved: (saved) => {
                scopeSaved = saved;
              },
            })
          : await deps.conductor.decidePermission(id, toolUseId, decision);
    } catch (error) {
      if (error instanceof PermissionDecisionInProgressError) {
        reply.code(409);
        return { error: error.message };
      }
      throw error;
    }
    if (!decided) {
      reply.code(404);
      return { error: `no pending permission ${toolUseId} for session ${id}` };
    }
    deps.permissionResolved?.(id, toolUseId);
    return {
      sessionId: id,
      toolUseId,
      decided: true,
      ...(scopeSaved === undefined ? {} : { scopeSaved }),
    };
  });

  app.post('/sessions/:id/queue/:itemId/cancel', async (request, reply): Promise<unknown> => {
    const { id, itemId } = queuedItemParams.parse(request.params);
    const removed = await deps.conductor.dequeue(id, itemId);
    if (!removed) {
      reply.code(404);
      return { error: `queued turn ${itemId} not found for session ${id}` };
    }
    return { sessionId: id, itemId, ...removed };
  });
}
