import { hostname } from 'node:os';
import type { DockerClient } from './docker.js';

/** Resolve self from the current UTS namespace; HOSTNAME can be inherited from
 * a previous container generation, unlike the kernel's hostname. */
export function createServerLogSource(
  docker: Pick<DockerClient, 'containerLogs'> | undefined,
  configuredId?: string,
) {
  if (!docker?.containerLogs) return undefined;
  const id = configuredId ?? hostname();
  return (window: { since: string; until: string }) => docker.containerLogs!(id, 1000, window);
}
