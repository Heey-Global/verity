import type { SessionRecord } from '@verity/store';
import type { PullRequestStatus } from './forge-provider.js';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from './server-deps.js';

export interface PullRequestRepairKind {
  /** Marker namespace, also the durable automation-marker prefix. */
  id: 'ci-failure' | 'merge-conflict' | 'post-merge-actions-failure';
  /** Whether the PR state calls for this repair, checked both when scheduling and
   * again against the freshly re-read status before the turn is dispatched. */
  applies(pr: PullRequestStatus): boolean;
  key(sessionId: string, pr: PullRequestStatus): string;
  /** `host` names the project's code host (`GitHub`, `Forgejo`) in the turn. */
  prompt(pr: PullRequestStatus, host: string): string;
  displayPrompt(number: number): string;
}

/**
 * Start a repair turn in a session whose pull request needs one (failed checks,
 * conflicts, review changes), at most once per repair and only for a person who
 * may still work in the project.
 */
export function createPrRepairDispatcher(ctx: {
  deps: ServerDeps;
  app: FastifyInstance;
  conductor: Exclude<ServerDeps['conductor'], (...args: never[]) => unknown>;
  canExecuteAs: (userId: string | null | undefined, projectId: string | null) => Promise<boolean>;
  codeHostName: (session: SessionRecord) => Promise<string>;
  preparingRepairDispatches: Set<string>;
  reconcileSessionRepairs: (projectId: string) => Promise<void>;
  scheduledPrRepairTurns: Set<string>;
  sessionsBeingReaped: Set<string>;
  /** Read on use: the session overview is set up after this dispatcher. */
  sessionPrStatus: (session: SessionRecord) => Promise<PullRequestStatus | null>;
}) {
  const {
    deps,
    app,
    conductor,
    canExecuteAs,
    codeHostName,
    preparingRepairDispatches,
    reconcileSessionRepairs,
    scheduledPrRepairTurns,
    sessionsBeingReaped,
    sessionPrStatus,
  } = ctx;
  return async (
    session: SessionRecord,
    pr: PullRequestStatus,
    repair: PullRequestRepairKind,
  ): Promise<void> => {
    if (!repair.applies(pr)) return;
    const { sessionId } = session;
    const scheduledMarker = `${repair.id}:${repair.key(sessionId, pr)}`;
    if (scheduledPrRepairTurns.has(scheduledMarker)) return;
    scheduledPrRepairTurns.add(scheduledMarker);
    try {
      // Already handled revisions need no fresh git/GitHub read on each app poll.
      // The next cached discovery of a new head/base pair will have a new marker.
      if (await deps.eventStore.hasSessionAutomationMarker(sessionId, scheduledMarker)) {
        scheduledPrRepairTurns.delete(scheduledMarker);
        return;
      }
    } catch {
      scheduledPrRepairTurns.delete(scheduledMarker);
      return;
    }
    await conductor
      .runWhenIdle(sessionId, async () => {
        let marker: string | undefined;
        let dispatchId: string | undefined;
        let dispatchAttempted = false;
        let ownsMarker = false;
        try {
          // Re-checked HERE, not at the call site: `runWhenIdle` defers the
          // callback until the current turn settles, so the project delete can
          // have started in between. Dropping the repair is right either way —
          // the session is about to go with its project, and a delete that
          // fails leaves the PR state for the next poll to pick up.
          if (sessionsBeingReaped.has(sessionId)) return;
          const currentSession = await deps.eventStore.getSession(sessionId);
          if (!currentSession || currentSession.projectId !== session.projectId) return;
          const latest = await sessionPrStatus(currentSession).catch(() => null);
          if (latest === null || !repair.applies(latest)) return;
          const initiatedBy = await deps.eventStore.latestPromptInitiator(sessionId);
          if (
            currentSession.planning === 'active' ||
            (session.projectId !== null &&
              !(await canExecuteAs(initiatedBy?.userId, session.projectId)))
          ) {
            app.log.debug(
              {
                sessionId,
                pullRequest: latest.number,
                reason: currentSession.planning === 'active' ? 'planning' : 'execution_permission',
              },
              'automatic PR repair deferred',
            );
            return;
          }
          if (session.projectId !== null && latest.phase === 'open' && latest.headSha) {
            const origin = await deps.eventStore.repairs.registerSessionOrigin(
              session.projectId,
              `pr:${latest.number}`,
              sessionId,
            );
            if (origin !== sessionId) {
              app.log.debug(
                {
                  sessionId,
                  pullRequest: latest.number,
                  originatingSessionId: origin,
                  reason: 'different_origin',
                },
                'automatic PR repair deferred',
              );
              return;
            }
            await reconcileSessionRepairs(session.projectId);
          }
          marker = `${repair.id}:${repair.key(sessionId, latest)}`;
          const projectRepair = session.projectId !== null && latest.phase === 'open';
          const fresh =
            projectRepair || (await deps.eventStore.markSessionAutomation(sessionId, marker));
          if (!fresh) return;
          ownsMarker = !projectRepair;
          // Nobody asked for this turn, so it runs for the session's most recent user;
          // their project rights are still checked on every gateway call it makes.
          if (session.projectId !== null && latest.phase === 'open') {
            if (!latest.headSha) {
              await deps.eventStore.deleteSessionAutomationMarker(sessionId, marker);
              return;
            }
            const incident = await deps.eventStore.repairs.observe(
              session.projectId,
              `pr:${latest.number}`,
              latest.headSha,
              JSON.stringify({ observedAt: new Date().toISOString(), status: latest }),
            );
            const claim = await deps.eventStore.repairs.claimSessionRepair(
              incident.id,
              sessionId,
              marker,
            );
            if (!claim?.dispatch_id) {
              const budgetUsed = await deps.eventStore.repairs.budgetUsed(
                session.projectId,
                `pr:${latest.number}`,
              );
              const incidents = await deps.eventStore.repairs.incidents(session.projectId);
              const observed = incidents.find((row) => row.id === incident.id);
              const owner = incidents.find((row) => row.owner_session_id !== null);
              app.log.debug(
                {
                  sessionId,
                  pullRequest: latest.number,
                  incidentId: incident.id,
                  incidentState: observed?.state,
                  owningSessionId: owner?.owner_session_id,
                  budgetUsed,
                  reason:
                    budgetUsed >= 2
                      ? 'attempt_limit'
                      : owner
                        ? 'project_repair_active'
                        : 'claim_unavailable',
                },
                'automatic PR repair deferred',
              );
              return;
            }
            dispatchId = claim.dispatch_id;
            ownsMarker = true;
            preparingRepairDispatches.add(dispatchId);
          }
          dispatchAttempted = true;
          const { accepted } = await conductor.dispatchTurnWhenIdle(
            sessionId,
            repair.prompt(latest, await codeHostName(session)),
            undefined,
            {
              displayPrompt: repair.displayPrompt(latest.number),
              ...(dispatchId
                ? {
                    durableDispatchId: dispatchId,
                    validateSession: async (current: SessionRecord) => {
                      if (
                        current.planning === 'active' ||
                        current.projectId !== session.projectId ||
                        !(await canExecuteAs(initiatedBy?.userId, current.projectId))
                      )
                        return false;
                      const observed = await sessionPrStatus(current);
                      return (
                        observed !== null &&
                        repair.applies(observed) &&
                        repair.key(sessionId, observed) === repair.key(sessionId, latest)
                      );
                    },
                  }
                : {}),
              ...(initiatedBy ? { initiatedBy } : {}),
            },
          );
          if (!accepted) {
            if (dispatchId) await deps.eventStore.repairs.cancelReservedDispatch(dispatchId);
            else
              await deps.eventStore
                .deleteSessionAutomationMarker(sessionId, marker)
                .catch(() => undefined);
          }
        } catch (err) {
          app.log.warn(
            { err, sessionId, pullRequest: pr.number, repair: repair.id },
            'automatic PR repair failed',
          );
          // Uncertain admission keeps its durable claim and marker until reconciled.
          if (dispatchId && !dispatchAttempted)
            await deps.eventStore.repairs.cancelReservedDispatch(dispatchId);
          if (ownsMarker && marker !== undefined && (!dispatchId || !dispatchAttempted)) {
            await deps.eventStore
              .deleteSessionAutomationMarker(sessionId, marker)
              .catch(() => undefined);
          }
        } finally {
          if (dispatchId) preparingRepairDispatches.delete(dispatchId);
          scheduledPrRepairTurns.delete(scheduledMarker);
        }
      })
      .catch(() => {
        scheduledPrRepairTurns.delete(scheduledMarker);
      });
  };
}
