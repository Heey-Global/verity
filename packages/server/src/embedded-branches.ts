import type { EventStore } from '@verity/store';
import { createGitBranchService } from './branches.js';
import { CONTROL_PLANE_PROJECT_ID } from './control-plane-project.js';
import type { DockerClient } from './docker.js';
import type { EmbeddedServerConfig } from './embedded-types.js';
import { PROJECT_RUNSC_RUNTIME } from './gvisor-runtime-config.js';
import { assertQuerySandboxAllowed } from './query-sandbox-policy.js';
import { projectClonePath, type ProjectImageRefSource } from './provisioner.js';
import { MANAGED_CONTROL_PLANE_RUNNER_NAME } from './self-update/managed-control-plane-runner.js';
import {
  createSleepingSessionGit,
  sandboxIsRunning,
  createSandboxGit,
  withSleepingSessionGit,
} from './sandbox-git.js';

interface EmbeddedBranchRuntime {
  readonly projectDocker: DockerClient | undefined;
  readonly defaultProjectImage: ProjectImageRefSource;
  readonly dataVolumeRoot: string | undefined;
}

export function createEmbeddedBranches(
  config: Pick<
    EmbeddedServerConfig,
    'repoDir' | 'hostCloneRoot' | 'dockerBaseUrl' | 'controlPlaneRunner' | 'dataVolume'
  >,
  eventStore: Pick<
    EventStore,
    'getSession' | 'getSessionByWorktree' | 'getProject' | 'sessionRepositoryWorkspaceSessionId'
  >,
  runtime: EmbeddedBranchRuntime,
) {
  const sessionForWorktree = async (worktree: string | undefined) => {
    if (!worktree) return undefined;
    // Every git call resolves its session here, so it must not load the whole list.
    const primary = await eventStore.getSessionByWorktree(worktree);
    if (primary) return primary;
    const owner = await eventStore.sessionRepositoryWorkspaceSessionId(worktree);
    return owner === undefined ? undefined : eventStore.getSession(owner);
  };
  // Branch switcher for each session's worktree (#91). A dev checkout may provide
  // one global repo root; the multi-project runner deliberately sets VERITY_REPO_DIR=''
  // and instead resolves repo-wide git operations through each session worktree.
  const branches =
    config.repoDir || config.hostCloneRoot
      ? createGitBranchService({
          ...(config.repoDir ? { repoDir: config.repoDir } : {}),
          baseBranch: 'main',
          ...(config.dockerBaseUrl && config.hostCloneRoot
            ? {
                withGit: async (worktree, operation) => {
                  const docker = runtime.projectDocker;
                  if (!docker) throw new Error('Project Docker runtime is unavailable');
                  const session = await sessionForWorktree(worktree);
                  if (!session) throw new Error('Git requires persistent session context');
                  const project = await eventStore.getProject(
                    session.projectId ?? CONTROL_PLANE_PROJECT_ID,
                  );
                  if (!project) throw new Error('Project is unavailable');
                  const containerName =
                    project.kind === 'control_plane' && config.controlPlaneRunner === true
                      ? MANAGED_CONTROL_PLANE_RUNNER_NAME
                      : project.containerName;
                  const hostRoot = projectClonePath(config.hostCloneRoot!, project);
                  if (!(await sandboxIsRunning(() => docker.inspectContainer(containerName)))) {
                    assertQuerySandboxAllowed();
                    if (config.dataVolume && !runtime.dataVolumeRoot)
                      throw new Error('Data volume root is unavailable');
                    return withSleepingSessionGit(
                      {
                        docker,
                        templateContainer: containerName,
                        fallback: {
                          imageId:
                            typeof runtime.defaultProjectImage === 'function'
                              ? await runtime.defaultProjectImage()
                              : runtime.defaultProjectImage,
                          runtime: PROJECT_RUNSC_RUNTIME,
                          memoryBytes: 512 * 1024 ** 2,
                          nanoCpus: 1_000_000_000,
                          pidsLimit: 128,
                        },
                        projectId: project.id,
                        hostRoot,
                        dockerBaseUrl: config.dockerBaseUrl,
                        ...(config.dataVolume
                          ? {
                              dataVolume: {
                                name: config.dataVolume,
                                root: runtime.dataVolumeRoot!,
                              },
                            }
                          : {}),
                      },
                      operation,
                    );
                  }
                  return operation(
                    createSandboxGit({
                      containerName,
                      hostRoot,
                      dockerBaseUrl: config.dockerBaseUrl,
                      inspect: () => docker.inspectContainer(containerName),
                      timeoutMs: 10_000,
                    }),
                  );
                },
                git: async (args: readonly string[]) => {
                  // Repository helpers must run with the same privileges as the agent.
                  const index = args.indexOf('-C');
                  const path = index < 0 ? undefined : args[index + 1];
                  const session = await sessionForWorktree(path);
                  const projectDocker = runtime.projectDocker;
                  if (!session || !projectDocker)
                    throw new Error('Git operation has no project session context');
                  const project = await eventStore.getProject(
                    session.projectId ?? CONTROL_PLANE_PROJECT_ID,
                  );
                  if (!project) throw new Error('Project is unavailable');
                  const containerName =
                    project.kind === 'control_plane' && config.controlPlaneRunner === true
                      ? MANAGED_CONTROL_PLANE_RUNNER_NAME
                      : project.containerName;
                  const readOnly =
                    [
                      'rev-parse',
                      'for-each-ref',
                      'symbolic-ref',
                      'reflog',
                      'status',
                      'diff',
                      'log',
                      'show',
                      'merge-base',
                      'show-ref',
                    ].includes(args[index + 2] ?? '') ||
                    (args[index + 2] === 'worktree' && args[index + 3] === 'list');
                  if (
                    readOnly &&
                    !(await sandboxIsRunning(() => projectDocker.inspectContainer(containerName)))
                  ) {
                    assertQuerySandboxAllowed();
                    if (config.dataVolume && !runtime.dataVolumeRoot)
                      throw new Error('Data volume root is unavailable');
                    return createSleepingSessionGit({
                      docker: projectDocker,
                      templateContainer: containerName,
                      fallback: {
                        imageId:
                          typeof runtime.defaultProjectImage === 'function'
                            ? await runtime.defaultProjectImage()
                            : runtime.defaultProjectImage,
                        runtime: PROJECT_RUNSC_RUNTIME,
                        memoryBytes: 512 * 1024 ** 2,
                        nanoCpus: 1_000_000_000,
                        pidsLimit: 128,
                      },
                      projectId: project.id,
                      hostRoot: projectClonePath(config.hostCloneRoot!, project),
                      ...(config.dataVolume
                        ? {
                            dataVolume: { name: config.dataVolume, root: runtime.dataVolumeRoot! },
                          }
                        : {}),
                      dockerBaseUrl: config.dockerBaseUrl,
                    })(args);
                  }
                  return createSandboxGit({
                    containerName: containerName,
                    hostRoot: projectClonePath(config.hostCloneRoot!, project),
                    dockerBaseUrl: config.dockerBaseUrl,
                    inspect: () => projectDocker.inspectContainer(containerName),
                  })(args);
                },
              }
            : {}),
        })
      : undefined;
  return branches;
}
