// Planning mode. A session in planning mode runs every turn without permission to
// change files (the conductor maps it onto each agent's own read-only posture).
// The agent starts planning and presents plans through gateway tools; leaving it
// is the operator's decision — a tap in the app, or the approval card the agent
// raises when the operator asks for the implementation in the chat.
import { IMPLEMENT_PLAN_DISPLAY, IMPLEMENT_PLAN_PROMPT } from '@verity/events';
import type { DispatchTurnOptions, TurnOptions } from '@verity/session';
import type { EventStore, SessionPlanning } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export interface PlanningDeps {
  eventStore: Pick<
    EventStore,
    'getSession' | 'setSessionPlanning' | 'startSessionPlanning' | 'presentSessionPlan'
  >;
  dispatchTurn: (
    sessionId: string,
    prompt: string,
    opts: TurnOptions,
    dispatchOpts: DispatchTurnOptions,
  ) => Promise<{ queued: boolean; accepted?: boolean }>;
}

export interface SessionPlanningActions {
  /** Enter planning mode. Answers whether the session exists. */
  start(sessionId: string): Promise<boolean>;
  /** Leave planning mode and start the implementation as a turn of its own.
   *  Answers false when the session was not planning (already decided). */
  implement(sessionId: string, planningRevision: number): Promise<boolean>;
  present(sessionId: string, plan: string): Promise<number | undefined>;
  /** Leave planning mode without implementing. False when it was not planning. */
  discard(sessionId: string): Promise<boolean>;
  isPlanning(sessionId: string): Promise<boolean>;
}

export function createSessionPlanning(deps: PlanningDeps): SessionPlanningActions {
  const store = deps.eventStore;
  return {
    async start(sessionId) {
      return store.startSessionPlanning(sessionId);
    },
    async present(sessionId, plan) {
      return store.presentSessionPlan(sessionId, plan);
    },
    async implement(sessionId, planningRevision) {
      const session = await store.getSession(sessionId);
      if (session?.planningRevision !== planningRevision || session.planningPlan == null)
        return false;
      // Acceptance and the implementation backlog entry share one transaction;
      // recovery can resume it even if the server exits before updating its queue.
      const result = await deps.dispatchTurn(
        sessionId,
        `${IMPLEMENT_PLAN_PROMPT}\n\nApproved plan (revision ${planningRevision}):\n${session.planningPlan}`,
        {},
        { displayPrompt: IMPLEMENT_PLAN_DISPLAY, queueBehindActiveTurn: true, planningRevision },
      );
      if (result.accepted === false) return false;
      return true;
    },
    async discard(sessionId) {
      return store.setSessionPlanning(sessionId, 'discarded', ['active']);
    },
    async isPlanning(sessionId) {
      return (await store.getSession(sessionId))?.planning === 'active';
    },
  };
}

const sessionParams = z.object({ id: z.string().min(1) });
const planningBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('implement'), planningRevision: z.number().int().nonnegative() }),
  z.object({ action: z.literal('discard') }),
]);

/** `POST /sessions/:id/planning` — the operator ends planning mode from the app. */
export function registerPlanningRoutes(
  app: FastifyInstance,
  deps: { eventStore: PlanningDeps['eventStore']; planning: SessionPlanningActions },
): void {
  app.post('/sessions/:id/planning', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const body = planningBody.parse(request.body);
    const { action } = body;
    if ((await deps.eventStore.getSession(id)) === undefined) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    const ended =
      body.action === 'implement'
        ? await deps.planning.implement(id, body.planningRevision)
        : await deps.planning.discard(id);
    if (!ended) {
      reply.code(409);
      const session = await deps.eventStore.getSession(id);
      if (body.action === 'implement' && session?.planning === 'active') {
        return {
          error: 'The plan was updated. Please review the current plan.',
          code: 'stalePlan',
          planningRevision: session.planningRevision,
        };
      }
      return { error: 'this session is not in planning mode', code: 'notPlanning' };
    }
    const planning: SessionPlanning = action === 'implement' ? 'implemented' : 'discarded';
    return { planning };
  });
}
