import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
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
      owner: 'local',
      repo: id,
      kind: 'local',
      containerName: id,
      state: 'active',
    });
  await ctx.store.createSession({
    sessionId: 's',
    worktree: '/a/session',
    projectId: 'a',
    model: 'claude-test',
  });
  await ctx.store.upsertSessionBackendState({
    sessionId: 's',
    backend: 'claude',
    backendSessionId: 'old',
    contextSeq: 0,
  });
  await ctx.store.prepareSessionMove({
    sessionId: 's',
    operationId: 'move',
    sourceProjectId: 'a',
    sourceWorktree: '/a/session',
    targetProjectId: 'b',
    targetWorktree: '/b/session',
    branch: 'move',
    onCommits: 'block',
  });
});
it('commits workspace, durable notice, backend reset and source retention together', async () => {
  for (const projectId of ['a', 'b'])
    await ctx.db
      .insertInto('secret_run_grants')
      .values({
        capability_hash: projectId,
        grant_id: projectId,
        claims_json: JSON.stringify({ sessionId: 's', projectId }),
        expires_at: new Date(Date.now() + 60000).toISOString(),
      })
      .execute();
  await ctx.store.commitSessionMove('s', 'move', 'Moved to b', '{}');
  expect(
    (await ctx.db.selectFrom('secret_run_grants').select('grant_id').execute()).map(
      (row) => row.grant_id,
    ),
  ).toEqual(['b']);
  expect(await ctx.store.getSession('s')).toMatchObject({ projectId: 'b', worktree: '/b/session' });
  expect(await ctx.store.getSessionBackendStates('s')).toEqual([]);
  expect(await ctx.store.listLiveBackendSessionIds()).toContain('old');
  expect(await ctx.store.getSessionMoveNotice('s')).toBe('Moved to b');
  expect(await ctx.store.listSessionWorktrees()).toEqual(
    expect.arrayContaining(['/a/session', '/b/session']),
  );
  await ctx.store.commitSessionMove('s', 'move', 'Wrong retry notice', '{}');
  expect(await ctx.store.getSessionMoveNotice('s')).toBe('Moved to b');
});
it('leaves the source and backend intact when the target is hidden', async () => {
  await ctx.db
    .updateTable('projects')
    .set({ hidden_at: new Date().toISOString() })
    .where('id', '=', 'b')
    .execute();
  await expect(ctx.store.commitSessionMove('s', 'move', 'Moved', '{}')).rejects.toThrow();
  expect(await ctx.store.getSession('s')).toMatchObject({ projectId: 'a', worktree: '/a/session' });
  expect(await ctx.store.getSessionBackendStates('s')).toHaveLength(1);
  expect(await ctx.store.getSessionMoveNotice('s')).toBeUndefined();
});

it('keeps source recovery protection after the moved session is deleted', async () => {
  await ctx.store.commitSessionMove('s', 'move', 'Moved', '{}');
  await ctx.store.deleteSession('s');
  expect(await ctx.store.getSession('s')).toBeUndefined();
  expect(await ctx.store.listSessionWorktrees()).toContain('/a/session');
  expect(await ctx.store.listLiveBackendSessionIds()).toContain('old');
});
