import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './testing.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});

// Every sandbox git call resolves its session by worktree; the per-id and per-worktree
// reads must return the same record the list does, or a field silently drops out.
it('reads one session by id or worktree exactly as the list returns it', async () => {
  await ctx.store.createSession({ sessionId: 'a', worktree: '/wt/a', model: 'm', name: 'A' });
  await ctx.store.createSession({ sessionId: 'b', worktree: '/wt/b', model: 'm' });
  await ctx.store.setSessionFavorite('b', true);
  const listed = await ctx.store.listSessions();

  for (const record of listed) {
    expect(await ctx.store.getSession(record.sessionId)).toEqual(record);
    expect(await ctx.store.getSessionByWorktree(record.worktree)).toEqual(record);
  }
  expect(await ctx.store.getSessionByWorktree('/wt/missing')).toBeUndefined();
});
