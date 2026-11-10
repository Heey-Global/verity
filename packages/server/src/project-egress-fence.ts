import { transportRules, type EgressTransport } from './project-egress-transport.js';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { ProjectEgressResolution } from './project-egress-resolver.js';
import { canonicalEgressTarget, type EgressGrant, type EgressTarget } from '@verity/store';
import {
  projectDeadlineLease,
  type ProjectDeadlineEnforcer,
  type ProjectDeadlineLease,
} from './project-egress-deadline.js';

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
  /** Host-owned system grant ids: exempt from the project target inventory, and a
   * failed check excludes that grant alone instead of failing the refresh. */
  system?: readonly string[];
}
export interface ProjectFenceRelay {
  transport: EgressTransport;
  flowLabel: string;
}
export interface ProjectFenceDependencies {
  /** Only the trusted lifecycle owner may install this exact relay pair. */
  relay?: () => ProjectFenceRelay | undefined;
  /** Host restart must replace chains while retaining kernel expiry tombstones. */
  existing?: (binding: ProjectFenceBinding) => Promise<boolean>;
  /** Required suspend-aware guard; absence must never select a weaker executor. */
  deadline: ProjectDeadlineEnforcer;
  /** Trusted daemon inspection, not labels or a sandbox-provided attachment. */
  inspect(binding: ProjectFenceBinding): Promise<ProjectFenceBinding>;
  /** Must deny broker/system/overlapping destinations; absent classification denies. */
  directTargetAllowed(host: string): Promise<boolean>;
  /** Host-owned resolver called only for a valid, explicitly granted target. */
  resolve(host: string): Promise<ProjectEgressResolution>;
  /** Told when a host-owned system target was excluded from a refresh. */
  reportSystemFailure?(target: EgressTarget, error: unknown): void;
  /** Excludes host addresses and every project network, including public ranges. */
  destinationAllowed(address: string): Promise<boolean>;
  /** Recheck durable revision, current generation and sponsor authority at admission. */
  policyCurrent(snapshot: ProjectFenceSnapshot): Promise<boolean>;
  /** Must commit within 1000 ms of invocation or prevent the transaction entirely. */
  apply(script: string): Promise<void>;
  now?: () => number;
  /** Disposable timing evidence only; observations never select authorization. */
  observe?: (stage: string, durationMs: number) => void;
}
const LEASE_MS = 1000;
const APPLY_BUDGET_MS = 1000;
const tableName = (projectId: string): string =>
  'verity_egress_' + createHash('sha256').update(projectId).digest('hex').slice(0, 24);
const generationKey = (binding: ProjectFenceBinding): string =>
  binding.projectId + ':' + binding.generation;
const hexId = /^[a-f0-9]{64}$/u;
export function projectFenceTable(binding: ProjectFenceBinding): string {
  validateBinding(binding);
  return tableName(binding.projectId + ':' + binding.generation);
}
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
  admission?: ProjectDeadlineLease,
  relay?: ProjectFenceRelay,
  flowLabel = admission?.nonce,
): string {
  validateBinding(binding);
  const table = tableName(binding.projectId + ':' + binding.generation);
  // Keep expiry tombstones in the kernel for the entire generation. A packet
  // already past TC can update them after a userspace snapshot has been read.
  // Declaring each object first makes the flushes and the bridge deletion
  // succeed when an object is already absent. Otherwise one missing table
  // turns every later denial of this generation into a failed transaction.
  const commands = replace
    ? [
        `add table inet ${table}`,
        `add chain inet ${table} fence`,
        `add chain inet ${table} reply`,
        `add chain inet ${table} forward { type filter hook forward priority -200; policy accept; }`,
        `add chain inet ${table} input { type filter hook input priority -200; policy accept; }`,
        `add chain inet ${table} output { type filter hook output priority -200; policy accept; }`,
        ...[4, 6].map(
          (f) =>
            `add set inet ${table} allow${f} { type ipv${f}_addr . inet_proto . inet_service; flags timeout; }`,
        ),
        ...['fence', 'reply', 'forward', 'input', 'output'].map(
          (chain) => `flush chain inet ${table} ${chain}`,
        ),
        `flush set inet ${table} allow4`,
        `flush set inet ${table} allow6`,
        `add table bridge ${table}`,
        `delete table bridge ${table}`,
      ]
    : [];
  if (relay && relay.transport.sandbox.address !== binding.ipv4)
    throw new Error('Relay sandbox does not match direct binding');
  const network = { ...binding, networkName: '' };
  const relayRules = (family: 'inet' | 'bridge') =>
    relay ? transportRules(network, relay.transport, family, relay.flowLabel) : '';
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
  if (leases.length && !admission) throw new Error('Packet deadline is required for admission');
  if (
    admission &&
    (flowLabel === undefined || !/^[a-f0-9]{32}$/u.test(flowLabel) || /^0+$/u.test(flowLabel))
  )
    throw new Error('Invalid packet admission identity');
  // Numeric ct-label tokens name bit indices, not a raw bitmap literal.
  const bits = Array.from({ length: 128 }, (_, bit) => bit).filter(
    (bit) => (BigInt(`0x${flowLabel ?? '0'}`) & (1n << BigInt(bit))) !== 0n,
  );
  const label = bits.length ? `(${bits.join(' | ')})` : '(0 & 1)';
  const wall = admission?.authorityExpiresAt;
  if (wall !== undefined && wall !== null && (!Number.isSafeInteger(wall) || wall < 0))
    throw new Error('Invalid absolute packet expiry');
  const expiries: Array<number | null> =
    admission && wall !== null && wall !== undefined
      ? Object.keys(admission.authorityBootDeadlines).map(Number)
      : [null];
  if (wall != null && (!expiries.includes(wall) || Math.min(...expiries.map(Number)) !== wall))
    throw new Error('Invalid authority expiry set');
  const deadlines = expiries.map((expiry) => {
    if (expiry !== null && (!Number.isSafeInteger(expiry) || expiry < 0))
      throw new Error('Invalid absolute packet expiry');
    return {
      identity: createHash('sha256')
        .update(expiry === null ? 'standing' : String(expiry))
        .digest('hex')
        .slice(0, 16),
      // nft date syntax rounds down, so permission can only close early.
      date:
        expiry === null
          ? null
          : new Date(Math.floor(expiry / 1000) * 1000).toISOString().slice(0, 19).replace('T', ' '),
    };
  });
  const expirySets = deadlines
    .flatMap(({ identity }) =>
      [4, 6].map(
        (family) =>
          `set expired${family}_${identity} { type ipv${family}_addr; flags dynamic; size 1; }`,
      ),
    )
    .join('\n');
  const expiry = (reverse: boolean): string =>
    [4, 6]
      .map((family) => {
        const ip = family === 4 ? 'ip' : 'ip6';
        const source = `${ip} ${reverse ? 'daddr' : 'saddr'} ${family === 4 ? binding.ipv4 : binding.ipv6}`;
        const identityAddress = family === 4 ? binding.ipv4 : binding.ipv6;
        const identityField = `${ip} ${reverse ? 'daddr' : 'saddr'}`;
        // Latch every represented authority before any earlier-expiry drop. An
        // in-flight packet must retain B's expiry even after A's rules are replaced.
        const latch = deadlines
          .filter(({ date }) => date !== null)
          .map(
            ({ identity, date }) =>
              `${source} meta time >= "${date}" add @expired${family}_${identity} { ${identityAddress} }`,
          );
        const reject = deadlines.map(
          ({ identity }) =>
            `${source} ${identityField} @expired${family}_${identity} counter name expired drop`,
        );
        const wallReject = deadlines
          .filter(({ date }) => date !== null)
          .map(({ date }) => `${source} meta time >= "${date}" counter name expired drop`);
        return [...latch, ...wallReject, ...reject].join('\n') + '\n';
      })
      .join('');
  commands.push(`table inet ${table} {
${sets}
${expirySets}
counter expired { }
chain fence {
 ip saddr != ${binding.ipv4} drop
 ip6 saddr != ${binding.ipv6} drop
 ${expiry(false)}
 ct state new ct label == (0 & 1) tcp flags & (syn | ack | rst | fin) == syn ct label set ${label}
 ct state new ct label == (0 & 1) meta l4proto udp ct label set ${label}
 ct direction original ct label == ${label} ip daddr . meta l4proto . th dport @allow4 accept
 ct direction original ct label == ${label} ip6 daddr . meta l4proto . th dport @allow6 accept
 counter drop
}
chain reply {
 ip daddr != ${binding.ipv4} drop
 ip6 daddr != ${binding.ipv6} drop
 ${expiry(true)}
 ct direction reply ct label == ${label} ip saddr . meta l4proto . th sport @allow4 accept
 ct direction reply ct label == ${label} ip6 saddr . meta l4proto . th sport @allow6 accept
 counter drop
}
chain forward { type filter hook forward priority -200; policy accept; ${relayRules('inet')} iifname "${binding.bridge}" jump fence; oifname "${binding.bridge}" jump reply; }
chain output { type filter hook output priority -200; policy accept;
 oifname "${binding.bridge}" ip6 hoplimit 255 icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } accept
 oifname "${binding.bridge}" jump reply
}
chain input { type filter hook input priority -200; policy accept;
 iifname "${binding.bridge}" ip6 hoplimit 255 icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } accept
 iifname "${binding.bridge}" counter drop
}
}`);
  // Routed inet hooks alone do not cover packets switched between bridge ports.
  commands.push(`table bridge ${table} {
chain forward { type filter hook forward priority -200; policy accept; ${relayRules('bridge')} meta ibrname "${binding.bridge}" counter drop; }
}`);
  return commands.join('\n') + '\n';
}

/** Host-owned instance only; it is not registered as a sandbox-callable API.
 * Lifecycle integration must install denial before starting workloads and restore
 * denial before daemon restart. This adapter alone does not supply that boot gate.
 */
export class ProjectEgressFence {
  private readonly active = new Map<
    string,
    {
      binding: ProjectFenceBinding;
      revision: number;
      continuity?: {
        lease: ProjectDeadlineLease;
        flowLabel: string;
        grants: string;
        validUntil: number;
        targets: string;
        /** Granted hostnames and exactly the addresses admitted for them. */
        names: ReadonlyMap<string, readonly string[]>;
      };
    }
  >();
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
  private async deny(binding: ProjectFenceBinding, next?: ProjectDeadlineLease): Promise<void> {
    const active = this.active.get(binding.projectId);
    if (active) delete active.continuity;
    try {
      await this.deps.deadline.revoke(binding, next);
    } finally {
      await this.deps.apply(
        projectFenceRules(binding, [], this.now(), true, undefined, this.deps.relay?.()),
      );
    }
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
      try {
        await this.deps.deadline.prepare(binding);
      } finally {
        await this.deps.apply(
          projectFenceRules(
            binding,
            [],
            this.now(),
            (old !== undefined && bindingKey(old.binding) === key) ||
              ((await this.deps.existing?.(binding)) ?? false),
            undefined,
            this.deps.relay?.(),
          ),
        );
      }
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
      let observed = performance.now();
      const observe = (stage: string) => {
        const now = performance.now();
        this.deps.observe?.(stage, now - observed);
        observed = now;
      };
      // Capture before inspection, classification, DNS or either executor can pause.
      let admission: ProjectDeadlineLease;
      let capturedRealNs: bigint;
      let continuity: (typeof current)['continuity'];
      let authority: ProjectFenceSnapshot['grants'];
      try {
        const sample = await this.deps.deadline.clock();
        capturedRealNs = BigInt(sample.realNs);
        const capturedAt = Number(capturedRealNs / 1_000_000n);
        continuity =
          this.deps.deadline.renew &&
          current.continuity &&
          current.revision === snapshot.revision &&
          current.continuity.grants === JSON.stringify(snapshot.grants) &&
          current.continuity.lease.bootId === sample.bootId &&
          current.continuity.validUntil > capturedAt &&
          BigInt(current.continuity.lease.bootDeadlineNs) > BigInt(sample.bootAfterNs)
            ? current.continuity
            : undefined;
        authority = snapshot.grants.filter(
          (grant) =>
            grant.revokedAt === undefined &&
            (grant.expiresAt === null || grant.expiresAt > capturedAt),
        );
        const expiry = authority.reduce<number | null>(
          (earliest, grant) =>
            grant.expiresAt === null
              ? earliest
              : earliest === null
                ? grant.expiresAt
                : Math.min(earliest, grant.expiresAt),
          null,
        );
        admission = projectDeadlineLease(
          snapshot.binding,
          snapshot.revision,
          expiry,
          sample,
          authority.flatMap((grant) => (grant.expiresAt === null ? [] : [grant.expiresAt])),
        );
      } catch (error) {
        await this.deny(current.binding);
        throw error;
      }
      observe('lease-capture');
      // Close old access before inspecting or resolving. A failing refresh cannot
      // keep its previous grants alive; kernel timeouts also bound a killed process.
      if (!continuity) await this.deny(current.binding, admission);
      observe('prior-denial');
      current.revision = snapshot.revision;
      await this.verify(snapshot.binding);
      if (!(await this.deps.policyCurrent(snapshot)))
        throw new Error('Project fence authority changed');
      observe('initial-inspection-policy');
      const leases: Lease[] = [];
      const names = new Map<string, string[]>();
      const system = new Set(snapshot.system ?? []);
      // Never reconsider excluded grants after an asynchronous wall-clock rollback.
      for (const grant of authority) {
        const admitted: Lease[] = [];
        const named: string[] = [];
        try {
          if (
            grant.revokedAt !== undefined ||
            (grant.expiresAt !== null && grant.expiresAt <= this.now())
          )
            continue;
          if (grant.expiresAt !== null && !Number.isFinite(grant.expiresAt))
            throw new Error('Invalid grant expiry');
          const target = canonicalEgressTarget(grant.target);
          if (!system.has(grant.id) && !(await this.deps.directTargetAllowed(target.host)))
            throw new Error('Destination requires a broker or system route');
          const resolution = isIP(target.host)
            ? { addresses: [target.host], expiresAt: Infinity }
            : await this.deps.resolve(target.host);
          const { addresses } = resolution;
          if (
            !addresses.length ||
            addresses.length > 32 ||
            addresses.some((address) => !publicAddress(address)) ||
            (!isIP(target.host) &&
              (!Number.isSafeInteger(resolution.expiresAt) || resolution.expiresAt <= this.now()))
          )
            throw new Error('Nonpublic project fence resolution');
          for (const address of addresses)
            if (!(await this.deps.destinationAllowed(address)))
              throw new Error('Protected project or host destination');
          const expiresAt = Math.min(
            (grant.expiresAt ?? Infinity) - APPLY_BUDGET_MS,
            resolution.expiresAt - APPLY_BUDGET_MS,
            this.now() + LEASE_MS,
          );
          for (const address of addresses)
            admitted.push({ address, protocol: target.protocol, port: target.port, expiresAt });
          if (!isIP(target.host)) named.push(target.host, ...addresses);
        } catch (error) {
          // A host-owned system target never takes the project's own grants down.
          if (system.has(grant.id)) {
            this.deps.reportSystemFailure?.(grant.target, error);
            continue;
          }
          throw error;
        }
        leases.push(...admitted);
        const [host, ...addresses] = named;
        if (host) names.set(host, [...new Set([...(names.get(host) ?? []), ...addresses])]);
      }
      const targets = JSON.stringify(
        leases.map((lease) => [lease.address, lease.protocol, lease.port]).sort(),
      );
      if (continuity && continuity.targets !== targets) {
        continuity = undefined;
        await this.deny(current.binding, admission);
      }
      if (this.deps.deadline.renew && leases.length) {
        // A continuous epoch must not outlive its earliest DNS/tuple budget.
        // Make that budget part of the kernel lease, not a userspace precheck.
        const tupleBudget =
          BigInt(Math.floor(Math.min(...leases.map((lease) => lease.expiresAt)))) * 1_000_000n -
          capturedRealNs;
        const tupleDeadline =
          tupleBudget > 0n ? BigInt(admission.capturedBootNs) + tupleBudget : 0n;
        if (tupleDeadline < BigInt(admission.bootDeadlineNs))
          admission = Object.freeze({ ...admission, bootDeadlineNs: tupleDeadline.toString() });
      }
      observe('resolution-classification');
      // Resolution may yield while Docker replaces an attachment. Recheck before admission.
      await this.verify(snapshot.binding);
      if (!(await this.deps.policyCurrent(snapshot)))
        throw new Error('Project fence authority changed');
      observe('final-inspection-policy');
      await this.deps.apply(
        projectFenceRules(
          snapshot.binding,
          leases,
          this.now(),
          true,
          admission,
          this.deps.relay?.(),
          continuity?.flowLabel ?? admission.nonce,
        ),
      );
      observe('nft-commit');
      try {
        // A lifecycle change can arrive while the kernel transaction is pending.
        // Do not arm its TC guard after that transaction lost its authority.
        if (!(await this.deps.policyCurrent(snapshot)))
          throw new Error('Project fence authority changed');
        if (leases.length) {
          try {
            if (continuity)
              await this.deps.deadline.renew!(
                snapshot.binding,
                admission,
                continuity.lease.bootDeadlineNs,
              );
            else await this.deps.deadline.arm(snapshot.binding, admission);
          } finally {
            observe('kernel-admission');
          }
          if (!(await this.deps.policyCurrent(snapshot)))
            throw new Error('Project fence authority changed');
          observe('committed-policy');
          current.continuity = {
            lease: admission,
            flowLabel: continuity?.flowLabel ?? admission.nonce,
            grants: JSON.stringify(snapshot.grants),
            validUntil: Math.min(...leases.map((lease) => lease.expiresAt)),
            targets,
            names,
          };
        }
      } catch (error) {
        await this.deny(snapshot.binding);
        throw error;
      }
    });
  }
  /** Addresses currently admitted for a granted hostname of this exact generation.
   * Read-only: it never renews, resolves or extends authority. A short TTL keeps a
   * sandbox from caching an answer beyond the admission it describes.
   */
  admitted(
    binding: ProjectFenceBinding,
    host: string,
  ): { addresses: readonly string[]; ttlSeconds: number } | undefined {
    const current = this.active.get(binding.projectId);
    const continuity = current?.continuity;
    const remaining = (continuity?.validUntil ?? 0) - this.now();
    if (
      !current ||
      !continuity ||
      bindingKey(current.binding) !== bindingKey(binding) ||
      this.retired.has(generationKey(binding)) ||
      remaining <= 0
    )
      return undefined;
    const addresses = continuity.names.get(host);
    if (!addresses?.length) return undefined;
    // Several grants for one name may union beyond one DNS answer; any subset is
    // admitted, so keep up to 16 of each family rather than starving one of them.
    return {
      addresses: [4, 6].flatMap((family) =>
        addresses.filter((address) => isIP(address) === family).slice(0, 16),
      ),
      ttlSeconds: Math.max(1, Math.min(5, Math.floor(remaining / 1000))),
    };
  }
  retire(binding: ProjectFenceBinding): Promise<void> {
    binding = { ...binding };
    return this.serialize(async () => {
      const current = this.active.get(binding.projectId);
      if (!current || bindingKey(current.binding) !== bindingKey(binding))
        throw new Error('Inactive project fence generation');
      await this.deny(binding);
      this.retired.add(generationKey(binding));
      // Keep the deny-only table and attachment reservation until explicit host cleanup.
    });
  }
  /** Close access before loading replacement authority, without retiring identity. */
  revoke(binding: ProjectFenceBinding): Promise<void> {
    binding = { ...binding };
    return this.serialize(async () => {
      const current = this.active.get(binding.projectId);
      if (
        !current ||
        bindingKey(current.binding) !== bindingKey(binding) ||
        this.retired.has(generationKey(binding))
      )
        throw new Error('Inactive project fence generation');
      await this.deny(binding);
    });
  }
}

/** Bounded evidence for one failed nft transaction. It carries nft's own error
 * messages and the line they name, never the rule text that nft echoes back:
 * that echo can contain addresses, labels and deadlines of the project policy. */
export interface ProjectFenceTransactionEvidence {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  /** The one-second budget elapsed and nft was killed; the kernel may or may
   * not have committed, so the caller must treat the state as unknown. */
  timedOut: boolean;
  /** Error messages reported by nft, each as `line N: message` when located. */
  diagnostics: string[];
  /** Commands named by a located error, only when they are bare table, chain
   * or set operations whose text cannot carry policy. */
  statements: string[];
  stderrBytes: number;
  /** nft could not be started at all (ENOENT, EAGAIN, ENOMEM ...). */
  spawnError?: string;
  /** nft stopped reading its script before the end, e.g. after a parse error. */
  stdinError?: string;
}
const STDERR_LIMIT = 8192;
const MAX_DIAGNOSTICS = 4;
const SAFE_STATEMENT =
  /^(?:(?:add|delete|flush) (?:table|chain|set) (?:inet|bridge|ip|ip6) [a-z0-9_]{1,64}(?: [a-z0-9_]{1,64})?|table (?:inet|bridge) [a-z0-9_]{1,64}) ?\{?$/u;
const printable = (value: string, limit: number) =>
  value
    .replace(/[^\x20-\x7e‘’]/gu, '?')
    .trim()
    .slice(0, limit);

/** Reduce nft stderr to its located error messages. Lines nft echoes from the
 * script and its caret markers are dropped; unrecognised output is withheld. */
export function projectFenceDiagnostics(
  stderr: string,
  script: string,
): Pick<ProjectFenceTransactionEvidence, 'diagnostics' | 'statements'> {
  const lines = script.split('\n');
  const diagnostics: string[] = [];
  const statements: string[] = [];
  for (const line of stderr.split('\n')) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
    const located = /^[^:\n]{0,256}:(\d{1,7}):[\d-]{1,32}: Error: (.+)$/u.exec(line);
    if (located) {
      const number = Number(located[1]);
      diagnostics.push(`line ${number}: ${printable(located[2]!, 200)}`);
      const statement = lines[number - 1]?.trim() ?? '';
      const bare = statement.replace(/ ?\{$/u, '');
      if (SAFE_STATEMENT.test(statement) && !statements.includes(bare)) statements.push(bare);
      continue;
    }
    const general = /^(?:[a-z]{1,16}: )?Error: (.+)$/u.exec(line);
    if (general) diagnostics.push(printable(general[1]!, 200));
  }
  return { diagnostics, statements };
}

export class ProjectFenceTransactionError extends Error {
  constructor(readonly evidence: ProjectFenceTransactionEvidence) {
    const summary = [
      evidence.timedOut
        ? `timed out after ${Math.round(evidence.durationMs)} ms`
        : evidence.spawnError
          ? `nft could not start: ${evidence.spawnError}`
          : `exit ${evidence.exitCode ?? 'none'}${evidence.signal ? ` signal ${evidence.signal}` : ''}`,
      ...evidence.diagnostics.slice(0, 2),
    ].join('; ');
    super(`Project fence transaction failed (${summary})`);
    this.name = 'ProjectFenceTransactionError';
  }
}

/** Must execute in the trusted host network namespace, never inside a project. */
export function applyProjectFenceRules(
  script: string,
  options: { executable?: string; budgetMs?: number } = {},
): Promise<void> {
  const budget = options.budgetMs ?? APPLY_BUDGET_MS;
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let timedOut = false;
    let stdinError: string | undefined;
    let stderrBytes = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (fields: Partial<ProjectFenceTransactionEvidence>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(chunks).toString('utf8');
      reject(
        new ProjectFenceTransactionError({
          exitCode: null,
          signal: null,
          durationMs: performance.now() - started,
          timedOut,
          stderrBytes,
          ...projectFenceDiagnostics(stderr, script),
          ...(stdinError ? { stdinError } : {}),
          ...fields,
        }),
      );
    };
    const child = spawn(options.executable ?? '/usr/sbin/nft', ['-f', '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', TZ: 'UTC' },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, budget);
    child.stderr.on('data', (chunk: Buffer) => {
      const room = STDERR_LIMIT - Math.min(STDERR_LIMIT, stderrBytes);
      stderrBytes += chunk.length;
      if (room > 0) chunks.push(chunk.subarray(0, room));
    });
    child.once('error', (error: NodeJS.ErrnoException) =>
      fail({ spawnError: error.code ?? 'unknown' }),
    );
    // nft closes its input early after a parse error. That is not the failure
    // itself; the exit status and nft's own message are reported on close.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      stdinError = error.code ?? 'unknown';
    });
    child.once('close', (code, signal) => {
      // A script nft did not read completely was not committed as written.
      if (code === 0 && !timedOut && stdinError === undefined) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
        return;
      }
      fail({ exitCode: code, signal });
    });
    child.stdin.end(script);
  });
}
