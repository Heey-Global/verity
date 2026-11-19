import type { ProjectRecord } from '@verity/store';
import { createDockerClient } from './docker.js';
import type { EmbeddedServerConfig } from './embedded-types.js';
import { removeRetiredSessionSandboxes } from './retired-session-sandboxes.js';

export function createEmbeddedDocker(
  config: Pick<EmbeddedServerConfig, 'dockerBaseUrl' | 'hostCloneRoot' | 'registryAuth'>,
) {
  const logDockerPull = (message: string): void => {
    console.info(`verity: ${message}`);
  };
  const projectDocker =
    config.dockerBaseUrl && config.hostCloneRoot
      ? createDockerClient({
          baseUrl: config.dockerBaseUrl,
          ...(config.registryAuth !== undefined ? { registryAuth: config.registryAuth } : {}),
          pullLog: logDockerPull,
        })
      : undefined;
  if (projectDocker !== undefined) {
    // Per-session sandboxes from a Server that ran sessions in private containers
    // have no owner here; see removeRetiredSessionSandboxes.
    void removeRetiredSessionSandboxes(projectDocker)
      .then((result) => {
        if (result.containers + result.volumes + result.failed > 0) {
          console.info(`verity: removed retired session sandboxes ${JSON.stringify(result)}`);
        }
      })
      .catch((error: unknown) => {
        console.warn('verity: could not remove retired session sandboxes', error);
      });
  }
  const runtimeDocker = config.dockerBaseUrl
    ? (projectDocker ??
      createDockerClient({
        baseUrl: config.dockerBaseUrl,
        ...(config.registryAuth !== undefined ? { registryAuth: config.registryAuth } : {}),
        pullLog: logDockerPull,
      }))
    : undefined;
  const resolvePreviewUser = async (project: ProjectRecord): Promise<string | undefined> => {
    const sandbox = await projectDocker?.inspectContainer(project.containerName);
    const env = Object.fromEntries(
      (sandbox?.env ?? []).map((entry) => {
        const index = entry.indexOf('=');
        return [entry.slice(0, index), entry.slice(index + 1)];
      }),
    );
    if (env.VERITY_RUNNER_RUNTIME) {
      const uid = env.VERITY_AGENT_UID,
        gid = env.VERITY_AGENT_GID;
      if (!uid || !gid || !/^\d+$/.test(uid) || !/^\d+$/.test(gid))
        throw new Error('sandbox agent identity is unavailable');
      return `${uid}:${gid}`;
    }
    return sandbox?.user || undefined;
  };
  return { projectDocker, runtimeDocker, resolvePreviewUser };
}
