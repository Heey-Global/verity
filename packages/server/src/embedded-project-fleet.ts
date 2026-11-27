import {
  SealedError,
  type EventStore,
  type ProjectRecord,
  type SealableSecretCipher,
} from '@verity/store';
import type { ServerDeps } from './server-deps.js';
import type { ProvisionerImpl } from './provisioner.js';
import { syncProjectsFromInstallation } from './embedded-support.js';
import { reconcileGitHubRepository } from './github-repository-rename.js';
import { createContainerLiveness, type ContainerLiveness } from './container-liveness.js';
import { createProjectListCache, type ProjectListCache } from './project-list-cache.js';
import type { reconcileProjectContainerStates } from './project-state.js';

type FleetContext = {
  eventStore: EventStore;
  installationService: Parameters<typeof syncProjectsFromInstallation>[1] | undefined;
  docker: Parameters<typeof reconcileProjectContainerStates>[1] | undefined;
  provisioner:
    | Pick<
        ProvisionerImpl,
        | 'isProjectProvisioning'
        | 'recoverInterruptedSleep'
        | 'recoverInterruptedWake'
        | 'syncProjectCheckout'
      >
    | undefined;
};

/** One per server: the list cache and the detail route share whether Docker's
 * event stream is open. */
const livenessByStore = new WeakMap<
  EventStore,
  { docker: object; provisioner: object | undefined; liveness: ContainerLiveness }
>();
function livenessFor(ctx: FleetContext): ContainerLiveness | undefined {
  const { eventStore, docker, provisioner } = ctx;
  if (docker === undefined) return undefined;
  const held = livenessByStore.get(eventStore);
  // A server reopened on the same store with a new provisioner must not judge
  // its projects with the previous one's provisioning and recovery hooks.
  if (held?.docker === docker && held.provisioner === provisioner) return held.liveness;
  const liveness = createContainerLiveness({
    eventStore,
    docker,
    provisioner,
    log: { warn: (message, error) => console.warn(message, error) },
  });
  livenessByStore.set(eventStore, { docker, provisioner, liveness });
  return liveness;
}

/** Sync the installation's repositories, letting projects follow GitHub renames. */
function syncInstallation(ctx: FleetContext, includeHidden = false): Promise<ProjectRecord[]> {
  const { eventStore, installationService, provisioner } = ctx;
  if (installationService === undefined) return eventStore.listProjects({ includeHidden });
  return syncProjectsFromInstallation(eventStore, installationService, {
    includeHidden,
    reconcile: (observation) =>
      reconcileGitHubRepository(eventStore, () => provisioner, observation),
  });
}

export function createEmbeddedProjectList(ctx: FleetContext) {
  const { installationService } = ctx;
  const liveness = livenessFor(ctx);
  // Memoised fleet listing. The routes that write an operator-owned project
  // field (fold state, order, setup status) invalidate it through
  // `invalidateProjectList`, or the write would stay invisible to the overview
  // for the whole window.
  const projectList =
    installationService === undefined
      ? undefined
      : createProjectListCache(
          async () => {
            const projects = await syncInstallation(ctx);
            // While Docker's event stream is open the rows already follow the
            // containers; otherwise compare them here, as every list read did.
            // A list poll can land after wake persisted `waking` but before
            // Docker starts the retained container; the comparison has the
            // same recovery hooks as the detail route, so an in-process wake
            // keeps `waking` rather than publishing a momentary `failed`.
            return liveness === undefined || liveness.following()
              ? projects
              : liveness.reconcile(projects);
          },
          { ttlMs: 3_000 },
        );

  return projectList;
}

export function createEmbeddedProjectFleetBindings(
  ctx: FleetContext & {
    projectList: ProjectListCache | undefined;
    hasMasterPassword: boolean;
    secretCipher: Pick<SealableSecretCipher, 'isSealed'>;
    refreshProjectToken: ServerDeps['refreshProjectToken'];
  },
): Pick<
  ServerDeps,
  | 'refreshProjectToken'
  | 'listProjects'
  | 'invalidateProjectList'
  | 'listAvailableRepositories'
  | 'reconcileProjectState'
  | 'containerLiveness'
> {
  const { installationService, projectList, hasMasterPassword, secretCipher, refreshProjectToken } =
    ctx;
  const liveness = livenessFor(ctx);
  return {
    // Multi-repo fleet-registry listing (concept §19, #174). The provider syncs
    // the live GitHub-App-installation repos into the durable `projects` cache
    // (upsert preserves worker-owned state — cloning/container_starting/active/
    // failed survives a list-refresh that runs mid-provisioning) and returns the
    // cache. New repos land as `state='absent'`; Verity-self's row appears after
    // the first `GET /projects` because Verity is itself a normal installation
    // repo (§19.1).
    ...(installationService !== undefined && projectList !== undefined
      ? {
          ...(refreshProjectToken !== undefined ? { refreshProjectToken } : {}),
          listProjects: async () => {
            if (hasMasterPassword && secretCipher.isSealed()) throw new SealedError();
            return projectList.list();
          },
          invalidateProjectList: () => projectList.invalidate(),
          listAvailableRepositories: async () => {
            if (hasMasterPassword && secretCipher.isSealed()) throw new SealedError();
            return syncInstallation(ctx, true);
          },
        }
      : {}),
    // Single-project freshness for `GET /projects/:id` (the screen that owns
    // Repair). Deliberately independent of `listProjects`: no GitHub-installation
    // sync and no list cache, so detail stays correct while the installation sync
    // is degraded. While Docker's event stream is open the row already shows a
    // sandbox that died; otherwise one container inspect makes it visible the
    // moment the screen loads instead of after the next overview poll.
    ...(liveness !== undefined
      ? {
          reconcileProjectState: async (project: ProjectRecord) => {
            if (liveness.following()) return project;
            const [reconciled] = await liveness.reconcile([project]);
            return reconciled ?? project;
          },
          containerLiveness: {
            start: () => {
              // A state the event stream wrote reaches the overview at once,
              // not after the cached list expires; for as long as this server
              // follows the stream.
              const unsubscribe = projectList
                ? liveness.onStateWritten(() => projectList.invalidate())
                : () => undefined;
              const stop = liveness.start();
              return async () => {
                unsubscribe();
                await stop();
              };
            },
            following: () => liveness.following(),
            onContainerChange: (listener) => liveness.onContainerChange(listener),
          },
        }
      : {}),
  };
}
