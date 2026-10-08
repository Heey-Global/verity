// Planning mode. A session in planning mode runs every turn without permission to
// change files (the conductor maps it onto each agent's own read-only posture).
// The agent starts planning and presents plans through gateway tools; leaving it
// is the user's decision — a tap in the app or an instruction in the chat.
import {
  IMPLEMENT_PLAN_DISPLAY,
  IMPLEMENT_PLAN_PROMPT,
  PRESENT_PLAN_TOOL,
  planningToolName,
} from '@verity/events';
import type { DispatchTurnOptions, TurnOptions } from '@verity/session';
import type { EventStore, SessionPlanning } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/** Only a direct, complete instruction can substitute for the implementation card.
 * Quoted instructions, explanations and agent-supplied arguments are not consent. */
export function isPlanImplementationInstruction(text: string): boolean {
  return /^(?:(?:passt|okay|ok|ja|yes)[,.!]?\s+)?(?:leg los|los geht[’']?s|so umsetzen|plan umsetzen|setz(?:e)? (?:den )?plan um|implement(?: the)? plan|go ahead|start implementing)[.!]?$/iu.test(
    text.trim(),
  );
}

export async function hasTrustedPlanInstruction(
  store: Pick<
    EventStore,
    'listRunningTurns' | 'getEventsAfter' | 'getEventsBeforeSeq' | 'getSession'
  >,
  sessionId: string,
  turnId: string,
): Promise<boolean> {
  const running = (await store.listRunningTurns()).find((turn) => turn.sessionId === sessionId);
  if (running?.turnId !== turnId) return false;
  const events = await store.getEventsAfter(sessionId, running.promptSeq - 1);
  const prompts = events.filter(({ event }) => event.t === 'prompt');
  const latest = prompts.at(-1);
  if (latest?.event.t !== 'prompt' || latest.event.peer || !latest.event.initiatedBy) return false;
  // A successor prompt belongs to a different turn even before its marker is rebound.
  if (latest.seq !== running.promptSeq && !latest.event.steered) return false;
  if (!isPlanImplementationInstruction(latest.event.text)) return false;
  const session = await store.getSession(sessionId);
  if (session?.planning !== 'active' || session.planningRevision === undefined) return false;
  const { events: preceding } = await store.getEventsBeforeSeq(sessionId, 200, latest.seq);
  const calls = new Set(
    preceding.flatMap(({ event }) =>
      event.t === 'tool_call' && planningToolName(event.name) === PRESENT_PLAN_TOOL
        ? [event.id]
        : [],
    ),
  );
  // Consent covers the revision the user could see when sending their message.
  // Missing or old backend results require the normal confirmation instead.
  return preceding.some(
    ({ event }) =>
      event.t === 'tool_result' &&
      !event.isError &&
      calls.has(event.id) &&
      presentedRevision(event.output) === session?.planningRevision,
  );
}

function presentedRevision(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.planningRevision === 'number') return object.planningRevision;
  if (object.structuredContent !== undefined) return presentedRevision(object.structuredContent);
  const content = object.content ?? (Array.isArray(value) ? value : undefined);
  if (Array.isArray(content))
    for (const item of content) {
      if (typeof item !== 'object' || item === null) continue;
      const text = (item as Record<string, unknown>).text;
      if (typeof text !== 'string') continue;
      try {
        const revision = presentedRevision(JSON.parse(text));
        if (revision !== undefined) return revision;
      } catch {
        /* Not a structured gateway response. */
      }
    }
  return undefined;
}

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
  discard(sessionId: string, planningRevision?: number): Promise<boolean>;
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
    async discard(sessionId, planningRevision) {
      return store.setSessionPlanning(sessionId, 'discarded', ['active'], planningRevision);
    },
    async isPlanning(sessionId) {
      return (await store.getSession(sessionId))?.planning === 'active';
    },
  };
}

const sessionParams = z.object({ id: z.string().min(1) });
const planningBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('implement'), planningRevision: z.number().int().nonnegative() }),
  z.object({
    action: z.literal('discard'),
    planningRevision: z.number().int().nonnegative().optional(),
  }),
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
        : await deps.planning.discard(id, body.planningRevision);
    if (!ended) {
      reply.code(409);
      const session = await deps.eventStore.getSession(id);
      if (body.planningRevision !== undefined && session?.planning === 'active') {
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
