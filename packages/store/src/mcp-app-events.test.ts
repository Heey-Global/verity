import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { AgentEvent } from '@verity/events';
import { createTestDb, truncateAll, type TestDb } from './testing.js';
import { EventStore } from './store.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});
afterAll(async () => {
  await ctx.close();
});

it('restores only the latest snapshot of the requested app from its own session', async () => {
  await ctx.store.createSession({ sessionId: 's', model: 'test', worktree: '/work/s' });
  await ctx.store.createSession({ sessionId: 'other', model: 'test', worktree: '/work/other' });
  const event: Extract<AgentEvent, { t: 'mcp_app' }> = {
    t: 'mcp_app',
    appId: '00000000-0000-4000-8000-000000000001',
    projectId: 'p',
    sessionId: 's',
    turnId: 'finished',
    connectionId: 'c',
    connectionFingerprint: 'fingerprint',
    toolName: 'dashboard',
    resourceUri: 'ui://dashboard',
    input: {},
    result: { content: [], structuredContent: { count: 1 }, _meta: { privateToApp: true } },
  };
  await ctx.store.appendEvent('s', event);
  await ctx.store.appendEvent('s', {
    ...event,
    result: { content: [], structuredContent: { count: 2 } },
  });
  const restarted = new EventStore(ctx.db);
  expect((await restarted.getMcpAppEvent('s', event.appId))?.result.structuredContent).toEqual({
    count: 2,
  });
  expect(await restarted.getMcpAppEvent('other', event.appId)).toBeUndefined();
  expect(
    await restarted.getMcpAppEvent('s', '00000000-0000-4000-8000-000000000002'),
  ).toBeUndefined();
});
