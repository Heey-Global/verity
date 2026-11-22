import type { ProjectRecord } from '@verity/store';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { ServerDeps } from './server-deps.js';
import type { DockerClient } from './docker.js';
import { projectClonePath, type DevcontainerFeatureSource } from './provisioner.js';
import { DockerExecBackend } from './project-backend.js';
import { createSandboxGit } from './sandbox-git.js';
import { projectSettingsEnv } from './project-settings-env.js';
import { DockerProjectRuntime, type DockerProjectRuntimeOptions } from './project-runtime.js';
import { createSandboxUpdateChecker } from './sandbox-updates.js';

export function createEmbeddedProjectRuntimeBindings(ctx: {
  config: Pick<
    EmbeddedServerConfig,
    | 'defaultProjectImageVersion'
    | 'repoDir'
    | 'dockerBaseUrl'
    | 'hostCloneRoot'
    | 'enableProjectRuntime'
  >;
  projectDocker: DockerClient | undefined;
  defaultProjectImage: Parameters<typeof createSandboxUpdateChecker>[0]['defaultProjectImage'];
  devcontainerFeature: Extract<DevcontainerFeatureSource, () => unknown> | undefined;
  provisioner: ServerDeps['provisioner'];
  projectSandboxLifecycleTelemetry: ServerDeps['projectSandboxLifecycleTelemetry'];
  resolvePreviewUser: NonNullable<DockerProjectRuntimeOptions['resolveUser']>;
}): Pick<
  ServerDeps,
  | 'sandboxUpdates'
  | 'workspaceDir'
  | 'provisioner'
  | 'projectSandboxLifecycleTelemetry'
  | 'projectCloneRoot'
  | 'projectWorktreeBranchesOnly'
  | 'projectBackend'
  | 'sandboxGit'
  | 'projectRuntime'
> {
  const {
    config,
    projectDocker,
    defaultProjectImage,
    devcontainerFeature,
    provisioner,
    projectSandboxLifecycleTelemetry,
    resolvePreviewUser,
  } = ctx;
  return {
    ...(projectDocker !== undefined
      ? {
          sandboxUpdates: createSandboxUpdateChecker({
            docker: projectDocker,
            defaultProjectImage,
            defaultProjectImageVersion: config.defaultProjectImageVersion,
            toolkitFeatureRef:
              devcontainerFeature === undefined
                ? undefined
                : async () => (await devcontainerFeature())?.ref,
          }),
        }
      : {}),
    // Repo root reserved for the human/main session — the server's delete path
    // never removes it (#105 safety guard); sessions always run in their own worktree.
    ...(config.repoDir !== undefined ? { workspaceDir: config.repoDir } : {}),
    // Multi-repo fleet-registry provisioner + deprovisioner (§19.3/#19.8). Absent →
    // the `project` field on POST /sessions and POST /projects/:id/deprovision
    // both return 503 (the mobile picker hides the fleet-registry UI).
    ...(provisioner !== undefined ? { provisioner } : {}),
    ...(provisioner !== undefined ? { projectSandboxLifecycleTelemetry } : {}),
    ...(config.dockerBaseUrl !== undefined && config.hostCloneRoot !== undefined
      ? { projectCloneRoot: config.hostCloneRoot }
      : {}),
    ...(!config.repoDir && config.hostCloneRoot !== undefined
      ? { projectWorktreeBranchesOnly: true }
      : {}),
    ...(config.dockerBaseUrl !== undefined && config.hostCloneRoot !== undefined
      ? {
          projectBackend: (project: ProjectRecord, selected, settings) =>
            new DockerExecBackend({
              containerName: project.containerName,
              hostProjectRoot: projectClonePath(config.hostCloneRoot as string, project),
              dockerBaseUrl: config.dockerBaseUrl,
              backend: selected,
              containerEnv: projectSettingsEnv(settings),
            }),
          // Git for the GitHub-free merge, run inside the project's own container.
          // Same shape as the backend above on purpose: the merge touches a clone the
          // session owns, so it must execute where the session's own code executes.
          // The daemon distinguishes stopped sandboxes from failed Git commands.
          ...(projectDocker !== undefined
            ? {
                sandboxGit: (project: ProjectRecord, clonePath: string) =>
                  createSandboxGit({
                    containerName: project.containerName,
                    hostRoot: clonePath,
                    dockerBaseUrl: config.dockerBaseUrl,
                    // Trust daemon state rather than repository-controlled Git output.
                    inspect: () => projectDocker.inspectContainer(project.containerName),
                  }),
              }
            : {}),
          ...(config.enableProjectRuntime === true
            ? {
                projectRuntime: new DockerProjectRuntime({
                  resolveUser: resolvePreviewUser,
                  dockerBaseUrl: config.dockerBaseUrl,
                }),
              }
            : {}),
        }
      : {}),
  };
}
