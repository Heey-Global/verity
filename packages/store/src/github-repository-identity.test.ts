import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { projectForRepository } from './project-repositories.js';
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

async function project(id: string, repo: string, overviewVisible = true) {
  const created = await ctx.store.upsertProject({
    id,
    owner: 'heey-global',
    repo,
    containerName: `heey-global-${repo}`,
    state: 'absent',
    overviewVisible,
  });
  return created;
}

const renamed = {
  requestedOwner: 'heey-global',
  requestedRepo: 'deep-ocr',
  id: '4242',
  owner: 'heey-global',
  repo: 'ocr-engine',
};

describe('GitHub repository identity', () => {
  it('learns the ID GitHub reports for the stored name, once', async () => {
    await project('p', 'deep-ocr');
    const observation = { ...renamed, owner: 'heey-global', repo: 'deep-ocr' };
    expect(await ctx.store.githubRepositories.reconcile(observation)).toEqual({
      renamedProjectIds: [],
      renamedRepositoryProjectIds: [],
    });
    expect((await ctx.store.getProject('p'))?.githubRepositoryId).toBe('4242');
    expect(await ctx.store.githubRepositories.lookup('Heey-Global', 'Deep-OCR')).toBe('4242');
  });

  it('moves a project to the new name and keeps its clone, sessions and capability', async () => {
    await project('p', 'deep-ocr');
    await ctx.store.githubRepositories.reconcile({ ...renamed, repo: 'deep-ocr' });
    await ctx.store.createSession({
      sessionId: 's',
      worktree: '/data/dev/heey-global-deep-ocr/sessions/s',
      model: 'm',
      projectId: 'p',
    });
    await ctx.db
      .insertInto('users')
      .values({ id: 'u', role: 'member', status: 'active' })
      .execute();
    await ctx.db
      .insertInto('gh_token_capabilities')
      .values({
        project_id: 'p',
        user_id: 'u',
        cap_hash: 'h',
        owner: 'heey-global',
        repo: 'deep-ocr',
        container_generation: null,
      })
      .execute();

    const result = await ctx.store.githubRepositories.reconcile(renamed);

    expect(result.renamedProjectIds).toEqual(['p']);
    const moved = await ctx.store.getProject('p');
    expect(moved).toMatchObject({
      id: 'p',
      owner: 'heey-global',
      repo: 'ocr-engine',
      githubRepositoryId: '4242',
      // The clone directory and the container are where they were.
      cloneDir: 'heey-global-deep-ocr',
      containerName: 'heey-global-deep-ocr',
      repositoryInstance: 1,
    });
    expect((await ctx.store.getSession('s'))?.projectId).toBe('p');
    const capability = await ctx.db
      .selectFrom('gh_token_capabilities')
      .select(['owner', 'repo'])
      .executeTakeFirstOrThrow();
    expect(capability).toEqual({ owner: 'heey-global', repo: 'ocr-engine' });
    // Seen again — by either name — nothing changes any more.
    expect((await ctx.store.githubRepositories.reconcile(renamed)).renamedProjectIds).toEqual([]);
    expect(
      (
        await ctx.store.githubRepositories.reconcile({
          ...renamed,
          requestedRepo: 'ocr-engine',
        })
      ).renamedProjectIds,
    ).toEqual([]);
    expect(await ctx.store.getProject('p')).toEqual(moved);
  });

  it('never moves a project from a name GitHub did not report for it', async () => {
    // Without a recorded ID, only an observation for the stored name can bind it.
    await project('p', 'deep-ocr');
    await ctx.store.githubRepositories.reconcile({ ...renamed, requestedRepo: 'something-else' });
    expect(await ctx.store.getProject('p')).toMatchObject({
      repo: 'deep-ocr',
      githubRepositoryId: null,
    });
  });

  it('leaves the old name to a different repository that takes it over', async () => {
    await project('p', 'deep-ocr');
    await ctx.store.githubRepositories.reconcile({ ...renamed, repo: 'deep-ocr' });
    // GitHub now reports a different repository under the old name. The project is
    // bound to 4242 and must neither move nor adopt the newcomer's ID.
    const newcomer = { ...renamed, id: '9999', repo: 'deep-ocr' };
    expect(await ctx.store.githubRepositories.reconcile(newcomer)).toEqual({
      renamedProjectIds: [],
      renamedRepositoryProjectIds: [],
    });
    expect(await ctx.store.getProject('p')).toMatchObject({
      repo: 'deep-ocr',
      githubRepositoryId: '4242',
    });
    // Nor does the newcomer's own rename drag the bound project along.
    await ctx.store.githubRepositories.reconcile({ ...newcomer, repo: 'newcomer-renamed' });
    expect(await ctx.store.getProject('p')).toMatchObject({
      repo: 'deep-ocr',
      githubRepositoryId: '4242',
    });
    await ctx.store.githubRepositories.reconcile(renamed);
    expect(await ctx.store.githubRepositories.lookup('heey-global', 'deep-ocr')).toBeUndefined();
    expect(await ctx.store.githubRepositories.lookup('heey-global', 'ocr-engine')).toBe('4242');
  });

  it('refuses to pick between repositories bound under the same name', async () => {
    await project('p', 'deep-ocr');
    await ctx.store.githubRepositories.reconcile({ ...renamed, repo: 'deep-ocr' });
    await ctx.store.addProjectRepository({
      projectId: 'p',
      name: 'other',
      kind: 'github',
      owner: 'other-owner',
      repo: 'deep-ocr',
    });
    await ctx.db
      .updateTable('project_repositories')
      .set({ owner: 'heey-global', github_repository_id: '9999' })
      .execute();
    await expect(ctx.store.githubRepositories.lookup('heey-global', 'deep-ocr')).rejects.toThrow(
      'bound to more than one GitHub repository',
    );
  });

  it('rejects an ID that would not survive a JavaScript number', async () => {
    await expect(
      ctx.store.githubRepositories.reconcile({ ...renamed, id: '9007199254740993' }),
    ).rejects.toThrow('invalid GitHub repository ID');
  });

  it('adopts the placeholder the installation sync left under the new name', async () => {
    await project('p', 'deep-ocr');
    await ctx.store.githubRepositories.reconcile({ ...renamed, repo: 'deep-ocr' });
    await project('placeholder', 'ocr-engine', false);

    await ctx.store.githubRepositories.reconcile(renamed);

    expect(await ctx.store.getProject('placeholder')).toBeUndefined();
    expect(await ctx.store.getProject('p')).toMatchObject({
      repo: 'ocr-engine',
      repositoryInstance: 1,
    });
  });

  it('keeps a project someone created under the new name and numbers the moved one after it', async () => {
    await project('p', 'deep-ocr');
    await ctx.store.githubRepositories.reconcile({ ...renamed, repo: 'deep-ocr' });
    await project('other', 'ocr-engine');

    await ctx.store.githubRepositories.reconcile(renamed);

    expect(await ctx.store.getProject('other')).toMatchObject({
      repo: 'ocr-engine',
      repositoryInstance: 1,
    });
    expect(await ctx.store.getProject('p')).toMatchObject({
      repo: 'ocr-engine',
      repositoryInstance: 2,
      cloneDir: 'heey-global-deep-ocr',
    });
  });

  it('moves an additional repository and keeps its ID apart from the default one', async () => {
    const owner = await project('p', 'app');
    await ctx.store.githubRepositories.reconcile({
      ...renamed,
      id: '1',
      requestedRepo: 'app',
      repo: 'app',
    });
    const added = await ctx.store.addProjectRepository({
      projectId: 'p',
      name: 'deep-ocr',
      kind: 'github',
      owner: 'heey-global',
      repo: 'deep-ocr',
    });
    await ctx.store.githubRepositories.reconcile({ ...renamed, repo: 'deep-ocr' });

    const result = await ctx.store.githubRepositories.reconcile(renamed);

    expect(result).toEqual({ renamedProjectIds: [], renamedRepositoryProjectIds: ['p'] });
    const repository = await ctx.store.getProjectRepository('p', added.id);
    expect(repository).toMatchObject({
      id: added.id,
      name: 'ocr-engine',
      repo: 'ocr-engine',
      githubRepositoryId: '4242',
    });
    const target = projectForRepository((await ctx.store.getProject('p')) ?? owner, repository!);
    // A token for the additional repository must never be scoped to the default one.
    expect(target.githubRepositoryId).toBe('4242');
    expect((await ctx.store.getProject('p'))?.githubRepositoryId).toBe('1');
  });
});
