import {
  BackendTerminationUnconfirmedError,
  SessionBusyError,
  type Conductor,
} from '@verity/session';
import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { sessionParams } from './session-route-schemas.js';

const patchSessionBody = z.object({
  name: z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length >= 1 && value.length <= 80, 'name must be 1–80 characters')
    .nullable()
    .optional(),
  model: z.string().min(1).optional(),
});

export interface SessionMetadataRouteDeps {
  store: Pick<
    EventStore,
    | 'getSession'
    | 'renameSession'
    | 'getSessionBackendStates'
    | 'setSessionModel'
    | 'deleteSessionBackendStates'
  >;
  runBackendHandoff: Conductor['runBackendHandoff'];
  closeSession: Conductor['closeSession'];
  isModelAllowed: (model: string | undefined) => boolean;
  projectModelError: string;
}

/** Registers atomic session rename and backend/model handoff updates. */
export function registerSessionMetadataRoute(
  app: FastifyInstance,
  deps: SessionMetadataRouteDeps,
): void {
  app.patch('/sessions/:id', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { name, model } = patchSessionBody.parse(request.body);
    const current = model !== undefined ? await deps.store.getSession(id) : undefined;

    if (model !== undefined && !current) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }

    if (
      model !== undefined &&
      !deps.isModelAllowed(model) &&
      current !== undefined &&
      current.projectId !== null
    ) {
      reply.code(400);
      return { error: deps.projectModelError };
    }

    const modelUnchanged = model !== undefined && current?.model === model;

    // A rename is independent metadata and must land before a handoff that may
    // answer 409/503. Those responses explicitly tell the client it was applied.
    if (name !== undefined) {
      const renamed = await deps.store.renameSession(id, name);
      if (!renamed) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
    }

    if (model !== undefined && !modelUnchanged) {
      let switched: boolean;
      try {
        switched = await deps.runBackendHandoff(id, async () => {
          // Repeat the no-op check under the fence: another serialized patch may
          // have completed the same switch after the initial read.
          const live = await deps.store.getSession(id);
          if (live === undefined) return false;
          if (live.model === model) return true;
          const previousBackendStates = await deps.store.getSessionBackendStates(id);
          const updated = await deps.store.setSessionModel(id, model);
          if (!updated) return false;
          try {
            await deps.store.deleteSessionBackendStates(id);
          } catch (error) {
            // Keep model and resume handles all-or-nothing if cleanup fails.
            try {
              await deps.store.setSessionModel(id, live.model);
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                'failed to clear backend state and roll back the session model',
                { cause: rollbackError },
              );
            }
            throw error;
          }
          deps.closeSession?.(id);
          for (const state of previousBackendStates) deps.closeSession?.(state.backendSessionId);
          return true;
        });
      } catch (error) {
        if (error instanceof BackendTerminationUnconfirmedError) {
          reply.code(503).header('retry-after', '5');
          return {
            error:
              `session ${id} still has an unterminated backend — retry the model switch` +
              (name !== undefined ? ' (the rename in this request was applied)' : ''),
          };
        }
        if (error instanceof SessionBusyError) {
          reply.code(409).header('retry-after', '5');
          return {
            error:
              `session ${id} is busy with another operation — retry the model switch` +
              (name !== undefined ? ' (the rename in this request was applied)' : ''),
          };
        }
        throw error;
      }
      if (!switched) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
    }

    return {
      sessionId: id,
      ...(name !== undefined ? { name } : {}),
      ...(model !== undefined ? { model, deferred: false } : {}),
    };
  });
}
