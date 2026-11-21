import type { CapacityLease, CapacityLeaseInput, CapacityLeaseStore } from '@verity/store';
import type { CapacityLeaseReply } from './project-runtime-capacity.js';
import { buildStoragePolicy, type BuildStoragePolicy } from './build-storage-policy.js';

type Owner = Pick<CapacityLeaseInput, 'projectId' | 'userId' | 'sessionId' | 'containerGeneration'>;
export type DependencyCapacityRequest =
  | {
      action: 'reserve';
      id: string;
      kind: CapacityLeaseInput['kind'];
      bytes: number;
      inodes: number;
    }
  | { action: 'start' | 'status' | 'settle'; id: string };
type Control = (
  lease: CapacityLease,
  action: 'create' | 'status' | 'retire',
) => Promise<CapacityLeaseReply>;
const ownership = ['projectId', 'userId', 'sessionId', 'containerGeneration'] as const;
const LIMIT = 10_000;
const lockPath = (id: string) => `/run/verity-capacity-leases/${id}.lock`;

/** The Server is the single admission owner. Provisional amounts are visible to
 * synchronous BuildStorage admission before any persistence or broker await.
 * Only a root broker's atomic retirement proof releases a durable reservation. */
export class DependencyCapacity {
  private readonly leases = new Map<string, CapacityLease>();
  private initialized = false;
  private problem: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private initialization: Promise<void> | undefined;
  private cursor = 0;
  constructor(
    private readonly store: Pick<
      CapacityLeaseStore,
      'get' | 'listUnsettled' | 'reserve' | 'transition'
    >,
    private readonly check: (bytes: number, inodes: number) => void,
    private readonly control: Control,
    private readonly policy: BuildStoragePolicy = buildStoragePolicy(),
  ) {}

  initialize(): Promise<void> {
    return (this.initialization ??= (async () => {
      const inventory = await this.store.listUnsettled(LIMIT);
      if (inventory.overflow) throw new Error('Dependency capacity inventory exceeds its bound.');
      for (const lease of inventory.leases) this.leases.set(lease.id, lease);
      this.initialized = true;
      this.pressure();
    })().catch((error: unknown) => {
      this.problem = 'Durable dependency capacity inventory is unavailable or incomplete.';
      throw error;
    }));
  }

  pressure(): { bytes: number; inodes: number } {
    if (!this.initialized || this.problem)
      throw new Error(this.problem ?? 'Dependency capacity inventory is loading.');
    let bytes = 0,
      inodes = 0;
    for (const lease of this.leases.values()) {
      bytes += lease.bytes;
      inodes += lease.inodes;
      if (
        ![bytes, inodes, lease.bytes, lease.inodes].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
      )
        throw new Error('Dependency capacity inventory exceeds safe accounting limits.');
    }
    return { bytes, inodes };
  }

  diagnostics() {
    let amounts: { bytes: number; inodes: number } | undefined;
    try {
      amounts = this.pressure();
    } catch {
      /* Unknown is never reported as zero. */
    }
    const leases = [...this.leases.values()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    return {
      initialized: this.initialized && !this.problem,
      count: leases.length,
      ...(amounts ? { reservedBytes: amounts.bytes, reservedInodes: amounts.inodes } : {}),
      ...(leases[0] ? { oldestAt: leases[0].createdAt.toISOString() } : {}),
      ...(this.problem ? { problem: this.problem } : {}),
      leases: leases.slice(0, 20).map(({ id, kind, state, bytes, inodes, createdAt }) => ({
        id,
        kind,
        state,
        bytes,
        inodes,
        createdAt: createdAt.toISOString(),
      })),
    };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async move(
    lease: CapacityLease,
    state: 'started' | 'uncertain' | 'settled',
  ): Promise<CapacityLease> {
    const updated = await this.store.transition(
      lease.id,
      ['reserved', 'started', 'uncertain'],
      state,
    );
    if (!updated) throw new Error('Dependency capacity state changed unexpectedly.');
    if (updated.state === 'settled') this.leases.delete(updated.id);
    else this.leases.set(updated.id, updated);
    return updated;
  }

  private async broker(
    lease: CapacityLease,
    action: 'create' | 'status' | 'retire',
  ): Promise<CapacityLeaseReply['state']> {
    try {
      const result = await this.control(lease, action);
      if (
        result.ok !== true ||
        result.capacityLeaseVersion !== 1 ||
        result.operationId !== lease.id ||
        result.generation !== lease.containerGeneration ||
        result.path !== lockPath(lease.id)
      )
        return 'unknown';
      return result.state;
    } catch {
      return 'unknown';
    }
  }

  private async retire(lease: CapacityLease): Promise<CapacityLease> {
    // The broker tombstones the original inode while holding it exclusively.
    // A missing file or a client-reported exit never counts as retirement.
    const state = await this.broker(lease, 'retire');
    if (state === 'held') return lease;
    return this.move(lease, state === 'retired' ? 'settled' : 'uncertain');
  }

  async request(owner: Owner, input: DependencyCapacityRequest) {
    await this.initialize();
    return this.serial(async () => {
      this.pressure();
      let lease = this.leases.get(input.id) ?? (await this.store.get(input.id));
      const existingLease = lease;
      if (existingLease && ownership.some((field) => existingLease[field] !== owner[field]))
        throw new Error('Dependency capacity operation belongs to another owner or generation.');
      if (input.action === 'reserve') {
        // npm's unpacked growth cannot be inferred from lockfiles. This is an
        // estimate and live admission check, not a physical filesystem quota.
        const bytes =
          input.kind === 'dependency-prepare'
            ? Math.max(input.bytes, this.policy.estimateBytes)
            : input.bytes;
        const inodes =
          input.kind === 'dependency-prepare'
            ? Math.max(input.inodes, this.policy.reserveInodes)
            : input.inodes;
        const record: CapacityLeaseInput = {
          ...owner,
          id: input.id,
          kind: input.kind,
          bytes,
          inodes,
        };
        if (
          lease &&
          (lease.kind !== record.kind || lease.bytes !== bytes || lease.inodes !== inodes)
        )
          throw new Error('Dependency capacity request id has conflicting resource amounts.');
        if (!lease) {
          if (this.leases.size >= LIMIT)
            throw new Error('Dependency capacity inventory exceeds its bound.');
          this.check(bytes, inodes);
          // The provisional entry cannot disappear on an ambiguous database failure.
          const provisional: CapacityLease = {
            ...record,
            state: 'reserved',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          this.leases.set(record.id, provisional);
          try {
            lease = await this.store.reserve(record);
          } catch (error) {
            this.problem =
              'Dependency capacity persistence is uncertain; admission is held until verified recovery.';
            throw error;
          }
          this.leases.set(lease.id, lease);
        }
        if (lease.state !== 'settled') {
          const state = await this.broker(lease, 'create');
          if (state !== 'idle' && state !== 'held') {
            lease = await this.move(lease, 'uncertain');
            throw new Error('Dependency capacity broker could not establish the operation lock.');
          }
        }
      } else {
        if (!lease) throw new Error('Dependency capacity operation was not reserved.');
        if (lease.state !== 'settled') {
          if (input.action === 'start') {
            if ((await this.broker(lease, 'status')) !== 'held')
              throw new Error(
                'Dependency capacity start requires the original inherited broker lock.',
              );
            this.check(0, 0);
            lease = await this.move(lease, 'started');
          } else if (input.action === 'settle') lease = await this.retire(lease);
          else {
            this.check(0, 0);
            const state = await this.broker(lease, 'status');
            if (state === 'retired') lease = await this.move(lease, 'settled');
            else if (state !== 'held' && lease.state === 'started')
              lease = await this.move(lease, 'uncertain');
          }
        }
      }
      return {
        version: 1 as const,
        id: lease.id,
        state: lease.state,
        lockPath: lockPath(lease.id),
        admitted: lease.state === 'reserved' || lease.state === 'started',
        reservedBytes: lease.bytes,
        reservedInodes: lease.inodes,
      };
    });
  }

  /** Small rotating passes never clear an uncertain owner merely because time passed. */
  async reconcile(): Promise<void> {
    await this.initialize();
    const ids = [...this.leases.keys()].sort();
    const until = Date.now() + 10_000;
    for (let count = 0; count < Math.min(8, ids.length) && Date.now() < until; count++) {
      const id = ids[this.cursor++ % ids.length]!;
      await this.serial(async () => {
        const lease = this.leases.get(id);
        if (lease) await this.retire(lease);
      });
    }
  }
}
