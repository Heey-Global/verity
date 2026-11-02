import { beforeAll, afterAll, beforeEach, it, expect, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { executeQAAnalysis, type QAAnalysisDeps } from './qa-analysis-tool.js';
let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'team',
    repo: 'app',
    containerName: 'app',
    state: 'active',
  });
  await ctx.store.repairs.configureQA(true, 'admin');
  await ctx.store.repairs.qaSession('qa');
  await ctx.store.repairs.configure('p', 'admin', 'monitor');
});
const call = { sessionId: 'qa', turnId: 'turn' };
function deps(): QAAnalysisDeps {
  return {
    eventStore: ctx.store,
    initiator: async () => ({ userId: 'reader' }),
    permitted: async () => true,
    read: vi.fn(async () => ({ data: ['evidence'] })),
  };
}
it('reads only enabled projects for the current user', async () => {
  const d = deps();
  expect(await executeQAAnalysis(d, { ...call, request: { action: 'projects' } })).toMatchObject({
    projects: [{ projectId: 'p' }],
  });
  d.permitted = async () => false;
  expect(await executeQAAnalysis(d, { ...call, request: { action: 'projects' } })).toEqual({
    projects: [],
  });
  await expect(
    executeQAAnalysis(d, { ...call, request: { action: 'pulls', projectId: 'p' } }),
  ).rejects.toThrow('no current read');
  expect(d.read).not.toHaveBeenCalled();
});
it('rejects a result after access is withdrawn during retrieval', async () => {
  const d = deps();
  d.read = async () => {
    d.permitted = async () => false;
    return { data: ['private'] };
  };
  await expect(
    executeQAAnalysis(d, { ...call, request: { action: 'pulls', projectId: 'p' } }),
  ).rejects.toThrow('no current read');
});
it('refuses other sessions and global or project disabling', async () => {
  const d = deps();
  await expect(
    executeQAAnalysis(d, { ...call, sessionId: 'other', request: { action: 'projects' } }),
  ).rejects.toThrow('disabled');
  await ctx.store.repairs.configure('p', 'admin', 'off');
  await expect(
    executeQAAnalysis(d, { ...call, request: { action: 'pulls', projectId: 'p' } }),
  ).rejects.toThrow('no current read');
  await ctx.store.repairs.configureQA(false, 'admin');
  await expect(executeQAAnalysis(d, { ...call, request: { action: 'projects' } })).rejects.toThrow(
    'disabled',
  );
});
it('saves only server-generated report snapshots for the same session and project', async () => {
  const d = deps();
  d.read = async () => ({ groups: [], complete: true, continuation: null });
  d.saveReport = vi.fn(async () => ({ path: 'insights/report.md' }));
  const result = (await executeQAAnalysis(d, {
    ...call,
    request: { action: 'statistics', projectId: 'p' },
  })) as { reportId: string };
  expect(result.reportId).toEqual(expect.any(String));
  await executeQAAnalysis(d, {
    ...call,
    request: { action: 'save_report', projectId: 'p', reportId: result.reportId },
  });
  expect(d.saveReport).toHaveBeenCalledTimes(1);
  await expect(
    executeQAAnalysis(d, {
      ...call,
      request: {
        action: 'save_report',
        projectId: 'p',
        reportId: result.reportId,
        content: 'arbitrary write',
      },
    }),
  ).rejects.toThrow();
  d.initiator = async () => ({ userId: 'other-reader' });
  await expect(
    executeQAAnalysis(d, {
      ...call,
      request: { action: 'save_report', projectId: 'p', reportId: result.reportId },
    }),
  ).rejects.toThrow('Report expired');
});

it('saves an approved systemic follow-up once without launching or assigning work', async () => {
  await sql`insert into users(id,role,status) values ('reader','member','active')`.execute(ctx.db);
  await ctx.store.createSession({
    sessionId: 'qa',
    projectId: 'p',
    worktree: '/tmp/qa',
    model: 'm',
  });
  const d = deps();
  const publishSessionEvent = vi.fn(async () => {});
  const followupDeps = { ...d, publishSessionEvent };
  const request = {
    action: 'create_followup',
    projectId: 'p',
    taskId: '10000000-0000-4000-8000-000000000042',
    title: 'Prevent recurring type failures',
    detail:
      'Evidence: failed job URL. Baseline: first-attempt rate. Target: improve the next equal period.',
  };
  await expect(executeQAAnalysis(d, { ...call, request })).rejects.toThrow('explicit approval');
  expect(
    await executeQAAnalysis(followupDeps, { ...call, request, approvedByCard: true }),
  ).toMatchObject({
    taskId: request.taskId,
    executionAuthorized: false,
  });
  expect(publishSessionEvent).toHaveBeenCalledWith('qa', {
    t: 'tasks_updated',
    origin: 'agent',
    change: 'added',
    taskIds: [request.taskId],
  });
  await executeQAAnalysis(d, { ...call, request, approvedByCard: true });
  const task = await ctx.store.tasks.get(request.taskId, 'reader');
  expect(task).toMatchObject({
    projectId: 'p',
    sourceSessionId: 'qa',
    sessionId: null,
    status: 'open',
  });
  d.permitted = async (_user, _project, permission) => permission === 'read';
  await expect(executeQAAnalysis(d, { ...call, request, approvedByCard: true })).rejects.toThrow(
    'execution permission',
  );
  expect(d.read).not.toHaveBeenCalled();
});
