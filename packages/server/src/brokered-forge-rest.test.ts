import { describe, expect, it } from 'vitest';
import { createGitHubForgeAdapter, type ForgeAction } from './brokered-forge-github.js';
const binding = { projectId: 'p', owner: 'acme', repo: 'app' };
describe('repository workflow API policy', () => {
  it.each([
    ['GET', '/commits/abc/check-runs', 'checks-read'],
    ['GET', '/commits/abc/status', 'checks-read'],
    ['GET', '/commits/abc/statuses', 'checks-read'],
    ['GET', '/branches/main/protection', 'repository-rules-read'],
    ['HEAD', '/branches/main/protection/required_status_checks', 'repository-rules-read'],
    ['GET', '/rulesets', 'repository-rules-read'],
    ['GET', '/rulesets/123', 'repository-rules-read'],
    ['GET', '/rules/branches/main', 'repository-rules-read'],
    ['GET', '/contents/releases/server-production.json', 'git-read'],
    ['POST', '/git/refs', 'git-write'],
    ['PATCH', '/git/refs/heads/automation/promote', 'git-write'],
    ['GET', '/pulls/12/reviews', 'pulls-read'],
    ['PUT', '/pulls/12/reviews/45/dismissals', 'pulls-write'],
    ['PUT', '/pulls/12/update-branch', 'pulls-write'],
    ['POST', '/actions/workflows/ci.yml/dispatches', 'actions-write'],
    ['POST', '/actions/runs/123/rerun', 'actions-write'],
    ['POST', '/actions/runs/123/cancel', 'actions-write'],
    ['GET', '/actions/runs/123/logs', 'actions-read'],
    ['GET', '/actions/artifacts/123/zip', 'actions-read'],
    ['POST', '/releases', 'releases-write'],
    ['PATCH', '/releases/123', 'releases-write'],
    ['DELETE', '/releases/assets/123', 'releases-write'],
    ['GET', '/issues/123/labels', 'issues-read'],
    ['HEAD', '/issues/123', 'issues-read'],
  ])(
    'authorizes only the bound repository and explicit action: %s %s',
    async (method, path, action) => {
      let mints = 0;
      const adapter = createGitHubForgeAdapter({
        mintDiagnostic: async () => {
          mints++;
          return 'diagnostic-token';
        },
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

// A diagnostic grant must never become authority to relax merge requirements.
describe('repository rules mutations', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects %s before minting', async (method) => {
    let mints = 0;
    const adapter = createGitHubForgeAdapter({
      mint: async () => {
        mints++;
        return 'token';
      },
      transport: async () => {
        throw new Error('unexpected');
      },
    });
    for (const suffix of [
      '/branches/main/protection',
      '/rulesets',
      '/rulesets/123',
      '/rules/branches/main',
    ]) {
      await expect(
        adapter.authorize(
          { hostname: 'api.github.com', method, path: '/repos/acme/app' + suffix },
          binding,
          new Set<ForgeAction>(['repository-rules-read']),
          AbortSignal.timeout(1000),
        ),
      ).rejects.toThrow();
    }
    expect(mints).toBe(0);
  });
});

// Missing optional grants must not disable the project's normal Git credentials.
describe('isolated diagnostic credentials', () => {
  it('selects minimal diagnostic grants and keeps Git usable after denied issuance', async () => {
    const permissions: string[] = [];
    let ordinaryMints = 0;
    const adapter = createGitHubForgeAdapter({
      mint: async () => {
        ordinaryMints++;
        return 'ordinary-token';
      },
      mintDiagnostic: async (_binding, permission) => {
        permissions.push(permission);
        return undefined;
      },
      transport: async () => {
        throw new Error('unexpected');
      },
    });
    const actions = new Set<ForgeAction>(['checks-read', 'repository-rules-read', 'git-read']);
    for (const suffix of [
      '/commits/abc/status',
      '/commits/abc/statuses',
      '/branches/main/protection',
      '/rulesets',
      '/rules/branches/main',
    ]) {
      await expect(
        adapter.authorize(
          { hostname: 'api.github.com', method: 'GET', path: '/repos/acme/app' + suffix },
          binding,
          actions,
          AbortSignal.timeout(1000),
        ),
      ).rejects.toThrow();
    }
    expect(permissions).toEqual(['statuses', 'statuses', 'administration', 'contents', 'contents']);
    expect(ordinaryMints).toBe(0);
    await expect(
      adapter.authorize(
        {
          hostname: 'github.com',
          method: 'GET',
          path: '/acme/app.git/info/refs?service=git-upload-pack',
        },
        binding,
        actions,
        AbortSignal.timeout(1000),
      ),
    ).resolves.toMatchObject({ action: 'git-read' });
    expect(ordinaryMints).toBe(1);
    const before = permissions.length;
    await expect(
      adapter.authorize(
        {
          hostname: 'api.github.com',
          method: 'GET',
          path: '/repos/acme/other/branches/main/protection',
        },
        binding,
        actions,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow();
    expect(permissions).toHaveLength(before);
  });
});

// Repository and branch names must not select a stronger diagnostic permission.
it.each([
  ['protection', '/rulesets', 'contents'],
  ['app', '/rules/branches/protection-fix', 'contents'],
  ['protection', '/branches/main/protection', 'administration'],
])('selects the endpoint grant for %s%s', async (repo, suffix, expected) => {
  const grants: string[] = [];
  const adapter = createGitHubForgeAdapter({
    mint: async () => {
      throw new Error('unexpected ordinary mint');
    },
    mintDiagnostic: async (_binding, permission) => {
      grants.push(permission);
      return 'diagnostic-token';
    },
    transport: async () => {
      throw new Error('unexpected transport');
    },
  });
  await adapter.authorize(
    { hostname: 'api.github.com', method: 'GET', path: `/repos/acme/${repo}${suffix}` },
    { ...binding, repo },
    new Set<ForgeAction>(['repository-rules-read']),
    AbortSignal.timeout(1000),
  );
  expect(grants).toEqual([expected]);
});

// A file named status must retain contents access rather than receive a status token.
it('keeps content paths out of status-token selection', async () => {
  const adapter = createGitHubForgeAdapter({
    mint: async () => 'contents-token',
    mintDiagnostic: async () => {
      throw new Error('unexpected diagnostic mint');
    },
    transport: async () => {
      throw new Error('unexpected transport');
    },
  });
  await expect(
    adapter.authorize(
      {
        hostname: 'api.github.com',
        method: 'GET',
        path: '/repos/acme/app/contents/commits/foo/status',
      },
      binding,
      new Set<ForgeAction>(['git-read']),
      AbortSignal.timeout(1000),
    ),
  ).resolves.toMatchObject({ action: 'git-read', authorization: 'Bearer contents-token' });
});

// Updating a PR branch must not grant other methods or adjacent routes.
it.each(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'PUT'])(
  'rejects unsupported update-branch requests: %s',
  async (method) => {
    let mints = 0;
    const adapter = createGitHubForgeAdapter({
      mint: async () => {
        mints++;
        return 'token';
      },
      transport: async () => {
        throw new Error('unexpected');
      },
    });
    for (const path of method === 'PUT'
      ? ['/pulls/12/update-branch/extra', '/pulls/nope/update-branch']
      : ['/pulls/12/update-branch']) {
      await expect(
        adapter.authorize(
          { hostname: 'api.github.com', method, path: '/repos/acme/app' + path },
          binding,
          new Set<ForgeAction>(['pulls-read', 'pulls-write']),
          AbortSignal.timeout(1000),
        ),
      ).rejects.toThrow();
    }
    expect(mints).toBe(0);
  },
);
