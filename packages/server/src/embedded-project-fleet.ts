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
import { createProjectListCache, type ProjectListCache } from './project-list-cache.js';
import { reconcileProjectContainerStates } from './project-state.js';

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
  const { eventStore, installationService, docker, provisioner } = ctx;
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
            const reconciled =
              docker !== undefined
                ? reconcileProjectContainerStates(
                    projects,
                    docker,
                    (id, state, provisionError, provisionWarning) =>
                      eventStore.updateProjectState(id, state, provisionError, provisionWarning),
                    (id) => provisioner?.isProjectProvisioning(id) === true,
                    // A list poll can land after wake persisted `waking` but before
                    // Docker starts the retained container. Give reconciliation the
                    // same recovery hooks as the detail route: an in-process wake
                    // owns the mutation barrier, so recovery declines and the
                    // reconciler preserves `waking` instead of publishing a
                    // momentary, operator-actionable `failed` state.
                    provisioner?.recoverInterruptedSleep?.bind(provisioner),
                    provisioner?.recoverInterruptedWake?.bind(provisioner),
                  )
                : projects;
            const result = await reconciled;
            return result;
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
> {
  const {
    eventStore,
    installationService,
    docker,
    provisioner,
    projectList,
    hasMasterPassword,
    secretCipher,
    refreshProjectToken,
  } = ctx;
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
    // sync and no list cache, just one container inspect — so detail stays correct
    // while the installation sync is degraded, and a sandbox that died is visible
    // the moment the screen loads instead of after the next overview poll.
    ...(docker !== undefined
      ? {
          reconcileProjectState: async (project: ProjectRecord) => {
            const [reconciled] = await reconcileProjectContainerStates(
              [project],
              docker,
              (id, state, provisionError, provisionWarning) =>
                eventStore.updateProjectState(id, state, provisionError, provisionWarning),
              (id) => provisioner?.isProjectProvisioning(id) === true,
              provisioner?.recoverInterruptedSleep?.bind(provisioner),
              provisioner?.recoverInterruptedWake?.bind(provisioner),
            );
            return reconciled ?? project;
          },
        }
      : {}),
  };
}
