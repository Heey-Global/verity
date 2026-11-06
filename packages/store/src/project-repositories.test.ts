import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from './testing.js';
import { projectForRepository } from './project-repositories.js';

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

async function project(id = 'p') {
  return ctx.store.createProject({
    id,
    owner: 'one',
    repo: id,
    containerName: `container-${id}`,
    state: 'active',
  });
}

describe('project repository assignments', () => {
  it('preserves the legacy default identity and session worktree without copying them', async () => {
    const original = await project();
    await ctx.store.createSession({
      sessionId: 's',
      projectId: 'p',
      worktree: '/existing',
      model: 'test',
    });
    const repositories = await ctx.store.listProjectRepositories('p');
    expect(repositories).toMatchObject([
      { id: 'default:p', owner: 'one', repo: 'p', isDefault: true },
    ]);
    expect(projectForRepository(original, repositories[0]!)).toEqual(original);
    expect((await ctx.store.getSession('s'))?.worktree).toBe('/existing');
    expect(await ctx.store.listSessionRepositoryWorkspaces('s')).toEqual([]);
  });

  it('connects repositories across organizations and hosts and rejects duplicate active identities', async () => {
    await project();
    const extra = await ctx.store.addProjectRepository({
      projectId: 'p',
      name: 'API',
      kind: 'forgejo',
      owner: 'Elsewhere',
      repo: 'Api',
      forgeConnectionId: 'forge',
      defaultBranch: 'develop',
    });
    expect(extra).toMatchObject({
      owner: 'elsewhere',
      repo: 'api',
      defaultBranch: 'develop',
      isDefault: false,
    });
    await expect(
      ctx.store.addProjectRepository({
        projectId: 'p',
        name: 'duplicate',
        kind: 'forgejo',
        owner: 'ELSEWHERE',
        repo: 'API',
        forgeConnectionId: 'forge',
      }),
    ).rejects.toThrow();
    await ctx.store.addProjectRepository({
      projectId: 'p',
      name: 'Other host',
      kind: 'github',
      owner: 'elsewhere',
      repo: 'api',
    });
    expect(await ctx.store.listProjectRepositories('p')).toHaveLength(3);
    await expect(
      ctx.store.addProjectRepository({
        projectId: 'p',
        name: 'Alias duplicate',
        kind: 'github',
        owner: 'elsewhere',
        repo: 'api',
        forgeConnectionId: 'legacy-github',
      }),
    ).rejects.toThrow();
    await expect(
      ctx.store.addProjectRepository({
        projectId: 'p',
        name: 'default again',
        kind: 'github',
        owner: 'one',
        repo: 'p',
      }),
    ).rejects.toThrow('already');
  });

  it('rejects foreign repository and session assignments and preserves revoked workspaces', async () => {
    const own = await project();
    await project('other');
    await ctx.store.createSession({
      sessionId: 's',
      projectId: 'p',
      worktree: '/main',
      model: 'test',
    });
    await ctx.store.createSession({
      sessionId: 'foreign',
      projectId: 'other',
      worktree: '/foreign',
      model: 'test',
    });
    const extra = await ctx.store.addProjectRepository({
      projectId: 'p',
      name: 'API',
      kind: 'github',
      owner: 'two',
      repo: 'api',
    });
    expect(await ctx.store.getProjectRepository('other', extra.id)).toBeUndefined();
    expect(() => projectForRepository({ ...own, id: 'other' }, extra)).toThrow('not connected');
    const assignment = {
      sessionId: 's',
      projectId: 'p',
      repositoryId: extra.id,
      worktree: '/api',
      branch: 'feat/api',
    };
    await expect(
      ctx.store.upsertSessionRepositoryWorkspace({ ...assignment, sessionId: 'foreign' }),
    ).rejects.toThrow('session');
    const first = await ctx.store.upsertSessionRepositoryWorkspace(assignment);
    expect(
      await ctx.store.upsertSessionRepositoryWorkspace({ ...assignment, worktree: '/duplicate' }),
    ).toEqual(first);
    const pullRequest = {
      dependsOn: ['https://github.com/one/p/pull/1'],
      number: 7,
      head: 'feat/renamed',
      url: 'https://github.com/two/api/pull/7',
    };
    await ctx.store.recordRepositoryPullRequest(
      'p',
      extra.id,
      pullRequest.head,
      pullRequest,
      'foreign',
    );
    expect((await ctx.store.listSessionRepositoryWorkspaces('s'))[0]?.pullRequest).toBeNull();
    await ctx.store.recordRepositoryPullRequest('p', extra.id, pullRequest.head, pullRequest, 's');
    const saved = (await ctx.store.listSessionRepositoryWorkspaces('s'))[0];
    expect(saved?.branch).toBe(pullRequest.head);
    expect(saved?.pullRequest).toEqual(pullRequest);
    await ctx.store.recordRepositoryPullRequest(
      'p',
      extra.id,
      pullRequest.head,
      { number: 7, state: 'closed' },
      's',
    );
    expect((await ctx.store.listSessionRepositoryWorkspaces('s'))[0]?.pullRequest).toEqual({
      ...pullRequest,
      state: 'closed',
    });
    const updated = (await ctx.store.listSessionRepositoryWorkspaces('s'))[0];
    expect(await ctx.store.removeProjectRepository('p', extra.id)).toBe(true);
    expect(await ctx.store.getProjectRepository('p', extra.id)).toBeUndefined();
    expect(await ctx.store.listProjectRepositories('p')).toHaveLength(1);
    expect(await ctx.store.listProjectRepositories('p', { includeRemoved: true })).toHaveLength(2);
    expect(await ctx.store.listSessionRepositoryWorkspaces('s')).toEqual([updated]);
    await expect(ctx.store.upsertSessionRepositoryWorkspace(assignment)).rejects.toThrow(
      'not connected',
    );
  });
});
