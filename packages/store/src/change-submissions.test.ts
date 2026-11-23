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
      { id: 'mara', role: 'member', status: 'active' },
      { id: 'alex', role: 'member', status: 'active' },
    ])
    .execute();
  await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
});

const submissions = () => ctx.store.changeSubmissions;

describe('change submissions', () => {
  it('opens, withdraws and resubmits one submission per session', async () => {
    await submissions().submit({ sessionId: 's1', userId: 'mara', revision: 'abc' });
    expect(await submissions().get('s1')).toMatchObject({
      submittedBy: 'mara',
      revision: 'abc',
      state: 'submitted',
    });
    expect([...(await submissions().open(['s1', 'other'])).keys()]).toEqual(['s1']);
    // A second submit while one is open changes nothing.
    expect(await submissions().submit({ sessionId: 's1', userId: 'mara' })).toBeUndefined();
    expect((await submissions().get('s1'))?.revision).toBe('abc');

    expect(await submissions().settle('s1', 'withdrawn')).toBe(true);
    // Only an open submission can be settled; a second withdrawal changes nothing.
    expect(await submissions().settle('s1', 'added')).toBe(false);
    expect((await submissions().open(['s1'])).size).toBe(0);

    await submissions().submit({ sessionId: 's1', userId: 'mara' });
    expect(await submissions().get('s1')).toMatchObject({ state: 'submitted', revision: null });
    expect(await submissions().settle('s1', 'added')).toBe(true);
    expect((await submissions().get('s1'))?.state).toBe('added');
  });

  it('names the people who wrote after the submission, first writer first', async () => {
    // A prompt from before the submission is not a check of it.
    await ctx.store.appendEvent('s1', {
      t: 'prompt',
      text: 'old',
      initiatedBy: { userId: 'alex' },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await submissions().submit({ sessionId: 's1', userId: 'mara' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await ctx.store.appendEvent('s1', {
      t: 'prompt',
      text: 'more',
      initiatedBy: { userId: 'mara' },
    });
    await ctx.store.appendEvent('s1', {
      t: 'prompt',
      text: 'look',
      initiatedBy: { userId: 'alex' },
    });
    await ctx.store.appendEvent('s1', {
      t: 'prompt',
      text: 'again',
      initiatedBy: { userId: 'mara' },
    });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'agent' });
    expect(Object.fromEntries(await submissions().writersSince([{ sessionId: 's1' }]))).toEqual({
      s1: ['mara', 'alex'],
    });
  });
});
