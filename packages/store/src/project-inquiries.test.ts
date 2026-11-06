import { sql } from 'kysely';
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

it('pages both recovery queues beyond 100 rows without relying on delivery success', async () => {
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
  await sql`insert into project_inquiries (id, source_session_id, target_session_id, source_project_id, target_project_id, title, body, kind, status)
    select 'request' || lpad(n::text,3,'0'), 'source', 'target', 'source', 'target', 'Question', 'Body', 'question', 'approved' from generate_series(1,120) n`.execute(
    ctx.db,
  );
  const first = await ctx.store.projectInquiries.undelivered();
  expect(first).toHaveLength(100);
  const second = await ctx.store.projectInquiries.undelivered(first.at(-1)!.id);
  expect(second).toHaveLength(20);
  expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(120);
  await sql`update project_inquiries set status='answered', answer='Answer'`.execute(ctx.db);
  const answers = await ctx.store.projectInquiries.unansweredDeliveries();
  expect(answers).toHaveLength(100);
  expect(await ctx.store.projectInquiries.unansweredDeliveries(answers.at(-1)!.id)).toHaveLength(
    20,
  );
});

it('applies target visibility before limiting pending approvals', async () => {
  for (const id of ['source', 'target', 'other']) {
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
  await sql`insert into project_inquiries (id, source_session_id, target_session_id, source_project_id, target_project_id, title, body, kind, status, created_at)
    select 'hidden' || n, 'source', 'other', 'source', 'other', 'Hidden', 'Body', 'change', 'pending', now() from generate_series(1,201) n`.execute(
    ctx.db,
  );
  await sql`insert into project_inquiries (id, source_session_id, target_session_id, source_project_id, target_project_id, title, body, kind, status, created_at)
    values ('visible', 'source', 'target', 'source', 'target', 'Visible', 'Body', 'change', 'pending', now() - interval '1 day')`.execute(
    ctx.db,
  );
  const visible = await ctx.store.projectInquiries.list(undefined, true, ['target']);
  expect(visible.map((row) => row.id)).toEqual(['visible']);
  expect(await ctx.store.projectInquiries.list(undefined, true, [])).toEqual([]);
});
