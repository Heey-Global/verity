import type { ProjectRecord, ProjectState } from '@verity/store';
import { PROJECT_IMAGE_REBUILDING_WARNING } from '@verity/events';

import { DockerError, type DockerClient } from './docker.js';

export type UpdateProjectState = (
  id: string,
  state: ProjectState,
  provisionError?: string | null,
  provisionWarning?: string | null,
) => Promise<ProjectRecord | undefined>;

/**
 * Reconcile stable project states with Docker's current container truth.
 * Provisioning states are worker-owned, so this deliberately avoids touching
 * `cloning` and `container_starting`.
 *
 * A live project whose container has stopped or vanished is demoted to
 * `failed` (VISIBLE + repairable), NEVER to `absent`. `absent` means "this repo
 * is not provisioned as a project" and HIDES the row from `GET /projects` — so
 * demoting to `absent` here would make a project silently disappear ("unknown
 * project" for any session pinned to it) after a transient container blip (e.g.
 * a server redeploy). `absent` is reserved for an explicit operator deprovision.
 * The `failed` row stays visible with a Repair action, and the running-container
 * branch below heals it straight back to `active` once the container returns.
 */
export async function reconcileProjectContainerStates(
  projects: ProjectRecord[],
  docker: DockerClient,
  updateProjectState: UpdateProjectState,
  isProjectProvisioning: (projectId: string) => boolean = () => false,
): Promise<ProjectRecord[]> {
  return Promise.all(
    projects.map((project) =>
      reconcileProject(project, docker, updateProjectState, isProjectProvisioning),
    ),
  );
}

/** Reason strings surfaced as the project's `provision_error` when a live
 *  project's container is no longer running — user-facing in the app. */
export const CONTAINER_STOPPED_REASON = 'Sandbox container stopped — Repair to restart it.';
export const CONTAINER_MISSING_REASON = 'Sandbox container is missing — Repair to recreate it.';
export const STALE_PROVISIONING_REASON =
  'Project setup did not finish and no Sandbox container is running — Repair to retry it.';
/** Docker keeps a crash-looping container in `restarting`, which can report
 *  `Running: true`. Naming it separately is what tells the
 *  operator the sandbox is failing to come up rather than sitting stopped. */
export const CONTAINER_RESTARTING_REASON =
  'Sandbox container keeps restarting — Repair to recreate it.';
/** A `docker pause`d container can also report `Running: true`; it is frozen, not gone. */
export const CONTAINER_PAUSED_REASON = 'Sandbox container is paused — Repair to resume it.';
const DEFAULT_PROVISIONING_STALE_MS = 2 * 60_000;

/** Return the reason when Docker's combined status says the container is unusable. */
function stoppedReason(running: boolean, status: string | undefined): string | undefined {
  if (status === 'restarting') return CONTAINER_RESTARTING_REASON;
  if (status === 'paused') return CONTAINER_PAUSED_REASON;
  return running ? undefined : CONTAINER_STOPPED_REASON;
}

async function reconcileProject(
  project: ProjectRecord,
  docker: DockerClient,
  updateProjectState: UpdateProjectState,
  isProjectProvisioning: (projectId: string) => boolean,
): Promise<ProjectRecord> {
  if (project.kind === 'control_plane') return project;

  if (project.state === 'cloning' || project.state === 'container_starting') {
    // Age off `stateChangedAt`, NOT `updatedAt`. Every writer that touches the
    // row bumps `updated_at` — including the GitHub installation sync, which
    // deliberately preserves `state` and runs on a cadence shorter than this
    // grace period. Measured against it the window never elapsed: a project
    // whose container start failed sat in `container_starting` forever, skipped
    // by the relay reconciler (which only considers `active` projects) and never
    // demoted to `failed`, so the app showed a permanent "starting…" with no
    // Repair action.
    const ageMs = Date.now() - project.stateChangedAt.getTime();
    if (ageMs < DEFAULT_PROVISIONING_STALE_MS) return project;
  }

  try {
    const inspect = await docker.inspectContainer(project.containerName);
    // Status must win over `Running`: Docker reports true for paused containers
    // and may do so while a restart is in progress.
    const containerFailure = stoppedReason(inspect.running, inspect.status);
    if (containerFailure) {
      if (
        project.state === 'active' ||
        project.state === 'cloning' ||
        project.state === 'container_starting'
      ) {
        return (await updateProjectState(project.id, 'failed', containerFailure)) ?? project;
      }
      return project;
    }
    if (inspect.running) {
      if (project.state === 'active') {
        // A cacheless rebuild keeps the old container serving and records this
        // durable notice for clients recovering from a dropped request. The
        // build itself is process-local, though, so after a server restart no
        // operation remains to clear the notice. Reconciliation removes that
        // orphan while preserving it for a build this process still owns.
        if (
          project.provisionWarning === PROJECT_IMAGE_REBUILDING_WARNING &&
          !isProjectProvisioning(project.id)
        ) {
          return (await updateProjectState(project.id, 'active', null, null)) ?? project;
        }
        return project;
      }
      // Container is back (or never left) → self-heal to active, clearing any
      // prior failure reason. This is what recovers a project after its sandbox
      // restarts (unless-stopped) following a reboot/redeploy.
      return (await updateProjectState(project.id, 'active', null)) ?? project;
    }
    return project;
  } catch (error) {
    if (
      error instanceof DockerError &&
      error.kind === 'container_not_found' &&
      (project.state === 'active' ||
        project.state === 'cloning' ||
        project.state === 'container_starting')
    ) {
      // Container removed or never created after a stale provisioning transition
      // → `failed`, not `absent`. Only an explicit deprovision should ever move a
      // project to `absent`.
      const reason =
        project.state === 'active' ? CONTAINER_MISSING_REASON : STALE_PROVISIONING_REASON;
      return (await updateProjectState(project.id, 'failed', reason)) ?? project;
    }
    return project;
  }
}
