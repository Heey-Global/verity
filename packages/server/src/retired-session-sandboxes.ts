import type { DockerClient } from './docker.js';

/** Label every per-session sandbox carried while sessions ran in private containers. */
export const RETIRED_SESSION_SANDBOX_LABEL = 'verity.session-id';

/** Private dependency volume of such a sandbox: `verity-session-<24 hex>-node-modules`. */
const RETIRED_SESSION_VOLUME = /^verity-session-[0-9a-f]{24}-node-modules$/u;

export interface RetiredSessionSandboxSweep {
  containers: number;
  volumes: number;
  failed: number;
}

/**
 * Remove the per-session sandboxes a Server with private session containers left
 * behind.
 *
 * Nothing in this Server creates, stops or owns them any more. Left alone they
 * keep running through project sleep, rebuild and deletion, still holding their
 * workspace and credential mounts, with no lifecycle that will ever reach them.
 * Their checkouts live on the data volume and are not touched here; only the
 * containers and their regenerable dependency volumes go.
 *
 * Best-effort per item: one container the daemon refuses must not keep the rest
 * running. Volumes are removed after the containers, which hold them in use.
 */
export async function removeRetiredSessionSandboxes(
  docker: Pick<DockerClient, 'removeContainer' | 'listContainers' | 'listVolumes' | 'removeVolume'>,
): Promise<RetiredSessionSandboxSweep> {
  const result: RetiredSessionSandboxSweep = { containers: 0, volumes: 0, failed: 0 };
  for (const container of (await docker.listContainers?.()) ?? []) {
    if (container.labels?.[RETIRED_SESSION_SANDBOX_LABEL] === undefined) continue;
    try {
      await docker.removeContainer(container.id);
      result.containers++;
    } catch {
      result.failed++;
    }
  }
  for (const volume of (await docker.listVolumes?.()) ?? []) {
    if (!RETIRED_SESSION_VOLUME.test(volume.name)) continue;
    try {
      await docker.removeVolume?.(volume.name);
      result.volumes++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
