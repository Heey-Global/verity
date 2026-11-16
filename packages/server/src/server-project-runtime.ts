import type { Conductor } from '@verity/session';
import type { ProjectRecord } from '@verity/store';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ServerContext } from './server-context.js';
import type { ServerDeps } from './server-deps.js';
import type { ProjectDeleteOutcome } from './server-types.js';
import {
  observeProjectActivity,
  startProjectIdleSleepScheduler,
  PROJECT_SANDBOX_IDLE_TIMEOUT_MS,
  type ProjectActivitySnapshot,
} from './project-idle-sleep.js';
import {
  PROJECT_DELETE_SPAWN_WAIT_MS,
  startProjectRelayMigrationScheduler,
} from './server-support.js';
import type { VulnerabilityScanService } from './vulnerability-scan.js';
import { scanStartedProjectIfNeeded } from './vulnerability-start.js';

interface ProjectRuntimeOptions {
  hasMeetingJob: (sessionId: string) => boolean;
  vulnerabilityService: () => VulnerabilityScanService;
}

interface ProjectRuntime {
  projectsBeingDeleted: Set<string>;
  sessionsBeingReaped: Set<string>;
  projectDeletesInFlight: Map<string, Promise<ProjectDeleteOutcome>>;
  beginProjectSpawn: (projectId: string) => () => void;
  settleProjectSpawns: (projectId: string, log: FastifyBaseLogger) => Promise<boolean>;
  afterProjectProvision: (projectId: string, scanAfterStart?: boolean) => Promise<void>;
  settleBackgroundProvision: (
    projectId: string,
    provision: Promise<unknown>,
    onError: (error: unknown) => void,
  ) => void;
}

export function createServerProjectRuntime(
  app: FastifyInstance,
  deps: ServerDeps,
  conductor: Conductor,
  { hasMeetingJob, vulnerabilityService }: ProjectRuntimeOptions,
): ProjectRuntime {
  // Teardown exclusion for `DELETE /projects/:id`. Between the moment that route
  // quiesces a project's sessions and the moment its purge has removed the clone
  // root, turns and session spawns must not enter worktrees being deleted.
  // Keep the window here: hiding the project row before deprovision succeeds
  // would hide a still-running container. Both sets clear in the route's
  // `finally`, handing sessions back after a failed teardown.
  const projectsBeingDeleted = new Set<string>();
  const sessionsBeingReaped = new Set<string>();
  // In-flight `DELETE /projects/:id`, by project id. A second request for the
  // same project — an impatient double tap, a client retry — joins the first
  // rather than starting a second teardown beside it: two deprovisions of one
  // project would race each other over the same container and clone root, and
  // the exclusion above is keyed by id, so whichever request finished first
  // would clear the other's flags mid-purge and reopen the window they close.
  // Joining also means both callers get the same answer, which a double tap
  // should get.
  const projectDeletesInFlight = new Map<string, Promise<ProjectDeleteOutcome>>();
  // Spawns that passed the teardown guard, by project id. The guard only keeps
  // NEW spawns out; one already past it is still creating its worktree inside
  // the clone root the purge is about to remove. The delete waits for these to
  // settle before it tears anything down, so the two never overlap on the
  // filesystem. (The store lock in `createSession` covers only the row: it stops
  // such a spawn from leaving a session behind, not from writing a directory.)
  const projectSpawnsInFlight = new Map<string, Set<Promise<void>>>();
  deps.sessionStorage?.bind(
    (id, run) =>
      conductor.isMovingSession(id) || sessionsBeingReaped.has(id) || hasMeetingJob(id)
        ? Promise.resolve({ ran: false as const })
        : conductor.tryRunExclusive(id, run),
    // A teardown or a spawn creating a worktree holds the whole project. A dev
    // server or preview holds only the worktree of the session that runs it:
    // blocking the project instead left every idle session's worktree in place
    // for as long as any one session kept a server up. Orphaned registrations
    // (`sessionId` null) belong to no session, so any server or preview there
    // still defers that pass.
    (projectId, sessionId) =>
      projectsBeingDeleted.has(projectId) ||
      (projectSpawnsInFlight.get(projectId)?.size ?? 0) > 0 ||
      (sessionId === null
        ? deps.managedDevServerManager?.hasRunningServers(projectId) === true ||
          deps.managedDevServerManager?.hasUnverifiedServers(projectId) === true ||
          (deps.localPreviewManager?.listProject(projectId).length ?? 0) > 0
        : deps.managedDevServerManager?.hasRunningSessionServers(sessionId) === true ||
          (deps.localPreviewManager?.list(sessionId).length ?? 0) > 0),
  );
  const beginProjectSpawn = (projectId: string): (() => void) => {
    let finish: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = projectSpawnsInFlight.get(projectId) ?? new Set<Promise<void>>();
    pending.add(settled);
    projectSpawnsInFlight.set(projectId, pending);
    return () => {
      pending.delete(settled);
      if (pending.size === 0) projectSpawnsInFlight.delete(projectId);
      finish();
    };
  };
  /** Wait for the spawns admitted before the teardown flag went up. Bounded: the
   *  wait is for an HTTP handler that is creating a worktree, not for anything
   *  open-ended, so exceeding the budget means something is wedged. Returns
   *  `false` in that case and the delete gives up rather than purging the clone
   *  root out from under a live worktree operation — the caller can retry, and
   *  the flag it holds meanwhile keeps further spawns out. */
  const settleProjectSpawns = async (
    projectId: string,
    log: FastifyBaseLogger,
  ): Promise<boolean> => {
    const pending = projectSpawnsInFlight.get(projectId);
    if (pending === undefined || pending.size === 0) return true;
    const expired = Symbol('spawn-wait-timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      Promise.all([...pending]),
      new Promise<typeof expired>((resolve) => {
        timer = setTimeout(
          () => resolve(expired),
          deps.projectDeleteSpawnWaitMs ?? PROJECT_DELETE_SPAWN_WAIT_MS,
        );
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (result !== expired) return true;
    log.error(
      { projectId, pending: pending.size },
      'verity: refusing to tear a project down with a spawn still in flight',
    );
    return false;
  };
  /** Provisioning outlives the request that started it — the clone and the image
   *  build take minutes, and `DELETE /projects/:id` deliberately does not wait
   *  for one (it would block the delete for just as long). So the provision
   *  compensates on the way out instead: if the project it just built is gone or
   *  hidden by now, tear that work down again rather than leaving a live
   *  container and clone behind a row nobody can see. */
  const discardProvisionOfDeletedProject = async (projectId: string): Promise<boolean> => {
    // Join a teardown that is running right now, so this purge does not race the
    // delete's own over the same container and clone root.
    await projectDeletesInFlight.get(projectId)?.catch(() => undefined);
    let project: ProjectRecord | undefined;
    try {
      project = await deps.eventStore.getProject(projectId);
    } catch (error) {
      // A failed read is not evidence that the project is gone, and what follows
      // removes a container and a clone — so keep what was just provisioned and
      // say loudly that nobody checked it. Leaking a container the operator can
      // still see and delete beats purging a live project on a hiccup.
      app.log.error(
        { err: error, projectId },
        'verity: cannot tell whether a provisioned project was deleted meanwhile',
      );
      return false;
    }
    if (project !== undefined && project.hiddenAt === null) return false;
    app.log.warn({ projectId }, 'verity: discarding a project provisioned into its own deletion');
    try {
      await deps.deprovisioner?.deprovision(projectId, { purge: true });
    } catch (error) {
      app.log.error({ err: error, projectId }, 'verity: discarding the provisioned project failed');
    }
    return true;
  };
  const afterProjectProvision = async (
    projectId: string,
    scanAfterStart = false,
  ): Promise<void> => {
    if (await discardProvisionOfDeletedProject(projectId)) return;
    if (scanAfterStart) {
      void scanStartedProjectIfNeeded(projectId, {
        store: deps.eventStore.vulnerabilityScans,
        getProject: (id) => deps.eventStore.getProject(id),
        service: vulnerabilityService(),
      }).catch((error: unknown) =>
        app.log.warn({ err: error, projectId }, 'Vulnerability scan after project start failed'),
      );
    }
  };
  /** Settle a provision the caller is not waiting on (the routes answer `202` and
   *  let the worker clone and build in the background). Either outcome ends at
   *  the discard check: a provision that failed halfway can still have left a
   *  container or a clone behind, and if the project went away meanwhile that
   *  debris belongs to nobody. */
  const settleBackgroundProvision = (
    projectId: string,
    provision: Promise<unknown>,
    onError: (error: unknown) => void,
  ): void => {
    void provision.then(
      () => afterProjectProvision(projectId, true),
      async (error: unknown) => {
        onError(error);
        await discardProvisionOfDeletedProject(projectId);
      },
    );
  };
  return {
    projectsBeingDeleted,
    sessionsBeingReaped,
    projectDeletesInFlight,
    beginProjectSpawn,
    settleProjectSpawns,
    afterProjectProvision,
    settleBackgroundProvision,
  };
}

interface ProjectSandboxRuntime {
  projectActivity: (
    projectId: string,
    exceptSessionIds?: ReadonlySet<string>,
  ) => Promise<ProjectActivitySnapshot>;
  isProjectBusy: (projectId: string, exceptSessionIds?: ReadonlySet<string>) => Promise<boolean>;
}

export function createServerProjectSandboxRuntime(ctx: ServerContext): ProjectSandboxRuntime {
  const { app, deps, conductor, lifecycle } = ctx;
  // Recreate and sleep share the same activity evidence.
  const projectActivity = async (
    projectId: string,
    exceptSessionIds?: ReadonlySet<string>,
  ): Promise<ProjectActivitySnapshot> =>
    observeProjectActivity({
      projectId,
      exceptSessionIds,
      listSessions: () => deps.eventStore.listSessions(),
      isTurnBusy: (sessionId) => conductor.isBusy(sessionId),
      listShares: () => deps.eventStore.listPublicPreviewShares(projectId),
      hasLocalPreviewShares: () => deps.localPreviewManager?.hasProjectShares(projectId) ?? false,
      hasUnverifiedDevServers: () =>
        deps.managedDevServerManager?.hasUnverifiedServers(projectId) ?? false,
      isShareTargetLive: (share) =>
        deps.previewShareManager?.hasLiveTarget(share) ?? Promise.resolve(false),
      hasRunningDevServers: () =>
        deps.managedDevServerManager?.hasRunningServers(projectId) ?? false,
    });
  const isProjectBusy = async (
    projectId: string,
    exceptSessionIds?: ReadonlySet<string>,
  ): Promise<boolean> =>
    (await projectActivity(projectId, exceptSessionIds)).observations.length > 0;
  // Migrate legacy networks using the same activity barrier.
  const stopProjectRelayMigrationScheduler = startProjectRelayMigrationScheduler(
    deps,
    app.log,
    projectActivity,
  );
  lifecycle.onClose(() => {
    stopProjectRelayMigrationScheduler();
  });
  const idleSleepScheduler =
    deps.provisioner?.sleepProject === undefined
      ? undefined
      : startProjectIdleSleepScheduler({
          listProjects: () => deps.eventStore.listProjects(),
          isBusy: isProjectBusy,
          ...(deps.provisioner.projectSandboxLastActivityAt === undefined
            ? {}
            : {
                lastActivityAt: deps.provisioner.projectSandboxLastActivityAt.bind(
                  deps.provisioner,
                ),
              }),
          sleepProject: deps.provisioner.sleepProject.bind(deps.provisioner),
          idleMs: PROJECT_SANDBOX_IDLE_TIMEOUT_MS,
          onSlept: (projectId) => app.log.info({ projectId }, 'idle project Sandbox slept'),
          onError: (projectId, err) =>
            app.log.warn(
              { projectId, err },
              projectId === undefined
                ? 'idle project Sandbox sweep failed'
                : 'idle project Sandbox sleep deferred',
            ),
          onSweep: (projects) => {
            const summary = deps.projectSandboxLifecycleTelemetry?.summaryIfDue(projects);
            if (summary !== undefined) {
              app.log.info(summary, 'project Sandbox lifecycle summary');
            }
          },
        });
  deps.projectSandboxLifecycleTelemetry?.attachSink((event) => {
    app.log.info(event, 'project Sandbox lifecycle transition');
  });
  lifecycle.onClose(() => idleSleepScheduler?.stop());
  return { projectActivity, isProjectBusy };
}
