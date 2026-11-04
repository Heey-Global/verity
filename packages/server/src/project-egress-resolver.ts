import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { canonicalEgressTarget } from '@verity/store';

/** A complete answer established that the name has no public unicast address. */
export const EGRESS_DNS_NOT_PUBLIC = 'EGRESS_DNS_NOT_PUBLIC';
/** A complete answer mixed public and non-public addresses; `publicAddresses` lists the former. */
export const EGRESS_DNS_MIXED = 'EGRESS_DNS_MIXED';
const forbidden = (code: string, publicAddresses: readonly string[] = []): Error =>
  Object.assign(new Error('Forbidden project DNS answer'), { code, publicAddresses });

export interface ProjectEgressResolution {
  addresses: readonly string[];
  expiresAt: number;
}
interface DnsRecord {
  address: string;
  ttl: number;
}
interface ProjectResolver {
  resolve4(host: string, options: { ttl: true }): Promise<DnsRecord[]>;
  resolve6(host: string, options: { ttl: true }): Promise<DnsRecord[]>;
  cancel(): void;
}

/** Host-owned DNS only. Call after route classification and grant validation;
 * this function does not authorize a hostname or expose DNS to the sandbox.
 */
export function createProjectEgressResolver(options: {
  servers: readonly string[];
  destinationAllowed(address: string): Promise<boolean>;
  now?: () => number;
  createResolver?: () => ProjectResolver;
}): (host: string) => Promise<ProjectEgressResolution> {
  if (
    !options.servers.length ||
    options.servers.length > 3 ||
    options.servers.some((server) => !isIP(server))
  )
    throw new Error('Explicit DNS server addresses are required');
  const servers = [...options.servers];
  const now = options.now ?? Date.now;
  const create =
    options.createResolver ??
    (() => {
      const resolver = new Resolver({ timeout: 500, tries: 1 });
      resolver.setServers(servers);
      return resolver;
    });
  return async (host) => {
    const target = canonicalEgressTarget({ host, protocol: 'tcp', port: 443 });
    if (isIP(target.host) || target.host !== host)
      throw new Error('Expected a canonical granted hostname');
    const resolver = create();
    const startedAt = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const results = await Promise.race([
        Promise.all(
          [resolver.resolve4(host, { ttl: true }), resolver.resolve6(host, { ttl: true })].map(
            async (pending) =>
              pending.catch((error: unknown) => {
                // Absence of one family is normal; resolver failures are not absence.
                if ((error as NodeJS.ErrnoException).code === 'ENODATA') return [];
                throw error;
              }),
          ),
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Project DNS deadline exceeded')), 1000);
        }),
      ]);
      const records = results.flat();
      if (!records.length)
        throw Object.assign(new Error('Invalid project DNS answer count'), {
          code: EGRESS_DNS_NOT_PUBLIC,
        });
      if (records.length > 32) throw new Error('Invalid project DNS answer count');
      // Structure first, for every record, so the outcome never depends on record order.
      for (const [family, answers] of results.entries())
        for (const record of answers)
          if (
            isIP(record.address) !== (family === 0 ? 4 : 6) ||
            !Number.isSafeInteger(record.ttl) ||
            record.ttl <= 0
          )
            throw new Error('Forbidden project DNS answer');
      // Sinkholed, private and host/project addresses are definitive, not outages.
      const publicAddresses: string[] = [];
      for (const record of records)
        if (
          ipaddr.parse(record.address).range() === 'unicast' &&
          (await options.destinationAllowed(record.address))
        )
          publicAddresses.push(ipaddr.parse(record.address).toString());
      if (publicAddresses.length !== records.length)
        throw forbidden(publicAddresses.length ? EGRESS_DNS_MIXED : EGRESS_DNS_NOT_PUBLIC, [
          ...new Set(publicAddresses),
        ]);
      const expiresAt = startedAt + Math.min(...records.map((record) => record.ttl), 86400) * 1000;
      if (now() >= expiresAt) throw new Error('Project DNS answer expired');
      return {
        addresses: [...new Set(records.map((record) => ipaddr.parse(record.address).toString()))],
        expiresAt,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      resolver.cancel();
    }
  };
}

/** Keep protected inventory DNS independent from per-admission host/Docker checks. */
export function createProjectEgressResolvers(
  options: Parameters<typeof createProjectEgressResolver>[0],
): {
  resolve: ReturnType<typeof createProjectEgressResolver>;
  resolveProtected: ReturnType<typeof createProjectEgressResolver>;
} {
  const resolve = createProjectEgressResolver(options);
  return {
    resolve,
    // Inventory protects every public broker/system front end, including public
    // host-owned addresses. Admission separately excludes host/project networks.
    resolveProtected: createProjectEgressResolver({
      ...options,
      destinationAllowed: () => Promise.resolve(true),
    }),
  };
}
