import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './testing.js';
import { ContextConflictError } from './user-context.js';
let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.db
    .insertInto('users')
    .values([
      { id: 'context-u1', role: 'member', status: 'active' },
      { id: 'context-u2', role: 'member', status: 'active' },
    ])
    .execute();
});
afterAll(async () => {
  await ctx.close();
});
describe('private user context', () => {
  it('isolates users, detects lost updates and keeps explicit clears authoritative', async () => {
    const first = await ctx.store.userContext.replace('context-u1', 0, {
      instructions: 'Use English',
      memory: 'Prefers tea',
    });
    expect(await ctx.store.userContext.read('context-u2')).toEqual({
      instructions: '',
      memory: '',
      revision: 0,
    });
    await expect(
      ctx.store.userContext.replace('context-u1', 0, { instructions: '', memory: '' }),
    ).rejects.toBeInstanceOf(ContextConflictError);
    await ctx.store.userContext.replace('context-u1', first.revision, {
      instructions: '',
      memory: '',
    });
    expect(await ctx.store.userContext.read('context-u1')).toEqual({
      instructions: '',
      memory: '',
      revision: 2,
    });
  });
  it('serializes two edits from the same revision', async () => {
    const results = await Promise.allSettled(
      ['a', 'b'].map((memory) =>
        ctx.store.userContext.replace('context-u2', 0, { instructions: '', memory }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
  it('rejects oversized context without changing storage', async () => {
    await expect(
      ctx.store.userContext.replace('context-u1', 2, {
        instructions: 'x'.repeat(12_001),
        memory: '',
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect((await ctx.store.userContext.read('context-u1')).revision).toBe(2);
  });
});
