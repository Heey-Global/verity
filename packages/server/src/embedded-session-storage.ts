import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { EventStore } from '@verity/store';
import type { EmbeddedServerConfig } from './embedded-types.js';
import { SessionStorage } from './session-storage.js';
import { sessionStorageAccess } from './session-storage-access.js';
import { RunnerCacheStorage } from './runner-cache-storage.js';
import {
  RunnerCacheMaintenance,
  reclaimSleepingRunnerCaches,
  cacheMaintenanceFailure,
} from './runner-cache-maintenance.js';
import { MaintenanceImageError } from './maintenance-image.js';
import { projectClonePath, type ProvisionerImpl } from './provisioner.js';
import { PROJECT_RUNSC_RUNTIME } from './gvisor-runtime-config.js';
import { requestRunnerSupervisor } from '@verity/session';
import { candidateRunnerProjectIds, CONTROL_PLANE_RUNNER_PROJECT_ID } from './embedded-support.js';

type Access = Parameters<typeof sessionStorageAccess>[0];
export function createEmbeddedSessionStorage(ctx: {
  log: () => FastifyInstance['log'];
  config: Pick<
    EmbeddedServerConfig,
    | 'hostCloneRoot'
    | 'dockerBaseUrl'
    | 'dataVolume'
    | 'runnerSupervisor'
    | 'runnerSupervisorTrustedDefaultImage'
    | 'runnerRuntimeGid'
    | 'runnerCacheMaxBytes'
    | 'controlPlaneRunner'
  >;
  eventStore: EventStore;
  projectDocker: Access['docker'] | undefined;
  provisioner: ProvisionerImpl | undefined;
  withStorageProjectMutation: Access['withStorageProjectMutation'];
  devServers: Access['devServers'];
  localPreviewManager: Access['localPreviews'];
  preparedWorktreeImages: Access['preparedWorktreeImages'];
  defaultProjectImage: Access['defaultProjectImage'];
  maintenanceImages: Access['maintenanceImages'];
  cachedProjectTokenMint: Access['projectTokenMint'];
  dataVolumeRoot: string | undefined;
  readProjectStatus: ConstructorParameters<typeof SessionStorage>[0]['pr'];
}) {
  const {
    config,
    eventStore,
    projectDocker,
    provisioner,
    withStorageProjectMutation,
    localPreviewManager,
    preparedWorktreeImages,
    defaultProjectImage,
    maintenanceImages,
    cachedProjectTokenMint,
    dataVolumeRoot,
    readProjectStatus,
  } = ctx;
  const sessionStorage =
    config.hostCloneRoot && projectDocker && provisioner?.withProjectExclusiveMutation
      ? new SessionStorage({
          gitRoot: '/work',
          log: (summary) => ctx.log().info(summary, 'session storage pass complete'),
          listProjects: () => eventStore.listProjects(),
          listSessions: () => eventStore.listSessions(),
          activity: async (id) =>
            (await eventStore.listSessionProjectionFacts([id], 0)).get(id)?.lastActivityAt ?? null,
          root: (project) => projectClonePath(config.hostCloneRoot!, project),
          ...sessionStorageAccess({
            store: eventStore,
            docker: projectDocker,
            provisioner,
            withStorageProjectMutation,
            devServers: ctx.devServers,
            localPreviews: localPreviewManager,
            preparedWorktreeImages,
            defaultProjectImage,
            maintenanceImages,
            projectTokenMint: cachedProjectTokenMint,
            hostCloneRoot: config.hostCloneRoot,
            dockerBaseUrl: config.dockerBaseUrl!,
            dataVolume: config.dataVolume,
            dataVolumeRoot,
          }),
          wake: async (project, sessionId) => {
            if (project.state === 'sleeping')
              await provisioner.ensureProjectSandboxAwake?.(project.id, new Set([sessionId]));
          },
          pr: (project, branch) => readProjectStatus(project, branch),
        })
      : undefined;
  const runnerCacheMaintenance = new RunnerCacheMaintenance({
    request: (projectId, request) =>
      requestRunnerSupervisor(
        join(dataVolumeRoot!, 'runners', projectId, 'supervisor.sock'),
        request,
        30_000,
      ),
    resolveOwners: (input) => eventStore.resolveRunnerTurnOwnership(input),
    offline: async (projectId, sessionIds, maxBytes) => {
      if (
        !projectDocker ||
        !dataVolumeRoot ||
        !provisioner?.withProjectExclusiveMutation ||
        config.runnerSupervisor !== true ||
        config.runnerSupervisorTrustedDefaultImage !== true ||
        projectId === CONTROL_PLANE_RUNNER_PROJECT_ID
      )
        throw cacheMaintenanceFailure('runtime-not-idle');
      const project = await eventStore.getProject(projectId);
      if (project?.state !== 'sleeping' || project.imageOverrideRef)
        throw cacheMaintenanceFailure('runtime-not-idle');
      const selected =
        typeof defaultProjectImage === 'function'
          ? await defaultProjectImage()
          : defaultProjectImage;
      if (!selected || !maintenanceImages) throw new MaintenanceImageError('image-unavailable');
      return maintenanceImages.withImage(selected, (image, recheck) =>
        provisioner.withProjectExclusiveMutation(projectId, () =>
          withStorageProjectMutation(projectId, async () => {
            const assertIdle = async () => {
              const project = await eventStore.getProject(projectId);
              if (
                project?.state !== 'sleeping' ||
                project.imageOverrideRef ||
                ctx.devServers()?.hasRunningServers(projectId) ||
                ctx.devServers()?.hasUnverifiedServers(projectId) ||
                (localPreviewManager?.listProject(projectId).length ?? 0) > 0 ||
                (await eventStore.listPublicPreviewShares(projectId)).some((share) =>
                  ['creating', 'active', 'revoking'].includes(share.state),
                )
              )
                throw cacheMaintenanceFailure('runtime-not-idle');
              const sessions = new Set(
                (await eventStore.listSessions())
                  .filter((session) => session.projectId === projectId)
                  .map((session) => session.sessionId),
              );
              if (sessions.size !== sessionIds.length || sessionIds.some((id) => !sessions.has(id)))
                throw cacheMaintenanceFailure('runtime-not-idle');
              if (
                (await eventStore.listRunningTurns()).some((turn) => sessions.has(turn.sessionId))
              )
                throw cacheMaintenanceFailure('runtime-not-idle');
            };
            await assertIdle();
            await recheck();
            const self = await projectDocker.inspectContainer(hostname());
            return reclaimSleepingRunnerCaches({
              docker: projectDocker,
              projectId,
              runtimeRoot: join(dataVolumeRoot, 'runners', projectId),
              image: image.id,
              runtime: PROJECT_RUNSC_RUNTIME,
              serverContainerId: self.id,
              runtimeGid: config.runnerRuntimeGid ?? 1101,
              ...(config.dataVolume
                ? { dataVolume: { name: config.dataVolume, root: dataVolumeRoot } }
                : {}),
              sessionIds,
              maxBytes,
              assertIdle,
            });
          }),
        ),
      );
    },
  });
  const runnerCacheStorage =
    dataVolumeRoot === undefined
      ? undefined
      : new RunnerCacheStorage({
          onFailure: (failure) =>
            ctx.log().warn(failure, 'Runner cache maintenance failed; unverified caches retained'),
          ...(config.runnerCacheMaxBytes !== undefined
            ? { maxBytes: config.runnerCacheMaxBytes }
            : {}),
          listRuntimes: async () => {
            const projects = await eventStore.listProjects();
            const sessions = await eventStore.listSessions();
            const runtimes = new Map<string, Set<string>>();
            for (const project of projects) runtimes.set(project.id, new Set());
            if (config.controlPlaneRunner) runtimes.set(CONTROL_PLANE_RUNNER_PROJECT_ID, new Set());
            for (const session of sessions) {
              for (const id of candidateRunnerProjectIds({
                projectId: session.projectId,
                isControlPlaneProject: projects.some(
                  (p) => p.id === session.projectId && p.kind === 'control_plane',
                ),
                controlPlaneRunner: config.controlPlaneRunner === true,
              }))
                runtimes.get(id)?.add(session.sessionId);
            }
            // Do not wake sleeping sandboxes or infer deleted sessions from directory names.
            return [...runtimes]
              .filter(([id]) => existsSync(join(dataVolumeRoot, 'runners', id)))
              .map(([projectId, ids]) => ({ projectId, sessionIds: [...ids] }));
          },
          request: (projectId, sessionIds, maxBytes) =>
            runnerCacheMaintenance.request(projectId, sessionIds, maxBytes),
        });
  return { sessionStorage, runnerCacheStorage };
}
