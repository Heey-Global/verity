import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { CapacityLease, CapacityLeaseInput, CapacityLeaseState } from '@verity/store';
import { DependencyCapacity } from './dependency-capacity.js';
import { BuildStorage } from './build-storage.js';
import type { CapacityLeaseReply } from './project-runtime-capacity.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const owner = {
  projectId: 'project-a',
  userId: 'user-a',
  sessionId: 'session-a',
  containerGeneration: 'generation-a',
};
const policy = { estimateBytes: 80, reserveBytes: 10, reserveInodes: 2 };
const copy = (bytes = 60, inodes = 10) => ({
  action: 'reserve' as const,
  id: randomUUID(),
  kind: 'dependency-copy' as const,
  bytes,
  inodes,
});
const clone = (lease: CapacityLease): CapacityLease => ({
  ...lease,
  createdAt: new Date(lease.createdAt),
  updatedAt: new Date(lease.updatedAt),
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const persisted = (overrides: Partial<CapacityLease> = {}): CapacityLease => ({
  ...owner,
  id: randomUUID(),
  kind: 'dependency-copy',
  bytes: 60,
  inodes: 10,
  state: 'uncertain',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

/** This durable fake survives manager replacement; it never expires records. */
class DurableStore {
  readonly rows = new Map<string, CapacityLease>();
  overflow = false;
  readFailure = false;
  getFailure = false;
  reserveFailure = false;
  commitThenFail = false;
  transitionFailure = false;
  reserveWait?: Promise<void>;
  enteredReserve?: () => void;
  reserveCalls = 0;
  async listUnsettled() {
    if (this.readFailure) throw new Error('database read failed');
    return {
      leases: [...this.rows.values()].filter((lease) => lease.state !== 'settled').map(clone),
      overflow: this.overflow,
    };
  }
  async get(id: string) {
    if (this.getFailure) throw new Error('database get failed');
    const value = this.rows.get(id);
    return value ? clone(value) : null;
  }
  async reserve(input: CapacityLeaseInput): Promise<CapacityLease> {
    this.reserveCalls++;
    this.enteredReserve?.();
    await this.reserveWait;
    if (this.reserveFailure && !this.commitThenFail) throw new Error('database write failed');
    let value = this.rows.get(input.id);
    if (!value) {
      value = { ...input, state: 'reserved', createdAt: new Date(), updatedAt: new Date() };
      this.rows.set(value.id, value);
    }
    if (this.reserveFailure) throw new Error('database write acknowledgement lost');
    return clone(value);
  }
  async transition(id: string, expected: readonly CapacityLeaseState[], to: CapacityLeaseState) {
    if (this.transitionFailure) throw new Error('database transition failed');
    const current = this.rows.get(id);
    if (!current || !expected.includes(current.state)) return null;
    const value = { ...current, state: to, updatedAt: new Date() };
    this.rows.set(id, value);
    return clone(value);
  }
}
class Broker {
  readonly states = new Map<string, CapacityLeaseReply['state']>();
  readonly calls: Array<{ id: string; action: string }> = [];
  override?: (
    lease: CapacityLease,
    action: 'create' | 'status' | 'retire',
  ) => CapacityLeaseReply | Promise<CapacityLeaseReply>;
  reply(lease: CapacityLease, state: CapacityLeaseReply['state']): CapacityLeaseReply {
    return {
      ok: true,
      capacityLeaseVersion: 1,
      operationId: lease.id,
      generation: lease.containerGeneration,
      state,
      path: `/run/verity-capacity-leases/${lease.id}.lock`,
      identity: { device: '1', inode: '2' },
    };
  }
  async control(
    lease: CapacityLease,
    action: 'create' | 'status' | 'retire',
  ): Promise<CapacityLeaseReply> {
    this.calls.push({ id: lease.id, action });
    if (this.override) return this.override(lease, action);
    if (action === 'create' && !this.states.has(lease.id)) this.states.set(lease.id, 'idle');
    const state = this.states.get(lease.id) ?? 'unknown';
    if (action === 'retire' && state === 'idle') {
      this.states.set(lease.id, 'retired');
      return this.reply(lease, 'retired');
    }
    return this.reply(lease, state);
  }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dependency-capacity-'));
  roots.push(root);
  const report = join(root, 'storage.json');
  const local = { availableBytes: 100, freeInodes: 100 };
  const writeReport = () =>
    writeFileSync(
      report,
      JSON.stringify({
        schemaVersion: 1,
        hostBootId: randomUUID(),
        hostIdentity: 'a'.repeat(64),
        observedAt: new Date().toISOString(),
        roots: ['buildkit', 'docker', 'containerd', 'export', 'project'].map((kind) => ({
          kind,
          state: 'available',
          observedAt: new Date().toISOString(),
          filesystemId: 'one-filesystem',
          ...local,
        })),
      }),
    );
  writeReport();
  const store = new DurableStore();
  const broker = new Broker();
  const build = new BuildStorage(join(root, 'builds'), report, policy, () => local);
  const check = vi.fn((bytes: number, inodes: number) =>
    build.checkDependencyCapacity(bytes, inodes),
  );
  const make = () =>
    new DependencyCapacity(store, check, (lease, action) => broker.control(lease, action), policy);
  let manager = make();
  build.setDependencyReservations(() => manager.pressure());
  return {
    store,
    broker,
    build,
    check,
    local,
    writeReport,
    get manager() {
      return manager;
    },
    reopen() {
      manager = make();
      return manager;
    },
  };
}

it('publishes provisional bytes and inodes to BuildStorage before persistence resolves', async () => {
  const f = fixture();
  const entered = deferred(),
    release = deferred();
  f.store.enteredReserve = entered.resolve;
  f.store.reserveWait = release.promise;
  const value = copy(60, 50);
  const pending = f.manager.request(owner, value);
  await entered.promise;
  try {
    expect(f.manager.pressure()).toEqual({ bytes: 60, inodes: 50 });
    expect(f.store.rows.size).toBe(0);
    expect(() => f.build.checkDependencyCapacity(31, 0)).toThrow(/admission rejected/u);
    expect(() => f.build.checkDependencyCapacity(0, 49)).toThrow(/admission rejected/u);
    expect(() => f.build.checkDependencyCapacity(30, 48)).not.toThrow();
  } finally {
    release.resolve();
    await pending;
  }
});

it.each([
  { bytes: 60, inodes: 1, nextBytes: 31, nextInodes: 1 },
  { bytes: 1, inodes: 60, nextBytes: 1, nextInodes: 39 },
])(
  'serializes cross-project reservations against shared byte and inode pressure: %j',
  async ({ bytes, inodes, nextBytes, nextInodes }) => {
    const f = fixture();
    const first = copy(bytes, inodes),
      second = copy(nextBytes, nextInodes);
    const results = await Promise.allSettled([
      f.manager.request(owner, first),
      f.manager.request({ ...owner, projectId: 'project-b', sessionId: 'session-b' }, second),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(f.store.rows.size).toBe(1);
    expect(f.manager.pressure()).toEqual({ bytes, inodes });
  },
);

it('reloads old uncertain reservations after restart without a TTL release', async () => {
  const f = fixture();
  const lease = persisted();
  f.store.rows.set(lease.id, lease);
  await f.manager.initialize();
  expect(f.manager.pressure()).toEqual({ bytes: 60, inodes: 10 });
  await f.reopen().initialize();
  await f.manager.reconcile();
  expect(f.manager.pressure()).toEqual({ bytes: 60, inodes: 10 });
  expect(f.manager.diagnostics()).toMatchObject({ count: 1, oldestAt: new Date(0).toISOString() });
  expect(f.store.rows.get(lease.id)?.state).toBe('uncertain');
});

it('keeps held broker operations reserved during settlement and reconciliation', async () => {
  const f = fixture();
  const lease = persisted({ state: 'started' });
  f.store.rows.set(lease.id, lease);
  f.broker.states.set(lease.id, 'held');
  await f.manager.initialize();
  const result = await f.manager.request(owner, { action: 'settle', id: lease.id });
  await f.manager.reconcile();
  expect(result.state).toBe('started');
  expect(f.manager.pressure()).toEqual({ bytes: lease.bytes, inodes: lease.inodes });
  expect(f.store.rows.get(lease.id)?.state).toBe('started');
  expect(f.broker.calls.every((call) => call.action === 'retire')).toBe(true);
});

it.each(['unknown', 'idle'] as const)(
  'retains reservations when retirement is %s rather than tombstoned',
  async (state) => {
    const f = fixture();
    const lease = persisted();
    f.store.rows.set(lease.id, lease);
    f.broker.override = (value) => f.broker.reply(value, state);
    await f.manager.initialize();
    const result = await f.manager.request(owner, { action: 'settle', id: lease.id });
    await f.manager.reconcile();
    expect(result.admitted).toBe(false);
    expect(f.manager.pressure()).toEqual({ bytes: lease.bytes, inodes: lease.inodes });
    expect(f.store.rows.get(lease.id)?.state).toBe('uncertain');
  },
);

it.each(['missing', 'wrong-id', 'wrong-generation', 'wrong-path', 'wrong-version'] as const)(
  'does not release a lease on missing or mismatched retirement proof: %s',
  async (failure) => {
    const f = fixture();
    const lease = persisted();
    f.store.rows.set(lease.id, lease);
    f.broker.override = (value) => {
      if (failure === 'missing') throw new Error('broker unavailable');
      const response = f.broker.reply(value, 'retired');
      if (failure === 'wrong-id') response.operationId = randomUUID();
      if (failure === 'wrong-generation') response.generation = 'other-generation';
      if (failure === 'wrong-path') response.path = '/another/lock';
      if (failure === 'wrong-version')
        return { ...response, capacityLeaseVersion: 2 } as unknown as CapacityLeaseReply;
      return response;
    };
    await f.manager.initialize();
    await f.manager.reconcile();
    expect(f.manager.pressure()).toEqual({ bytes: lease.bytes, inodes: lease.inodes });
    expect(f.store.rows.get(lease.id)?.state).toBe('uncertain');
  },
);

it('releases only after broker retirement and rejects delayed starts of that operation', async () => {
  const f = fixture();
  const value = copy();
  await f.manager.request(owner, value);
  const settled = await f.manager.request(owner, { action: 'settle', id: value.id });
  expect(settled).toMatchObject({ admitted: false, state: 'settled' });
  expect(f.manager.pressure()).toEqual({ bytes: 0, inodes: 0 });
  expect(f.broker.states.get(value.id)).toBe('retired');
  const delayed = await f.manager.request(owner, { action: 'start', id: value.id });
  expect(delayed).toMatchObject({ admitted: false, state: 'settled' });
  expect(f.store.reserveCalls).toBe(1);
});

it('requires the inherited held lock before starting and preserves accounting on idle status', async () => {
  const f = fixture();
  const value = copy();
  await f.manager.request(owner, value);
  await expect(f.manager.request(owner, { action: 'start', id: value.id })).rejects.toThrow(
    /inherited broker lock/u,
  );
  expect(f.manager.pressure()).toEqual({ bytes: 60, inodes: 10 });
  f.broker.states.set(value.id, 'held');
  expect(await f.manager.request(owner, { action: 'start', id: value.id })).toMatchObject({
    state: 'started',
    admitted: true,
  });
  f.broker.states.set(value.id, 'unknown');
  expect(await f.manager.request(owner, { action: 'status', id: value.id })).toMatchObject({
    state: 'uncertain',
    admitted: false,
  });
  expect(f.manager.pressure()).toEqual({ bytes: 60, inodes: 10 });
});

it('replays exact requests without double counting and rejects owner, generation and amount conflicts', async () => {
  const f = fixture();
  const value = copy();
  const first = await f.manager.request(owner, value);
  expect(await f.manager.request(owner, value)).toEqual(first);
  expect(f.store.reserveCalls).toBe(1);
  expect(f.manager.pressure()).toEqual({ bytes: 60, inodes: 10 });
  for (const field of ['projectId', 'userId', 'sessionId', 'containerGeneration'] as const)
    await expect(f.manager.request({ ...owner, [field]: 'other' }, value)).rejects.toThrow(
      /another owner or generation/u,
    );
  await expect(f.manager.request(owner, { ...value, bytes: 61 })).rejects.toThrow(
    /conflicting resource amounts/u,
  );
  await expect(f.manager.request(owner, { ...value, kind: 'dependency-private' })).rejects.toThrow(
    /conflicting resource amounts/u,
  );
  expect(f.store.reserveCalls).toBe(1);
});

it('rejects capacity use while initialization is incomplete and never treats it as zero', async () => {
  const f = fixture();
  expect(() => f.build.checkDependencyCapacity(0, 0)).toThrow(/inventory is loading/u);
  expect(f.manager.diagnostics()).not.toHaveProperty('reservedBytes');
  await f.manager.initialize();
  expect(() => f.build.checkDependencyCapacity(0, 0)).not.toThrow();
});

it('does not release existing reservations when a requested record is missing or unreadable', async () => {
  const f = fixture();
  const lease = persisted();
  f.store.rows.set(lease.id, lease);
  await f.manager.initialize();
  f.store.getFailure = true;
  await expect(f.manager.request(owner, { action: 'status', id: randomUUID() })).rejects.toThrow(
    /database get/u,
  );
  f.store.getFailure = false;
  await expect(f.manager.request(owner, { action: 'status', id: randomUUID() })).rejects.toThrow(
    /not reserved/u,
  );
  expect(f.manager.pressure()).toEqual({ bytes: lease.bytes, inodes: lease.inodes });
  expect(f.store.rows.get(lease.id)?.state).toBe('uncertain');
  expect(f.broker.calls).toEqual([]);
});

it('keeps persisted pressure when broker creation cannot establish the operation lock', async () => {
  const f = fixture();
  const value = copy();
  f.broker.override = (lease) => f.broker.reply(lease, 'unknown');
  await expect(f.manager.request(owner, value)).rejects.toThrow(/could not establish/u);
  expect(f.manager.pressure()).toEqual({ bytes: 60, inodes: 10 });
  expect(f.store.rows.get(value.id)?.state).toBe('uncertain');
  await expect(f.manager.request(owner, value)).rejects.toThrow(/could not establish/u);
  expect(f.store.reserveCalls).toBe(1);
});

it.each(['overflow', 'read-failure'] as const)(
  'fails closed before admission when durable inventory has %s',
  async (failure) => {
    const f = fixture();
    if (failure === 'overflow') f.store.overflow = true;
    else f.store.readFailure = true;
    await expect(f.manager.request(owner, copy())).rejects.toThrow();
    expect(() => f.build.checkDependencyCapacity(0, 0)).toThrow(/unavailable or incomplete/u);
    expect(f.manager.diagnostics()).toMatchObject({ initialized: false });
    expect(f.manager.diagnostics()).not.toHaveProperty('reservedBytes');
    expect(f.check).not.toHaveBeenCalled();
    expect(f.broker.calls).toEqual([]);
  },
);

it.each([false, true])(
  'retains provisional admission on an ambiguous persistence failure (committed=%s)',
  async (committed) => {
    const f = fixture();
    f.store.reserveFailure = true;
    f.store.commitThenFail = committed;
    await expect(f.manager.request(owner, copy())).rejects.toThrow(/database write/u);
    expect(f.manager.diagnostics()).toMatchObject({ initialized: false, count: 1 });
    expect(() => f.build.checkDependencyCapacity(0, 0)).toThrow(/persistence is uncertain/u);
    expect(f.broker.calls).toEqual([]);
    await expect(f.manager.request({ ...owner, projectId: 'project-b' }, copy())).rejects.toThrow(
      /persistence is uncertain/u,
    );
    expect(f.store.rows.size).toBe(committed ? 1 : 0);
  },
);

it('does not release pressure when retirement persistence fails after the broker tombstones', async () => {
  const f = fixture();
  const value = copy();
  await f.manager.request(owner, value);
  f.store.transitionFailure = true;
  await expect(f.manager.request(owner, { action: 'settle', id: value.id })).rejects.toThrow(
    /database transition/u,
  );
  expect(f.broker.states.get(value.id)).toBe('retired');
  expect(f.manager.pressure()).toEqual({ bytes: 60, inodes: 10 });
  await expect(f.manager.request(owner, { action: 'start', id: value.id })).rejects.toThrow(
    /inherited broker lock/u,
  );
  f.store.transitionFailure = false;
  expect(await f.manager.request(owner, { action: 'settle', id: value.id })).toMatchObject({
    admitted: false,
    state: 'settled',
  });
  expect(f.manager.pressure()).toEqual({ bytes: 0, inodes: 0 });
});

it.each([
  { bytes: 1, inodes: 1, reservedBytes: 80, reservedInodes: 2 },
  { bytes: 90, inodes: 20, reservedBytes: 90, reservedInodes: 20 },
])(
  'uses the prepared-install policy floor while preserving larger estimates and exact private copies: %j',
  async ({ bytes, inodes, reservedBytes, reservedInodes }) => {
    const f = fixture();
    const prepared = { ...copy(bytes, inodes), kind: 'dependency-prepare' as const };
    expect(await f.manager.request(owner, prepared)).toMatchObject({
      reservedBytes,
      reservedInodes,
    });
    expect(f.manager.pressure()).toEqual({ bytes: reservedBytes, inodes: reservedInodes });
    const privateCopy = { ...copy(0, 0), kind: 'dependency-private' as const };
    expect(await f.manager.request(owner, privateCopy)).toMatchObject({
      reservedBytes: 0,
      reservedInodes: 0,
    });
  },
);

it('fails closed on unsafe aggregate arithmetic and bounds diagnostic samples', async () => {
  const f = fixture();
  f.store.rows.set('one', persisted({ id: 'one', bytes: Number.MAX_SAFE_INTEGER }));
  f.store.rows.set('two', persisted({ id: 'two', bytes: 1 }));
  await expect(f.manager.initialize()).rejects.toThrow(/safe accounting/u);
  expect(f.manager.diagnostics()).toMatchObject({ initialized: false, count: 2 });
  expect(f.manager.diagnostics()).not.toHaveProperty('reservedBytes');
  f.store.rows.clear();
  for (let index = 0; index < 21; index++) {
    const lease = persisted({ bytes: 1, inodes: 1 });
    f.store.rows.set(lease.id, lease);
  }
  await f.reopen().initialize();
  expect(f.manager.diagnostics()).toMatchObject({
    initialized: true,
    count: 21,
    reservedBytes: 21,
    reservedInodes: 21,
  });
  expect(f.manager.diagnostics().leases).toHaveLength(20);
});
