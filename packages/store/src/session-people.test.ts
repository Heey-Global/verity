import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
  await ctx.db
    .insertInto('users')
    .values([
      { id: 'owner', role: 'member', status: 'active' },
      { id: 'mara', role: 'member', status: 'active' },
    ])
    .execute();
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'acme',
    repo: 'site',
    containerName: 'acme-site',
    state: 'active',
  });
  await ctx.db
    .updateTable('projects')
    .set({ created_by_user_id: 'owner' } as never)
    .where('id', '=', 'p1')
    .execute();
});

describe('session owners', () => {
  it('names the creator, then the project creator, and leaves ownerless sessions out', async () => {
    await ctx.store.createSession({
      sessionId: 'mine',
      worktree: '/wt/mine',
      model: 'm',
      projectId: 'p1',
      createdByUserId: 'mara',
    });
    // Sessions from before creators were recorded fall back to the project's creator.
    await ctx.store.createSession({
      sessionId: 'old',
      worktree: '/wt/old',
      model: 'm',
      projectId: 'p1',
    });
    await ctx.store.createSession({ sessionId: 'loose', worktree: '/wt/loose', model: 'm' });
    const owners = await ctx.store.sessionPeople.owners(['mine', 'old', 'loose', 'missing']);
    // The project creator stays a candidate behind the creator, for when the
    // creator can no longer answer.
    expect(Object.fromEntries(owners)).toEqual({ mine: ['mara', 'owner'], old: ['owner'] });
  });

  it('forgets a creator who is deleted, falling back to the project creator', async () => {
    await ctx.store.createSession({
      sessionId: 'mine',
      worktree: '/wt/mine',
      model: 'm',
      projectId: 'p1',
      createdByUserId: 'mara',
    });
    await ctx.db.deleteFrom('users').where('id', '=', 'mara').execute();
    expect((await ctx.store.sessionPeople.owners(['mine'])).get('mine')).toEqual(['owner']);
  });

  it('creates a session for an identity without a user row, leaving it to the project creator', async () => {
    await ctx.store.createSession({
      sessionId: 'service',
      worktree: '/wt/service',
      model: 'm',
      projectId: 'p1',
      createdByUserId: 'not-a-user',
    });
    expect((await ctx.store.sessionPeople.owners(['service'])).get('service')).toEqual(['owner']);
  });
});
