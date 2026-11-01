import {
  transportRules,
  directCorridorRules,
  type EgressDirectCorridor,
  type EgressTransport,
} from './project-egress-transport.js';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u);
const objectId = z.string().regex(/^[a-f0-9]{64}$/u);
const networkBinding = z.strictObject({
  projectId: identity,
  generation: identity,
  networkId: objectId,
  networkName: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u),
  bridge: z.string().regex(/^vep[a-f0-9]{12}$/u),
});
const reference = { projectId: identity, generation: identity };
export const projectEgressHostRequest = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('current'), projectId: identity }),
  z.strictObject({ operation: z.literal('register'), binding: networkBinding }),
  z.strictObject({ operation: z.literal('prepare'), ...reference }),
  z.strictObject({ operation: z.literal('connect'), ...reference }),
  z.strictObject({ operation: z.literal('refresh-direct'), ...reference }),
  z.strictObject({ operation: z.literal('revoke-direct'), ...reference }),
  z.strictObject({
    operation: z.literal('start'),
    ...reference,
    role: z.enum(['sandbox', 'relay']),
    containerId: objectId,
  }),
  z.strictObject({ operation: z.literal('retire'), ...reference }),
]);
export const projectEgressHostResponse = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('current'),
    projectId: identity,
    binding: networkBinding.nullable(),
    packetEnforcement: z.boolean().optional(),
  }),
  z.strictObject({
    state: z.enum(['denied', 'started-denied', 'retired', 'direct-refreshed', 'direct-revoked']),
    generation: identity,
  }),
  z.strictObject({
    state: z.enum(['connected', 'started-connected']),
    generation: identity,
    relayAddress: z.ipv4(),
    directAuthority: z.boolean().optional(),
  }),
]);
export type ProjectEgressHostResponse = z.infer<typeof projectEgressHostResponse>;
export type ProjectEgressHostRequest = z.infer<typeof projectEgressHostRequest>;
export type ProjectEgressNetworkBinding = z.infer<typeof networkBinding>;
const recordSchema = z.strictObject({
  binding: networkBinding,
  retired: z.boolean(),
  bootId: z.uuid().optional(),
  containers: z.strictObject({ sandbox: objectId.optional(), relay: objectId.optional() }),
});
export const projectEgressHostState = z.strictObject({
  version: z.literal(1),
  records: z.array(recordSchema).max(10000),
});
export type ProjectEgressHostState = z.infer<typeof projectEgressHostState>;
type RecordState = z.infer<typeof recordSchema>;
const containerIds = (record: RecordState): string[] =>
  Object.values(record.containers).filter((id): id is string => id !== undefined);
export interface ProjectEgressHostEnforcement {
  directAuthority(binding: ProjectEgressNetworkBinding): boolean;
  invalidate(binding: { projectId: string; generation: string }): void;
  connect(
    binding: ProjectEgressNetworkBinding,
    ids: { sandbox: string; relay: string },
    relay: { transport: EgressTransport; flowLabel: string },
  ): Promise<EgressDirectCorridor>;
  deny(binding: ProjectEgressNetworkBinding): Promise<void>;
  refresh(binding: ProjectEgressNetworkBinding): Promise<void>;
  revoke(binding: ProjectEgressNetworkBinding): Promise<void>;
}
interface Dependencies {
  bootId?: string;
  enforcement?: ProjectEgressHostEnforcement;
  save(state: ProjectEgressHostState): Promise<void>;
  apply(script: string): Promise<void>;
  inspectNetwork(
    binding: ProjectEgressNetworkBinding,
    allowedContainers: readonly string[],
  ): Promise<void>;
  inspectContainer(
    binding: ProjectEgressNetworkBinding,
    id: string,
    role: 'sandbox' | 'relay',
    restoring?: boolean,
  ): Promise<void>;
  /** A fresh, phase-local batch that performs all role, network and transport checks. */
  inspectDirectTransport?(
    binding: ProjectEgressNetworkBinding,
    ids: { sandbox: string; relay: string },
  ): Promise<EgressTransport | undefined>;
  inspectTransport?(
    binding: ProjectEgressNetworkBinding,
    ids: { sandbox: string; relay: string },
  ): Promise<EgressTransport | undefined>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string): Promise<void>;
}
const key = (binding: { projectId: string; generation: string }): string =>
  `${binding.projectId}:${binding.generation}`;

/** Reserved bridge prefix is denied even before a generation is registered. */
export function projectEgressBootstrapRules(
  active: readonly {
    binding: ProjectEgressNetworkBinding;
    transport: EgressTransport;
    flowLabel: string;
    direct?: EgressDirectCorridor;
  }[] = [],
): string {
  const allowed = (family: 'inet' | 'bridge') =>
    active
      .map(
        ({ binding, transport, flowLabel, direct }) =>
          transportRules(networkBinding.parse(binding), transport, family, flowLabel) +
          directCorridorRules(binding, transport, direct, 'forward', family),
      )
      .join('\n');
  const input = (family: 'inet' | 'bridge') =>
    active
      .map(({ binding, transport, direct }) =>
        directCorridorRules(binding, transport, direct, 'input', family),
      )
      .join('\n');
  return `add table inet verity_egress_boot
  delete table inet verity_egress_boot
  table inet verity_egress_boot {
    chain forward { type filter hook forward priority -220; policy accept; ${allowed('inet')} iifname "vep*" counter drop; oifname "vep*" counter drop; }
    chain input { type filter hook input priority -220; policy accept; ${input('inet')} iifname "vep*" counter drop; }
  }
  add table bridge verity_egress_boot
  delete table bridge verity_egress_boot
  table bridge verity_egress_boot {
    chain forward { type filter hook forward priority -220; policy accept; ${allowed('bridge')} meta ibrname "vep*" counter drop; meta obrname "vep*" counter drop; }
    chain input { type filter hook input priority -220; policy accept; ${input('bridge')} meta ibrname "vep*" counter drop; }
  }
`;
}

/** Denial does not depend on endpoints, which Docker may allocate only at start.
 * Replacing both tables in one transaction also restores denial after a restart.
 * These tables remain until explicit, trusted host cleanup, including retirement.
 */
export function projectEgressStartupRules(
  binding: ProjectEgressNetworkBinding,
  admission?: { transport: EgressTransport; flowLabel: string; direct?: EgressDirectCorridor },
): string {
  networkBinding.parse(binding);
  const table =
    'verity_start_' + createHash('sha256').update(key(binding)).digest('hex').slice(0, 24);
  return `add table inet ${table}
delete table inet ${table}
table inet ${table} {
 chain forward { type filter hook forward priority -210; policy accept; ${admission ? transportRules(binding, admission.transport, 'inet', admission.flowLabel) + directCorridorRules(binding, admission.transport, admission.direct, 'forward', 'inet') : ''} iifname "${binding.bridge}" counter drop; oifname "${binding.bridge}" counter drop; }
 chain input { type filter hook input priority -210; policy accept; ${admission ? directCorridorRules(binding, admission.transport, admission.direct, 'input', 'inet') : ''} iifname "${binding.bridge}" counter drop; }
}
add table bridge ${table}
delete table bridge ${table}
table bridge ${table} {
 chain forward { type filter hook forward priority -210; policy accept; ${admission ? transportRules(binding, admission.transport, 'bridge', admission.flowLabel) : ''} meta ibrname "${binding.bridge}" counter drop; meta obrname "${binding.bridge}" counter drop; }
}
`;
}

/** Trusted host process only. No supplied labels, commands, rules or destinations.
 * Only inspected Sandbox-to-relay service ports can cross the startup fence.
 * General network admission and production activation remain separate gates.
 */
export class ProjectEgressHost {
  private state: ProjectEgressHostState;
  private queue: Promise<unknown> = Promise.resolve();
  private healthy = true;
  private readonly transports = new Map<
    string,
    {
      binding: ProjectEgressNetworkBinding;
      transport: EgressTransport;
      flowLabel: string;
      direct?: EgressDirectCorridor;
    }
  >();
  constructor(
    state: unknown,
    private readonly deps: Dependencies,
  ) {
    this.state = projectEgressHostState.parse(state);
    const generations = new Set<string>();
    const bridges = new Set<string>();
    const networks = new Set<string>();
    const containers = new Set<string>();
    const projects = new Set<string>();
    for (const record of this.state.records) {
      if (
        generations.has(key(record.binding)) ||
        bridges.has(record.binding.bridge) ||
        networks.has(record.binding.networkId) ||
        (!record.retired && projects.has(record.binding.projectId))
      )
        throw new Error('Conflicting host registry');
      generations.add(key(record.binding));
      bridges.add(record.binding.bridge);
      networks.add(record.binding.networkId);
      if (!record.retired) projects.add(record.binding.projectId);
      for (const id of containerIds(record)) {
        if (containers.has(id)) throw new Error('Conflicting container registration');
        containers.add(id);
      }
    }
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(async () => {
      if (!this.healthy) throw new Error('Host registry requires restart');
      return action();
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  private async save(): Promise<void> {
    try {
      await this.deps.save(structuredClone(this.state));
    } catch (error) {
      this.healthy = false;
      throw error;
    }
  }
  /** Reject queued/new commands before waiting for any in-flight kernel write. */
  shutdown(): Promise<void> {
    this.healthy = false;
    for (const record of this.state.records) this.deps.enforcement?.invalidate(record.binding);
    return this.queue.then(async () => {
      this.transports.clear();
      try {
        await this.deps.apply(projectEgressBootstrapRules());
        for (const record of this.state.records) await this.deps.enforcement?.deny(record.binding);
      } catch (error) {
        const stopped = await Promise.allSettled(
          this.state.records.flatMap(containerIds).map((id) => this.deps.stopContainer(id)),
        );
        throw new AggregateError(
          [
            error,
            ...stopped.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : [])),
          ],
          'Host shutdown denial failed; containment attempted',
          { cause: error },
        );
      }
    });
  }
  /** Must finish before opening the control socket; does not require Docker. */
  restore(retireGenerations = false): Promise<void> {
    return this.serialize(async () => {
      this.transports.clear();
      try {
        await this.deps.apply(projectEgressBootstrapRules());
        let changed = false;
        for (const record of this.state.records) {
          await this.deps.apply(projectEgressStartupRules(record.binding));
          if (
            !record.retired &&
            (retireGenerations ||
              (this.deps.bootId !== undefined && record.bootId !== this.deps.bootId))
          ) {
            record.retired = true;
            changed = true;
          }
        }
        if (changed) await this.save();
      } catch (error) {
        this.healthy = false;
        const stopped = await Promise.allSettled(
          this.state.records.flatMap(containerIds).map((id) => this.deps.stopContainer(id)),
        );
        throw new AggregateError(
          [
            error,
            ...stopped.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : [])),
          ],
          'Host restoration failed; containment attempted',
          { cause: error },
        );
      }
    });
  }
  /** Docker is available here; boot-time restore remains independent of the daemon. */
  revalidate(): Promise<void> {
    return this.serialize(async () => {
      const failures: unknown[] = [];
      for (const record of this.state.records) {
        await this.deny(record);
        if (record.retired) continue;
        for (const role of ['sandbox', 'relay'] as const) {
          const id = record.containers[role];
          if (!id) continue;
          try {
            await this.deps.inspectContainer(record.binding, id, role, true);
            await this.deps.inspectNetwork(record.binding, containerIds(record));
          } catch (error) {
            failures.push(error);
            try {
              await this.deps.stopContainer(id);
            } catch (stopError) {
              failures.push(stopError);
            }
          }
        }
      }
      if (failures.length) {
        this.healthy = false;
        throw new AggregateError(
          failures,
          'Restored container binding mismatch; containment attempted',
        );
      }
    });
  }
  execute(input: unknown): Promise<ProjectEgressHostResponse> {
    const request = projectEgressHostRequest.parse(input);
    if (request.operation !== 'current' && request.operation !== 'refresh-direct')
      this.deps.enforcement?.invalidate(
        request.operation === 'register' ? request.binding : request,
      );
    return this.serialize(async () => {
      if (request.operation === 'current') {
        const record = this.state.records.find(
          (record) => !record.retired && record.binding.projectId === request.projectId,
        );
        // Read authority, not health: querying must not alter rules or renew a lease.
        return {
          state: 'current',
          projectId: request.projectId,
          binding: record === undefined ? null : structuredClone(record.binding),
          ...(this.deps.enforcement ? { packetEnforcement: true } : {}),
        };
      }
      if (request.operation === 'register') {
        const existing = this.state.records.find(
          (record) => key(record.binding) === key(request.binding),
        );
        if (existing) {
          if (
            existing.retired ||
            JSON.stringify(existing.binding) !== JSON.stringify(request.binding)
          )
            throw new Error('Generation already reserved');
          await this.prepare(existing);
          return { state: 'denied', generation: existing.binding.generation };
        }
        if (this.state.records.length >= 10000) throw new Error('Host registry capacity exceeded');
        if (
          this.state.records.some(
            (record) =>
              record.binding.bridge === request.binding.bridge ||
              record.binding.networkId === request.binding.networkId ||
              (!record.retired && record.binding.projectId === request.binding.projectId),
          )
        )
          throw new Error('Retire the existing generation and use a fresh network');
        await this.deps.inspectNetwork(request.binding, []);
        const record: RecordState = {
          binding: request.binding,
          retired: false,
          containers: {},
          ...(this.deps.bootId === undefined ? {} : { bootId: this.deps.bootId }),
        };
        this.state.records.push(record);
        // Reserve durably before any successful response or process start.
        await this.save();
        await this.prepare(record);
        return { state: 'denied', generation: record.binding.generation };
      }
      const record = this.state.records.find((record) => key(record.binding) === key(request));
      if (!record) throw new Error('Unknown generation');
      if (request.operation === 'retire') {
        await this.deny(record);
        record.retired = true;
        await this.save();
        // A failed stop leaves a permanent deny fence and cannot reactivate.
        const stopped = await Promise.allSettled(
          containerIds(record).map((id) =>
            Promise.resolve().then(() => this.deps.stopContainer(id)),
          ),
        );
        const failures = stopped.flatMap((result) =>
          result.status === 'rejected' ? [result.reason as unknown] : [],
        );
        if (failures.length)
          throw new AggregateError(failures, 'Generation retired; container stop failed');
        return { state: 'retired', generation: record.binding.generation };
      }
      if (record.retired) throw new Error('Retired generation');
      if (request.operation === 'prepare') {
        await this.prepare(record);
        return { state: 'denied', generation: record.binding.generation };
      }
      if (request.operation === 'refresh-direct' || request.operation === 'revoke-direct') {
        if (!this.deps.enforcement || !this.transports.has(key(record.binding)))
          throw new Error('Direct enforcement is not ready');
        const verifyTransport = async () => {
          const ids = { sandbox: record.containers.sandbox!, relay: record.containers.relay! };
          const transport = this.deps.inspectDirectTransport
            ? await this.deps.inspectDirectTransport(record.binding, ids)
            : await (async () => {
                for (const role of ['sandbox', 'relay'] as const)
                  await this.deps.inspectContainer(record.binding, record.containers[role]!, role);
                await this.deps.inspectNetwork(record.binding, containerIds(record));
                return await this.deps.inspectTransport?.(record.binding, {
                  sandbox: record.containers.sandbox!,
                  relay: record.containers.relay!,
                });
              })();
          if (
            JSON.stringify(transport) !==
            JSON.stringify(this.transports.get(key(record.binding))!.transport)
          )
            throw new Error('Direct transport changed');
        };
        let directContained = false;
        try {
          if (request.operation === 'revoke-direct')
            await this.deps.enforcement.revoke(record.binding);
          else {
            await verifyTransport();
            try {
              await this.deps.enforcement.refresh(record.binding);
            } catch (error) {
              // Authority failures close direct access while preserving the checked relay.
              // A topology change or failed containment still closes both paths below.
              await verifyTransport();
              await this.deps.enforcement.revoke(record.binding);
              directContained = true;
              throw error;
            }
          }
        } catch (error) {
          if (!directContained) await this.deny(record);
          throw error;
        }
        return {
          state: request.operation === 'refresh-direct' ? 'direct-refreshed' : 'direct-revoked',
          generation: record.binding.generation,
        };
      }
      if (request.operation === 'connect') {
        await this.prepare(record);
        const transport = await this.connect(record);
        if (!transport) throw new Error('Both transport roles must be running');
        return {
          state: 'connected',
          generation: record.binding.generation,
          relayAddress: transport.relay.address,
          ...(this.deps.enforcement?.directAuthority(record.binding)
            ? { directAuthority: true }
            : {}),
        };
      }
      // Revoke even when a changed role/image fails the first validation.
      await this.deny(record);
      const prior = record.containers[request.role];
      if (
        (prior !== undefined && prior !== request.containerId) ||
        this.state.records.some((other) =>
          Object.entries(other.containers).some(
            ([role, id]) =>
              id === request.containerId && (other !== record || role !== request.role),
          ),
        )
      )
        throw new Error('Container identity already reserved');
      await this.deps.inspectContainer(record.binding, request.containerId, request.role);
      record.containers[request.role] = request.containerId;
      await this.save();
      await this.prepare(record);
      // This inspection and Docker start share the same serialized generation operation.
      await this.deps.inspectContainer(record.binding, request.containerId, request.role);
      let transport: EgressTransport | undefined;
      try {
        await this.deps.startContainer(request.containerId);
        await this.deps.inspectContainer(record.binding, request.containerId, request.role);
        await this.deps.inspectNetwork(record.binding, containerIds(record));
        transport = await this.connect(record);
      } catch (error) {
        const containment = await Promise.allSettled([
          Promise.resolve().then(() => this.deny(record)),
          Promise.resolve().then(() => this.deps.stopContainer(request.containerId)),
        ]);
        throw new AggregateError(
          [
            error,
            ...containment.flatMap((result) =>
              result.status === 'rejected' ? [result.reason as unknown] : [],
            ),
          ],
          'Host start failed; containment attempted',
          { cause: error },
        );
      }
      if (transport)
        return {
          state: 'started-connected',
          generation: record.binding.generation,
          relayAddress: transport.relay.address,
          ...(this.deps.enforcement?.directAuthority(record.binding)
            ? { directAuthority: true }
            : {}),
        };
      return { state: 'started-denied', generation: record.binding.generation };
    });
  }
  private async deny(record: RecordState): Promise<void> {
    this.transports.delete(key(record.binding));
    try {
      await this.deps.apply(
        projectEgressBootstrapRules([...this.transports.values()]) +
          projectEgressStartupRules(record.binding),
      );
      await this.deps.enforcement?.deny(record.binding);
    } catch (error) {
      this.healthy = false;
      const stopped = await Promise.allSettled(
        containerIds(record).map((id) => this.deps.stopContainer(id)),
      );
      throw new AggregateError(
        [error, ...stopped.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []))],
        'Transport revocation failed; containment attempted',
        { cause: error },
      );
    }
  }
  private async connect(record: RecordState): Promise<EgressTransport | undefined> {
    const { sandbox, relay } = record.containers;
    if (!sandbox || !relay || !this.deps.inspectTransport) return undefined;
    for (const role of ['sandbox', 'relay'] as const)
      await this.deps.inspectContainer(record.binding, record.containers[role]!, role);
    await this.deps.inspectNetwork(record.binding, containerIds(record));
    const transport = await this.deps.inspectTransport(record.binding, { sandbox, relay });
    if (!transport) return undefined;
    const admission: {
      binding: ProjectEgressNetworkBinding;
      transport: EgressTransport;
      flowLabel: string;
      direct?: EgressDirectCorridor;
    } = {
      binding: record.binding,
      transport,
      flowLabel: randomBytes(16).toString('hex'),
    };
    try {
      if (this.deps.enforcement)
        admission.direct = await this.deps.enforcement.connect(
          record.binding,
          { sandbox, relay },
          admission,
        );
      const next = [...this.transports.values(), admission];
      await this.deps.apply(
        projectEgressBootstrapRules(next) + projectEgressStartupRules(record.binding, admission),
      );
      // Fail closed if an endpoint changed while the kernel transaction was installed.
      const confirmed = await this.deps.inspectTransport(record.binding, { sandbox, relay });
      if (JSON.stringify(confirmed) !== JSON.stringify(transport))
        throw new Error('Transport endpoint changed during admission');
      this.transports.set(key(record.binding), admission);
      return transport;
    } catch (error) {
      await this.deny(record);
      throw error;
    }
  }
  private async prepare(record: RecordState): Promise<void> {
    // Even an unexpected attachment is fenced before reporting a mismatch.
    await this.deny(record);
    await this.deps.inspectNetwork(record.binding, containerIds(record));
  }
}
