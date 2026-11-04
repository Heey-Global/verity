import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { canonicalEgressTarget, type EgressTarget } from '@verity/store';
import {
  EGRESS_DNS_MIXED,
  EGRESS_DNS_NOT_PUBLIC,
  type ProjectEgressResolution,
} from './project-egress-resolver.js';

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

/**
 * System destinations every fenced project reaches without a grant or card. Interim:
 * OpenCode's built-in web search calls this fixed endpoint, and its addresses are
 * therefore not protected. Projects still cannot grant `exa.ai` names themselves.
 */
export const SYSTEM_DIRECT_TARGETS: readonly EgressTarget[] = [
  { host: 'mcp.exa.ai', protocol: 'tcp', port: 443 },
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
  /** Re-resolve every protected host. Rejects if any built-in host stayed unresolved. */
  refresh(): Promise<void>;
  /** False for protected addresses and whenever any built-in host's entry is stale. */
  allows(address: string): boolean;
}

/** Public addresses a complete answer established, or undefined for a transient
 * failure. Mixed answers keep their public subset; NXDOMAIN, empty, sinkholed or
 * private answers contribute none. Timeouts and oversized answers stay transient.
 */
function establishedPublic(error: unknown): readonly string[] | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, publicAddresses } = error as NodeJS.ErrnoException & {
    publicAddresses?: readonly string[];
  };
  if (code === EGRESS_DNS_MIXED) return publicAddresses ?? [];
  if (code === 'ENOTFOUND' || code === 'ENODATA' || code === EGRESS_DNS_NOT_PUBLIC) return [];
  return undefined;
}

/** Host-owned inventory. Unknown or stale state denies every direct address. */
export function createProtectedAddressInventory(options: {
  resolve(host: string): Promise<ProjectEgressResolution>;
  hosts?: readonly string[];
  /** Deployment-configured names require fresh complete answers, like built-ins. */
  configuredHosts?: readonly string[];
  /** Report transient failures without weakening direct-address protection. */
  reportConfiguredFailure?(host: string, error: unknown): void;
  now?: () => number;
  maxAgeMs?: number;
}): ProtectedAddressInventory {
  const hosts = [...(options.hosts ?? PROTECTED_ADDRESS_HOSTS)];
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? 10 * 60_000;
  // Per built-in host: last confirmed public addresses and when they were confirmed.
  const entries = new Map<string, { addresses: readonly string[]; at: number }>();
  // Configured hosts share the built-in freshness requirement.
  const configured = new Map<string, { addresses: readonly string[]; at: number }>();
  let pending: Promise<void> | undefined;
  // IPv4-mapped IPv6 must compare equal to the IPv4 front end it names.
  const normalize = (address: string): string => ipaddr.process(address).toString();
  const refresh = async (): Promise<void> => {
    const startedAt = now();
    const failures: unknown[] = [];
    await Promise.all(
      hosts.map(async (host) => {
        try {
          const result = await options.resolve(host);
          entries.set(host, { addresses: result.addresses.map(normalize), at: startedAt });
        } catch (error) {
          // A complete answer contributes its public subset; a transient failure keeps
          // the last confirmed addresses until they age out.
          const established = establishedPublic(error);
          if (established)
            entries.set(host, { addresses: established.map(normalize), at: startedAt });
          else failures.push(error);
        }
      }),
    );
    // A definitive private/empty answer is complete. A transient failure cannot
    // establish that a configured broker has no public address.
    await Promise.all(
      (options.configuredHosts ?? []).map(async (host) => {
        try {
          configured.set(host, {
            addresses: (await options.resolve(host)).addresses.map(normalize),
            at: startedAt,
          });
        } catch (error) {
          const established = establishedPublic(error);
          if (established)
            configured.set(host, { addresses: established.map(normalize), at: startedAt });
          else {
            failures.push(error);
            options.reportConfiguredFailure?.(host, error);
          }
        }
      }),
    );
    if (failures.length)
      throw new AggregateError(failures, 'Protected destination inventory incomplete');
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
      const at = now();
      for (const host of hosts) {
        const entry = entries.get(host);
        if (entry === undefined || at - entry.at > maxAgeMs) return false;
      }
      for (const host of options.configuredHosts ?? []) {
        const entry = configured.get(host);
        if (entry === undefined || at - entry.at > maxAgeMs) return false;
      }
      const candidate = normalize(address);
      return (
        [...configured.values()].every((entry) => !entry.addresses.includes(candidate)) &&
        hosts.every((host) => !entries.get(host)!.addresses.includes(candidate))
      );
    },
  };
}
