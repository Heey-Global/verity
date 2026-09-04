import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';

import { sessionParams } from './session-route-schemas.js';
import { repairSessionWorktreePermissions } from './session-worktree-recovery.js';

export interface SessionRecoveryRouteDeps {
  store: Pick<EventStore, 'getSession'>;
  projectCloneRoot?: string;
  isBusy: (sessionId: string) => boolean;
  hasMeetingJob: (sessionId: string) => boolean;
  repair?: typeof repairSessionWorktreePermissions;
  uid?: () => number | undefined;
}

/** Registers safe ownership recovery for project-session worktrees. */
export function registerSessionRecoveryRoute(
  app: FastifyInstance,
  deps: SessionRecoveryRouteDeps,
): void {
  app.post('/sessions/:id/recover-worktree', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const session = await deps.store.getSession(id);
    if (session === undefined) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    if (session.projectId === null) {
      reply.code(409);
      return { error: 'worktree recovery is available only for project sessions' };
    }
    if (deps.projectCloneRoot === undefined) {
      reply.code(409);
      return { error: 'worktree recovery is not configured for project sessions' };
    }
    if (deps.isBusy(id) || deps.hasMeetingJob(id)) {
      reply.code(409);
      return { error: `session ${id} is busy — retry worktree recovery when its turn ends` };
    }
    try {
      const repair = deps.repair ?? repairSessionWorktreePermissions;
      const result = await repair(
        session.worktree,
        deps.uid?.() ?? process.getuid?.(),
        deps.projectCloneRoot,
      );
      request.log.info(
        { sessionId: id, projectId: session.projectId, repaired: result.repaired },
        'verity: session worktree permission recovery completed',
      );
      return { sessionId: id, repaired: result.repaired };
    } catch (error) {
      request.log.warn(
        { err: error, sessionId: id, projectId: session.projectId },
        'verity: session worktree permission recovery refused',
      );
      reply.code(409);
      return {
        error:
          'session worktree permissions could not be repaired safely — ownership or path shape requires project reprovisioning',
      };
    }
  });
}
