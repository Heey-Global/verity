import type { ProjectDeleteOutcome, SessionArtifactPurgeBudget } from './server-types.js';
import { projectDeleteStore, SESSION_ARTIFACT_PURGE_TIMEOUT_MS } from './server-support.js';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerDeps } from './server-deps.js';

/**
 * Delete a project: settle its spawns and sessions, deprovision its sandboxes and
 * hide it, recording the outcome. Built once per server from the state it shares
 * with the session routes (docs/adr/0029-module-boundaries-and-file-size.md).
 */
export function createProjectDeleteRunner(ctx: {
  deps: ServerDeps;
  app: FastifyInstance;
  conductor: Exclude<ServerDeps['conductor'], (...args: never[]) => unknown>;
  deleteSessionEverywhere: (
    sessionId: string,
    budget?: SessionArtifactPurgeBudget,
  ) => Promise<boolean>;
  projectsBeingDeleted: Set<string>;
  sessionsBeingReaped: Set<string>;
  settleProjectSpawns: (projectId: string, log: FastifyBaseLogger) => Promise<boolean>;
  worktrees: NonNullable<ServerDeps['worktrees']>;
}) {
  const {
    deps,
    app,
    conductor,
    deleteSessionEverywhere,
    projectsBeingDeleted,
    sessionsBeingReaped,
    settleProjectSpawns,
    worktrees,
  } = ctx;
  return async function runProjectDelete(
    request: FastifyRequest,
    id: string,
  ): Promise<ProjectDeleteOutcome> {
    const project = await deps.eventStore.getProject(id);
    if (project === undefined) {
      return { code: 404, body: { error: `project ${id} not found` } };
    }
    if (!deps.deprovisioner && project.state !== 'absent') {
      return { code: 503, body: { error: 'multi-repo provisioning is not configured' } };
    }
    // The project's sessions have to go with it. They are bound by
    // `project_id`, and the soft delete below keeps that row — so nothing ever
    // unbound them: `GET /projects` stopped listing the project while
    // `GET /sessions` kept returning its sessions, and the overview collected
    // the strays under a permanent "Inactive project / Project unavailable"
    // group that the operator could only clear one session at a time.
    //
    // Reaping is split in two, because the two halves have opposite failure
    // costs. Stopping a session's work has to happen BEFORE the deprovision:
    // `purge: true` removes the clone root and with it every session worktree
    // underneath, so a turn still in flight would keep writing into a
    // directory being deleted while racing the container stop. Deleting the
    // rows has to happen AFTER it: a deprovision that throws (a credential it
    // could not revoke, say) leaves the project visible and the delete
    // retryable, and destroying the transcripts first would have burnt them
    // for a delete that did not happen. A quiesced session survives that in a
    // recoverable state — idle, its backend closed — and the retry finishes
    // the job.
    //
    // Every step is best-effort and independently guarded: a session that
    // cannot be reaped is logged and leaves exactly the stray row this block
    // exists to prevent, and one failing step must not skip the rest. That is
    // the symptom this fixes, not a reason to make the project undeletable
    // again — which is the failure mode the teardown path was just hardened
    // against. What is NOT best-effort is the order: a session whose work
    // could not be stopped keeps its row (see below).
    const listProjectSessionIds = async (): Promise<string[]> =>
      (await deps.eventStore.listSessions())
        .filter((session) => session.projectId === id)
        .map((session) => session.sessionId);
    const bestEffort = async (
      sessionId: string,
      step: string,
      run: () => Promise<unknown> | void,
    ): Promise<boolean> => {
      try {
        await run();
        return true;
      } catch (error) {
        request.log.error(
          { err: error, projectId: id, sessionId, step },
          'verity: a project session could not be reaped on project delete',
        );
        return false;
      }
    };
    /** The sessions this request flagged, so the `finally` clears exactly those. */
    const marked = new Set<string>();
    /** Stop a session's work. `true` only if every step got through. */
    const quiesce = async (sessionId: string): Promise<boolean> => {
      // Mark it BEFORE the first step: the guards keyed on this set are what
      // keep an agent loop, a PR-repair turn, or the operator from starting
      // new work on a session that is being torn down — a turn dispatched
      // between the cancel here and the purge below would write into a
      // worktree that is being removed under it. The project row cannot carry
      // that flag: hiding it before the deprovision has succeeded would take a
      // project whose container is still running out of the overview.
      sessionsBeingReaped.add(sessionId);
      marked.add(sessionId);
      // Drop the backlog BEFORE cancelling: the cancelled turn's `finally`
      // drains the next queued one, which would start against a session
      // about to be deleted and a worktree about to be purged.
      const cleared = await bestEffort(sessionId, 'clear-queue', () =>
        conductor.clearQueue(sessionId),
      );
      // Force-settle instead of refusing the way DELETE /sessions/:id does:
      // there is nothing left to finish the turn against, since the sandbox
      // it runs in is being torn down either way. The cancel is bounded and
      // does not promise a settle, so `closeSession` follows to kill the
      // in-process child, and the container removal below takes anything
      // running inside the sandbox with it.
      const cancelled = await bestEffort(sessionId, 'cancel-turn', async () => {
        if (conductor.isBusy(sessionId)) await conductor.cancelTurn(sessionId);
      });
      const closed = await bestEffort(sessionId, 'close-session', () =>
        conductor.closeSession?.(sessionId),
      );
      return cleared && cancelled && closed;
    };
    projectsBeingDeleted.add(id);
    const quiesced = new Set<string>();
    try {
      // The flag turns new spawns away; one already past it is mid-worktree and
      // has to land (or fail) before the purge removes the clone root under it.
      // Unlike a session that will not quiesce — which the deprovision kills
      // anyway — a spawn still writing into the clone root has no such backstop,
      // so if it does not settle in time the delete gives up instead of purging
      // underneath it. Nothing is torn down yet at this point, so the project is
      // simply still there and the operator can delete it again.
      if (!(await settleProjectSpawns(id, request.log))) {
        return {
          code: 409,
          body: { error: `project ${id} still has a session spawn in flight; try again` },
        };
      }
      for (const sessionId of await listProjectSessionIds()) {
        // Retried once: the steps are ordinary store/conductor calls, and a
        // transient failure is worth a second attempt while stopping the work
        // still means something. A session that stays unquiesced does NOT abort
        // the delete — the deprovision below stops the container the agent runs
        // in, which is the actual kill, and refusing would put the project back
        // in the undeletable state a wedged conductor used to leave it in. It
        // does cost the session its row (see the second pass).
        if ((await quiesce(sessionId)) || (await quiesce(sessionId))) quiesced.add(sessionId);
      }
      if (deps.deprovisioner) {
        try {
          await deps.deprovisioner.deprovision(id, { purge: true });
        } catch (error) {
          request.log.error({ err: error, projectId: id }, 'verity: project delete cleanup failed');
          throw error;
        }
      }
      // Soft-delete: the row (and its stable id/settings) stays, marked hidden,
      // so the GitHub-installation sync can't resurrect it on the next
      // `GET /projects`. The container is already gone via the deprovision
      // above, whose resource cleanup is best-effort by design: a wedged relay
      // or an unremovable clone directory reports itself in the log rather than
      // leaving the project stuck in the overview forever. Its credential
      // revocation is not — a deprovision that could not revoke the project's
      // capabilities throws, and we never reach this line, so no project is
      // hidden while a leaked capability still redeems.
      // Re-adding the same repo (POST /projects, restore) un-hides it.
      const hidden = await projectDeleteStore(deps.eventStore).hideProject(id);
      if (!hidden) {
        return { code: 404, body: { error: `project ${id} not found` } };
      }
      // Before the image cleanup, so the trail reads deletion first, removals second.
      // Best-effort: the deletion has happened, and a lost record becomes a write gap.
      try {
        await deps.audit?.recorder.projectDeleted({
          projectId: id,
          projectLabel: `${project.owner}/${project.repo}`,
          initiator: { kind: 'user', userId: request.localUserId },
        });
      } catch (error) {
        request.log.warn({ err: error, projectId: id }, 'project deletion not audited');
      }
      try {
        await deps.onProjectHidden?.(id);
      } catch (error) {
        request.log.warn({ err: error, projectId: id }, 'project image cleanup deferred to GC');
      }
      // The deprovision succeeded and the project is hidden, so the rows can go
      // now. Re-list rather than reusing the set from before: a spawn that raced
      // the deprovision created its session after that first pass and would
      // outlive the project exactly like the strays this route cleans up. It is
      // also the last chance to catch one — `createSession` takes a SHARE lock
      // on the project row and refuses a hidden project, so any spawn still in
      // flight either committed before `hideProject` did (and is in this list)
      // or is rejected outright.
      // One purge budget for the whole loop, not one per session: on a wedged data
      // volume a per-session bound multiplies by the session count and turns this route
      // into the minutes-long stall the bound was there to prevent. What each delete
      // gives up is the removal of one session's transcripts, which the startup sweep
      // collects on the next boot.
      const purgeBudget: SessionArtifactPurgeBudget = {
        remainingMs: SESSION_ARTIFACT_PURGE_TIMEOUT_MS,
      };
      for (const sessionId of await listProjectSessionIds()) {
        // A late arrival was never quiesced; a session whose first attempt
        // failed gets one more.
        if (!quiesced.has(sessionId) && !(await quiesce(sessionId))) {
          // Its agent may still be running, and the row is the only durable
          // trace of it — the transcript, and the entry the operator can act
          // on. Keep it: a stray session under "Inactive project" is the
          // symptom this route exists to fix, but it beats destroying the
          // history of a session nobody managed to stop.
          request.log.error(
            { projectId: id, sessionId },
            'verity: keeping a project session that could not be stopped',
          );
          continue;
        }
        // Each delete also purges the session's backend transcripts, which for codex
        // means resolving a thread against the runtime's dated rollout archive — a walk
        // one might expect to repeat per session here. It does not: the `deprovision`
        // above ran with `purge: true`, which already removed
        // `<dataVolumeRoot>/runners/<projectId>` whole, so every lookup below reads an
        // absent directory and returns immediately. The archive that survives is the
        // shared control-plane runtime's, and only a control-plane project's sessions
        // are searched in it — where the walk IS per session, and a deprovision that
        // failed to purge puts the project's own runtime back in that position too. Both
        // are the O(sessions x rollouts) case `session-artifacts.ts` names the fix for;
        // neither is on the ordinary path, which is why it has not been paid for yet.
        await bestEffort(sessionId, 'delete-session', () =>
          deleteSessionEverywhere(sessionId, purgeBudget),
        );
      }
      return { code: 200, body: { projectId: id } };
    } finally {
      // A failed teardown leaves the project visible and the delete
      // retryable, so its sessions have to become usable again — the flags
      // only cover the window in which the worktrees are being removed.
      // Clearing them here is safe despite being keyed by id: a concurrent
      // delete of the same project joined this one instead of running beside
      // it, so this request is the only owner of both entries.
      projectsBeingDeleted.delete(id);
      // Only the ones this request flagged — another project's delete owns
      // its own entries.
      for (const sessionId of marked) sessionsBeingReaped.delete(sessionId);
    }
  };
}
