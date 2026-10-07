import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { worktreeExists } from '@verity/session';
import type { EventStore, ProjectRecord } from '@verity/store';
import type { WorktreeProvisioner } from './worktree.js';

export const VERITY_CONTROL_SESSION_NAME = 'Verity Control';

export interface VerityControlSessionRouteDeps {
  eventStore: EventStore;
  defaultModel: string;
  worktrees: WorktreeProvisioner;
  makeBranch: (name: string) => string;
  deleteSessionEverywhere: (id: string) => Promise<boolean>;
  advancedModeEnabled: () => Promise<boolean>;
  ensureControlProject: () => Promise<ProjectRecord>;
}

export function registerVerityControlSessionRoute(
  app: FastifyInstance,
  deps: VerityControlSessionRouteDeps,
): void {
  const existingControlSession = async (): Promise<string | undefined> => {
    const sessions = await deps.eventStore.listSessions();
    const newestFirst = [...sessions].reverse();
    for (const session of newestFirst) {
      if (
        (session.name !== VERITY_CONTROL_SESSION_NAME && session.name !== 'Concierge') ||
        session.projectId !== null
      )
        continue;
      if (await worktreeExists(session.worktree)) {
        if (session.name !== VERITY_CONTROL_SESSION_NAME) {
          await deps.eventStore.renameSession(session.sessionId, VERITY_CONTROL_SESSION_NAME);
        }
        return session.sessionId;
      }
    }
    return undefined;
  };

  const createControlSession = async (): Promise<string> => {
    const worktree = await deps.worktrees.add(deps.makeBranch('verity-control'));
    const sessionId = randomUUID();
    try {
      await deps.eventStore.createSession({
        sessionId,
        worktree,
        model: deps.defaultModel,
      });
      await deps.eventStore.renameSession(sessionId, VERITY_CONTROL_SESSION_NAME);
      return sessionId;
    } catch (error) {
      await deps.deleteSessionEverywhere(sessionId).catch(() => false);
      await deps.worktrees.remove(worktree).catch(() => undefined);
      throw error;
    }
  };

  app.post(
    '/verity-control/session',
    async (_request, reply): Promise<{ sessionId: string } | { error: string }> => {
      if (await deps.advancedModeEnabled()) {
        const project = await deps.ensureControlProject();
        const worktree = await deps.worktrees.add(deps.makeBranch('verity-control'));
        const sessionId = randomUUID();
        try {
          await deps.eventStore.createSession({
            sessionId,
            worktree,
            model: deps.defaultModel,
            projectId: project.id,
          });
          reply.code(201);
          return { sessionId };
        } catch (error) {
          await deps.deleteSessionEverywhere(sessionId).catch(() => false);
          await deps.worktrees.remove(worktree).catch(() => undefined);
          throw error;
        }
      }
      const existing = await existingControlSession();
      if (existing !== undefined) return { sessionId: existing };
      const sessionId = await createControlSession();
      reply.code(201);
      return { sessionId };
    },
  );
}
