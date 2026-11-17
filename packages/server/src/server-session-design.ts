import type { FastifyInstance } from 'fastify';
import { createSessionMockups, registerMockupRoutes } from './mockups.js';
import { createSessionPlanning, registerPlanningRoutes, type PlanningDeps } from './planning.js';
import type { ServerContext } from './server-context.js';
import type { ServerDeps } from './server-deps.js';

type SessionDesignContext = Pick<ServerContext, 'conductor'> & {
  // Project runtime is initialized after the planning actions are created.
  sessionsBeingReaped: () => ServerContext['sessionsBeingReaped'];
};

export function createServerSessionDesign(deps: ServerDeps, wiring: SessionDesignContext) {
  const dispatchServerTurn: PlanningDeps['dispatchTurn'] = (
    sessionId,
    prompt,
    opts,
    dispatchOpts,
  ) => {
    // No await before dispatch: deletion must not reopen a quiesced worktree.
    if (wiring.sessionsBeingReaped().has(sessionId)) {
      throw Object.assign(new Error('session is being deleted with its project'), {
        statusCode: 409,
      });
    }
    return wiring.conductor.dispatchTurn(sessionId, prompt, opts, dispatchOpts);
  };
  const sessionPlanning = createSessionPlanning({
    eventStore: deps.eventStore,
    dispatchTurn: dispatchServerTurn,
  });
  const sessionMockups = createSessionMockups({ eventStore: deps.eventStore });
  return { sessionPlanning, sessionMockups };
}

export function installSessionDesign(
  app: FastifyInstance,
  ctx: ServerContext,
  wiring: ReturnType<typeof createServerSessionDesign>,
): void {
  registerPlanningRoutes(app, {
    eventStore: ctx.deps.eventStore,
    planning: wiring.sessionPlanning,
  });
  registerMockupRoutes(app, { mockups: wiring.sessionMockups });
}
