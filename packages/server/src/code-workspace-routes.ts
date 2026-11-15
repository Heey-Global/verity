import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import {
  CodeWorkspaceUnavailableError,
  createCodeWorkspaceRecovery,
  type CodeWorkspaceRecovery,
} from './code-workspace-recovery.js';
import type { ServerContext } from './server-context.js';
import { projectSettingsStore } from './server-support.js';
import { sessionParams } from './session-route-schemas.js';
import { createGitWorktreeProvisioner } from './worktree.js';

/** The response for a code workspace that cannot be provided; never a Documents fallback. */
export function codeWorkspaceUnavailable(error: CodeWorkspaceUnavailableError) {
  return { error: error.message, code: error.code, reason: error.reason };
}

/**
 * Wires legacy Documents session conversion: before each operator turn, and on demand
 * through `POST /sessions/:id/code-workspace/restore` from the session's Files panel.
 */
export function installCodeWorkspaces(
  app: FastifyInstance,
  ctx: ServerContext,
  { invalidateBranchCache }: { invalidateBranchCache: (worktree: string) => void },
): CodeWorkspaceRecovery {
  const { deps, conductor, liveHub } = ctx;
  const recovery = createCodeWorkspaceRecovery({
    store: deps.eventStore,
    cloneRoot: deps.projectCloneRoot,
    dataRoot: deps.dataRoot,
    defaultBranch: async (projectId) =>
      (await projectSettingsStore(deps.eventStore).getProjectSettings(projectId))?.defaultBranch ??
      'main',
    worktrees: (project, clonePath, opts) =>
      deps.projectWorktrees?.(project, clonePath, opts) ??
      createGitWorktreeProvisioner({
        repoDir: clonePath,
        worktreeRoot: join(clonePath, '.verity-sessions'),
        ...opts,
      }),
    ensureWorkspace: (session) =>
      deps.sessionStorage?.ensureWorkspace(session) ?? Promise.resolve(),
    prepareLocalDocuments: deps.provisioner?.prepareLocalDocuments?.bind(deps.provisioner),
    claimIdle: (sessionId, fn) => conductor.tryMoveSession(sessionId, fn),
    closeBackends: async (sessionId) => {
      conductor.closeSession?.(sessionId);
      for (const binding of await deps.eventStore.getSessionBackendStates(sessionId))
        conductor.closeSession?.(binding.backendSessionId);
    },
    afterCommit: async (sessionId, retainedWorktree) => {
      invalidateBranchCache(retainedWorktree);
      await liveHub.recheckSession(sessionId);
    },
  });

  if (deps.codeWorkspaceTurns)
    deps.codeWorkspaceTurns.prepare = (sessionId) =>
      recovery.beforeTurn(sessionId, { starting: true });

  app.post('/sessions/:id/code-workspace/restore', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    if (!(await deps.eventStore.getSession(id))) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    try {
      const result = await recovery.restore(id);
      request.log.info(
        { sessionId: id, source: result.source ?? 'current' },
        'verity: session code workspace restored',
      );
      return result;
    } catch (error) {
      request.log.warn({ err: error, sessionId: id }, 'verity: session code workspace unavailable');
      reply.code(409);
      return codeWorkspaceUnavailable(
        error instanceof CodeWorkspaceUnavailableError
          ? error
          : new CodeWorkspaceUnavailableError((error as Error).message, 'unrecoverable', {
              cause: error,
            }),
      );
    }
  });
  return recovery;
}
