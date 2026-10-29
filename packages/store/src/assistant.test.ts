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
  for (const id of ['a', 'b'])
    await ctx.store.upsertProject({
      id,
      owner: 'team',
      repo: id,
      containerName: id,
      state: 'active',
    });
});

describe('assistant settings', () => {
  it('starts disabled and bumps the revision on every change', async () => {
    expect(await ctx.store.assistant.settings()).toMatchObject({ enabled: false, revision: 0 });
    await ctx.store.assistant.configure(true, 'admin');
    await ctx.store.assistant.configure(false, 'admin');
    expect(await ctx.store.assistant.settings()).toMatchObject({
      enabled: false,
      revision: 2,
      sponsor_user_id: 'admin',
    });
  });

  it('keeps the first session id when concurrent callers race to create it', async () => {
    await expect(ctx.store.assistant.session('s0')).rejects.toThrow(/not configured/);
    await ctx.store.assistant.configure(true, 'admin');
    const ids = await Promise.all([
      ctx.store.assistant.session('s1'),
      ctx.store.assistant.session('s2'),
    ]);
    expect(new Set(ids).size).toBe(1);
    // Disabling must not forget the session, or re-enabling would orphan its history.
    await ctx.store.assistant.configure(false, 'admin');
    expect((await ctx.store.assistant.settings()).session_id).toBe(ids[0]);
  });
});

describe('assistant project grants', () => {
  it('stores one grant per project and drops it with the project', async () => {
    expect(await ctx.store.assistant.grant('a')).toBeUndefined();
    await ctx.store.assistant.setGrant('a', 'user', 'tasks');
    await ctx.store.assistant.setGrant('a', 'other', 'delegate');
    expect(await ctx.store.assistant.grant('a')).toMatchObject({
      mode: 'delegate',
      sponsor_user_id: 'other',
      revision: 2,
    });
    await ctx.store.assistant.setGrant('b', 'user', 'off');
    expect((await ctx.store.assistant.grants()).map((grant) => grant.project_id)).toEqual([
      'a',
      'b',
    ]);
    await ctx.store.deleteProject('a');
    expect(await ctx.store.assistant.grant('a')).toBeUndefined();
  });
});
