import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventStore } from './store.js';
import { createTestDb, type TestDb } from './testing.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});

describe('project package protection decision', () => {
  it('defaults existing projects to undecided, persists across store instances, and is removed with the project', async () => {
    const id = randomUUID();
    await ctx.store.upsertProject({
      id,
      owner: 'example',
      repo: 'package-protection',
      containerName: 'test-package-protection',
      state: 'absent',
    });
    expect(await ctx.store.getPackageProtectionDecision(id)).toBe('undecided');
    await ctx.store.setPackageProtectionDecision(id, 'skipped');
    expect(await new EventStore(ctx.db).getPackageProtectionDecision(id)).toBe('skipped');
    await ctx.store.setPackageProtectionDecision(id, 'protected');
    expect(await ctx.store.getPackageProtectionDecision(id)).toBe('protected');
    await ctx.db.deleteFrom('projects').where('id', '=', id).execute();
    expect(await ctx.store.getPackageProtectionDecision(id)).toBe('undecided');
  });
});
