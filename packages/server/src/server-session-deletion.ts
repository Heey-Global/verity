import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { createDocumentWorkspaceProvisioner, isDocumentWorkspace } from './document-workspace.js';
import { projectClonePath } from './provisioner.js';
import { registerSessionDeleteRoute } from './session-delete-route.js';
import {
  createSessionDeletionManager,
  deletionDeadline,
  SessionDeletionDeadlineError,
  type SessionDeletionPayload,
} from './session-deletion.js';
import { removeSessionRepositoryWorkspaces } from './session-repositories.js';
import { noteDeletedSession } from './wiki-occasions.js';
import { createGitWorktreeProvisioner, type WorktreeProvisioner } from './worktree.js';

import type { ServerContext } from './server-context.js';
import { isControlPlaneProject, SESSION_ARTIFACT_PURGE_TIMEOUT_MS } from './server-support.js';
import type { SessionArtifactPurgeBudget } from './server-types.js';

/**
 * The one way to delete a session, shared by every route that removes sessions:
 * single deletes, project teardown and Verity's own cleanup. `buildServer`
 * builds it once and shares it as `ServerContext.deleteSession`; a second
 * instance would not serialize against the first.
 */
export function createSessionDeletion({
  app,
  deps,
}: Pick<ServerContext, 'app' | 'deps'>): (
  sessionId: string,
  budget?: SessionArtifactPurgeBudget,
) => Promise<boolean> {
  /**
   * Delete a session everywhere it exists, not just in the store.
   *
   * Every `deleteSession` in the server's routes goes through here. The store delete removes
   * the row and cascades to the durable transcript, but the backend's own transcript
   * file on the runner runtime is nobody's child and used to survive — so a deleted
   * session's prompts and replies stayed readable on disk indefinitely. The purge
   * runs FIRST because it needs `session_backend_state` to know which files are the
   * session's, and the cascade is about to delete exactly that.
   *
   * Managed runners persist cleanup ownership through `queueSessionArtifacts` before
   * the cascade, then wake a background worker after deletion. That durable write must
   * succeed; supervisor calls and filesystem purges never run in the request.
   *
   * A purge failure never blocks the delete: leaving the row behind because a file
   * could not be unlinked would strand the session in the UI, which is strictly
   * worse than the leak it is trying to prevent. A purge that neither succeeds nor
   * fails is bounded for the same reason — see `SESSION_ARTIFACT_PURGE_TIMEOUT_MS`.
   *
   * `budget` shares one such bound across a run of deletes. Per call it would be a
   * per-call bound, and a project with fifty sessions on a wedged volume would spend
   * fifty times ten seconds inside one request — the stall the bound exists to prevent,
   * arrived at by arithmetic.
   */
  const deleteSessionEverywhereUnqueued = async (
    sessionId: string,
    budget?: SessionArtifactPurgeBudget,
  ): Promise<boolean> => {
    const session = await deps.eventStore.getSession(sessionId);
    const release = session?.projectId
      ? await deps.localPreviewManager?.beginSessionMove(session.projectId)
      : undefined;
    try {
      // Processes started for this session must not outlive its worktree.
      try {
        await deps.managedDevServerManager?.stopSession(sessionId);
      } catch (error) {
        // The delete goes on; the orphan sweep stops tagged processes left behind.
        app.log.warn({ err: error, sessionId }, 'verity: could not stop managed dev servers');
      }
      await deps.localPreviewManager?.stopSession(sessionId);
      await deps.queueSessionArtifacts?.(sessionId);
      // `.catch()` alone would only cover a REJECTED promise; an implementation that
      // throws before returning one would escape and fail the delete — the outcome the
      // paragraph above says must never happen. try/catch covers both.
      try {
        const purge = deps.purgeSessionArtifacts?.(sessionId);
        // `Promise.race` attaches its own handler to `purge` immediately, so a purge
        // that rejects after the timer won is already handled, not an unhandled
        // rejection. The timer is unref'd: losing the race must not hold the process.
        if (purge !== undefined) {
          const allowance = budget?.remainingMs ?? SESSION_ARTIFACT_PURGE_TIMEOUT_MS;
          const startedAt = Date.now();
          await Promise.race([purge, sleep(allowance, undefined, { ref: false })]);
          // Only time spent WAITING is charged, so a healthy volume — where each purge
          // returns in milliseconds — never runs the budget down and every session in the
          // loop gets its transcripts removed. It is a wedged volume the budget is for.
          if (budget !== undefined) {
            budget.remainingMs = Math.max(0, budget.remainingMs - (Date.now() - startedAt));
          }
        }
      } catch {
        // Logged by the implementation; never fatal here.
      }
      const deleted = await deps.eventStore.deleteSession(sessionId);
      if (deleted) deps.scheduleSessionCleanup?.();
      return deleted;
    } finally {
      release?.();
    }
  };
  // The preview fence is project-wide, even when deleting different sessions.
  // Optimistic clients can send the next delete before the first cleanup settles.
  const projectSessionDeletes = new Map<string, Promise<void>>();
  return async function deleteSessionEverywhere(
    sessionId: string,
    budget?: SessionArtifactPurgeBudget,
  ): Promise<boolean> {
    const session = await deps.eventStore.getSession(sessionId);
    const projectId = session?.projectId;
    if (!projectId || !deps.localPreviewManager)
      return deleteSessionEverywhereUnqueued(sessionId, budget);
    const previous = projectSessionDeletes.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    projectSessionDeletes.set(projectId, current);
    await previous;
    try {
      return await deleteSessionEverywhereUnqueued(sessionId, budget);
    } finally {
      release();
      if (projectSessionDeletes.get(projectId) === current) projectSessionDeletes.delete(projectId);
    }
  };
}

/** Closures `buildServer` still owns that session deletion depends on. */
export interface SessionDeletionWiring {
  worktrees: WorktreeProvisioner;
  hasMeetingJob: (sessionId: string) => boolean;
}

/**
 * `DELETE /sessions/:id` with the deletion manager behind it: fencing and
 * stopping the session's work, releasing its previews and dev servers, removing
 * its worktree, and resuming unfinished deletions on start and every 30 s.
 */
export function installSessionDeletion(
  app: FastifyInstance,
  ctx: ServerContext,
  { worktrees, hasMeetingJob }: SessionDeletionWiring,
): void {
  const { deps, lifecycle, conductor } = ctx;
  // Permanently delete a session: drop its durable log (events + transcript
  // lines + the session row, transactionally) and remove its isolated worktree
  // from disk. A session with a turn in flight AT REQUEST TIME is refused with
  // 409 (same idle guard as the branch-switch route) so the operator doesn't
  // delete a session out from under a running `--resume` process. NB: this does
  // not close the narrow TOCTOU where a `POST /turns` is accepted in the window
  // between this check and the row delete — that turn's background append would
  // then violate the events FK and surface via onTurnError. Acceptable for the
  // single-operator v1 (one human, the delete is modal-gated); a per-session
  // delete-vs-dispatch lock in the conductor would close it (follow-up). 404 for
  // an unknown id. Worktree removal is best-effort: a session whose worktree was
  // already cleaned up (resumable=false) still deletes cleanly, and the repo-root
  // checkout (`workspaceDir`, e.g. `/work`) is NEVER removed (safety guard #105).
  const deletionRequestIds = new Map<string, string>();
  const sessionDeletions = createSessionDeletionManager({
    store: deps.eventStore,
    fence: (id) => conductor.beginSessionDeletion?.(id),
    terminationConfirmed: (id) => conductor.isDeletionTerminationConfirmed?.(id) ?? false,
    stop: async (id) => {
      if (conductor.stopForDeletion) return conductor.stopForDeletion(id);
      // Compatibility with custom conductors: inability to prove termination parks
      // physical cleanup, but must not prevent a durable logical deletion.
      return false;
    },
    capture: async (session) => ({
      session: {
        sessionId: session.sessionId,
        worktree: session.worktree,
        projectId: session.projectId,
        model: session.model,
      },
      ...(!deps.queueSessionArtifacts && deps.purgeSessionArtifacts
        ? {
            legacyArtifactsRequired: true,
            artifactBindings: (
              await deps.eventStore.getSessionBackendStates(session.sessionId)
            ).map(({ backend, backendSessionId }) => ({ backend, backendSessionId })),
          }
        : {}),
      previewIds: (await deps.eventStore.listLocalPreviewShares())
        .filter((share) => share.sessionId === session.sessionId)
        .map((share) => share.id),
      ...(deps.managedDevServerManager
        ? { managed: await deps.managedDevServerManager.captureSessionCleanup(session.sessionId) }
        : {}),
      ...(await (async () => {
        const marker = (await deps.eventStore.listRunningTurns()).find(
          (turn) => turn.sessionId === session.sessionId,
        );
        return marker?.turnId && marker.startCommandId
          ? { runnerIdentity: { turnId: marker.turnId, startCommandId: marker.startCommandId } }
          : {};
      })()),
    }),
    prepare: async (id) => {
      await deps.queueSessionArtifacts?.(id);
    },
    ...(!deps.queueSessionArtifacts && deps.purgeSessionArtifacts
      ? {
          beforeDelete: async (id: string, payload: SessionDeletionPayload) => {
            await deps.purgeSessionArtifacts!(id, payload.artifactBindings ?? []);
          },
        }
      : {}),
    releasePublications: async (payload) => {
      for (const shareId of payload.previewIds) await deps.localPreviewManager?.stop(shareId);
      await deps.localPreviewManager?.stopSession(payload.session.sessionId);
      if (
        payload.managed &&
        deps.managedDevServerManager &&
        (await deps.managedDevServerManager.cleanupDeletedSession(payload.managed)) !== 'clean'
      )
        return false;
      return true;
    },
    confirmTermination: async (payload) => {
      const { session } = payload;
      if (
        conductor.isDeletionWorktreeBusy?.(session.sessionId) ||
        !deps.cleanupDeletedSessionRuntime
      )
        return false;
      const outcome = await deps.cleanupDeletedSessionRuntime(session.sessionId, session.projectId);
      if (conductor.isDeletionWorktreeBusy?.(session.sessionId)) return false;
      return outcome === 'absent' || (outcome === 'clean' && payload.runnerIdentity !== undefined);
    },
    cleanup: async (payload, terminationConfirmed) => {
      const { session } = payload;
      deps.scheduleSessionCleanup?.();
      if (conductor.isDeletionWorktreeBusy?.(session.sessionId)) return false;
      // Successful privileged home deletion kills/fences exact workers. A missing
      // DB marker after cascade is not evidence that a process has exited.
      if (deps.cleanupDeletedSessionRuntime) {
        const result = await deps.cleanupDeletedSessionRuntime(
          session.sessionId,
          session.projectId,
        );
        if (result === 'deferred') return false;
        if (result === 'not-applicable' && !terminationConfirmed) return false;
        if (result === 'clean' && !terminationConfirmed && !payload.runnerIdentity) return false;
      } else if (!terminationConfirmed) return false;
      if (conductor.isDeletionWorktreeBusy?.(session.sessionId)) return false;
      conductor.closeSession?.(session.sessionId);
      let cleanupWorktrees = worktrees;
      if (session.projectId !== null && deps.projectCloneRoot !== undefined) {
        const project = await deps.eventStore.getProject(session.projectId);
        if (project !== undefined && !isControlPlaneProject(project)) {
          const projectClone = projectClonePath(deps.projectCloneRoot, project);
          await removeSessionRepositoryWorkspaces(projectClone, session.sessionId);
          cleanupWorktrees =
            isDocumentWorkspace(session.worktree) && deps.dataRoot
              ? createDocumentWorkspaceProvisioner(deps.dataRoot, project.id, projectClone)
              : (deps.projectWorktrees?.(project, projectClone) ??
                createGitWorktreeProvisioner({
                  repoDir: projectClone,
                  worktreeRoot: join(projectClone, '.verity-sessions'),
                }));
        }
      }
      if (conductor.isDeletionWorktreeBusy?.(session.sessionId)) return false;
      if (
        (await deps.eventStore.listSessions()).some((owner) => owner.worktree === session.worktree)
      )
        return false;
      if (session.worktree !== deps.workspaceDir) await cleanupWorktrees.remove(session.worktree);
      return true;
    },
    report: (sessionId, phase, outcome, elapsedMs, error) => {
      app.log.info(
        {
          sessionId,
          reqId: deletionRequestIds.get(sessionId),
          phase,
          outcome,
          elapsedMs,
          ...(error === undefined
            ? {}
            : { errorKind: error instanceof Error ? error.name : 'unknown' }),
        },
        'verity: session delete phase',
      );
    },
  });
  lifecycle.every(30_000, () => {
    void sessionDeletions
      .resume()
      .catch((error: unknown) =>
        app.log.warn({ err: error }, 'verity: session deletion retry failed'),
      );
  });
  app.addHook('onReady', () => {
    void sessionDeletions
      .resume()
      .catch((error: unknown) =>
        app.log.warn({ err: error }, 'verity: session deletion recovery failed'),
      );
  });
  lifecycle.onClose(() => sessionDeletions.close());

  registerSessionDeleteRoute(app, {
    remove: async (request, reply, id, force, options) => {
      if (conductor.isMovingSession?.(id)) {
        reply.code(409);
        return { error: 'Wait for the session move to finish before deleting.' };
      }
      request.log.info(
        { sessionId: id, phase: 'lookup', outcome: 'started' },
        'verity: session delete phase',
      );
      const session = await deletionDeadline(deps.eventStore.getSession(id), 15_000).then(
        (session) => {
          request.log.info(
            { sessionId: id, phase: 'lookup', outcome: 'completed' },
            'verity: session delete phase',
          );
          return session;
        },
        (error: unknown) => {
          request.log.info(
            {
              sessionId: id,
              phase: 'lookup',
              outcome: error instanceof SessionDeletionDeadlineError ? 'deadline' : 'failed',
            },
            'verity: session delete phase',
          );
          throw error;
        },
      );
      if (!session) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      // Meeting jobs can enter a non-cancellable delivery phase. Never tear
      // their session or worktree down through force-delete; the dedicated
      // cancel route is the only operation that knows whether the job can still
      // be stopped safely.
      if (hasMeetingJob(id)) {
        reply.code(409);
        return { error: `session ${id} has an active meeting job — stop it before deleting` };
      }
      if (!force && conductor.isBusy(id)) {
        reply.code(409);
        return { error: `session ${id} is busy — finish the turn before deleting it` };
      }
      deletionRequestIds.set(id, request.id);
      // Read before the transcript goes with the session; only once deletion is admitted.
      const noteForWiki = () =>
        noteDeletedSession(deps.eventStore, session, options?.keepForWiki === true, request.log);
      try {
        if (force) {
          await noteForWiki();
          return await sessionDeletions.remove(session);
        }
        let removal: ReturnType<typeof sessionDeletions.remove> | undefined;
        const admission = await conductor.tryRunExclusive(id, async () => {
          let release!: () => void;
          const admitted = new Promise<void>((resolve) => {
            release = resolve;
          });
          await noteForWiki();
          removal = sessionDeletions.remove(session, release);
          // The HTTP deadline must not release an unfinished admission operation.
          void removal.catch(() => undefined);
          await Promise.race([
            admitted,
            sessionDeletions.waitForLogical(id).catch(() => undefined),
          ]);
        });
        if (!admission.ran) {
          reply.code(409);
          return { error: `session ${id} is busy — finish the turn before deleting it` };
        }
        return await removal;
      } catch (error) {
        request.log.warn(
          { errorKind: error instanceof Error ? error.name : 'unknown', sessionId: id },
          'verity: session deletion deferred',
        );
        reply.code(503).header('retry-after', '5');
        return {
          error:
            error instanceof SessionDeletionDeadlineError
              ? error.message
              : 'Session deletion could not be completed; retry shortly',
        };
      } finally {
        if (deletionRequestIds.get(id) === request.id) deletionRequestIds.delete(id);
      }
    },
  });
}
