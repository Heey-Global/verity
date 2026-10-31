import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { canonicalEgressTarget } from '@verity/store';

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
      if (!records.length || records.length > 32)
        throw new Error('Invalid project DNS answer count');
      for (const [family, answers] of results.entries())
        for (const record of answers)
          if (
            isIP(record.address) !== (family === 0 ? 4 : 6) ||
            ipaddr.parse(record.address).range() !== 'unicast' ||
            !Number.isSafeInteger(record.ttl) ||
            record.ttl <= 0 ||
            !(await options.destinationAllowed(record.address))
          )
            throw new Error('Forbidden project DNS answer');
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
