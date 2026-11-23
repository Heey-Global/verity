import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubRepositoryObservation } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { syncProjectsFromInstallation } from './embedded-support.js';
import { reconcileGitHubRepository } from './github-repository-rename.js';

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

const installation = (repos: { owner: string; repo: string; id?: string }[]) => ({
  listInstallationRepos: () => Promise.resolve(repos),
});

async function deepOcr(state: 'absent' | 'active' = 'active') {
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'heey-global',
    repo: 'deep-ocr',
    containerName: 'verity-heey-global-deep-ocr',
    state,
    overviewVisible: true,
  });
}

describe('installation sync across a GitHub rename', () => {
  it('moves the project to the new name instead of adding a second one', async () => {
    await deepOcr();
    const reconcile = (observation: GitHubRepositoryObservation) =>
      ctx.store.githubRepositories.reconcile(observation);
    // First pass binds the project to its repository's ID ...
    await syncProjectsFromInstallation(
      ctx.store,
      installation([{ owner: 'heey-global', repo: 'deep-ocr', id: '4242' }]),
      { reconcile },
    );
    expect((await ctx.store.getProject('p'))?.githubRepositoryId).toBe('4242');
    // ... so after the rename the same project carries the new name.
    const renamed = installation([{ owner: 'heey-global', repo: 'ocr-engine', id: '4242' }]);
    for (let pass = 0; pass < 2; pass += 1) {
      const projects = await syncProjectsFromInstallation(ctx.store, renamed, { reconcile });
      expect(projects.map(({ id, repo }) => ({ id, repo }))).toEqual([
        { id: 'p', repo: 'ocr-engine' },
      ]);
    }
    expect(await ctx.store.getProject('p')).toMatchObject({
      cloneDir: 'heey-global-deep-ocr',
      state: 'active',
    });
  });

  it('adds a repository that reuses an old name as its own placeholder', async () => {
    await deepOcr();
    const reconcile = (observation: GitHubRepositoryObservation) =>
      ctx.store.githubRepositories.reconcile(observation);
    await syncProjectsFromInstallation(
      ctx.store,
      installation([{ owner: 'heey-global', repo: 'deep-ocr', id: '4242' }]),
      { reconcile },
    );
    const projects = await syncProjectsFromInstallation(
      ctx.store,
      installation([
        { owner: 'heey-global', repo: 'ocr-engine', id: '4242' },
        { owner: 'heey-global', repo: 'deep-ocr', id: '9999' },
      ]),
      { reconcile, includeHidden: true },
    );
    const byRepo = new Map(projects.map((project) => [project.repo, project]));
    expect(byRepo.get('ocr-engine')?.id).toBe('p');
    expect(byRepo.get('deep-ocr')?.id).not.toBe('p');
    expect(byRepo.get('deep-ocr')?.state).toBe('absent');
  });
});

describe('installation sync with a reused name', () => {
  it('never applies a different repository’s state to a bound project', async () => {
    await deepOcr();
    const reconcile = (observation: GitHubRepositoryObservation) =>
      ctx.store.githubRepositories.reconcile(observation);
    await syncProjectsFromInstallation(
      ctx.store,
      installation([{ owner: 'heey-global', repo: 'deep-ocr', id: '4242' }]),
      { reconcile },
    );
    // 4242 left the installation; an archived newcomer now answers to its old name.
    await syncProjectsFromInstallation(
      ctx.store,
      {
        listInstallationRepos: () =>
          Promise.resolve([{ owner: 'heey-global', repo: 'deep-ocr', id: '9999', archived: true }]),
      },
      { reconcile },
    );
    expect(await ctx.store.getProject('p')).toMatchObject({
      repo: 'deep-ocr',
      githubRepositoryId: '4242',
      archived: false,
    });
  });
});

describe('reconcileGitHubRepository', () => {
  const observation = {
    requestedOwner: 'heey-global',
    requestedRepo: 'deep-ocr',
    id: '4242',
    owner: 'heey-global',
    repo: 'ocr-engine',
  };

  it('refreshes the checkout of a renamed project that has a Sandbox', async () => {
    await deepOcr('active');
    await ctx.store.githubRepositories.reconcile({ ...observation, repo: 'deep-ocr' });
    const syncProjectCheckout = vi.fn(() => Promise.resolve());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(
        await reconcileGitHubRepository(ctx.store, () => ({ syncProjectCheckout }), observation),
      ).toEqual(['p']);
      await vi.waitFor(() => expect(syncProjectCheckout).toHaveBeenCalledWith('p'));
      // Repeating the observation moves nothing and refreshes nothing.
      await reconcileGitHubRepository(ctx.store, () => ({ syncProjectCheckout }), observation);
      expect(syncProjectCheckout).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves a project without a Sandbox to its next provisioning', async () => {
    await deepOcr('absent');
    await ctx.store.githubRepositories.reconcile({ ...observation, repo: 'deep-ocr' });
    const syncProjectCheckout = vi.fn(() => Promise.resolve());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await reconcileGitHubRepository(ctx.store, () => ({ syncProjectCheckout }), observation);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(syncProjectCheckout).not.toHaveBeenCalled();
      expect((await ctx.store.getProject('p'))?.repo).toBe('ocr-engine');
    } finally {
      warn.mockRestore();
    }
  });
});
