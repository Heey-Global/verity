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

it('keeps exact-scope approvals, reusable targets and revocation durable', async () => {
  for (const id of ['source', 'target']) {
    await ctx.store.createProject({
      id,
      owner: 'team',
      repo: id,
      containerName: id,
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: id,
      projectId: id,
      worktree: `/${id}`,
      model: 'test',
    });
  }
  const inquiries = ctx.store.projectInquiries;
  await inquiries.setGrant('source', 'target', true);
  await inquiries.bind('source', 'target', 'target');
  expect(await inquiries.target('source', 'target')).toBe('target');
  const input = {
    id: 'request',
    sourceSessionId: 'source',
    targetSessionId: 'target',
    sourceProjectId: 'source',
    targetProjectId: 'target',
    title: 'Staging',
    body: 'Create staging only',
    kind: 'change' as const,
    status: 'pending' as const,
    userId: null,
  };
  await inquiries.create(input);
  await expect(inquiries.create({ ...input, body: 'Create production' })).rejects.toThrow(
    'different request',
  );
  expect(await inquiries.decide('request', 'source', true, null)).toBe(false);
  expect(await inquiries.decide('request', 'target', true, null)).toBe(true);
  expect(await inquiries.decide('request', 'target', true, null)).toBe(false);
  await inquiries.markQueued('request');
  expect(await inquiries.answer('request', 'source', 'Done')).toBe(false);
  expect(await inquiries.answer('request', 'target', 'Done')).toBe(true);
  expect(await inquiries.unansweredDeliveries()).toHaveLength(1);
  await inquiries.markAnswerDelivered('request');
  expect(await inquiries.unansweredDeliveries()).toEqual([]);
  await inquiries.create({ ...input, id: 'revoked' });
  await inquiries.setGrant('source', 'target', false);
  expect((await inquiries.get('revoked'))?.status).toBe('blocked');
  expect(await inquiries.decide('revoked', 'target', true, null)).toBe(false);
});
