import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { canonicalEgressTarget, type ProjectEgressStore } from '@verity/store';
import { projectEgressHostDocker } from './project-egress-host-runtime.js';
import {
  mandatoryEgressRoute,
  type ProtectedAddressInventory,
} from './project-egress-classification.js';

/** Fixed installation files only. No path comes from the control protocol. */
export async function readEgressHostConfiguration(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (!file) return undefined;
  try {
    const value = await file.stat();
    if (
      !value.isFile() ||
      value.uid !== 0 ||
      (value.mode & 0o077) !== 0 ||
      value.size > 65536 ||
      (await realpath(path)) !== path
    )
      throw new Error('Untrusted host configuration');
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      const stat = await lstat(parent);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== 0 ||
        (stat.mode & 0o022) !== 0
      )
        throw new Error('Untrusted host configuration directory');
      if (parent === '/') break;
    }
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } finally {
    await file.close();
  }
}
const name = z.string().min(1).max(128);
const canonicalHosts = (limit: number) =>
  z
    .array(z.string())
    .max(limit)
    .transform((hosts) =>
      hosts.map((host) => canonicalEgressTarget({ host, protocol: 'tcp', port: 443 }).host),
    );
export const egressHostAuthority = z
  .strictObject({
    databaseUrl: z
      .string()
      .url()
      .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
    dnsServers: z
      .array(z.union([z.ipv4(), z.ipv6()]))
      .min(1)
      .max(3),
    /** An explicit host-reviewed route inventory; unclassified hosts stay unavailable. */
    directHosts: canonicalHosts(1000),
    /** Deployment-specific broker/system hosts (Matrix, OpenCode, private MCP). */
    mandatoryHosts: canonicalHosts(100).default([]),
    projectSponsors: z.record(name, name),
  })
  // A configuration that lists a broker-only destination as direct is rejected,
  // not silently narrowed: the operator must see the conflict.
  .refine(
    (value) => value.directHosts.every((host) => !mandatoryEgressRoute(host, value.mandatoryHosts)),
    { message: 'Direct hosts must not include broker or system destinations' },
  );

/** Re-read all host addresses and every Docker subnet on each admission check.
 * Public project CIDRs and publicly addressed host control sockets are protected too.
 */
export async function egressHostDestinationAllowed(
  address: string,
  io = {
    addresses: async () =>
      (
        await promisify(execFile)('/sbin/ip', ['-j', 'address', 'show'], {
          timeout: 1000,
          maxBuffer: 2 * 1024 * 1024,
        })
      ).stdout,
    docker: projectEgressHostDocker,
  },
): Promise<boolean> {
  const candidate = ipaddr.parse(address);
  if (candidate.range() !== 'unicast') return false;
  const interfaces = z
    .array(z.object({ addr_info: z.array(z.object({ local: z.string() })) }))
    .parse(JSON.parse(await io.addresses()));
  if (
    interfaces.some((item) =>
      item.addr_info.some((info) => ipaddr.parse(info.local).toString() === candidate.toString()),
    )
  )
    return false;
  const ids = (await io.docker('network', 'ls', '-q', '--no-trunc'))
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (!ids.length || ids.length > 10000 || ids.some((id) => !/^[a-f0-9]{64}$/u.test(id)))
    throw new Error('Invalid host network inventory');
  // Bound daemon argument and response sizes independently of project count.
  for (let offset = 0; offset < ids.length; offset += 64) {
    const networks = z
      .array(
        z.object({
          IPAM: z.object({
            Config: z.array(z.object({ Subnet: z.string().optional() })).nullable(),
          }),
        }),
      )
      .parse(JSON.parse(await io.docker('network', 'inspect', ...ids.slice(offset, offset + 64))));
    if (networks.length !== Math.min(64, ids.length - offset))
      throw new Error('Incomplete host network inventory');
    for (const network of networks)
      for (const subnet of network.IPAM.Config ?? []) {
        if (!subnet.Subnet) continue;
        const range = ipaddr.parseCIDR(subnet.Subnet);
        if (candidate.kind() === range[0].kind() && candidate.match(range)) return false;
      }
  }
  return true;
}

/** Absence is a closed direct path, not a legacy-network fallback. */
export const unavailableEgressAuthority: Pick<ProjectEgressStore, 'readForAdmission'> = {
  readForAdmission: () => Promise.reject(new Error('Host admission authority is not configured')),
};

/** Direct admission checks: an inventoried host that is not broker-only, at an
 * address that is neither a host/project destination nor a protected front end.
 */
export function egressHostDirectChecks(
  authority: z.infer<typeof egressHostAuthority> | undefined,
  protectedAddresses: Pick<ProtectedAddressInventory, 'allows'>,
  destinationAllowed: (address: string) => Promise<boolean> = egressHostDestinationAllowed,
): {
  directTargetAllowed(host: string): Promise<boolean>;
  destinationAllowed(address: string): Promise<boolean>;
} {
  return {
    directTargetAllowed: (host) =>
      Promise.resolve(
        authority?.directHosts.includes(host) === true &&
          mandatoryEgressRoute(host, authority.mandatoryHosts) === undefined,
      ),
    destinationAllowed: async (address) =>
      protectedAddresses.allows(address) && (await destinationAllowed(address)),
  };
}
