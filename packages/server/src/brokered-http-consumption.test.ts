import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createBrokeredHttpConsumptionStore } from './brokered-http-consumption.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
beforeEach(async () => {
  await ctx.store.upsertProject({
    id: 'project-1',
    owner: 'acme',
    repo: 'app',
    containerName: 'verity-acme-app',
    state: 'active',
  });
  await ctx.store.createSession({
    sessionId: 'session-1',
    worktree: '/tmp/brokered-http-consumption',
    model: 'codex/default',
    projectId: 'project-1',
  });
});
afterEach(async () => truncateAll(ctx.db));
afterAll(async () => ctx.close());

describe('brokered HTTP consumption store', () => {
  it('consumes one attested call durably while allowing a later identical request', async () => {
    const store = createBrokeredHttpConsumptionStore(ctx.db);
    const first = {
      projectId: 'project-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      callId: 'call-1',
      requestHash: 'a'.repeat(64),
    };
    await expect(store.consume(first)).resolves.toBe(true);
    await expect(store.consume(first)).resolves.toBe(false);
    await expect(store.consume({ ...first, callId: 'call-2' })).resolves.toBe(true);
    await ctx.db.deleteFrom('sessions').where('session_id', '=', 'session-1').execute();
    await expect(
      ctx.db.selectFrom('brokered_http_consumptions').select('call_id').execute(),
    ).resolves.toEqual([]);
  });
  it('has one concurrent winner and retains the fence across store recreation', async () => {
    const input = {
      projectId: 'project-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      callId: 'call-1',
      requestHash: 'a'.repeat(64),
    };
    const stores = [
      createBrokeredHttpConsumptionStore(ctx.db),
      createBrokeredHttpConsumptionStore(ctx.db),
    ];
    const results = await Promise.all(stores.map((store) => store.consume(input)));
    expect(results.sort()).toEqual([false, true]);
    const reopened = createBrokeredHttpConsumptionStore(ctx.db);
    await expect(reopened.consume(input)).resolves.toBe(false);
    // Editing an already consumed call cannot turn its identity into fresh permission.
    await expect(reopened.consume({ ...input, requestHash: 'b'.repeat(64) })).resolves.toBe(false);
    await expect(reopened.consume({ ...input, callId: 'call-2' })).resolves.toBe(true);
  });
});
