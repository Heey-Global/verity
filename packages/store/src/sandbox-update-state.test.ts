import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './testing.js';
import { SandboxUpdateStateStore } from './sandbox-update-state.js';
let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
it('retains wait and recovery across store reconstruction; removes them with the project', async () => {
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'example',
    repo: 'site',
    containerName: 'dev-p1',
    state: 'active',
  });
  const state = { since: 123, reasons: ['preview'], reportedAt: 456 };
  await ctx.store.sandboxUpdateState.set('p1', state);
  const restarted = new SandboxUpdateStateStore(ctx.db);
  expect((await restarted.list()).get('p1')).toEqual(state);
  const recovery = {
    ...state,
    reasons: [],
    recovery: { state: 'failed' as const, at: 789, detail: 'web did not restart' },
  };
  await restarted.set('p1', recovery);
  expect((await ctx.store.sandboxUpdateState.list()).get('p1')).toEqual(recovery);
  await sql`delete from projects where id='p1'`.execute(ctx.db);
  expect(await restarted.list()).toEqual(new Map());
  await restarted.clear('p1');
  expect(await restarted.list()).toEqual(new Map());
  await restarted.set('gone', state);
  expect(await restarted.list()).toEqual(new Map());
});
