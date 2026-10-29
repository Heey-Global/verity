import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { canonicalEgressTarget, type EgressGrant } from '@verity/store';

export interface ProjectFenceBinding {
  projectId: string;
  generation: string;
  containerId: string;
  networkId: string;
  endpointId: string;
  bridge: string;
  ipv4: string;
  ipv6: string;
}
export interface ProjectFenceSnapshot {
  binding: ProjectFenceBinding;
  revision: number;
  grants: readonly EgressGrant[];
}
export interface ProjectFenceDependencies {
  /** Trusted daemon inspection, not labels or a sandbox-provided attachment. */
  inspect(binding: ProjectFenceBinding): Promise<ProjectFenceBinding>;
  /** Must deny broker/system/overlapping destinations; absent classification denies. */
  directTargetAllowed(host: string): Promise<boolean>;
  /** Host-owned resolver called only for a valid, explicitly granted target. */
  resolve(host: string): Promise<readonly string[]>;
  /** Excludes host addresses and every project network, including public ranges. */
  destinationAllowed(address: string): Promise<boolean>;
  /** Recheck durable revision, current generation and sponsor authority at admission. */
  policyCurrent(snapshot: ProjectFenceSnapshot): Promise<boolean>;
  apply(script: string): Promise<void>;
  now?: () => number;
}
const LEASE_MS = 1000;
const tableName = (projectId: string): string =>
  'verity_egress_' + createHash('sha256').update(projectId).digest('hex').slice(0, 24);
const generationKey = (binding: ProjectFenceBinding): string =>
  binding.projectId + ':' + binding.generation;
const hexId = /^[a-f0-9]{64}$/u;
function validateBinding(binding: ProjectFenceBinding): void {
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(binding.projectId) ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(binding.generation) ||
    ![binding.containerId, binding.networkId, binding.endpointId].every((id) => hexId.test(id)) ||
    !/^[a-zA-Z0-9_-]{1,15}$/u.test(binding.bridge) ||
    isIP(binding.ipv4) !== 4 ||
    isIP(binding.ipv6) !== 6
  )
    throw new Error('Invalid project fence binding');
}
function bindingKey(binding: ProjectFenceBinding): string {
  validateBinding(binding);
  return [
    binding.projectId,
    binding.generation,
    binding.containerId,
    binding.networkId,
    binding.endpointId,
    binding.bridge,
    binding.ipv4,
    binding.ipv6,
  ].join('|');
}
function publicAddress(address: string): boolean {
  if (!isIP(address)) return false;
  const parsed = ipaddr.parse(address);
  // Transition/mapped address forms are not a second path to a private target.
  return parsed.range() === 'unicast';
}
interface Lease {
  address: string;
  protocol: 'tcp' | 'udp';
  port: number;
  expiresAt: number;
}

/** One atomic nft transaction; never exempt established connections from current policy. */
export function projectFenceRules(
  binding: ProjectFenceBinding,
  leases: readonly Lease[],
  now: number,
  replace: boolean,
): string {
  validateBinding(binding);
  const table = tableName(binding.projectId + ':' + binding.generation);
  const commands = replace ? [`delete table inet ${table}`, `delete table bridge ${table}`] : [];
  const unique = new Map<string, Lease>();
  for (const lease of leases) {
    if (
      !publicAddress(lease.address) ||
      !['tcp', 'udp'].includes(lease.protocol) ||
      !Number.isInteger(lease.port) ||
      lease.port < 1 ||
      lease.port > 65535 ||
      !Number.isFinite(lease.expiresAt)
    )
      throw new Error('Invalid project fence lease');
    const address = ipaddr.parse(lease.address).toString();
    const key = `${address}|${lease.protocol}|${lease.port}`;
    const previous = unique.get(key);
    if (!previous || previous.expiresAt < lease.expiresAt) unique.set(key, { ...lease, address });
  }
  const elements = (family: number): string =>
    [...unique.values()]
      .filter((lease) => isIP(lease.address) === family && lease.expiresAt - now >= 1)
      .map(
        (lease) =>
          `${lease.address} . ${lease.protocol} . ${lease.port} timeout ${Math.min(LEASE_MS, Math.floor(lease.expiresAt - now))}ms`,
      )
      .join(', ');
  const sets = [4, 6]
    .map((f) => {
      const values = elements(f);
      return `set allow${f} { type ipv${f}_addr . inet_proto . inet_service; flags timeout;${values ? ` elements = { ${values} };` : ''} }`;
    })
    .join('\n');
  commands.push(`table inet ${table} {
${sets}
chain fence {
 ip saddr != ${binding.ipv4} drop
 ip6 saddr != ${binding.ipv6} drop
 ip daddr . meta l4proto . th dport @allow4 accept
 ip6 daddr . meta l4proto . th dport @allow6 accept
 counter drop
}
chain forward { type filter hook forward priority -200; policy accept; iifname "${binding.bridge}" jump fence; }
chain input { type filter hook input priority -200; policy accept;
 iifname "${binding.bridge}" ip6 hoplimit 255 icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } accept
 iifname "${binding.bridge}" counter drop
}
}`);
  // Routed inet hooks alone do not cover packets switched between bridge ports.
  commands.push(`table bridge ${table} {
chain forward { type filter hook forward priority -200; policy accept; meta ibrname "${binding.bridge}" counter drop; }
}`);
  return commands.join('\n') + '\n';
}

/** Host-owned instance only; it is not registered as a sandbox-callable API.
 * Lifecycle integration must install denial before starting workloads and restore
 * denial before daemon restart. This adapter alone does not supply that boot gate.
 */
export class ProjectEgressFence {
  private readonly active = new Map<string, { binding: ProjectFenceBinding; revision: number }>();
  private readonly retired = new Set<string>();
  private readonly bridges = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  constructor(private readonly deps: ProjectFenceDependencies) {
    this.now = deps.now ?? Date.now;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async verify(binding: ProjectFenceBinding): Promise<void> {
    if (bindingKey(await this.deps.inspect(binding)) !== bindingKey(binding))
      throw new Error('Project fence attachment changed');
  }
  prepare(binding: ProjectFenceBinding): Promise<void> {
    binding = { ...binding };
    return this.serialize(async () => {
      const key = bindingKey(binding);
      if (this.retired.has(generationKey(binding)))
        throw new Error('Retired project fence generation');
      const old = this.active.get(binding.projectId);
      if (old && bindingKey(old.binding) !== key && !this.retired.has(generationKey(old.binding)))
        throw new Error('Retire the previous generation first');
      if (this.bridges.has(binding.bridge) && this.bridges.get(binding.bridge) !== key)
        throw new Error('Use a fresh bridge for a new generation');
      for (const entry of this.active.values())
        if (
          entry.binding.projectId !== binding.projectId &&
          entry.binding.bridge === binding.bridge
        )
          throw new Error('Project fence bridge already bound');
      await this.verify(binding);
      await this.deps.apply(
        projectFenceRules(
          binding,
          [],
          this.now(),
          old !== undefined && bindingKey(old.binding) === key,
        ),
      );
      this.bridges.set(binding.bridge, key);
      this.active.set(binding.projectId, {
        binding: { ...binding },
        revision: old && bindingKey(old.binding) === key ? old.revision : -1,
      });
    });
  }
  refresh(snapshot: ProjectFenceSnapshot): Promise<void> {
    snapshot = structuredClone(snapshot);
    return this.serialize(async () => {
      const current = this.active.get(snapshot.binding.projectId);
      if (
        !current ||
        bindingKey(current.binding) !== bindingKey(snapshot.binding) ||
        this.retired.has(generationKey(snapshot.binding))
      )
        throw new Error('Inactive project fence generation');
      if (
        !Number.isSafeInteger(snapshot.revision) ||
        snapshot.revision < 0 ||
        snapshot.revision < current.revision ||
        snapshot.grants.length > 1000
      )
        throw new Error('Stale or invalid project fence policy');
      // Close old access before inspecting or resolving. A failing refresh cannot
      // keep its previous grants alive; kernel timeouts also bound a killed process.
      await this.deps.apply(projectFenceRules(current.binding, [], this.now(), true));
      current.revision = snapshot.revision;
      await this.verify(snapshot.binding);
      if (!(await this.deps.policyCurrent(snapshot)))
        throw new Error('Project fence authority changed');
      const leases: Lease[] = [];
      for (const grant of snapshot.grants) {
        if (
          grant.revokedAt !== undefined ||
          (grant.expiresAt !== null && grant.expiresAt <= this.now())
        )
          continue;
        if (grant.expiresAt !== null && !Number.isFinite(grant.expiresAt))
          throw new Error('Invalid grant expiry');
        const target = canonicalEgressTarget(grant.target);
        if (!(await this.deps.directTargetAllowed(target.host)))
          throw new Error('Destination requires a broker or system route');
        const addresses = isIP(target.host) ? [target.host] : await this.deps.resolve(target.host);
        if (
          !addresses.length ||
          addresses.length > 32 ||
          addresses.some((address) => !publicAddress(address))
        )
          throw new Error('Nonpublic project fence resolution');
        for (const address of addresses)
          if (!(await this.deps.destinationAllowed(address)))
            throw new Error('Protected project or host destination');
        const expiresAt = Math.min(grant.expiresAt ?? Infinity, this.now() + LEASE_MS);
        for (const address of addresses)
          leases.push({ address, protocol: target.protocol, port: target.port, expiresAt });
      }
      // Resolution may yield while Docker replaces an attachment. Recheck before admission.
      await this.verify(snapshot.binding);
      if (!(await this.deps.policyCurrent(snapshot)))
        throw new Error('Project fence authority changed');
      await this.deps.apply(projectFenceRules(snapshot.binding, leases, this.now(), true));
    });
  }
  retire(binding: ProjectFenceBinding): Promise<void> {
    binding = { ...binding };
    return this.serialize(async () => {
      const current = this.active.get(binding.projectId);
      if (!current || bindingKey(current.binding) !== bindingKey(binding))
        throw new Error('Inactive project fence generation');
      await this.deps.apply(projectFenceRules(binding, [], this.now(), true));
      this.retired.add(generationKey(binding));
      // Keep the deny-only table and attachment reservation until explicit host cleanup.
    });
  }
}

/** Must execute in the trusted host network namespace, never inside a project. */
export function applyProjectFenceRules(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/sbin/nft', ['-f', '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: 1000,
      killSignal: 'SIGKILL',
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    child.stderr.resume();
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('Project fence transaction failed')),
    );
    child.stdin.end(script);
  });
}
