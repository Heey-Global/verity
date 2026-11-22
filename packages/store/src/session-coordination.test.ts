import { SessionCoordinationStore } from './session-coordination.js';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
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

it('commits links and recovery state atomically, and never restores a revoked grant on retry', async () => {
  await ctx.store.createProject({
    id: 'project',
    kind: 'local',
    owner: '__local__',
    repo: 'project',
    state: 'active',
    containerName: 'project',
  });
  await sql`update sessions set project_id = 'project' where session_id = 'source'`.execute(ctx.db);
  await ctx.store.createSession({
    sessionId: 'target',
    projectId: 'project',
    worktree: '/target',
    model: 'test',
  });
  await ctx.store.sessionCoordination.claim('source', 'request', 'hash', 'target');
  const failure = vi
    .spyOn(SessionCoordinationStore.prototype, 'update')
    .mockRejectedValueOnce(new Error('receipt write failed'));
  try {
    await expect(ctx.store.createSessionLink('source', 'target', 'request')).rejects.toThrow(
      'receipt write failed',
    );
  } finally {
    failure.mockRestore();
  }
  expect(await ctx.store.listSessionLinks('source')).toEqual([]);
  expect(await ctx.store.sessionCoordination.claim('source', 'request', 'hash', 'target')).toEqual({
    phase: 'reserved',
  });
  await ctx.store.createSessionLink('source', 'target', 'request');
  expect(await ctx.store.sessionCoordination.claim('source', 'request', 'hash', 'target')).toEqual({
    phase: 'linked',
  });
  await ctx.store.deleteSessionLink('source', 'target');
  await expect(ctx.store.createSessionLink('source', 'target', 'request')).rejects.toThrow(
    'revoked',
  );
  expect(await ctx.store.listSessionLinks('source')).toEqual([]);
});

it('lists a session’s requests from both sides and keeps a handover marked through later phases', async () => {
  await ctx.store.createProject({
    id: 'project',
    kind: 'local',
    owner: '__local__',
    repo: 'project',
    state: 'active',
    containerName: 'project',
  });
  await sql`update sessions set project_id = 'project' where session_id = 'source'`.execute(ctx.db);
  // A target id that sorts before its source: the link is stored in the other order.
  await ctx.store.createSession({
    sessionId: 'a-target',
    projectId: 'project',
    worktree: '/target',
    model: 'test',
  });
  const coordination = ctx.store.sessionCoordination;
  await coordination.claim('source', 'request', 'hash', 'a-target');
  await coordination.update('source', 'request', { phase: 'created', result: { created: true } });
  // The link phase writes no result; losing the mark would turn a handover into a question.
  await ctx.store.createSessionLink('source', 'a-target', 'request');
  const [entry] = await coordination.listForSession('a-target');
  expect(entry).toMatchObject({
    sourceSessionId: 'source',
    targetSessionId: 'a-target',
    phase: 'linked',
    createdSession: true,
  });
  expect(entry?.linkedAt).toBeInstanceOf(Date);
  expect(await coordination.listForSession('source')).toEqual([entry]);
  await ctx.store.deleteSessionLink('source', 'a-target');
  expect((await coordination.listForSession('source'))[0]?.linkedAt).toBeNull();
});
