import type { FastifyInstance } from 'fastify';
import type { EventStore } from '@verity/store';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { DockerClient } from './docker.js';
import type { ProvisionerImpl } from './provisioner.js';
import type { ManagedDevServerManager } from './managed-dev-server-manager.js';
import type { LocalPreviewManager } from './local-preview-manager.js';
import type { ProjectRelayLifecycle } from './project-relay-lifecycle.js';
import type { BuildStorage } from './build-storage.js';
import type { DataVolumeUsage } from './data-volume-usage.js';
import type { createEmbeddedSessionStorage } from './embedded-session-storage.js';
import type { createEmbeddedPreviewMutations } from './embedded-preview-mutations.js';
import type { createProjectImageReferences } from './derived-image-references.js';
import type { createAuditRecorder } from './audit-recorder.js';
import { StorageReclamation, requestNativeReclamation } from './storage-reclamation.js';
import { registerStorageReclamationRoutes } from './storage-reclamation-routes.js';
import {
  retireStoppedContainers,
  boundedContainerRetirement,
  retireCompletedUpdateContainers,
} from './stopped-container-gc.js';
import {
  describeBuildCapacityReclamation,
  startDockerGcScheduler,
  type DockerGcReport,
} from './docker-gc.js';

type SessionStorage = ReturnType<typeof createEmbeddedSessionStorage>;

export function installEmbeddedDockerGc(
  app: FastifyInstance,
  ctx: {
    config: Pick<EmbeddedServerConfig, 'dockerGc' | 'dockerGcPolicy' | 'dataVolumeRoot'>;
    projectDocker: DockerClient | undefined;
    eventStore: EventStore;
    provisioner: ProvisionerImpl | undefined;
    withStorageProjectMutation: ReturnType<
      typeof createEmbeddedPreviewMutations
    >['withStorageProjectMutation'];
    managedDevServerManager: ManagedDevServerManager | undefined;
    localPreviewManager: LocalPreviewManager | undefined;
    getProjectRelayLifecycle: () => ProjectRelayLifecycle | undefined;
    runnerCacheStorage: SessionStorage['runnerCacheStorage'];
    sessionStorage: SessionStorage['sessionStorage'];
    volumeUsage: DataVolumeUsage | undefined;
    imageReferences: ReturnType<typeof createProjectImageReferences>;
    auditRecorder: Pick<ReturnType<typeof createAuditRecorder>, 'imageRemoved'>;
    buildStorage: BuildStorage | undefined;
    onReport: (report: DockerGcReport) => void;
  },
) {
  const {
    config,
    projectDocker,
    eventStore,
    provisioner,
    withStorageProjectMutation,
    managedDevServerManager,
    localPreviewManager,
    getProjectRelayLifecycle,
    runnerCacheStorage,
    sessionStorage,
    volumeUsage,
    imageReferences,
    auditRecorder,
    buildStorage,
    onReport,
  } = ctx;
  let storageReclamation: StorageReclamation | undefined;

  // Host-disk GC (docker-gc.ts). Wired off `projectDocker` because that is the
  // client that CREATES the resources it collects — the devcontainer image cache
  // in `resolveOrBuildImage` and the sandbox containers whose anonymous volumes
  // can outlive them. Without this the runner's two append-only caches grow until
  // the disk is full; `docker system prune` does not reach either (the image tags
  // are tagged, not dangling, and prune skips volumes entirely).
  if (projectDocker !== undefined && config.dockerGc !== false) {
    let nativeMaintenanceRequested: string | null = null;
    let cacheHelperProjectOffset = 0;
    const retireProjectContainers = async (cacheHelpersOnly: boolean, capacityOnly = false) => {
      const removed =
        cacheHelpersOnly || capacityOnly
          ? []
          : await retireCompletedUpdateContainers(projectDocker);
      if (!provisioner?.withProjectExclusiveMutation) return { removed, errors: [] };
      const result = await retireStoppedContainers({
        docker: projectDocker,
        ...(cacheHelpersOnly || capacityOnly
          ? boundedContainerRetirement(cacheHelpersOnly, cacheHelperProjectOffset)
          : {}),
        listProjects: () => eventStore.listProjects(),
        withProjectMutation: (id, run) =>
          provisioner.withProjectExclusiveMutation(id, () =>
            withStorageProjectMutation(
              id,
              async () => {
                if (
                  managedDevServerManager?.hasRunningServers(id) ||
                  managedDevServerManager?.hasUnverifiedServers(id)
                )
                  throw new Error('Managed dev server is active');
                if (
                  (localPreviewManager?.listProject(id).length ?? 0) > 0 ||
                  (await eventStore.listPublicPreviewShares(id)).some((s) =>
                    ['creating', 'active', 'revoking'].includes(s.state),
                  )
                )
                  throw new Error('Preview is active');
                await run();
              },
              { waitForIdle: !cacheHelpersOnly && !capacityOnly },
            ),
          ),
      });
      if (cacheHelpersOnly || capacityOnly) cacheHelperProjectOffset += 8;
      return {
        removed: [...removed, ...result.removed],
        errors: result.errors,
        retained: result.retained,
      };
    };
    const dockerGc = startDockerGcScheduler({
      docker: projectDocker,
      log: app.log,
      ...(config.dockerGcPolicy !== undefined ? { policy: config.dockerGcPolicy } : {}),
      ...(config.dataVolumeRoot !== undefined ? { dataRoot: config.dataVolumeRoot } : {}),
      // Read through the `let` on every pass, not captured once: the lifecycle is
      // constructed below this block, and its held set changes with every
      // provision. This is what keeps the sweep off a relay whose sandbox has not
      // been created yet — neither the listing nor elapsed time can see that.
      heldRelays: () => getProjectRelayLifecycle()?.heldRelays() ?? [],
      beforeSweep: async () => {
        nativeMaintenanceRequested = null;
        await requestNativeReclamation()
          .then((requestedAt) => {
            nativeMaintenanceRequested = requestedAt;
          })
          .catch(() => undefined);
        await runnerCacheStorage?.runOnce();
        await sessionStorage?.runOnce();
        await volumeUsage?.runOnce();
      },
      describeCapacity: () => volumeUsage?.describe() ?? '',
      onReport: (report) => {
        report.nativeRequestedAt = nativeMaintenanceRequested;
        onReport(report);
      },
      retireContainers: () => retireProjectContainers(false),
      retireCacheHelpers: () => retireProjectContainers(true),
      retireCapacityContainers: () => retireProjectContainers(false, true),
      imageReferences,
      onProjectImageRemoved: (image) =>
        auditRecorder.imageRemoved({ imageRef: image.ref, imageId: image.imageId }),
    });
    storageReclamation = new StorageReclamation({
      collect: () => dockerGc.runOnce(),
      worktrees: () => sessionStorage?.lastReport,
      runnerCaches: () => runnerCacheStorage?.lastReport,
      dataRoot: config.dataVolumeRoot,
    });
    // A waiting build runs only the capacity steps, never the full maintenance
    // pass: that pass first works through runner caches and session worktrees,
    // which alone outlasted the build's reclamation deadline.
    buildStorage?.setReclaimer(async () =>
      describeBuildCapacityReclamation(await dockerGc.reclaimBuildCapacity()),
    );
    buildStorage?.setCapacityDescriber((short) => volumeUsage?.describe(short) ?? '');
    app.addHook('onClose', async () => {
      dockerGc.stop();
      await volumeUsage?.stop();
    });
  }
  registerStorageReclamationRoutes(app, eventStore, storageReclamation);
}
