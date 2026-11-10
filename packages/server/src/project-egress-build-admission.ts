import ipaddr from 'ipaddr.js';
import { isIP } from 'node:net';
import { projectDeadlineLease, type ProjectDeadlineLease } from './project-egress-deadline.js';
import {
  projectFenceTable,
  type ProjectFenceBinding,
  type ProjectFenceDependencies,
} from './project-egress-fence.js';

// Build downloads need no runtime grant. Nonpublic and transition address forms
// remain excluded even when a Dockerfile uses a literal address or its own DNS.
const excluded = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '2001::/23',
  '2001:db8::/32',
  '2002::/16',
  '3fff::/20',
];
/** One atomic transaction that replaces both build tables whether or not they
 * exist. `add table` is a no-op for a present table, so the following `delete`
 * cannot fail on a table that a partial cleanup, an earlier host process or an
 * operator already removed. Replacement must never depend on in-memory state:
 * a denial that cannot be applied leaves the previous policy in force. */
export function protectedBuildRules(
  binding: ProjectFenceBinding,
  blocked: readonly string[],
  lease?: ProjectDeadlineLease,
  flow = lease?.nonce,
  uplinks: readonly string[] = [],
): string {
  const table = projectFenceTable(binding);
  if (!/^veb[a-f0-9]{12}$/u.test(binding.bridge)) throw new Error('Build-only bridge required');
  if (lease && (!flow || !/^[a-f0-9]{32}$/u.test(flow))) throw new Error('Invalid build epoch');
  if (
    lease &&
    (!uplinks.length ||
      uplinks.length > 16 ||
      uplinks.some((name) => !/^[a-zA-Z0-9_.:-]{1,15}$/u.test(name)))
  )
    throw new Error('Invalid build uplinks');
  const routes = uplinks.map((name) => JSON.stringify(name)).join(', ');
  const prefixes = [
    ...new Set(
      [...excluded, ...blocked].map((value) => {
        const [address, bits] = ipaddr.parseCIDR(value);
        const bytes = address.toByteArray().map((byte, index) => {
          const remaining = Math.max(0, Math.min(8, bits - index * 8));
          return byte & ((0xff << (8 - remaining)) & 0xff);
        });
        return `${ipaddr.fromByteArray(bytes).toString()}/${bits}`;
      }),
    ),
  ];
  if (prefixes.length > 30000) throw new Error('Build network inventory too large');
  const bits = Array.from({ length: 128 }, (_, bit) => bit).filter(
    (bit) => (BigInt(`0x${flow ?? '0'}`) & (1n << BigInt(bit))) !== 0n,
  );
  const label = bits.length ? `(${bits.join(' | ')})` : '(0 & 1)';
  const sets = [4, 6]
    .map(
      (
        f,
      ) => `set blocked${f} { type ipv${f}_addr; flags interval; auto-merge; elements = { ${prefixes.filter((p) => isIP(p.split('/')[0]!) === f).join(', ')} }; }
set public${f} { type ipv${f}_addr; flags interval,timeout; ${lease ? `elements = { ${f === 4 ? '0.0.0.0/0' : '2000::/3'} timeout 1000ms };` : ''} }`,
    )
    .join('\n');
  const matches = (reverse: boolean) =>
    [4, 6]
      .map((f) => {
        const ip = f === 4 ? 'ip' : 'ip6';
        const field = reverse ? 'saddr' : 'daddr';
        return `${ip} ${field} @blocked${f} drop\nct direction ${reverse ? 'reply' : 'original'} ct label == ${label} meta l4proto { tcp, udp } ${ip} ${field} @public${f}${lease ? ` ${reverse ? 'iifname' : 'oifname'} { ${routes} }` : ''} accept`;
      })
      .join('\n');
  return `add table inet ${table}
delete table inet ${table}
add table bridge ${table}
delete table bridge ${table}
table inet ${table} {
${sets}
chain fence {
 ip saddr != ${binding.ipv4} drop
 ip6 saddr != ${binding.ipv6} drop
 ct state new ct label == (0 & 1) tcp flags & (syn | ack | rst | fin) == syn ct label set ${label}
 ct state new ct label == (0 & 1) meta l4proto udp ct label set ${label}
 ${matches(false)}
 counter drop
}
chain reply {
 ip daddr != ${binding.ipv4} drop
 ip6 daddr != ${binding.ipv6} drop
 ${matches(true)}
 counter drop
}
chain forward { type filter hook forward priority -200; policy accept; iifname "${binding.bridge}" jump fence; oifname "${binding.bridge}" jump reply; }
chain input { type filter hook input priority -200; policy accept;
 iifname "${binding.bridge}" ip6 hoplimit 255 icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } accept
 iifname "${binding.bridge}" drop
}
chain output { type filter hook output priority -200; policy accept;
 oifname "${binding.bridge}" ip6 hoplimit 255 icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } accept
 oifname "${binding.bridge}" jump reply
}
}
table bridge ${table} {
 chain forward { type filter hook forward priority -200; policy accept; meta ibrname "${binding.bridge}" drop; }
}
`;
}

/** One host-owned build attempt. Runtime grants and runtime relay exemptions do
 * not enter this policy. Both nft timeouts and the existing TC guard expire it.
 */
export function createProtectedBuildAdmission(options: {
  binding: ProjectFenceBinding;
  dependencies: Omit<ProjectFenceDependencies, 'policyCurrent'>;
  networkInventory(): Promise<{ blocked: readonly string[]; uplinks: readonly string[] }>;
}) {
  const binding = structuredClone(options.binding);
  const deps = options.dependencies;
  let previous: ProjectDeadlineLease | undefined;
  let flow: string | undefined;
  let prepared = false;
  let retired = false;
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn);
    queue = next.catch(() => undefined);
    return next;
  };
  const verify = async () => {
    const actual = await deps.inspect(binding);
    if (
      (Object.keys(binding) as Array<keyof ProjectFenceBinding>).some(
        (key) => actual[key] !== binding[key],
      )
    )
      throw new Error('Build endpoint changed');
  };
  const deny = async () => {
    previous = undefined;
    flow = undefined;
    try {
      await deps.deadline.revoke(binding);
    } finally {
      await deps.apply(protectedBuildRules(binding, []));
      prepared = true;
    }
  };
  return {
    prepare: () =>
      serialize(async () => {
        await verify();
        try {
          await deps.deadline.prepare(binding);
        } finally {
          await deny();
        }
      }),
    refresh: () =>
      serialize(async () => {
        if (!prepared || retired) throw new Error('Inactive build admission');
        try {
          const lease = projectDeadlineLease(binding, 0, null, await deps.deadline.clock());
          const inventory = await options.networkInventory();
          await verify();
          const same =
            previous && previous.bootId === lease.bootId && deps.deadline.renew !== undefined;
          flow = same ? flow : lease.nonce;
          await deps.apply(
            protectedBuildRules(binding, inventory.blocked, lease, flow, inventory.uplinks),
          );
          if (same) await deps.deadline.renew!(binding, lease, previous!.bootDeadlineNs);
          else await deps.deadline.arm(binding, lease);
          previous = lease;
        } catch (error) {
          await deny();
          throw error;
        }
      }),
    revoke: () => serialize(deny),
    retire: () =>
      serialize(async () => {
        retired = true;
        await deny();
      }),
    resolve: async (name: string) => {
      if (!previous || retired) return { addresses: [], ttlSeconds: 1 };
      const answer = await deps.resolve(name);
      // DNS must not hold up the heartbeat that renews packet authority.
      for (const address of answer.addresses)
        if (ipaddr.parse(address).range() !== 'unicast') throw new Error('Nonpublic build DNS');
      return { addresses: answer.addresses, ttlSeconds: 1 };
    },
  };
}
