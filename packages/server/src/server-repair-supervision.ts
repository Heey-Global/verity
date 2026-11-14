import { worktreeExists } from '@verity/session';
import { type FastifyInstance } from 'fastify';
import { createQACoordinator } from './qa-coordinator.js';
import { createRepairSupervisor } from './repair-supervisor.js';
import { type ServerContext } from './server-context.js';
import type { createServerSessionOverview } from './server-session-overview.js';
import type { SpawnSession } from './session-create-route.js';
import type { PrRepairTurns } from './server-pr-repair.js';
import type { ProjectRecord } from '@verity/store';

type SessionOverview = ReturnType<typeof createServerSessionOverview>;

/** Closures `buildServer` still owns that repair supervision depends on. */
export interface RepairSupervisionWiring {
  canExecuteAs: (userId: string | null | undefined, projectId: string | null) => Promise<boolean>;
  sessionPrStatus: SessionOverview['sessionPrStatus'];
  branchesForSession: SessionOverview['branchesForSession'];
  spawn: SpawnSession;
  ensureVerityControlProject: () => Promise<ProjectRecord>;
  repairTerminated: PrRepairTurns['repairTerminated'];
  preparingRepairDispatches: PrRepairTurns['preparingRepairDispatches'];
}

/**
 * QA repair supervision: the supervisor that assigns CI failures found by
 * repair discovery to sessions, and the QA coordinator that reviews them.
 * Does nothing unless the deployment provides repair discovery.
 */
export function installRepairSupervision(
  app: FastifyInstance,
  ctx: ServerContext,
  wiring: RepairSupervisionWiring,
): void {
  const { deps, conductor, lifecycle, liveHub, resources } = ctx;
  const {
    canExecuteAs,
    sessionPrStatus,
    branchesForSession,
    ensureVerityControlProject,
    repairTerminated,
    preparingRepairDispatches,
  } = wiring;
  if (deps.repairDiscovery) {
    const qaEnabled = async () => {
      const state = await deps.eventStore.repairs.qa();
      return (
        state.enabled &&
        !!state.sponsor &&
        (await deps.eventStore.isActiveAdministrator(state.sponsor))
      );
    };
    const preparingDispatches = preparingRepairDispatches;
    const supervisor = createRepairSupervisor({
      preparingDispatches,
      enabled: qaEnabled,
      coordinate: true,
      store: deps.eventStore,
      discover: deps.repairDiscovery,
      ...(deps.repairPullRequest ? { pullRequest: deps.repairPullRequest } : {}),
      changed: (projectId) => {
        resources.invalidate(`/projects/${encodeURIComponent(projectId)}/repairs`);
        void deps.eventStore.repairs
          .incidents(projectId)
          .then((incidents) => {
            for (const incident of incidents)
              if (incident.last_session_id)
                liveHub.notify({
                  sessionId: incident.last_session_id,
                  projectId,
                  topics: ['status'],
                });
          })
          .catch(() => undefined);
      },
      authorized: (userId, projectId) => canExecuteAs(userId, projectId),
      busy: (id) => conductor.isBusy(id),
      result: async (sessionId) => {
        const session = await deps.eventStore.getSession(sessionId);
        return session ? sessionPrStatus(session) : null;
      },
      target: async (projectId, branch, resource) => {
        let match: string | undefined;
        for (const session of await deps.eventStore.listSessions()) {
          if (session.projectId !== projectId || !(await worktreeExists(session.worktree)))
            continue;
          const branches = await branchesForSession(session);
          if (!branches || (await branches.current(session.worktree)) !== branch) continue;
          await deps.eventStore.repairs.registerSessionOrigin(
            projectId,
            resource,
            session.sessionId,
          );
          if (
            match ||
            conductor.isBusy(session.sessionId) ||
            session.planning === 'active' ||
            (await branches.isDirty(session.worktree))
          )
            return { blocked: true };
          match = session.sessionId;
        }
        return match ? { blocked: true } : { blocked: false };
      },
      terminated: repairTerminated,
      spawn: async (projectId, sessionId) => {
        if (await deps.eventStore.getSession(sessionId)) return;
        const result = await wiring.spawn(
          { projectId, sessionId, name: 'QA · CI repair' },
          app.log,
        );
        if (result.statusCode >= 300) throw new Error('Repair session could not be created');
      },
      dispatch: async (sessionId, prompt, dispatchId, validate, sponsorUserId, projectId) => {
        if ((await deps.eventStore.repairs.dispatchReceipt(dispatchId))?.state === 'admitted')
          return true;
        const result = await conductor.dispatchTurnWhenIdle(
          sessionId,
          prompt,
          {},
          {
            displayPrompt: 'QA: investigate assigned CI failure',
            durableDispatchId: dispatchId,
            initiatedBy: { userId: sponsorUserId },
            validateSession: async (session) => {
              if (session.projectId !== projectId || !(await validate())) return false;
              const mandate = await deps.eventStore.repairs.mandate(session.projectId);
              return (
                mandate?.mode === 'automatic' &&
                (await canExecuteAs(mandate.sponsor_user_id, session.projectId))
              );
            },
          },
        );
        return result.accepted;
      },
    });
    const qa = createQACoordinator({
      preparingDispatches,
      store: deps.eventStore,
      authorized: canExecuteAs,
      administrator: (userId) => deps.eventStore.isActiveAdministrator(userId),
      busy: (id) => conductor.isBusy(id),
      ensureSession: async (id) => {
        if (await deps.eventStore.getSession(id)) return;
        const project = await ensureVerityControlProject();
        const result = await wiring.spawn(
          { projectId: project.id, sessionId: id, name: 'Verity · QA' },
          app.log,
        );
        if (result.statusCode >= 300) throw new Error('QA session could not be created');
      },
      dispatch: async (id, prompt, validate, sponsor, dispatchId) => {
        const result = await conductor.dispatchTurnWhenIdle(
          id,
          prompt,
          { timeoutMs: 180_000 },
          {
            displayPrompt: 'QA: review changes in CI supervision',
            durableDispatchId: dispatchId,
            initiatedBy: { userId: sponsor },
            validateSession: validate,
          },
        );
        return result.accepted;
      },
      delegate: supervisor.delegate,
    });
    lifecycle.every(
      120_000,
      () => {
        void supervisor
          .sweep()
          .then(() => qa.tick())
          .catch((error) => app.log.warn({ error }, 'repair supervision failed'));
      },
      { startWhenReady: true },
    );
    lifecycle.onClose(async () => {
      await qa.stop();
      await supervisor.stop();
    });
  }
}
