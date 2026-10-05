import { basename, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Conductor } from '@verity/session';
import type { EventStore, ProjectRecord } from '@verity/store';
import { migrateLegacySessionClone } from './session-clone-migration.js';
import { sessionParams } from './session-route-schemas.js';
import { assertIndependentSessionClone } from './session-clone.js';

export function registerSessionIsolationMigrationRoute(
  app: FastifyInstance,
  deps: {
    eventStore: Pick<EventStore, 'getSession' | 'getProject'>;
    conductor: Pick<Conductor, 'tryRunExclusive'>;
    backupRoot: string;
    projectRepoPath: (project: ProjectRecord) => string;
    privateCloneRoot: (project: ProjectRecord) => string;
    /** Stop session-owned development processes; never stop a shared project container. */
    stopSessionProcesses: (sessionId: string) => Promise<void>;
    relocateSessionWorkspace: (
      sessionId: string,
      expectedWorktree: string,
      nextWorktree: string,
    ) => Promise<boolean>;
  },
): void {
  app.post('/sessions/:id/isolation/migrate', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const session = await deps.eventStore.getSession(id);
    if (!session) {
      reply.code(404);
      return { error: 'Session not found' };
    }
    if (!session.projectId) {
      reply.code(409);
      return { error: 'Session has no managed project' };
    }
    const project = await deps.eventStore.getProject(session.projectId);
    if (!project) {
      reply.code(409);
      return { error: 'Project checkout is unavailable' };
    }
    const destination = join(deps.privateCloneRoot(project), basename(session.worktree));
    if (destination === session.worktree) {
      await assertIndependentSessionClone(destination);
      return { migrated: true, worktree: destination };
    }
    const result = await deps.conductor.tryRunExclusive(id, async () => {
      await deps.stopSessionProcesses(id);
      const migration = await migrateLegacySessionClone({
        checkoutPath: session.worktree,
        projectRepoPath: deps.projectRepoPath(project),
        destinationPath: destination,
        backupRoot: join(deps.backupRoot, id),
        stopped: true,
      });
      const relocated = await deps.relocateSessionWorkspace(id, session.worktree, destination);
      if (!relocated)
        throw new Error(
          'Session workspace changed during migration; the original and backup were retained',
        );
      return { migrated: true, worktree: destination, backupPath: migration.backupPath };
    });
    if (!result.ran) {
      reply.code(409);
      return { error: 'Finish the current turn before migrating this session' };
    }
    return result.value;
  });
}
