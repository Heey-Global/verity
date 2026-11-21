import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { migrateToLatest } from './db.js';
import { createEmbeddedDb } from './pglite.js';
import type { Database } from './schema.js';
import { EventStore } from './store.js';
import { truncateAll } from './testing.js';
import {
  CapacityLeaseBindingConflictError,
  CapacityLeaseInputError,
  CAPACITY_LEASE_INVENTORY_LIMIT,
  type CapacityLeaseInput,
} from './capacity-leases.js';

let directory: string;
let db: Kysely<Database>;
let store: EventStore;
beforeAll(async () => {
  mkdirSync(join(process.cwd(), '.cache'), { recursive: true });
  directory = mkdtempSync(join(process.cwd(), '.cache', 'capacity-leases-test-'));
  db = createEmbeddedDb(directory);
  await migrateToLatest(db);
  store = new EventStore(db);
});
afterAll(async () => {
  await db?.destroy();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
beforeEach(async () => truncateAll(db));

const request = (overrides: Partial<CapacityLeaseInput> = {}): CapacityLeaseInput => ({
  id: randomUUID(),
  projectId: 'project-a',
  userId: 'user-a',
  sessionId: 'session-a',
  containerGeneration: 'generation-a',
  kind: 'dependency-copy',
  bytes: 100,
  inodes: 10,
  ...overrides,
});

it('returns the same binding and creation time for concurrent exact retries', async () => {
  const value = request();
  const [first, second] = await Promise.all([
    store.capacityLeases.reserve(value),
    new EventStore(db).capacityLeases.reserve(value),
  ]);
  expect(first).toEqual(second);
  expect(first).toMatchObject({ ...value, state: 'reserved' });
  expect(first.createdAt).toBeInstanceOf(Date);
  expect(await store.capacityLeases.reserve({ ...value, id: value.id.toUpperCase() })).toEqual(
    first,
  );
  expect((await store.capacityLeases.listUnsettled()).leases).toEqual([first]);
});

it.each([
  { projectId: 'project-b' },
  { userId: 'user-b' },
  { sessionId: 'session-b' },
  { containerGeneration: 'generation-b' },
  { kind: 'dependency-prepare' as const },
  { bytes: 101 },
  { inodes: 11 },
])('refuses request-id reuse with another operation binding: %j', async (change) => {
  const value = request();
  const lease = await store.capacityLeases.reserve(value);
  await expect(store.capacityLeases.reserve({ ...value, ...change })).rejects.toBeInstanceOf(
    CapacityLeaseBindingConflictError,
  );
  expect(await store.capacityLeases.get(value.id)).toEqual(lease);
});

it('admits only one binding when conflicting requests race', async () => {
  const value = request();
  const results = await Promise.allSettled([
    store.capacityLeases.reserve(value),
    new EventStore(db).capacityLeases.reserve({ ...value, userId: 'other-user' }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect((await store.capacityLeases.listUnsettled()).leases).toHaveLength(1);
});

it('uses compare-and-set transitions and never reopens a terminal lease', async () => {
  const value = request();
  await store.capacityLeases.reserve(value);
  const results = await Promise.all([
    store.capacityLeases.transition(value.id, ['reserved'], 'started'),
    new EventStore(db).capacityLeases.transition(value.id, ['reserved'], 'uncertain'),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const current = (await store.capacityLeases.get(value.id))!;
  expect(await store.capacityLeases.transition(value.id, ['reserved'], 'settled')).toBeNull();
  const settled = await store.capacityLeases.transition(value.id, [current.state], 'settled');
  expect(settled?.state).toBe('settled');
  expect(await store.capacityLeases.listUnsettled()).toEqual({ leases: [], overflow: false });
  await expect(
    store.capacityLeases.transition(value.id, ['settled'], 'started'),
  ).rejects.toBeInstanceOf(CapacityLeaseInputError);
  await expect(
    store.capacityLeases.transition(value.id, ['settled'], 'reserved'),
  ).rejects.toBeInstanceOf(CapacityLeaseInputError);
  expect(await store.capacityLeases.reserve(value)).toEqual(settled);
});

it('reports an incomplete global inventory explicitly instead of hiding other projects', async () => {
  const values = [
    request(),
    request({ projectId: 'project-b' }),
    request({ projectId: 'project-c' }),
  ];
  for (const value of values) await store.capacityLeases.reserve(value);
  const partial = await store.capacityLeases.listUnsettled(2);
  expect(partial.overflow).toBe(true);
  expect(partial.leases).toHaveLength(2);
  expect(await store.capacityLeases.listUnsettled(3)).toMatchObject({ overflow: false });
  await store.capacityLeases.transition(values[0]!.id, ['reserved'], 'settled');
  expect(await store.capacityLeases.listUnsettled(2)).toMatchObject({ overflow: false });
  for (const limit of [0, -1, 1.5, CAPACITY_LEASE_INVENTORY_LIMIT + 1])
    await expect(store.capacityLeases.listUnsettled(limit)).rejects.toBeInstanceOf(
      CapacityLeaseInputError,
    );
});

it('rejects unsafe amounts and arbitrary path fields before creating a lease', async () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(store.capacityLeases.reserve(request({ bytes: value }))).rejects.toBeInstanceOf(
      CapacityLeaseInputError,
    );
    await expect(store.capacityLeases.reserve(request({ inodes: value }))).rejects.toBeInstanceOf(
      CapacityLeaseInputError,
    );
  }
  await expect(
    store.capacityLeases.reserve({ ...request(), path: '/arbitrary' } as CapacityLeaseInput),
  ).rejects.toBeInstanceOf(CapacityLeaseInputError);
  await expect(
    store.capacityLeases.reserve(request({ containerGeneration: '../container' })),
  ).rejects.toBeInstanceOf(CapacityLeaseInputError);
  await expect(store.capacityLeases.reserve(request({ id: 'not-a-uuid' }))).rejects.toBeInstanceOf(
    CapacityLeaseInputError,
  );
  expect(await store.capacityLeases.listUnsettled()).toEqual({ leases: [], overflow: false });
  await expect(
    db
      .insertInto('dependency_capacity_leases')
      .values({
        id: randomUUID(),
        project_id: 'p',
        user_id: 'u',
        session_id: 's',
        container_generation: 'g',
        kind: 'dependency-private',
        bytes: -1,
        inodes: 0,
        state: 'reserved',
      })
      .execute(),
  ).rejects.toThrow();
});

it('round-trips zero and the largest safe resource amounts without precision loss', async () => {
  for (const amount of [0, Number.MAX_SAFE_INTEGER]) {
    const value = request({ kind: 'dependency-private', bytes: amount, inodes: amount });
    expect(await store.capacityLeases.reserve(value)).toMatchObject(value);
    expect(await store.capacityLeases.get(value.id)).toMatchObject(value);
  }
});

it('keeps outstanding leases after their owning project and session are deleted', async () => {
  await store.upsertProject({
    id: 'project-a',
    owner: 'example',
    repo: 'repo',
    containerName: 'container',
    state: 'active',
  });
  await store.createSession({
    sessionId: 'session-a',
    projectId: 'project-a',
    worktree: '/wt/capacity',
    model: 'test',
  });
  const value = request();
  await store.capacityLeases.reserve(value);
  await store.deleteSession('session-a');
  await store.deleteProject('project-a');
  expect(await store.capacityLeases.get(value.id)).toMatchObject({ ...value, state: 'reserved' });
});

it('retains uncertain leases across database close and reopen regardless of age', async () => {
  const value = request();
  await store.capacityLeases.reserve(value);
  await store.capacityLeases.transition(value.id, ['reserved'], 'uncertain');
  await sql`update dependency_capacity_leases set created_at='1970-01-01T00:00:00Z', updated_at='1970-01-01T00:00:00Z' where id=${value.id}::uuid`.execute(
    db,
  );
  await db.destroy();
  db = createEmbeddedDb(directory);
  await migrateToLatest(db);
  store = new EventStore(db);
  const lease = await store.capacityLeases.get(value.id);
  expect(lease).toMatchObject({
    ...value,
    state: 'uncertain',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  expect((await store.capacityLeases.listUnsettled()).leases).toEqual([lease]);
  expect(await store.capacityLeases.get(randomUUID())).toBeNull();
});
