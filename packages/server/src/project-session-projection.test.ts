import { expect, it, vi } from 'vitest';
import { app, ctx } from './server-fixture.test-helper.js';

it('loads project details without joining the full session history queue for short histories', async () => {
  await ctx.store.upsertProject({
    id: 'project',
    owner: 'test',
    repo: 'project',
    containerName: 'test-project',
    state: 'absent',
  });
  await ctx.store.createSession({
    sessionId: 'short-history',
    projectId: 'project',
    worktree: '/wt/short-history',
    model: 'm',
  });
  await ctx.store.appendEvent('short-history', { t: 'prompt', text: 'go' });
  const fullReads = vi.spyOn(ctx.store, 'visitSessionProjectionEvents');
  try {
    const response = await app.inject({ method: 'GET', url: '/projects/project' });
    expect(response.statusCode).toBe(200);
    expect(response.json().sessions).toMatchObject([{ sessionId: 'short-history' }]);
    expect(fullReads).not.toHaveBeenCalled();
  } finally {
    fullReads.mockRestore();
  }
});
