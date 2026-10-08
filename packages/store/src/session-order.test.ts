import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
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
async function project(id: string) {
  await ctx.store.upsertProject({
    id,
    owner: 'local',
    repo: id,
    containerName: id,
    state: 'active',
    kind: 'local',
  });
}
async function session(id: string, projectId: string | null = null) {
  await ctx.store.createSession({ sessionId: id, worktree: `/wt/${id}`, model: 'test', projectId });
}
async function order() {
  return ctx.store.sessionSortOrders(await ctx.store.listSessions());
}

it('persists manual overview positions without changing chronological history', async () => {
  await project('p');
  await session('a', 'p');
  await session('b', 'p');
  const history = (await ctx.store.listSessions()).map((s) => s.sessionId);
  expect(await order()).toEqual(new Map());
  expect(await ctx.store.reorderSessions('p', ['b', 'a'])).toEqual(['b', 'a']);
  expect(await order()).toEqual(
    new Map([
      ['b', 0],
      ['a', 1],
    ]),
  );
  expect((await ctx.store.listSessions()).map((s) => s.sessionId)).toEqual(history);
});
it('prepends concurrent additions and ignores deleted IDs without losing manual mode', async () => {
  await session('a');
  await ctx.store.reorderSessions(null, ['a']);
  await session('b');
  expect(await ctx.store.reorderSessions(null, ['a'])).toEqual(['b', 'a']);
  await ctx.store.deleteSession('a');
  expect(await ctx.store.reorderSessions(null, ['a', 'b'])).toEqual(['b']);
  await ctx.store.deleteSession('b');
  await ctx.store.reorderSessions(null, []);
  await session('c');
  expect(await order()).toEqual(new Map([['c', 0]]));
});
it('rejects duplicate and moved IDs atomically and isolates projects', async () => {
  await project('p');
  await project('q');
  await session('a', 'p');
  await session('b', 'p');
  await session('c', 'q');
  await ctx.store.reorderSessions('p', ['b', 'a']);
  await expect(ctx.store.reorderSessions('p', ['b', 'b'])).rejects.toThrow('Duplicate');
  await expect(ctx.store.reorderSessions('p', ['c', 'a'])).rejects.toThrow('another project');
  await ctx.store.setSessionProject('b', 'q');
  await expect(ctx.store.reorderSessions('p', ['b', 'a'])).rejects.toThrow('another project');
  expect(await order()).toEqual(new Map([['a', 0]]));
  await expect(ctx.store.reorderSessions('missing', [])).rejects.toThrow('Project not found');
});
it('serializes simultaneous writes as complete orders', async () => {
  await session('a');
  await session('b');
  await Promise.all([
    ctx.store.reorderSessions(null, ['b', 'a']),
    ctx.store.reorderSessions(null, ['a', 'b']),
  ]);
  const positions = await order();
  expect([...positions.keys()].sort()).toEqual(['a', 'b']);
  expect([...positions.values()].sort()).toEqual([0, 1]);
});
