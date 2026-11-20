import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { EventStore } from './store.js';
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
  await ctx.store.createSession({ sessionId: 'source', worktree: '/source', model: 'test' });
});

it('claims an exact request across concurrent retries and store recreation', async () => {
  const claim = () => ctx.store.sessionCoordination.claim('source', 'request', 'hash', 'target');
  expect(await Promise.all([claim(), claim()])).toEqual([
    { phase: 'reserved' },
    { phase: 'reserved' },
  ]);
  await ctx.store.sessionCoordination.update('source', 'request', { phase: 'created' });
  const reopened = new EventStore(ctx.db);
  expect(await reopened.sessionCoordination.claim('source', 'request', 'hash', 'target')).toEqual({
    phase: 'created',
  });
  await expect(
    reopened.sessionCoordination.claim('source', 'request', 'different', 'target'),
  ).rejects.toThrow('different request');
  await expect(
    reopened.sessionCoordination.claim('source', 'request', 'hash', 'different'),
  ).rejects.toThrow('different request');
});

it('retains completed target and result after target deletion without allowing phase regression', async () => {
  await ctx.store.createSession({ sessionId: 'target', worktree: '/target', model: 'test' });
  await ctx.store.sessionCoordination.claim('source', 'request', 'hash', 'target');
  const receipt = { phase: 'delivered' as const, result: { sessionId: 'target', queued: true } };
  await ctx.store.sessionCoordination.update('source', 'request', receipt);
  await sql`delete from sessions where session_id = 'target'`.execute(ctx.db);
  await ctx.store.sessionCoordination.update('source', 'request', { phase: 'created' });
  expect(await ctx.store.sessionCoordination.claim('source', 'request', 'hash', 'target')).toEqual(
    receipt,
  );
});

it('scopes request IDs to their source and removes receipts when their source is deleted', async () => {
  await ctx.store.createSession({ sessionId: 'other', worktree: '/other', model: 'test' });
  await ctx.store.sessionCoordination.claim('source', 'request', 'hash', 'target');
  expect(
    await ctx.store.sessionCoordination.claim('other', 'request', 'other-hash', 'other-target'),
  ).toEqual({ phase: 'reserved' });
  await sql`delete from sessions where session_id = 'source'`.execute(ctx.db);
  const rows = await sql<{ source_session_id: string }>`select source_session_id
    from session_coordination_requests`.execute(ctx.db);
  expect(rows.rows).toEqual([{ source_session_id: 'other' }]);
  await expect(
    ctx.store.sessionCoordination.update('source', 'request', { phase: 'linked' }),
  ).rejects.toThrow('unavailable');
});
