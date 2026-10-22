import { expect, it, vi } from 'vitest';
import { createForgejoForgeProvider } from './forgejo-forge-provider.js';
import { ForgejoRequestError, ForgejoTransport } from './forgejo-transport.js';

function fixture() {
  const transport = new ForgejoTransport('https://forge.test/prefix', () =>
    Promise.resolve('fixture'),
  );
  const pull = {
    number: 7,
    title: 'Change',
    html_url: 'https://forge.test/prefix/owner/repo/pulls/7',
    state: 'open',
    merged: false,
    mergeable: true,
    head: { ref: 'feature', sha: 'abc123' },
    base: { ref: 'main', sha: 'def456' },
    updated_at: '2026-01-01T00:00:00Z',
  };
  const json = vi.spyOn(transport, 'json').mockImplementation((path, method) => {
    if (method === 'POST' && path.endsWith('/merge')) return Promise.resolve(undefined);
    if (method === 'POST' && path.endsWith('/pulls')) return Promise.resolve(pull);
    if (path.includes('/pulls?')) return Promise.resolve(path.includes('page=1') ? [pull] : []);
    if (path.includes('/statuses/'))
      return Promise.resolve(
        path.includes('page=1')
          ? [
              { context: 'lint', status: 'success' },
              { context: 'lint', status: 'failure' },
            ]
          : [],
      );
    if (path.includes('/actions/runs?'))
      return Promise.resolve({
        workflow_runs: path.includes('page=1') ? [{ status: 'running', commit_sha: 'abc123' }] : [],
      });
    return Promise.resolve([]);
  });
  const provider = createForgejoForgeProvider({
    transport,
    token: () => Promise.resolve('fixture'),
    identityFor: () => () => Promise.resolve({ owner: 'owner', repo: 'repo' }),
  });
  return { provider, json };
}
it('binds remote parsing and clone URLs to the exact origin and path prefix', () => {
  const { provider } = fixture();
  expect(provider.parseRemote('https://forge.test/prefix/Owner/Repo.git')).toEqual({
    owner: 'owner',
    repo: 'repo',
  });
  for (const remote of [
    'https://other.test/prefix/owner/repo',
    'https://forge.test/other/owner/repo',
    'https://forge.test/prefix/owner/repo/extra',
    'https://user:pass@forge.test/prefix/owner/repo',
  ])
    expect(provider.parseRemote(remote)).toBeNull();
  expect(provider.cloneUrl({ owner: 'owner', repo: 'repo' })).toBe(
    'https://forge.test/prefix/owner/repo.git',
  );
});
it('combines newest commit contexts with Actions results and guards merge by head SHA', async () => {
  const { provider, json } = fixture();
  const service = provider.prServiceFor('/checkout');
  expect(await service.prStatusForBranch('feature')).toMatchObject({
    number: 7,
    pipeline: 'running',
    checks: { total: 2, successful: 1, failed: 0, pending: 1 },
    mergeable: true,
  });
  expect(await service.mergePr(7, 'abc123')).toBe(true);
  expect(json).toHaveBeenCalledWith('/repos/owner/repo/pulls/7/merge', 'POST', {
    Do: 'merge',
    head_commit_id: 'abc123',
  });
  expect(
    await provider.openPullRequest({ owner: 'owner', repo: 'repo' }, 'fixture', {
      head: 'feature',
      base: 'main',
      title: 'Change',
      body: '',
    }),
  ).toEqual({ number: 7, url: 'https://forge.test/prefix/owner/repo/pulls/7' });
});
it('degrades unsupported PR operations and exposes the capability change', async () => {
  const { provider, json } = fixture();
  json.mockRejectedValue(new ForgejoRequestError(405));
  expect(await provider.prServiceFor('/checkout').prStatusForBranch('feature')).toBeNull();
  expect(provider.capabilities.pullRequests).toBe(false);
  expect(await provider.prServiceFor('/checkout').mergePr(7)).toBe(false);
  expect(provider.capabilities.pullRequestMerge).toBe(false);
  expect(provider.capabilities.releases).toBe(false);
});

it('does not report success when Actions inspection fails after successful statuses', async () => {
  const { provider, json } = fixture();
  const implementation = json.getMockImplementation()!;
  json.mockImplementation((path, ...args) =>
    path.includes('/actions/')
      ? Promise.reject(new ForgejoRequestError(500))
      : implementation(path, ...args),
  );
  expect(await provider.prServiceFor('/checkout').prStatusForBranch('feature')).toMatchObject({
    pipeline: 'unknown',
  });
});
