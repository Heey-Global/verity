import { createHash } from 'node:crypto';
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
  }),
  z.strictObject({ state: z.enum(['denied', 'started-denied', 'retired']), generation: identity }),
]);
export type ProjectEgressHostResponse = z.infer<typeof projectEgressHostResponse>;
export type ProjectEgressHostRequest = z.infer<typeof projectEgressHostRequest>;
export type ProjectEgressNetworkBinding = z.infer<typeof networkBinding>;
const recordSchema = z.strictObject({
  binding: networkBinding,
  retired: z.boolean(),
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
interface Dependencies {
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
  ): Promise<void>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string): Promise<void>;
}
const key = (binding: { projectId: string; generation: string }): string =>
  `${binding.projectId}:${binding.generation}`;

/** Reserved bridge prefix is denied even before a generation is registered. */
export function projectEgressBootstrapRules(): string {
  return `add table inet verity_egress_boot
  delete table inet verity_egress_boot
  table inet verity_egress_boot {
    chain forward { type filter hook forward priority -220; policy accept; iifname "vep*" counter drop; }
    chain input { type filter hook input priority -220; policy accept; iifname "vep*" counter drop; }
  }
  add table bridge verity_egress_boot
  delete table bridge verity_egress_boot
  table bridge verity_egress_boot {
    chain forward { type filter hook forward priority -220; policy accept; meta ibrname "vep*" counter drop; }
  }
`;
}

/** Denial does not depend on endpoints, which Docker may allocate only at start.
 * Replacing both tables in one transaction also restores denial after a restart.
 * These tables remain until explicit, trusted host cleanup, including retirement.
 */
export function projectEgressStartupRules(binding: ProjectEgressNetworkBinding): string {
  networkBinding.parse(binding);
  const table =
    'verity_start_' + createHash('sha256').update(key(binding)).digest('hex').slice(0, 24);
  return `add table inet ${table}
delete table inet ${table}
table inet ${table} {
 chain forward { type filter hook forward priority -210; policy accept; iifname "${binding.bridge}" counter drop; }
 chain input { type filter hook input priority -210; policy accept; iifname "${binding.bridge}" counter drop; }
}
add table bridge ${table}
delete table bridge ${table}
table bridge ${table} {
 chain forward { type filter hook forward priority -210; policy accept; meta ibrname "${binding.bridge}" counter drop; }
}
`;
}

/** Trusted host process only. No supplied labels, commands, rules or destinations.
 * This first host increment is deny-only: no operation removes the startup fence.
 * Transport admission and production activation require separate verified gates.
 */
export class ProjectEgressHost {
  private state: ProjectEgressHostState;
  private queue: Promise<unknown> = Promise.resolve();
  private healthy = true;
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
  /** Must finish before opening the control socket; does not require Docker. */
  restore(): Promise<void> {
    return this.serialize(async () => {
      await this.deps.apply(projectEgressBootstrapRules());
      for (const record of this.state.records)
        await this.deps.apply(projectEgressStartupRules(record.binding));
    });
  }
  execute(input: unknown): Promise<ProjectEgressHostResponse> {
    const request = projectEgressHostRequest.parse(input);
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
        const record: RecordState = { binding: request.binding, retired: false, containers: {} };
        this.state.records.push(record);
        // Reserve durably before any successful response or process start.
        await this.save();
        await this.prepare(record);
        return { state: 'denied', generation: record.binding.generation };
      }
      const record = this.state.records.find((record) => key(record.binding) === key(request));
      if (!record) throw new Error('Unknown generation');
      if (request.operation === 'retire') {
        await this.deps.apply(projectEgressStartupRules(record.binding));
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
      try {
        await this.deps.startContainer(request.containerId);
        await this.deps.inspectContainer(record.binding, request.containerId, request.role);
        await this.deps.inspectNetwork(record.binding, containerIds(record));
      } catch (error) {
        const containment = await Promise.allSettled([
          Promise.resolve().then(() => this.deps.apply(projectEgressStartupRules(record.binding))),
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
      return { state: 'started-denied', generation: record.binding.generation };
    });
  }
  private async prepare(record: RecordState): Promise<void> {
    // Even an unexpected attachment is fenced before reporting a mismatch.
    await this.deps.apply(projectEgressStartupRules(record.binding));
    await this.deps.inspectNetwork(record.binding, containerIds(record));
  }
}
