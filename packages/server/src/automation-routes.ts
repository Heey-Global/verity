// Session automation routes (ADR 0008). A session carries at most one
// automation, created from an agent's proposal once the operator confirms it in
// the app. The operator's confirmation is the gate: the agent never calls these.
import { automationProposalSchema } from '@verity/events';
import {
  SessionAutomationWorkspaceChangedError,
  type EventStore,
  type SessionRecord,
} from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AutomationRunInput, AutomationRunResult } from './automation-executor.js';

const sessionParams = z.object({ id: z.string().min(1) });
const statusBody = z.object({ status: z.enum(['enabled', 'paused']) });

export function registerAutomationRoutes(
  app: FastifyInstance,
  deps: {
    eventStore: EventStore;
    /** Prove a check script works before it is saved. */
    checkScript: (automation: AutomationRunInput) => Promise<AutomationRunResult>;
    /** Returns an operator-facing reason when `model` cannot run in `session`. */
    validateModel: (model: string, session: SessionRecord) => Promise<string | null>;
    onAutomationsChanged?: () => void;
  },
): void {
  const changed = (): void => deps.onAutomationsChanged?.();

  app.get('/sessions/:id/automation', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    if (!(await deps.eventStore.getSession(id))) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    return { automation: (await deps.eventStore.getSessionAutomation(id)) ?? null };
  });

  app.put('/sessions/:id/automation', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const body = automationProposalSchema.parse(request.body);
    const session = await deps.eventStore.getSession(id);
    if (!session) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    const model = body.model ?? null;
    if (model !== null) {
      const problem = await deps.validateModel(model, session);
      if (problem !== null) {
        reply.code(400);
        return { error: problem };
      }
    }
    const script = body.script ?? null;
    if (script !== null) {
      const check = await deps.checkScript({
        id: `check:${id}`,
        sessionId: id,
        name: body.name,
        prompt: body.prompt,
        script,
        model,
      });
      if (check.outcome === 'error' || check.outcome === 'skipped') {
        reply.code(422);
        return {
          error: check.detail ?? 'The check could not run.',
          code: 'automationCheckFailed',
        };
      }
    }
    let automation;
    try {
      automation = await deps.eventStore.setSessionAutomation(
        {
          sessionId: id,
          name: body.name,
          schedule: body.schedule,
          prompt: body.prompt,
          script,
          model,
        },
        new Date(),
        session,
      );
    } catch (error) {
      if (!(error instanceof SessionAutomationWorkspaceChangedError)) throw error;
      reply.code(409);
      return { error: error.message, code: 'automationWorkspaceChanged' };
    }
    changed();
    return { automation };
  });

  app.patch('/sessions/:id/automation', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const { status } = statusBody.parse(request.body);
    const automation = await deps.eventStore.setSessionAutomationStatus(id, status);
    if (!automation) {
      reply.code(404);
      return { error: 'automation not found' };
    }
    changed();
    return { automation };
  });

  app.delete('/sessions/:id/automation', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    if (!(await deps.eventStore.deleteSessionAutomation(id))) {
      reply.code(404);
      return { error: 'automation not found' };
    }
    changed();
    return { ok: true };
  });
}
