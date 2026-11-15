import type { EventStore, ProjectRecord } from '@verity/store';

import type { GitOutput } from './branches.js';
import { DockerError, type DockerClient } from './docker.js';
import { PROJECT_RUNSC_RUNTIME } from './gvisor-runtime-config.js';
import { MaintenanceImageError, type MaintenanceImages } from './maintenance-image.js';
import {
  gitAuthHeader,
  projectClonePath,
  type ProjectImageRefSource,
  type Provisioner,
} from './provisioner.js';
import { createSandboxGit, withSleepingSessionGit } from './sandbox-git.js';
import { storageHold, type SessionStorage } from './session-storage.js';

type StorageDeps = ConstructorParameters<typeof SessionStorage>[0];
type HoldInput = Parameters<typeof storageHold>[0];

/**
 * How session storage reaches a project: `mutate` runs a worktree change under the
 * project's exclusive mutation and refuses while a dev server or preview needs it,
 * starting a maintenance image for a sleeping project whose container is gone;
 * `withGit` runs Git in the running sandbox, or in a short-lived one beside a
 * sleeping project, with the project's token only on fetches.
 */
export function sessionStorageAccess(deps: {
  store: Pick<EventStore, 'getProject' | 'listPublicPreviewShares'>;
  docker: DockerClient;
  provisioner: Required<Pick<Provisioner, 'withProjectExclusiveMutation'>>;
  withStorageProjectMutation: <T>(projectId: string, run: () => Promise<T>) => Promise<T>;
  /** Read on use: the dev server manager is created after session storage. */
  devServers: () => HoldInput['devServers'];
  localPreviews: HoldInput['localPreviews'];
  preparedWorktreeImages: Map<string, string>;
  defaultProjectImage: ProjectImageRefSource;
  maintenanceImages: MaintenanceImages | undefined;
  projectTokenMint: (project: ProjectRecord) => Promise<string | undefined>;
  hostCloneRoot: string;
  dockerBaseUrl: string;
  dataVolume: string | undefined;
  dataVolumeRoot: string | undefined;
}): Pick<StorageDeps, 'mutate' | 'withGit'> {
  const {
    store: eventStore,
    docker: projectDocker,
    provisioner,
    withStorageProjectMutation,
    preparedWorktreeImages,
    defaultProjectImage,
    maintenanceImages,
    dataVolumeRoot,
  } = deps;
  const cachedProjectTokenMint = deps.projectTokenMint;
  const config = {
    hostCloneRoot: deps.hostCloneRoot,
    dockerBaseUrl: deps.dockerBaseUrl,
    dataVolume: deps.dataVolume,
  };
  return {
    mutate: async (projectId, sessionId, operation, signal) => {
      const run = (imageId?: string, recheck?: () => Promise<void>) =>
        // Wait for the project owner before taking preview locks: that owner
        // may itself need preview teardown in order to finish.
        provisioner.withProjectExclusiveMutation(
          projectId,
          () =>
            withStorageProjectMutation(projectId, async () => {
              const hold = storageHold({
                projectId,
                sessionId,
                devServers: deps.devServers(),
                localPreviews: deps.localPreviews,
                publicShares: await eventStore.listPublicPreviewShares(projectId),
              });
              if (hold) throw new Error(hold);
              await recheck?.();
              if (imageId) preparedWorktreeImages.set(projectId, imageId);
              try {
                await operation();
              } finally {
                preparedWorktreeImages.delete(projectId);
              }
            }),
          sessionId ? new Set([sessionId]) : undefined,
          signal,
        );
      const project = await eventStore.getProject(projectId);
      if (project?.state === 'sleeping') {
        const parent = await projectDocker
          .inspectContainer(project.containerName)
          .catch((error: unknown) => {
            if (error instanceof DockerError && error.kind === 'container_not_found')
              return undefined;
            throw error;
          });
        if (!parent) {
          const selected =
            typeof defaultProjectImage === 'function'
              ? await defaultProjectImage()
              : defaultProjectImage;
          if (!selected || !maintenanceImages) throw new MaintenanceImageError('image-unavailable');
          return maintenanceImages.withImage(
            selected,
            (image, recheck) => run(image.id, recheck),
            signal,
          );
        }
      }
      return run();
    },
    withGit: async (project, operation) => {
      if (config.dataVolume && !dataVolumeRoot) throw new Error('Data volume root is unavailable');
      const containerName = project.containerName;
      const hostRoot = projectClonePath(config.hostCloneRoot, project);
      const inspect = await projectDocker
        .inspectContainer(containerName)
        .catch((error: unknown) => {
          if (error instanceof DockerError && error.kind === 'container_not_found') return null;
          throw error;
        });
      const authenticated = async (git: GitOutput) =>
        operation(async (args) => {
          if (!args.includes('fetch')) return git(args);
          // Keep provider credentials out of persistent Git config and cleanup reports.
          if (project.kind === 'forgejo')
            throw new Error('Forgejo retirement fetch is unavailable; worktree retained');
          const token =
            project.kind === 'local' ? undefined : await cachedProjectTokenMint(project);
          try {
            return await git([
              ...(token
                ? ['-c', `http.https://github.com/.extraHeader=${gitAuthHeader(token)}`]
                : []),
              ...args,
            ]);
          } catch {
            throw new Error('Retirement remote verification failed; worktree retained');
          }
        });
      if (!inspect?.running)
        return withSleepingSessionGit(
          {
            docker: projectDocker,
            templateContainer: containerName,
            projectId: project.id,
            hostRoot,
            dockerBaseUrl: config.dockerBaseUrl,
            maintenance: {
              ...(preparedWorktreeImages.has(project.id)
                ? {
                    fallback: {
                      imageId: preparedWorktreeImages.get(project.id)!,
                      runtime: PROJECT_RUNSC_RUNTIME,
                      memoryBytes: 512 * 1024 ** 2,
                      nanoCpus: 1_000_000_000,
                      pidsLimit: 128,
                    },
                  }
                : {}),
            },
            ...(config.dataVolume && dataVolumeRoot
              ? { dataVolume: { name: config.dataVolume, root: dataVolumeRoot } }
              : {}),
          },
          authenticated,
        );
      return authenticated(
        createSandboxGit({
          containerName,
          hostRoot,
          dockerBaseUrl: config.dockerBaseUrl,
          inspect: () => projectDocker.inspectContainer(containerName),
          timeoutMs: 15_000,
        }),
      );
    },
  };
}
