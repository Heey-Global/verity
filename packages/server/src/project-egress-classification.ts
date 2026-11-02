import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { canonicalEgressTarget } from '@verity/store';
import type { ProjectEgressResolution } from './project-egress-resolver.js';

export type MandatoryEgressClass =
  'forge' | 'google' | 'model' | 'secrets' | 'search' | 'packages' | 'configured';

/**
 * Destinations whose protected operations are reachable only through a Verity
 * broker or system path. A direct grant would let code bypass the adapter with
 * its own credential, so these domains and their subdomains are never direct.
 */
const MANDATORY_DOMAINS: readonly (readonly [string, MandatoryEgressClass])[] = [
  ['github.com', 'forge'],
  ['githubusercontent.com', 'forge'],
  ['ghcr.io', 'forge'],
  ['google.com', 'google'],
  ['googleapis.com', 'google'],
  ['googleusercontent.com', 'google'],
  ['anthropic.com', 'model'],
  ['claude.ai', 'model'],
  ['claude.com', 'model'],
  ['openai.com', 'model'],
  ['chatgpt.com', 'model'],
  ['doppler.com', 'secrets'],
  ['exa.ai', 'search'],
  ['npmjs.org', 'packages'],
  ['npmjs.com', 'packages'],
  ['yarnpkg.com', 'packages'],
  ['pypi.org', 'packages'],
  ['pythonhosted.org', 'packages'],
  ['crates.io', 'packages'],
  ['golang.org', 'packages'],
  ['maven.org', 'packages'],
  ['repo.maven.apache.org', 'packages'],
  ['nuget.org', 'packages'],
  ['rubygems.org', 'packages'],
  ['packagist.org', 'packages'],
];

/**
 * Representative hostnames whose current addresses must not be reachable through
 * a direct grant. Shared front ends serve protected and public names on the same
 * addresses; an IP-level rule cannot separate them. This is best effort for
 * anycast CDNs, which may answer a protected name on addresses these lookups did
 * not return; hostname classification remains the primary boundary.
 */
export const PROTECTED_ADDRESS_HOSTS: readonly string[] = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'uploads.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'ghcr.io',
  'www.googleapis.com',
  'oauth2.googleapis.com',
  'accounts.google.com',
  'docs.google.com',
  'drive.google.com',
  'api.anthropic.com',
  'claude.ai',
  'api.openai.com',
  'chatgpt.com',
  'api.doppler.com',
  'mcp.exa.ai',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'index.crates.io',
  'static.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'api.nuget.org',
  'rubygems.org',
  'repo.packagist.org',
];

const covers = (domain: string, host: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/** Classify a direct-target hostname; IP literals are handled by address inventory. */
export function mandatoryEgressRoute(
  host: string,
  configured: readonly string[] = [],
): MandatoryEgressClass | undefined {
  const canonical = canonicalEgressTarget({ host, protocol: 'tcp', port: 443 }).host;
  if (isIP(canonical)) return undefined;
  for (const [domain, kind] of MANDATORY_DOMAINS) if (covers(domain, canonical)) return kind;
  for (const domain of configured)
    if (covers(canonicalEgressTarget({ host: domain, protocol: 'tcp', port: 443 }).host, canonical))
      return 'configured';
  return undefined;
}

export interface ProtectedAddressInventory {
  /** Re-resolve every protected host; failure leaves the previous complete set. */
  refresh(): Promise<void>;
  /** False for protected addresses and whenever the inventory is absent or stale. */
  allows(address: string): boolean;
}

/** Host-owned inventory. Unknown or stale state denies every direct address. */
export function createProtectedAddressInventory(options: {
  resolve(host: string): Promise<ProjectEgressResolution>;
  hosts?: readonly string[];
  /** Deployment-configured names: a failed, empty or private answer adds nothing. */
  configuredHosts?: readonly string[];
  now?: () => number;
  maxAgeMs?: number;
}): ProtectedAddressInventory {
  const hosts = [...(options.hosts ?? PROTECTED_ADDRESS_HOSTS)];
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? 10 * 60_000;
  let addresses: ReadonlySet<string> | undefined;
  let refreshedAt = -Infinity;
  let pending: Promise<void> | undefined;
  // IPv4-mapped IPv6 must compare equal to the IPv4 front end it names.
  const normalize = (address: string): string => ipaddr.process(address).toString();
  const refresh = async (): Promise<void> => {
    const startedAt = now();
    // A partial answer would silently omit a protected front end.
    const results = await Promise.all([
      ...hosts.map((host) => options.resolve(host)),
      // Configured suffixes and private services may have no public address;
      // they must not invalidate the built-in inventory.
      ...(options.configuredHosts ?? []).map((host) =>
        options.resolve(host).catch(() => ({ addresses: [], expiresAt: 0 })),
      ),
    ]);
    if (startedAt < refreshedAt) return;
    addresses = new Set(results.flatMap((result) => result.addresses.map(normalize)));
    refreshedAt = startedAt;
  };
  return {
    refresh() {
      // Serialized: a slow refresh is joined rather than overtaken by a later tick.
      pending ??= refresh().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    allows(address) {
      if (addresses === undefined || now() - refreshedAt > maxAgeMs) return false;
      return !addresses.has(normalize(address));
    },
  };
}
