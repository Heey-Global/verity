import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { SANDBOX_REPAIR_MESSAGE_LIMIT } from './sandbox-repair-intents.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

const seed = (id: string) =>
  ctx.store.upsertProject({
    id,
    owner: 'example-org',
    repo: id,
    containerName: `dev-${id}`,
    state: 'failed',
  });

const intent = (projectId: string, overrides: Record<string, unknown> = {}) => ({
  projectId,
  version: 1 as const,
  attemptId: 'attempt-1',
  status: 'waiting' as const,
  sourceGeneration: 'generation-1',
  targetImageRef: 'example/image:target',
  failures: 2,
  retryAt: new Date('2026-11-12T10:05:00.000Z'),
  storageRefused: true,
  lastFailureAt: new Date('2026-11-12T10:00:00.000Z'),
  lastFailureMessage: 'build storage refused the build',
  ...overrides,
});

it('keeps an owed repair until it is cleared', async () => {
  await seed('p1');
  await ctx.store.sandboxRepairIntents.record(intent('p1'));
  await ctx.store.sandboxRepairIntents.record(intent('p1', { failures: 3 }));
  expect(await ctx.store.sandboxRepairIntents.list()).toEqual([intent('p1', { failures: 3 })]);

  await ctx.store.sandboxRepairIntents.clear('p1');
  expect(await ctx.store.sandboxRepairIntents.list()).toEqual([]);
});

it('ignores a project deleted before the failure was recorded, and goes with a deleted one', async () => {
  // The failure is recorded from a reconcile pass that may race a deletion;
  // failing that pass, or keeping a record for a project that is gone, would both
  // be wrong.
  await ctx.store.sandboxRepairIntents.record(intent('never-existed'));
  await seed('p2');
  await ctx.store.sandboxRepairIntents.record(intent('p2'));
  await ctx.store.deleteProject('p2');
  expect(await ctx.store.sandboxRepairIntents.list()).toEqual([]);
});

it('bounds the message shown to project members', async () => {
  await seed('p3');
  await ctx.store.sandboxRepairIntents.record(
    intent('p3', { lastFailureMessage: 'x'.repeat(SANDBOX_REPAIR_MESSAGE_LIMIT + 50) }),
  );
  const [stored] = await ctx.store.sandboxRepairIntents.list();
  expect(stored?.lastFailureMessage).toHaveLength(SANDBOX_REPAIR_MESSAGE_LIMIT);
});

it('makes only storage-refused retries due once storage was released', async () => {
  await seed('storage');
  await seed('other');
  await ctx.store.sandboxRepairIntents.record(intent('storage'));
  await ctx.store.sandboxRepairIntents.record(intent('other', { storageRefused: false }));
  const now = new Date('2026-11-12T10:01:00.000Z');
  await ctx.store.sandboxRepairIntents.releaseStorageBackoff(now);
  const byId = new Map(
    (await ctx.store.sandboxRepairIntents.list()).map((row) => [row.projectId, row.retryAt]),
  );
  expect(byId.get('storage')).toEqual(now);
  expect(byId.get('other')).toEqual(intent('other').retryAt);
});

it('does not resurrect a cancelled or superseded attempt on late failure', async () => {
  await seed('p4');
  await ctx.store.sandboxRepairIntents.record(intent('p4'));
  await ctx.store.sandboxRepairIntents.clear('p4');
  await ctx.store.sandboxRepairIntents.recordFailure(intent('p4'));
  expect(await ctx.store.sandboxRepairIntents.list()).toEqual([]);
  await ctx.store.sandboxRepairIntents.record(intent('p4', { attemptId: 'new-attempt' }));
  await ctx.store.sandboxRepairIntents.recordFailure(intent('p4', { failures: 9 }));
  expect(await ctx.store.sandboxRepairIntents.list()).toEqual([
    intent('p4', { attemptId: 'new-attempt' }),
  ]);
});

it.each(['absent', 'sleeping_starting', 'sleeping', 'waking'] as const)(
  'cancels the intent durably on %s',
  async (state) => {
    await seed('cancel-state');
    await ctx.store.sandboxRepairIntents.record(intent('cancel-state'));
    await ctx.store.updateProjectState('cancel-state', state);
    expect(await ctx.store.sandboxRepairIntents.list()).toEqual([]);
  },
);

it('cancels intent in a sleep lifecycle transition', async () => {
  await seed('cancel-sleep');
  await ctx.store.sandboxRepairIntents.record(intent('cancel-sleep'));
  await ctx.store.updateProjectSleepState('cancel-sleep', 'sleeping_starting', {
    sleepCompatibilityFingerprint: null,
    sleepingSince: null,
    wakeStartedAt: null,
  });
  expect(await ctx.store.sandboxRepairIntents.list()).toEqual([]);
});

it('cannot rearm a stopped project from a stale automatic repair snapshot', async () => {
  await seed('stopped');
  await ctx.store.updateProjectState('stopped', 'sleeping');
  await ctx.store.sandboxRepairIntents.record(intent('stopped'));
  expect(await ctx.store.sandboxRepairIntents.list()).toEqual([]);
});
