import { createTestDb } from '@verity/store/testing';
import { expect, it } from 'vitest';
import { createGitHubForgeProvider } from './github-forge-provider.js';
import { projectForgeProvider } from './project-forge-provider.js';

it('resolves project bindings without sharing credential caches between connections', async () => {
  const ctx = await createTestDb();
  try {
    const github = createGitHubForgeProvider({
      projectTokenMint: () => Promise.resolve(undefined),
      issuesTokenMint: () => Promise.resolve(undefined),
      installationToken: () => Promise.resolve(undefined),
    });
    for (const id of ['one', 'two'])
      await ctx.store.forgeConnections.upsert({
        id,
        provider: 'forgejo',
        baseUrl: 'https://forge.test',
        label: id,
        personalToken: `fixture-${id}`,
        githubAppId: null,
        githubAppInstallationId: null,
        githubAppPrivateKey: null,
      });
    const project = await ctx.store.createProject({
      id: 'forge-project',
      kind: 'forgejo',
      forgeConnectionId: 'one',
      owner: 'owner',
      repo: 'repo',
      containerName: 'forge',
      state: 'absent',
    });
    const first = await projectForgeProvider(ctx.store, github, project);
    const second = await projectForgeProvider(ctx.store, github, {
      ...project,
      forgeConnectionId: 'two',
    });
    expect(await first?.mintProjectToken(project)).toBe('fixture-one');
    expect(await second?.mintProjectToken(project)).toBe('fixture-two');
    await ctx.store.forgeConnections.upsert({
      id: 'one',
      provider: 'forgejo',
      baseUrl: 'https://forge.test',
      label: 'one',
      personalToken: 'rotated',
      githubAppId: null,
      githubAppInstallationId: null,
      githubAppPrivateKey: null,
    });
    expect(await first?.mintProjectToken(project)).toBe('rotated');
    expect(
      await projectForgeProvider(ctx.store, github, { ...project, forgeConnectionId: null }),
    ).toBeUndefined();
    expect(await projectForgeProvider(ctx.store, github, { ...project, kind: 'github' })).toBe(
      github,
    );
  } finally {
    await ctx.close();
  }
});
