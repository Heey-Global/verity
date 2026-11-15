import { setTimeout as sleep } from 'node:timers/promises';

import type { ServerContext } from './server-context.js';
import { SESSION_ARTIFACT_PURGE_TIMEOUT_MS } from './server-support.js';
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
