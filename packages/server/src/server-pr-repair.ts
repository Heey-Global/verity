import { type SessionRecord } from '@verity/store';
import { type PullRequestStatus } from './forge-provider.js';
import { repairTurnTerminated } from './repair-supervisor.js';
import { type ServerContext } from './server-context.js';
import {
  buildPullRequestCiFailureDisplayPrompt,
  buildPullRequestCiFailurePrompt,
  pullRequestCiFailureKey,
  buildPostMergeActionsFailureDisplayPrompt,
  buildPostMergeActionsFailurePrompt,
  postMergeActionsFailureKey,
  buildPullRequestConflictDisplayPrompt,
  buildPullRequestConflictPrompt,
  pullRequestConflictKey,
} from './server-support.js';

/** Closures `buildServer` still owns that the repair turns depend on. */
export interface PrRepairWiring {
  canExecuteAs: (userId: string | null | undefined, projectId: string | null) => Promise<boolean>;
  sessionPrStatus: (session: SessionRecord) => Promise<PullRequestStatus | null>;
}

/** What the session overview and repair supervision use from the repair turns. */
export interface PrRepairTurns {
  reconcileSessionRepairs: (projectId: string) => Promise<void>;
  maybeDispatchPrRepairTurns: (
    session: SessionRecord,
    pr: PullRequestStatus | null | undefined,
  ) => Promise<void>;
  repairTerminated: (sessionId: string, dispatchId: string) => Promise<boolean>;
  /** Durable repair dispatches being prepared, which reconciliation must not settle. */
  preparingRepairDispatches: Set<string>;
}

/**
 * Self-repair turns for a session's own pull request: CI failures, merge
 * conflicts and failed post-merge actions, deduplicated per head commit and
 * reconciled with the project's repair incidents.
 */
export function createPrRepairTurns(
  ctx: ServerContext,
  { canExecuteAs, sessionPrStatus }: PrRepairWiring,
): PrRepairTurns {
  const { app, deps, conductor, sessionsBeingReaped } = ctx;
  // The self-repair turns Verity dispatches from a session's own PR status. Each one
  // re-reads the PR right before dispatching (the state may have moved while the
  // session was busy) and dedupes durably per head commit, so a poll running every
  // couple of seconds still produces at most one turn per pushed state.
  interface PullRequestRepairKind {
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
  const CI_FAILURE_REPAIR: PullRequestRepairKind = {
    id: 'ci-failure',
    applies: (pr) => pr.phase === 'open' && pr.pipeline === 'failure' && pr.checks.failed > 0,
    key: pullRequestCiFailureKey,
    prompt: buildPullRequestCiFailurePrompt,
    displayPrompt: buildPullRequestCiFailureDisplayPrompt,
  };
  const MERGE_CONFLICT_REPAIR: PullRequestRepairKind = {
    id: 'merge-conflict',
    applies: (pr) => pr.phase === 'open' && pr.mergeState === 'dirty',
    key: pullRequestConflictKey,
    prompt: buildPullRequestConflictPrompt,
    displayPrompt: buildPullRequestConflictDisplayPrompt,
  };
  const POST_MERGE_ACTIONS_FAILURE_REVIEW: PullRequestRepairKind = {
    id: 'post-merge-actions-failure',
    applies: (pr) => pr.phase === 'merged' && pr.pipeline === 'failure' && pr.checks.failed > 0,
    key: postMergeActionsFailureKey,
    prompt: buildPostMergeActionsFailurePrompt,
    displayPrompt: buildPostMergeActionsFailureDisplayPrompt,
  };
  // Repair turns name the code host the agent has to act on; a Forgejo PR
  // described as a GitHub one sends the agent to the wrong tools.
  const codeHostName = async (session: SessionRecord): Promise<string> => {
    if (session.projectId === null) return 'GitHub';
    const project = await deps.eventStore.getProject(session.projectId).catch(() => undefined);
    return project?.kind === 'forgejo' ? 'Forgejo' : 'GitHub';
  };
  const scheduledPrRepairTurns = new Set<string>();
  const preparingRepairDispatches = new Set<string>();
  const repairTerminated = async (sessionId: string, dispatchId: string) => {
    const receipt = await deps.eventStore.repairs.dispatchReceipt(dispatchId);
    const boundary =
      receipt?.prompt_seq == null
        ? await deps.eventStore.repairs.attemptBoundary(dispatchId)
        : Number(receipt.prompt_seq);
    if (boundary === undefined || receipt?.state === 'reserved') return false;
    const latest = await deps.eventStore.latestSessionTurnControlEvent(sessionId, boundary);
    return repairTurnTerminated(latest ? [latest] : []);
  };
  const reconcileSessionRepairs = async (projectId: string) => {
    for (const incident of await deps.eventStore.repairs.incidents(projectId)) {
      if (
        !incident.dispatch_id ||
        !incident.owner_session_id ||
        conductor.isBusy(incident.owner_session_id)
      )
        continue;
      if (preparingRepairDispatches.has(incident.dispatch_id)) continue;
      const sessionMarker = await deps.eventStore.repairs.sessionAutomationMarker(
        incident.dispatch_id,
      );
      // Recover pre-existing QA PR claims even with QA disabled. Workflow workers
      // still need the supervisor's repair-PR / awaiting-merge handoff.
      if (
        !sessionMarker &&
        !(incident.resource.startsWith('pr:') && incident.originating_session_id)
      )
        continue;
      if (
        sessionMarker &&
        (await deps.eventStore.repairs.cancelReservedDispatch(incident.dispatch_id))
      )
        continue;
      if (await repairTerminated(incident.owner_session_id, incident.dispatch_id))
        await deps.eventStore.repairs.finishAttempt(
          incident.id,
          incident.dispatch_id,
          'verifying',
          incident.evidence,
        );
    }
  };
  const maybeDispatchPrRepairTurn = async (
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
  /** Dispatch the ONE repair turn a PR's state calls for. A conflicted PR takes
   * precedence over failing CI: GitHub builds no merge ref for it, so its checks are
   * either absent or stale, and asking the session to chase them before the branch
   * merges cleanly again sends it after the wrong problem. */
  const maybeDispatchPrRepairTurns = async (
    session: SessionRecord,
    pr: PullRequestStatus | null | undefined,
  ): Promise<void> => {
    if (pr === null || pr === undefined) return;
    if (session.projectId !== null) {
      const resource = `pr:${pr.number}`;
      if (pr.phase === 'open') {
        await deps.eventStore.repairs.registerSessionOrigin(
          session.projectId,
          resource,
          session.sessionId,
        );
        if (pr.headSha && pr.pipeline !== 'unknown')
          await deps.eventStore.repairs.supersede(session.projectId, resource, pr.headSha);
        if (
          pr.headSha &&
          pr.pipeline === 'success' &&
          !MERGE_CONFLICT_REPAIR.applies(pr) &&
          pr.checks.total > 0 &&
          pr.checks.pending === 0 &&
          pr.checks.failed === 0 &&
          pr.checks.successful === pr.checks.total &&
          (await deps.eventStore.repairs.incidents(session.projectId)).some(
            (i) => i.resource === resource,
          )
        ) {
          await reconcileSessionRepairs(session.projectId);
          const incident = await deps.eventStore.repairs.observe(
            session.projectId,
            resource,
            pr.headSha,
            JSON.stringify({ observedAt: new Date().toISOString(), status: pr }),
          );
          await deps.eventStore.repairs.resolve(incident.id, pr.headSha);
        }
      } else await deps.eventStore.repairs.retireResource(session.projectId, resource);
    }
    if (MERGE_CONFLICT_REPAIR.applies(pr)) {
      await maybeDispatchPrRepairTurn(session, pr, MERGE_CONFLICT_REPAIR);
      return;
    }
    if (POST_MERGE_ACTIONS_FAILURE_REVIEW.applies(pr)) {
      await maybeDispatchPrRepairTurn(session, pr, POST_MERGE_ACTIONS_FAILURE_REVIEW);
      return;
    }
    await maybeDispatchPrRepairTurn(session, pr, CI_FAILURE_REPAIR);
  };
  return {
    reconcileSessionRepairs,
    maybeDispatchPrRepairTurns,
    repairTerminated,
    preparingRepairDispatches,
  };
}
