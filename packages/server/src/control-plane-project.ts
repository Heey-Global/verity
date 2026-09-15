/**
 * The one project id the control plane runs under.
 *
 * Two names refer to it — {@link CONTROL_PLANE_RUNNER_PROJECT_ID} in `embedded.ts` for the
 * runner directory ACP turns are routed to, {@link VERITY_CONTROL_PROJECT_ID} in `server.ts`
 * for the project a control-plane session belongs to — because they answer different
 * questions. They are nevertheless the same id, and things break quietly when they are not:
 * the gateway advertises a control-plane tool by the first and authorises the caller by the
 * second, so a divergence would offer a tool that can only ever be refused after burning an
 * approval card. Both are defined from this constant so the divergence cannot happen.
 */
export const CONTROL_PLANE_PROJECT_ID = 'verity-control';
export const CONTROL_PLANE_PROJECT_OWNER = 'verity';
export const CONTROL_PLANE_PROJECT_REPO = 'control';
export const CONTROL_PLANE_PROJECT_CONTAINER = 'verity-control';

/** Persist the built-in project before any subsystem creates a row that
 * references it. The Runner identity starts during server construction, before
 * the HTTP overview has a chance to lazily materialize this project. */
export async function ensureControlPlaneProject(
  store: Pick<
    EventStore,
    'upsertProject' | 'updateProjectState' | 'setProjectSetupStatus' | 'getProject'
  >,
): Promise<ProjectRecord> {
  const project = await store.upsertProject({
    id: CONTROL_PLANE_PROJECT_ID,
    kind: 'control_plane',
    owner: CONTROL_PLANE_PROJECT_OWNER,
    repo: CONTROL_PLANE_PROJECT_REPO,
    containerName: CONTROL_PLANE_PROJECT_CONTAINER,
    state: 'active',
    overviewVisible: true,
  });
  const active =
    project.state === 'active'
      ? project
      : ((await store.updateProjectState(project.id, 'active', null)) ?? project);
  if (active.setupStatus !== 'complete') {
    await store.setProjectSetupStatus(project.id, 'complete');
    return (await store.getProject(project.id)) ?? active;
  }
  return active;
}
import type { EventStore, ProjectRecord } from '@verity/store';
