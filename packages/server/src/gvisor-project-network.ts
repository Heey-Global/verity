import { isIP } from 'node:net';

import type { DockerClient } from './docker.js';

/**
 * Name resolution for a project sandbox under the `runsc-project` runtime.
 *
 * Docker answers names on a user-defined network from its embedded resolver at 127.0.0.11,
 * reached through a DNAT rule into a listener that lives in the container's network namespace.
 * gVisor's netstack owns loopback inside the sandbox, so neither 127.0.0.11:53 nor the
 * resolver's real port is reachable from it; `--reproduce-nat` does not change that. Under runc
 * the same lookups succeed. Without this module a gVisor sandbox resolves nothing: not its relay
 * (Claude/Codex egress, the MCP gateway, the signing broker), and not the internet.
 *
 * The relay is pinned in `/etc/hosts` by the address Docker gave it on the project network, and
 * the sandbox's resolv.conf names the relay itself: it runs under runc on the same network and
 * forwards queries to its own 127.0.0.11 (packages/project-relay/src/dns.ts), so the sandbox
 * resolves what a runc container would, through whatever resolvers the host uses. Operators may
 * name upstream resolvers instead (`VERITY_SANDBOX_DNS_SERVERS`).
 */

/** `host:ip` entries for every relay hostname the sandbox is configured to reach. */
export async function relayHostEntries(
  docker: Pick<DockerClient, 'inspectContainer'>,
  network: string,
  urls: readonly (string | undefined)[],
): Promise<string[]> {
  const hosts = [
    ...new Set(
      urls
        .filter((url): url is string => url !== undefined)
        .map((url) => new URL(url).hostname)
        .filter((host) => isIP(host) === 0),
    ),
  ];
  const entries: string[] = [];
  for (const host of hosts) {
    // The relay's container name IS its hostname on the project network.
    const inspect = await docker.inspectContainer(host);
    const address = inspect.networks?.[network]?.ipAddress;
    if (address === undefined || isIP(address) === 0) {
      throw new Error(`${host} has no address on ${network}`);
    }
    entries.push(`${host}:${address}`);
  }
  return entries;
}

/**
 * The address a sandbox uses as its resolver: the relay's, from the entries
 * {@link relayHostEntries} pinned for it. The relay is addressed by container name, or by IP.
 */
export function relayResolverAddress(relayUrl: string, entries: readonly string[]): string {
  const host = new URL(relayUrl).hostname;
  if (isIP(host) !== 0) return host;
  const entry = entries.find((candidate) => candidate.startsWith(`${host}:`));
  if (entry === undefined) throw new Error(`${host} has no pinned address`);
  return entry.slice(host.length + 1);
}

/** Validate operator-configured resolvers (`VERITY_SANDBOX_DNS_SERVERS`). */
export function parseSandboxDnsServers(value: string): string[] {
  const servers = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  for (const server of servers) {
    if (isIP(server) === 0 || isLoopback(server)) {
      throw new Error(`VERITY_SANDBOX_DNS_SERVERS entry is not a non-loopback IP: ${server}`);
    }
  }
  return servers;
}

export function sandboxResolvConf(servers: readonly string[]): string {
  return `${servers.map((server) => `nameserver ${server}`).join('\n')}\noptions ndots:0\n`;
}

function isLoopback(address: string): boolean {
  return address.startsWith('127.') || address === '::1';
}
