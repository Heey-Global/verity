import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { EventStore } from './store.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

let ctx: TestDb;
const session = { sessionId: 's', worktree: '/wt/s', model: 'test' };
const url = 'https://github.com/example/repo/pull/1';
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.createSession(session);
});

it('retains the baseline and hides a changed workspace permanently across store instances', async () => {
  expect(await ctx.store.getSessionPrVisibility('s', session.worktree, url)).toBeUndefined();
  expect(await ctx.store.observeSessionPrVisibility('s', session.worktree, url, 'before')).toBe(
    false,
  );
  expect(await ctx.store.observeSessionPrVisibility('s', session.worktree, url, 'before')).toBe(
    false,
  );
  expect(await ctx.store.observeSessionPrVisibility('s', session.worktree, url, 'after')).toBe(
    true,
  );
  const reopened = new EventStore(ctx.db);
  expect(await reopened.getSessionPrVisibility('s', session.worktree, url)).toEqual({
    fingerprint: 'before',
    hidden: true,
  });
  expect(await reopened.observeSessionPrVisibility('s', session.worktree, url, 'before')).toBe(
    true,
  );
});

it('isolates PR identities and workspaces and cascades session deletion', async () => {
  await ctx.store.observeSessionPrVisibility('s', session.worktree, url, 'before');
  await ctx.store.observeSessionPrVisibility('s', session.worktree, url, 'after');
  expect(await ctx.store.observeSessionPrVisibility('s', '/wt/other', url, 'after')).toBe(false);
  expect(
    await ctx.store.observeSessionPrVisibility('s', session.worktree, `${url}0`, 'after'),
  ).toBe(false);
  await ctx.db.deleteFrom('sessions').where('session_id', '=', 's').execute();
  expect(await ctx.db.selectFrom('session_pr_visibility').selectAll().execute()).toEqual([]);
});

it('does not lose a concurrent change observation', async () => {
  const results = await Promise.all([
    ctx.store.observeSessionPrVisibility('s', session.worktree, url, 'before'),
    ctx.store.observeSessionPrVisibility('s', session.worktree, url, 'after'),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect((await ctx.store.getSessionPrVisibility('s', session.worktree, url))?.hidden).toBe(true);
});

it('seeds the settled housekeeping baseline before subsequent user work', async () => {
  await ctx.store.resetSessionPrVisibility('s', session.worktree, url, 'merged');
  expect(await ctx.store.observeSessionPrVisibility('s', session.worktree, url, 'merged')).toBe(
    false,
  );
  await ctx.store.observeSessionPrVisibility('s', session.worktree, url, 'cleanup');
  await ctx.store.resetSessionPrVisibility('s', session.worktree, url, 'cleanup');
  expect(await ctx.store.getSessionPrVisibility('s', session.worktree, url)).toEqual({
    fingerprint: 'cleanup',
    hidden: false,
  });
  expect(await ctx.store.observeSessionPrVisibility('s', session.worktree, url, 'cleanup')).toBe(
    false,
  );
  expect(await ctx.store.observeSessionPrVisibility('s', session.worktree, url, 'new-work')).toBe(
    true,
  );
});
