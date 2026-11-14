import {
  isLocalProject,
  LOCAL_PROJECT_OWNER,
  measureLatencyPhase,
  ProjectDefaultModelNotAllowedError,
  type ProjectRecord,
} from '@verity/store';
import { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseForgejoRepository, parseOwnerRepo } from './canonical.js';
import { ensureControlPlaneProject } from './control-plane-project.js';
import { type ReleaseSummary } from './forge-provider.js';
import { ProjectAgentNotAllowedError } from './project-agent-policy.js';
import { registerProjectRepositoriesRoutes } from './project-repositories-routes.js';
import { registerProjectCollectionRoutes } from './project-collection-routes.js';
import { registerProjectDetailRoutes } from './project-detail-routes.js';
import { registerProjectGitHubIssueRoutes } from './project-github-issues.js';
import { registerProjectGitHubLinkRoute } from './project-github-link-route.js';
import {
  activityReasons,
  recreateRefusalMessage,
  type ProjectActivitySnapshot,
} from './project-idle-sleep.js';
import { registerProjectLifecycleRoutes } from './project-lifecycle-routes.js';
import {
  parseRecreateContainerBody,
  registerProjectVerityControlRoutes,
} from './project-verity-control-routes.js';
import {
  AmbiguousGitPushError,
  ProvisioningError,
  ProvisioningWarning,
  type LinkCloneToGitHubResult,
} from './provisioner.js';
import { cachedTrustedToolkitIdentity } from './runner-boundary-attestation.js';
import { type SandboxUpdateStatus } from './sandbox-updates.js';
import { type ServerContext } from './server-context.js';
import {
  type ProjectDeleteOutcome,
  type ProjectSettingsRecord,
  type ProjectToolkitDrift,
  type PublicProjectRecord,
  type SandboxRepairVerdicts,
  type SessionArtifactPurgeBudget,
  type SessionSummary,
} from './server-types.js';
import { isDriftReportable, toolkitDriftEntryOf } from './toolkit-drift.js';
import {
  UNKNOWN_SANDBOX_UPDATE,
  NO_UNREPAIRED_SANDBOXES,
  veritySettingsStore,
  projectSettingsStore,
  projectDeleteStore,
  publicProject,
  isUniqueViolation,
  isControlPlaneProject,
  recordReleaseSummary,
  releaseDiffers,
  projectWithRelease,
  publicProjectSettings,
  SESSION_ARTIFACT_PURGE_TIMEOUT_MS,
} from './server-support.js';
import type { createServerSessionOverview } from './server-session-overview.js';

/**
 * Closures `buildServer` still owns that the project routes depend on. Each one
 * moves into `ServerContext` or into its own area's module when that area is
 * extracted from `server.ts`.
 */
export interface ProjectsWiring {
  presentProject: (...args: Parameters<typeof publicProject>) => PublicProjectRecord;
  projectActivity: (
    projectId: string,
    exceptSessionIds?: ReadonlySet<string>,
  ) => Promise<ProjectActivitySnapshot>;
  hasMeetingJob: (sessionId: string) => boolean;
  summarizeSessions: ReturnType<typeof createServerSessionOverview>['summarizeSessions'];
  /** The teardown sets `ServerContext` exposes read-only; only the delete writes them. */
  projectsBeingDeleted: Set<string>;
  sessionsBeingReaped: Set<string>;
  projectDeletesInFlight: Map<string, Promise<ProjectDeleteOutcome>>;
  settleProjectSpawns: (projectId: string, log: FastifyBaseLogger) => Promise<boolean>;
  afterProjectProvision: (projectId: string, scanAfterStart?: boolean) => Promise<void>;
  settleBackgroundProvision: (
    projectId: string,
    provision: Promise<unknown>,
    onError: (error: unknown) => void,
  ) => void;
}

/** What other areas use from the project routes. */
export interface InstalledProjects {
  advancedModeEnabled: () => Promise<boolean>;
  ensureVerityControlProject: () => Promise<ProjectRecord>;
}

/**
 * Project routes: the collection, details, lifecycle and deletion, GitHub
 * linking and repositories, and Verity Control's project.
 */
export function installProjects(
  app: FastifyInstance,
  ctx: ServerContext,
  {
    presentProject,
    projectActivity,
    hasMeetingJob,
    summarizeSessions,
    projectsBeingDeleted,
    sessionsBeingReaped,
    projectDeletesInFlight,
    settleProjectSpawns,
    afterProjectProvision,
    settleBackgroundProvision,
  }: ProjectsWiring,
): InstalledProjects {
  const { deps, conductor } = ctx;
  // A link keeps its original local identity reserved while the DB row
  // temporarily carries the GitHub target. This closes the only interval in
  // which a concurrent local create could steal the slug and block rollback.
  // Verity has one API writer process; symbols prevent an older request from
  // releasing a newer request's reservation.
  const localIdentityLinkReservations = new Map<string, symbol>();
  const githubTargetLinkReservations = new Map<string, symbol>();
  const resolveProjectRelease = async (
    project: ProjectRecord,
    opts?: { awaitRefresh?: boolean },
  ): Promise<{ project: ProjectRecord; release: ReleaseSummary | null }> => {
    // Neither the control-plane workspace nor a project without a GitHub
    // repository has releases to look up; both would just mint tokens and 404.
    if (isControlPlaneProject(project) || isLocalProject(project) || project.kind === 'forgejo') {
      return { project, release: null };
    }
    // Trigger the in-memory release refresh + read its freshest SETTLED value.
    // Tristate (see GitHubReleaseService): `undefined` = unknown (cold cache /
    // no token) → keep the persisted value and don't write; `null` = confirmed
    // no release → clear a stale persisted tag; a summary = the latest release.
    // Persist only on an actual change, so a polled overview/detail isn't a write
    // storm, and a release deleted on GitHub is cleared rather than pinned.
    let fresh: ReleaseSummary | null | undefined;
    if (opts?.awaitRefresh === true && deps.refreshLatestRelease !== undefined) {
      fresh = await measureLatencyPhase('project_release_refresh', () =>
        deps.refreshLatestRelease!(project.owner, project.repo),
      );
    } else {
      fresh = deps.latestRelease?.(project.owner, project.repo);
      // If the nonblocking cache is unknown, await one refresh. This is what
      // lets DB-backed GitHub-App deployments (no PAT/gh-token) populate release
      // badges from the project overview instead of staying permanently blank.
      if (fresh === undefined && deps.refreshLatestRelease !== undefined) {
        fresh = await measureLatencyPhase('project_release_refresh', () =>
          deps.refreshLatestRelease!(project.owner, project.repo),
        );
      }
    }
    if (fresh !== undefined && releaseDiffers(project, fresh)) {
      await measureLatencyPhase('project_release_persist', () =>
        deps.eventStore.updateProjectReleaseStatus(project.id, {
          tag: fresh?.tag ?? null,
          name: fresh?.name ?? null,
          url: fresh?.url ?? null,
          publishedAt: fresh?.publishedAt ?? null,
        }),
      );
    }
    // A cold/unknown lookup (undefined) falls back to the persisted value so
    // the badge never blanks out right after a restart.
    const release = fresh !== undefined ? fresh : recordReleaseSummary(project);
    return {
      project: fresh !== undefined ? projectWithRelease(project, fresh) : project,
      release,
    };
  };

  /**
   * This Server's own toolkit identity — the right-hand side of every drift
   * comparison in one response.
   *
   * Resolved once per response and passed down rather than looked up per
   * project. A successful read is cached process-wide, so on the happy path the
   * difference is nil; a failing one is not cached (a transient I/O fault must
   * not freeze into a permanently poisoned answer), and per-project resolution
   * would turn one broken mount into one filesystem retry per project on every
   * overview poll.
   *
   * A failure to read the bundle is a broken deployment, not a reason to fail
   * the project list: it degrades to `undefined`, which `toolkitDriftEntryOf`
   * turns into `unknown` — "cannot be compared", the one verdict that is still
   * true when the comparison is unavailable — and the wire then carries no
   * verdict at all. Reporting it as `matches` would be the exact false
   * all-clear the drift report exists to remove.
   *
   * But degrading quietly would be its own version of that: every project would
   * lose its drift verdict with nothing anywhere saying why, and the packaging or mount
   * fault behind it would be invisible. So it is logged — deduplicated while the
   * fault persists, and re-armed by the first read that succeeds, so a Server
   * polled once a second does not bury the finding in its own noise.
   */
  let toolkitIdentityFailureLogged = false;
  const serverToolkitIdentity = async (): Promise<string | undefined> =>
    (deps.toolkitIdentity ?? cachedTrustedToolkitIdentity)().then(
      (identity) => {
        toolkitIdentityFailureLogged = false;
        return identity;
      },
      (error: unknown) => {
        if (!toolkitIdentityFailureLogged) {
          toolkitIdentityFailureLogged = true;
          app.log.error(
            { err: error },
            'verity: cannot read the bundled sandbox toolkit — no project can be checked for drift until this is fixed',
          );
        }
        return undefined;
      },
    );

  /**
   * This project's toolkit drift verdict, or `null` when the report declines to
   * judge the row at all or can reach no verdict (`unknown`).
   *
   * Pure: it compares the project's recorded `toolkitIdentity` against the
   * identity the caller already resolved, so it costs no Docker call and no
   * disk read.
   */
  const projectToolkitDrift = (
    project: ProjectRecord,
    current: string | undefined,
  ): ProjectToolkitDrift | null => {
    if (!isDriftReportable(project)) return null;
    const { verdict, carrier } = toolkitDriftEntryOf(current, project);
    // Base-image projects are never attested, so `unknown` is their permanent
    // state, and a failed attestation already surfaces as a provision warning.
    // Shown, it would be a banner that is always on and nothing clears.
    if (verdict === 'unknown') return null;
    return { verdict, carrier };
  };

  /**
   * Qualify an update status with whether Verity's own repair is still working on it.
   *
   * The checker compares images and knows nothing about the reconciler, so it
   * always reports `converging`. Only the provisioner knows which projects the
   * automatic repair has given up on or will never pick up, and only that
   * distinction makes `state: 'available'` worth showing. A Server restart resumes
   * the existing Sandbox generation and queues its stale image until the project is
   * idle, so that waiting period is genuinely an in-flight automatic repair. Optional throughout —
   * a deployment whose provisioner does not reconcile (tests, non-relay setups)
   * keeps `converging`.
   *
   * Normally applied only to an `available` status. The deliberate exception is
   * a failed project the provisioner itself still owes a repair: its recreate may
   * already have removed the old container, so the image checker honestly says
   * `unknown` while the reconciler can still say, independently, that rebuilding
   * has stalled. Other unknowns (custom image, registry failure) remain unknown
   * and converging rather than acquiring a verdict nobody established.
   */
  const withSelfRepair = (
    project: ProjectRecord,
    status: SandboxUpdateStatus,
    verdicts: SandboxRepairVerdicts,
  ): SandboxUpdateStatus => {
    // Reported together, because they answer the same question — is this gap
    // closing on its own? — from the two sides the reconciler can be on. A
    // turn-blocked sandbox also reads `stalled` so that a client which knows
    // nothing of `turnBlocked` still surfaces it rather than showing the
    // reassuring spinner forever; one that does know reads the flag and names the
    // remedy. `available` only: a blocked update the checker cannot even see is
    // not something to report a turn about.
    const blocked = status.state === 'available' && verdicts.turnBlocked.has(project.id);
    const unrepaired =
      verdicts.unrepaired.has(project.id) &&
      (status.state === 'available' || (project.state === 'failed' && status.state === 'unknown'));
    // One expression for both reasons, deliberately: they set the SAME two fields,
    // and split branches drifting apart is how a sandbox ends up reported as
    // blocked without the `stalled` that older clients read.
    // Carried with its time whatever the verdict: while a retry waits or builds,
    // the status is `converging` and the failure is plainly an earlier one.
    const failure = status.state === 'current' ? undefined : verdicts.lastFailures?.get(project.id);
    const withFailure =
      failure === undefined
        ? status
        : {
            ...status,
            lastRepairFailure: { at: new Date(failure.at).toISOString(), message: failure.message },
          };
    if (!unrepaired && !blocked) return withFailure;
    return {
      ...withFailure,
      selfRepair: 'stalled',
      turnBlocked: blocked,
      blockedBy: blocked ? [...(verdicts.blockers?.get(project.id) ?? [])] : [],
    };
  };
  const sandboxRepairVerdicts = (): SandboxRepairVerdicts => ({
    unrepaired: deps.provisioner?.unrepairedSandboxes?.() ?? NO_UNREPAIRED_SANDBOXES,
    turnBlocked: deps.provisioner?.turnBlockedSandboxes?.() ?? NO_UNREPAIRED_SANDBOXES,
    ...(deps.provisioner?.sandboxUpdateBlockers
      ? { blockers: deps.provisioner.sandboxUpdateBlockers() }
      : {}),
    ...(deps.provisioner?.sandboxRepairLastFailures
      ? { lastFailures: deps.provisioner.sandboxRepairLastFailures() }
      : {}),
  });

  // Read marks and dismissed Home items of the person asking; a session they
  // never touched is unread-neutral and hides nothing.
  const sessionsAsSeenBy = async (
    viewer: string,
    summaries: SessionSummary[],
  ): Promise<SessionSummary[]> => {
    const views = await deps.eventStore.viewState.sessionViews(viewer);
    return summaries.map((summary) => {
      const view = views.get(summary.sessionId);
      return {
        ...summary,
        lastSeenEventCount: view?.lastSeenEventCount ?? null,
        inboxDismissed: view?.inboxDismissed ?? [],
      };
    });
  };
  // Fold state and dismissed Home items belong to the person asking, never to the
  // project row, so one member folding a group leaves everyone else's open.
  const projectsAsSeenBy = async (
    viewer: string,
    projects: PublicProjectRecord[],
  ): Promise<PublicProjectRecord[]> => {
    const views = await deps.eventStore.viewState.projectViews(viewer);
    return projects.map((project) => {
      const view = views.get(project.id);
      return {
        ...project,
        collapsed: view?.collapsed ?? false,
        inboxDismissed: view?.inboxDismissed ?? [],
      };
    });
  };
  const publicProjects = async (projects: ProjectRecord[]): Promise<PublicProjectRecord[]> => {
    const toolkit = await measureLatencyPhase('project_toolkit', serverToolkitIdentity);
    const resolved = await measureLatencyPhase('project_releases', () =>
      Promise.all(projects.map((project) => resolveProjectRelease(project))),
    );
    // One update check for the whole page. Per project this used to re-resolve
    // the default image, its labels and its registry version — the same answer
    // every time — so a ten-project overview poll walked ghcr.io ten times over,
    // and the poll runs several times a minute per client.
    const sandboxUpdates =
      (await measureLatencyPhase('project_sandbox_updates', async () =>
        deps.sandboxUpdates?.statusAll(
          resolved
            .map(({ project }) => project)
            .filter((project) => !isControlPlaneProject(project)),
        ),
      )) ?? new Map<string, SandboxUpdateStatus>();
    const verdicts = sandboxRepairVerdicts();
    return resolved.map(({ project, release }) =>
      presentProject(
        project,
        release,
        isControlPlaneProject(project)
          ? UNKNOWN_SANDBOX_UPDATE
          : withSelfRepair(
              project,
              sandboxUpdates.get(project.id) ?? UNKNOWN_SANDBOX_UPDATE,
              verdicts,
            ),
        projectToolkitDrift(project, toolkit),
      ),
    );
  };
  const advancedModeEnabled = async (): Promise<boolean> =>
    (await veritySettingsStore(deps.eventStore).getVeritySettingsRaw())?.advancedModeEnabled ===
    true;

  const ensureVerityControlProject = async (): Promise<ProjectRecord> => {
    return ensureControlPlaneProject(deps.eventStore);
  };

  const projectsForOverview = async (projects: ProjectRecord[]): Promise<ProjectRecord[]> => {
    const withoutControl = projects.filter((project) => !isControlPlaneProject(project));
    if (!(await measureLatencyPhase('project_settings', advancedModeEnabled)))
      return withoutControl;
    return [
      await measureLatencyPhase('project_control', ensureVerityControlProject),
      ...withoutControl,
    ];
  };

  const appearsInProjectOverview = (project: ProjectRecord): boolean =>
    project.state !== 'absent' || project.overviewVisible === true;

  registerProjectGitHubIssueRoutes(app, {
    store: deps.eventStore,
    list: deps.listProjectGitHubIssues,
  });
  registerProjectRepositoriesRoutes(app, {
    store: deps.eventStore,
    repositoryFor: deps.projectRepository,
  });
  registerProjectCollectionRoutes(app, {
    store: deps.eventStore,
    listOverview: async (userId, viewer) => {
      const projects = await measureLatencyPhase('project_list', () =>
        deps.listProjects ? deps.listProjects() : deps.eventStore.listProjects(),
      );
      const readableIds =
        userId === null
          ? null
          : new Set(
              await measureLatencyPhase('project_permissions', () =>
                deps.eventStore.listReadableProjectIds(userId),
              ),
            );
      return measureLatencyPhase('project_overview', async () =>
        projectsAsSeenBy(
          viewer,
          await publicProjects(
            await projectsForOverview(
              projects.filter(
                (project) =>
                  appearsInProjectOverview(project) &&
                  (readableIds === null || readableIds.has(project.id)),
              ),
            ),
          ),
        ),
      );
    },
    reorder: async (ids, viewer) => {
      const reordered = await deps.eventStore.reorderProjects(ids);
      deps.invalidateProjectList?.();
      return projectsAsSeenBy(
        viewer,
        await publicProjects(await projectsForOverview(reordered.filter(appearsInProjectOverview))),
      );
    },
    forgejoEnabled: deps.forgejoEnabled === true,
    listAvailableRepositories: async () =>
      deps.listAvailableRepositories
        ? deps.listAvailableRepositories()
        : deps.listProjects
          ? deps.listProjects()
          : deps.eventStore.listProjects({ includeHidden: true }),
    presentRepositories: publicProjects,
    localIdentityReservations: localIdentityLinkReservations,
    githubTargetReservations: githubTargetLinkReservations,
    isUniqueViolation,
  });
  registerProjectDetailRoutes(app, {
    getDetail: async (id, viewer) => {
      const cached = await deps.eventStore.getProject(id);
      if (cached === undefined) return undefined;
      const project = deps.reconcileProjectState
        ? await deps.reconcileProjectState(cached).catch(() => cached)
        : cached;
      const settings =
        (await projectSettingsStore(deps.eventStore).getProjectSettingsRaw(id)) ?? null;
      const sessions = (await deps.eventStore.listSessions()).filter(
        (session) => session.projectId === id,
      );
      const resolved = await resolveProjectRelease(project);
      const sandboxUpdate = withSelfRepair(
        resolved.project,
        (await deps.sandboxUpdates?.status(resolved.project)) ?? UNKNOWN_SANDBOX_UPDATE,
        sandboxRepairVerdicts(),
      );
      // The project page shows this person's dismissed health items too, so the
      // project carries their view state just as its sessions do.
      const presented = presentProject(
        resolved.project,
        resolved.release,
        sandboxUpdate,
        projectToolkitDrift(resolved.project, await serverToolkitIdentity()),
      );
      const [seen] = await projectsAsSeenBy(viewer, [presented]);
      return {
        project: seen ?? presented,
        settings: publicProjectSettings(settings),
        sessions: await sessionsAsSeenBy(viewer, await summarizeSessions(sessions)),
        // What this person may change here, so the app offers only that. The
        // routes check again; this only spares an edit the server would refuse.
        viewer: {
          canManage:
            deps.authRegistry?.isEnabled() !== true ||
            (await deps.eventStore.hasProjectPermission(viewer, id, 'manage')),
        },
      };
    },
    projectExists: async (id) => (await deps.eventStore.getProject(id)) !== undefined,
    renameProject: async (id, name) => {
      const renamed = await deps.eventStore.renameProject(id, name);
      // The overview list is memoised; it must show the new name at once.
      if (renamed !== undefined) deps.invalidateProjectList?.();
      return renamed;
    },
    ...(deps.listBrokeredGrants !== undefined ? { listGrants: deps.listBrokeredGrants } : {}),
    ...(deps.revokeBrokeredGrant !== undefined ? { revokeGrant: deps.revokeBrokeredGrant } : {}),
    setSetupStatus: async (id, status) => {
      const updated = await deps.eventStore.setProjectSetupStatus(id, status);
      if (updated === undefined) return undefined;
      const resolved = await resolveProjectRelease(updated, { awaitRefresh: false });
      const sandboxUpdate = withSelfRepair(
        resolved.project,
        (await deps.sandboxUpdates?.status(resolved.project)) ?? UNKNOWN_SANDBOX_UPDATE,
        sandboxRepairVerdicts(),
      );
      // After the last row write in this handler, so no list started in between
      // can memoise a state this request is still about to change.
      deps.invalidateProjectList?.();
      return presentProject(
        resolved.project,
        resolved.release,
        sandboxUpdate,
        projectToolkitDrift(resolved.project, await serverToolkitIdentity()),
      );
    },
    setCollapsed: async (id, collapsed, viewer) => {
      if (!(await deps.eventStore.viewState.setProjectCollapsed(viewer, id, collapsed)))
        return undefined;
      // Answer from the state just written, never from the memoised fleet list:
      // that list can predate the write by a whole cache window, and a client
      // trusting the response would fold the group straight back.
      const row = await deps.eventStore.getProject(id);
      if (row === undefined) return undefined;
      // The list path reconciles lifecycle state against the container; keep
      // the response on that footing, as the detail route does. The fold state
      // is already committed, so a reconciliation failure must not turn into an
      // error the client would roll its fold back for: answer with the row.
      const project = deps.reconcileProjectState
        ? await deps.reconcileProjectState(row).catch(() => row)
        : row;
      return (await projectsAsSeenBy(viewer, await publicProjects([project])))[0];
    },
    isSealed: () => deps.secretCipher?.isSealed() === true,
    updateSettings: async (id, patch) => {
      const store = projectSettingsStore(deps.eventStore);
      let settings: ProjectSettingsRecord | undefined;
      try {
        settings = await store.updateProjectSettings(id, patch);
      } catch (error) {
        if (error instanceof ProjectDefaultModelNotAllowedError) {
          throw new ProjectAgentNotAllowedError(error.model);
        }
        throw error;
      }
      return settings === undefined ? undefined : publicProjectSettings(settings)!;
    },
  });

  async function runProjectDelete(
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
          ctx.deleteSession(sessionId, purgeBudget),
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
  }

  registerProjectLifecycleRoutes(app, {
    deleteProject: async (request, id) => {
      const joined = projectDeletesInFlight.get(id);
      if (joined !== undefined) return joined;
      const teardown = runProjectDelete(request, id);
      projectDeletesInFlight.set(id, teardown);
      try {
        return await teardown;
      } finally {
        projectDeletesInFlight.delete(id);
      }
    },
    deprovision: async (request, id, purge) => {
      if (!deps.deprovisioner) {
        return { code: 503, error: 'multi-repo provisioning is not configured' };
      }
      const project = await deps.eventStore.getProject(id);
      if (project === undefined) return { code: 404, error: `project ${id} not found` };
      const busySession = (await deps.eventStore.listSessions()).find(
        (session) =>
          session.projectId === id &&
          (conductor.isBusy(session.sessionId) || hasMeetingJob(session.sessionId)),
      );
      if (busySession !== undefined) {
        return { code: 409, error: `project session ${busySession.sessionId} is busy` };
      }
      try {
        return {
          code: 200,
          project: await deps.deprovisioner.deprovision(id, { purge }),
        };
      } catch (error) {
        request.log.error({ err: error, projectId: id }, 'verity: deprovision failed');
        throw error;
      }
    },
    repair: async (request, id, confirmWarnings) => {
      if (!deps.provisioner) {
        return { code: 503, error: 'multi-repo provisioning is not configured' };
      }
      const project = await deps.eventStore.getProject(id);
      if (project === undefined || project.hiddenAt !== null) {
        return { code: 404, error: `project ${id} not found` };
      }
      if (project.state === 'active') return { code: 200, project };
      if (deps.secretCipher?.isSealed() === true) {
        return { code: 503, error: 'secret store is sealed', status: 'sealed' as const };
      }
      if (!confirmWarnings && deps.provisioner.provisionWarnings !== undefined) {
        const warnings = await deps.provisioner.provisionWarnings(project.id);
        if (warnings.length > 0) {
          return { code: 409, requiresConfirmation: true as const, warnings };
        }
      }
      const queued =
        project.state === 'absent' || project.state === 'failed'
          ? ((await deps.eventStore.updateProjectState(project.id, 'cloning')) ?? project)
          : project;
      settleBackgroundProvision(
        project.id,
        deps.provisioner.provision(project.id, {
          confirmWarnings,
          initiator: { kind: 'user', userId: request.localUserId },
        }),
        (error) =>
          request.log.error({ err: error, projectId: id }, 'verity: project repair failed'),
      );
      return { code: 202, project: queued };
    },
    sleep: async (request, id) => {
      if (deps.provisioner?.sleepProject === undefined) {
        return { code: 503, error: 'project sleep is not configured' };
      }
      const project = await deps.eventStore.getProject(id);
      if (project === undefined || project.hiddenAt !== null) {
        return { code: 404, error: `project ${id} not found` };
      }
      if (project.state === 'sleeping') {
        return {
          code: 200,
          project: presentProject(project, null, UNKNOWN_SANDBOX_UPDATE, null),
        };
      }
      if (project.state !== 'active') {
        return { code: 409, error: `project ${id} is ${project.state}` };
      }
      try {
        const slept = await deps.provisioner.sleepProject(id);
        return {
          code: 200,
          project: presentProject(slept, null, UNKNOWN_SANDBOX_UPDATE, null),
        };
      } catch (error) {
        request.log.error({ err: error, projectId: id }, 'verity: project sleep failed');
        throw error;
      }
    },
    wake: async (request, id) => {
      if (deps.provisioner?.wakeProject === undefined) {
        return { code: 503, error: 'project wake is not configured' };
      }
      const project = await deps.eventStore.getProject(id);
      if (project === undefined || project.hiddenAt !== null) {
        return { code: 404, error: `project ${id} not found` };
      }
      if (
        project.state === 'active' ||
        (project.state === 'waking' && deps.provisioner.ensureProjectSandboxAwake)
      ) {
        // An explicit wake takes ownership from a temporary background scan, also while
        // that scan's own wake is still in flight: it joins the wake and marks activity,
        // so the scan does not put the sandbox back to sleep afterwards.
        try {
          if (project.state === 'active') {
            // Only the activity mark matters here, which a scan lease reads as takeover;
            // the readiness gate is not needed for a sandbox that is already running.
            const acquired = deps.provisioner.tryBeginProjectSandboxActivity?.(id);
            if (acquired === false)
              return { code: 409, error: `project ${id} has a sandbox mutation in progress` };
            if (acquired) deps.provisioner.endProjectSandboxActivity?.(id);
            return {
              code: 200,
              project: presentProject(project, null, UNKNOWN_SANDBOX_UPDATE, null),
            };
          }
          const awake = (await deps.provisioner.ensureProjectSandboxAwake?.(id)) ?? project;
          return {
            code: 200,
            project: presentProject(awake, null, UNKNOWN_SANDBOX_UPDATE, null),
          };
        } catch (error) {
          // A row left in `waking` without a wake in flight (after a restart) stays a conflict.
          if (project.state === 'waking' && error instanceof ProvisioningError)
            return { code: 409, error: `project ${id} is ${project.state}` };
          request.log.error({ err: error, projectId: id }, 'verity: project wake failed');
          throw error;
        }
      }
      if (project.state !== 'sleeping') {
        return { code: 409, error: `project ${id} is ${project.state}` };
      }
      try {
        const awake = await deps.provisioner.wakeProject(id);
        return {
          code: 200,
          project: presentProject(awake, null, UNKNOWN_SANDBOX_UPDATE, null),
        };
      } catch (error) {
        request.log.error({ err: error, projectId: id }, 'verity: project wake failed');
        throw error;
      }
    },
  });

  registerProjectVerityControlRoutes(app, {
    canRefreshToken: () => deps.refreshProjectToken !== undefined,
    refreshToken: async (_request, reply, id) => {
      const project = await deps.eventStore.getProject(id);
      if (project === undefined) {
        reply.code(404);
        return { error: `project ${id} not found` };
      }
      await deps.refreshProjectToken!(project);
      return { projectId: project.id, refreshedAt: new Date().toISOString() };
    },
    canRecreateContainer: () => deps.provisioner?.recreateContainer !== undefined,
    recreateContainer: async (request, reply, id) => {
      const provisioner = deps.provisioner!;
      const recreateContainer = provisioner.recreateContainer!.bind(provisioner);
      const project = await deps.eventStore.getProject(id);
      // Hidden = soft-deleted: recreate must not resurrect it (mirrors /repair).
      if (project === undefined || project.hiddenAt !== null) {
        reply.code(404);
        return { error: `project ${id} not found` };
      }
      if (project.state === 'absent') {
        reply.code(409);
        return { error: `project ${id} is absent; provision it instead` };
      }
      if (project.state === 'cloning' || project.state === 'container_starting') {
        reply.code(409);
        return { error: `project ${id} is already provisioning` };
      }
      // SBX-1: refuse to recreate a sandbox with a turn in flight — recreate
      // stops+removes the container and would kill the running docker-exec agent
      // mid-turn. Operator cancels or waits, then retries.
      const activity = activityReasons(await projectActivity(id));
      if (activity.length > 0) {
        reply.code(409);
        return { error: recreateRefusalMessage(id, activity) };
      }
      const body = parseRecreateContainerBody(request.body);
      let updated: ProjectRecord;
      try {
        updated = await recreateContainer(project.id, {
          confirmWarnings: body?.confirmWarnings === true,
          forceRebuild: body?.forceRebuild === true,
          initiator: { kind: 'user', userId: request.localUserId },
        });
        await afterProjectProvision(project.id);
      } catch (error) {
        if (error instanceof ProvisioningWarning) {
          reply.code(409);
          return { requiresConfirmation: true, warnings: error.warnings };
        }
        if (error instanceof ProvisioningError) {
          reply.code(409);
          return { error: error.message };
        }
        throw error;
      }
      return { project: updated };
    },
  });

  /** The "connect later" bridge for a project created without GitHub. The target
   *  must be an EXISTING repository the App installation can reach — Verity does
   *  not create repositories. The provisioner merges an existing default branch
   *  before its plain (non-forced) push. */
  /** The linked project, plus how its history reached GitHub — an empty target takes
   *  it directly, a target with history gets a branch and the pull request that
   *  carries it in, which the operator still has to merge. */
  type LinkGitHubResponse = { project: ProjectRecord } & LinkCloneToGitHubResult;
  registerProjectGitHubLinkRoute(app, {
    isAvailable: () => deps.provisioner?.linkCloneToGitHub !== undefined,
    link: async (request, reply, id, repository, connectionId) => {
      const provisioner = deps.provisioner!;
      const project = await deps.eventStore.getProject(id);
      if (project === undefined || project.hiddenAt !== null) {
        reply.code(404);
        return { error: `project ${id} not found` };
      }
      if (!isLocalProject(project)) {
        reply.code(409);
        return { error: 'this project is already backed by a GitHub repository' };
      }
      let parsedTarget = parseOwnerRepo(repository);
      if (connectionId) {
        const connection = await deps.eventStore.forgeConnections.get(connectionId);
        if (connection?.provider === 'forgejo')
          parsedTarget = parseForgejoRepository(repository, connection.baseUrl);
      }
      if (parsedTarget === undefined || parsedTarget.owner === LOCAL_PROJECT_OWNER) {
        reply.code(400);
        return { error: 'invalid repository' };
      }
      const target: {
        owner: string;
        repo: string;
        forgeConnectionId?: string | null;
        kind?: 'github' | 'forgejo';
      } = { ...parsedTarget };
      if (connectionId) {
        if (
          !request.localUserId ||
          !(await deps.eventStore.isActiveAdministrator(request.localUserId))
        )
          return reply.code(403).send({ error: 'administrator required' });
        const connection = await deps.eventStore.forgeConnections.get(connectionId);
        if (!connection) return reply.code(404).send({ error: 'connection not found' });
        if (connection.provider === 'github' && connection.id !== 'legacy-github')
          return reply
            .code(400)
            .send({ error: 'only the existing GitHub App connection is supported' });
        if (connection.provider === 'forgejo' && !deps.forgejoEnabled)
          return reply.code(503).send({ error: 'Forgejo sandbox integration unavailable' });
        target.forgeConnectionId = connection.id;
        target.kind = connection.provider;
      }
      // The repository may already back other projects: the reservation below
      // either adopts its installation placeholder or reserves another instance
      // of it, so this project stays separate from every existing one.
      const performLink = async (): Promise<LinkGitHubResponse | { error: string }> => {
        // Scoped to the TARGET repo, not the project's current (local) identity.
        const token = await deps.ghTokenMint?.(target);
        if (token === undefined || token.length === 0) {
          reply.code(503);
          return { error: 'GitHub authentication is unavailable for this repository' };
        }
        const reserved = await deps.eventStore.reserveProjectIdentity(project.id, target);
        if (!reserved) {
          reply.code(409);
          return { error: `${target.owner}/${target.repo} is already registered as a project` };
        }
        // Publish first while the persisted project remains local. If the
        // process stops here, a retry can recognize the identical remote branch
        // and finish the DB transition; it never strands a false GitHub identity.
        let published: LinkCloneToGitHubResult;
        try {
          published = await provisioner.linkCloneToGitHub!(project, target, token);
        } catch (error) {
          // An ambiguous push may already have updated GitHub, so retain the
          // claim for this same project's idempotent retry. Every other error is
          // known to be pre-publication and releases the target immediately.
          if (!(error instanceof AmbiguousGitPushError)) {
            await deps.eventStore.releaseProjectIdentity(project.id, target);
          }
          if (error instanceof ProvisioningError) {
            // The message the operator sees names the STEP; git's own explanation
            // rides along as the cause and is the only thing that says WHY. It is
            // already redacted of the token, so log it rather than dropping it —
            // without it a rejected push is indistinguishable from a broken one.
            request.log.warn(
              {
                projectId: project.id,
                target: `${target.owner}/${target.repo}`,
                err: error.cause ?? error,
              },
              'verity: linking a project to GitHub failed',
            );
            reply.code(409);
            return {
              error:
                error.cause instanceof Error
                  ? `${error.message}: ${error.cause.message}${/signature|GH013|verified/i.test(error.cause.message) ? '. Configure a Git signing key and verified Git email; existing history is retained. If existing commits are unsigned, choose a target that accepts them or resolve the repository policy before retrying.' : ''}`
                  : error.message,
            };
          }
          throw error;
        }
        let linked: ProjectRecord | undefined;
        try {
          if (published.defaultBranch)
            await deps.eventStore.updateProjectSettings(project.id, {
              defaultBranch: published.defaultBranch,
            });
          linked = await deps.eventStore.linkProjectToGitHub(project.id, target);
        } catch (error) {
          // Publication is already externally visible. Retain the durable claim
          // for this project and turn every persistence failure into the same
          // idempotent recovery response; throwing a generic 500 here would hide
          // the fact that retrying safely completes the local transition.
          request.log.warn(
            { projectId: project.id, err: error },
            'GitHub publication succeeded but project finalization is pending',
          );
          reply.code(409);
          return {
            error: 'the repository was published but linking was not finalized; retry to finish',
          };
        }
        if (linked === undefined) {
          reply.code(409);
          return { error: 'this project is already being linked' };
        }
        // Best-effort: the clone and its worktrees are already correct, so a failed
        // recreate is a stale-sandbox problem the operator can Repair — not a reason
        // to report the link itself as failed.
        if (linked.state !== 'absent' && provisioner.recreateContainer) {
          try {
            await provisioner.recreateContainer(linked.id, {
              confirmWarnings: true,
              initiator: { kind: 'user', userId: request.localUserId },
            });
            await afterProjectProvision(linked.id);
          } catch (error) {
            app.log.warn(
              { projectId: linked.id, err: error },
              'verity: linked project to GitHub but recreating its sandbox failed',
            );
          }
        }
        return {
          project: (await deps.eventStore.getProject(linked.id)) ?? linked,
          // How the history reached GitHub. Absent for an empty target (it went
          // straight onto the default branch); otherwise the operator still has a
          // pull request to merge, and needs to be told so.
          ...(published.importBranch === undefined ? {} : { importBranch: published.importBranch }),
          ...(published.pullRequest === undefined ? {} : { pullRequest: published.pullRequest }),
          ...(published.pullRequestError === undefined
            ? {}
            : { pullRequestError: published.pullRequestError }),
        };
      };
      const localIdentityKey = `${project.owner}/${project.repo}`;
      if (localIdentityLinkReservations.has(localIdentityKey)) {
        reply.code(409);
        return { error: 'this project is already being linked' };
      }
      const reservation = Symbol(localIdentityKey);
      localIdentityLinkReservations.set(localIdentityKey, reservation);
      const targetKey = `${target.forgeConnectionId && target.forgeConnectionId !== 'legacy-github' ? `${target.forgeConnectionId}:` : ''}${target.owner}/${target.repo}`;
      if (githubTargetLinkReservations.has(targetKey)) {
        localIdentityLinkReservations.delete(localIdentityKey);
        reply.code(409);
        return { error: `${targetKey} is currently being linked` };
      }
      githubTargetLinkReservations.set(targetKey, reservation);
      try {
        // The barrier is installed before the second busy check and remains
        // through identity reservation, remote mutation, push, and recreate.
        // New turns wait; existing turns make the mutation fail cleanly.
        return provisioner.withProjectExclusiveMutation
          ? await provisioner.withProjectExclusiveMutation(id, performLink)
          : await performLink();
      } catch (error) {
        if (error instanceof ProvisioningError) {
          reply.code(409);
          return { error: `${error.message} — cancel it or wait, then link` };
        }
        throw error;
      } finally {
        if (localIdentityLinkReservations.get(localIdentityKey) === reservation) {
          localIdentityLinkReservations.delete(localIdentityKey);
        }
        if (githubTargetLinkReservations.get(targetKey) === reservation) {
          githubTargetLinkReservations.delete(targetKey);
        }
      }
    },
  });

  app.post('/projects/:id/disconnect-github', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const project = await deps.eventStore.getProject(id);
    if (!project || project.hiddenAt !== null)
      return reply.code(404).send({ error: 'Project not found' });
    if (!['github', 'local'].includes(project.kind ?? 'github'))
      return reply.code(409).send({ error: 'Only GitHub projects can be disconnected.' });
    const provisioner = deps.provisioner;
    if (!provisioner?.disconnectGitHub || !provisioner.withProjectExclusiveMutation)
      return reply.code(503).send({ error: 'GitHub disconnection is unavailable.' });
    try {
      const local = await provisioner.withProjectExclusiveMutation(id, () =>
        provisioner.disconnectGitHub!(project),
      );
      await afterProjectProvision(local.id);
      return { project: local };
    } catch (error) {
      if (error instanceof ProvisioningError) return reply.code(409).send({ error: error.message });
      request.log.warn({ err: error, projectId: id }, 'GitHub disconnection failed');
      return reply.code(409).send({
        error:
          'Could not disconnect GitHub. Local files and history were retained; retry or repair the Sandbox.',
      });
    }
  });

  return { advancedModeEnabled, ensureVerityControlProject };
}
