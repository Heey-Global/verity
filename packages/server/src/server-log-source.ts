import { hostname } from 'node:os';
import type { DockerClient } from './docker.js';

/** Resolve self from the current UTS namespace; HOSTNAME can be inherited from
 * a previous container generation, unlike the kernel's hostname. */
export function createServerLogSource(
  docker: Pick<DockerClient, 'containerLogs'> | undefined,
  configuredId?: string,
) {
  if (!docker?.containerLogs) return undefined;
  const explicitId = configuredId?.trim();
  const currentHostname = hostname();
  // Docker defaults to an ID prefix. Custom hostnames need an explicit identity;
  // looking up arbitrary hostnames can select an unrelated container by name.
  const id =
    explicitId ||
    (/^(?:[a-f0-9]{12}|[a-f0-9]{64})$/.test(currentHostname) ? currentHostname : undefined);
  if (!id) return undefined;
  return (window: { since: string; until: string }) => docker.containerLogs!(id, 1000, window);
}
