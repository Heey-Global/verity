import { describe, expect, it } from 'vitest';
import { createGitHubForgeAdapter, type ForgeAction } from './brokered-forge-github.js';
const binding = { projectId: 'p', owner: 'acme', repo: 'app' };
describe('repository workflow API policy', () => {
  it.each([
    ['GET', '/commits/abc/check-runs', 'checks-read'],
    ['GET', '/commits/abc/status', 'checks-read'],
    ['GET', '/contents/releases/server-production.json', 'git-read'],
    ['POST', '/git/refs', 'git-write'],
    ['PATCH', '/git/refs/heads/automation/promote', 'git-write'],
    ['GET', '/pulls/12/reviews', 'pulls-read'],
    ['PUT', '/pulls/12/reviews/45/dismissals', 'pulls-write'],
    ['POST', '/actions/workflows/ci.yml/dispatches', 'actions-write'],
    ['POST', '/actions/runs/123/rerun', 'actions-write'],
    ['POST', '/actions/runs/123/cancel', 'actions-write'],
    ['GET', '/actions/runs/123/logs', 'actions-read'],
    ['GET', '/actions/artifacts/123/zip', 'actions-read'],
    ['POST', '/releases', 'releases-write'],
    ['PATCH', '/releases/123', 'releases-write'],
    ['DELETE', '/releases/assets/123', 'releases-write'],
    ['GET', '/issues/123/labels', 'issues-read'],
  ])(
    'authorizes only the bound repository and explicit action: %s %s',
    async (method, path, action) => {
      let mints = 0;
      const adapter = createGitHubForgeAdapter({
        mint: async () => {
          mints++;
          return 'server-token';
        },
        transport: async () => {
          throw new Error('not expected');
        },
      });
      const request = {
        hostname: 'api.github.com',
        method,
        path: '/repos/acme/app' + path,
      };
      const actions = new Set<ForgeAction>([action as ForgeAction, 'pulls-read']);
      await expect(
        adapter.authorize(request, binding, actions, AbortSignal.timeout(1000)),
      ).resolves.toMatchObject({ action });
      expect(mints).toBe(1);
      for (const denied of [
        { ...request, path: request.path.replace('/acme/app', '/acme/other') },
        { ...request, path: '/repos/acme/app/actions/secrets' },
      ]) {
        await expect(
          adapter.authorize(denied, binding, actions, AbortSignal.timeout(1000)),
        ).rejects.toThrow();
      }
      expect(mints).toBe(1);
      await expect(
        adapter.authorize(request, binding, new Set(), AbortSignal.timeout(1000)),
      ).rejects.toThrow();
      expect(mints).toBe(1);
    },
  );
  it('binds streaming Release uploads before minting', async () => {
    const adapter = createGitHubForgeAdapter({
      mint: async () => 'token',
      transport: async () => {
        throw new Error('unexpected');
      },
    });
    const request = {
      hostname: 'uploads.github.com',
      method: 'POST',
      path: '/repos/acme/app/releases/123/assets?name=evidence.zip',
    };
    const actions = new Set<ForgeAction>(['releases-write']);
    expect(adapter.streams(request)).toBe(true);
    await expect(
      adapter.authorize(request, binding, actions, AbortSignal.timeout(1000)),
    ).resolves.toMatchObject({ action: 'releases-write' });
    for (const path of [
      '/repos/acme/other/releases/123/assets?name=x',
      '/repos/acme/app/releases/123/assets',
      '/repos/acme/app/releases/123/assets?name=x&url=https://evil.example',
    ])
      await expect(
        adapter.authorize({ ...request, path }, binding, actions, AbortSignal.timeout(1000)),
      ).rejects.toThrow();
  });
  it('binds signed commit mutations to the repository name inside the input', async () => {
    const adapter = createGitHubForgeAdapter({
      mint: async () => 'token',
      transport: async () => {
        throw new Error('unexpected');
      },
    });
    const query =
      'mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid signature{isValid}}}}';
    for (const repository of ['acme/app', 'acme/other']) {
      const request = {
        hostname: 'api.github.com',
        method: 'POST',
        path: '/graphql',
        body: Buffer.from(
          JSON.stringify({
            query,
            variables: {
              input: {
                branch: { repositoryNameWithOwner: repository, branchName: 'test' },
                expectedHeadOid: 'a'.repeat(40),
                message: { headline: 'test' },
                fileChanges: { additions: [{ path: 'release.json', contents: 'e30=' }] },
              },
            },
          }),
        ),
      };
      const result = adapter.authorize(
        request,
        binding,
        new Set<ForgeAction>(['git-write']),
        AbortSignal.timeout(1000),
      );
      if (repository === 'acme/app')
        await expect(result).resolves.toMatchObject({ action: 'git-write' });
      else await expect(result).rejects.toThrow();
    }
  });
});
