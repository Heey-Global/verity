import { afterEach, expect, it, vi } from 'vitest';
import { createForgejoForgeProvider } from './forgejo-forge-provider.js';
import { ForgejoRequestError, ForgejoTransport } from './forgejo-transport.js';

afterEach(() => vi.useRealTimers());

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
    head: { ref: 'feature', sha: 'abc123', repo: { full_name: 'owner/repo' } },
    base: { ref: 'main', sha: 'def456' },
    updated_at: '2026-01-01T00:00:00Z',
  };
  const json = vi.spyOn(transport, 'json').mockImplementation((path, method) => {
    if (path === '/repos/owner/repo') return Promise.resolve({ allow_merge_commits: true });
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
    checks: { total: 1, successful: 1, failed: 0, pending: 0 },
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
  json.mockRejectedValue(new ForgejoRequestError(501));
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

it('ignores fork branches and preserves later non-null branch results', async () => {
  vi.useFakeTimers();
  const { provider, json } = fixture();
  const implementation = json.getMockImplementation()!;
  json.mockImplementation(async (path, ...args) => {
    const result = await implementation(path, ...args);
    if (path.includes('/pulls?') && Array.isArray(result) && result.length) {
      const original = result[0] as { head: { ref: string; sha: string }; updated_at: string };
      return [
        {
          ...original,
          number: 999,
          updated_at: '2026-10-01T00:00:00Z',
          head: { ...original.head, repo: { full_name: 'fork/repo' } },
        },
        ...(result as unknown[]),
      ];
    }
    return result;
  });
  const service = provider.prServiceFor('/checkout');
  expect(await service.prForBranch('feature')).toBe(7);
  expect(await service.prStatusForBranches(['missing', 'feature'])).toMatchObject({ number: 7 });
  vi.advanceTimersByTime(2_001);
  json.mockImplementation(async (path, ...args) => {
    const result = await implementation(path, ...args);
    return path.includes('/pulls?') && Array.isArray(result)
      ? result.map((row) => ({ ...(row as object), state: 'closed', merged: true }))
      : result;
  });
  expect(await service.prStatusForBranches(['missing', 'feature'])).toMatchObject({
    number: 7,
    phase: 'merged',
  });
});

it('coalesces branch snapshots and status loads until TTL expires', async () => {
  vi.useFakeTimers();
  const { provider, json } = fixture();
  await Promise.all(
    Array.from({ length: 10 }, () =>
      provider.prServiceFor('/checkout').prStatusForBranch('feature'),
    ),
  );
  expect(json.mock.calls.filter(([path]) => path.includes('/pulls?'))).toHaveLength(2);
  expect(json.mock.calls.filter(([path]) => path.includes('/statuses/'))).toHaveLength(2);
  await provider.prServiceFor('/other').prStatusForBranches(['missing', 'feature']);
  expect(json.mock.calls.filter(([path]) => path.includes('/pulls?'))).toHaveLength(2);
  vi.advanceTimersByTime(2_001);
  await provider.prServiceFor('/checkout').prStatusForBranch('feature');
  expect(json.mock.calls.filter(([path]) => path.includes('/pulls?'))).toHaveLength(4);
});

it('cools down failed repository scans instead of repeating requests on every poll', async () => {
  vi.useFakeTimers();
  const { provider, json } = fixture();
  json.mockRejectedValue(new ForgejoRequestError(500));
  const service = provider.prServiceFor('/checkout');
  await service.prStatusForBranch('feature');
  await service.prStatusForBranch('feature');
  expect(json).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5_001);
  await service.prStatusForBranch('feature');
  expect(json).toHaveBeenCalledTimes(2);
});

it('keeps merge support after 405 and chooses the repository default allowed style', async () => {
  const { provider, json } = fixture();
  const original = json.getMockImplementation()!;
  json.mockImplementation((path, ...args) => {
    if (path === '/repos/owner/repo')
      return Promise.resolve({ allow_squash_merge: true, default_merge_style: 'squash' });
    if (path.endsWith('/merge')) return Promise.reject(new ForgejoRequestError(405));
    return original(path, ...args);
  });
  expect(await provider.prServiceFor('/checkout').mergePr(7, 'abc123')).toBe(false);
  expect(provider.capabilities.pullRequestMerge).toBe(true);
  expect(json).toHaveBeenCalledWith('/repos/owner/repo/pulls/7/merge', 'POST', {
    Do: 'squash',
    head_commit_id: 'abc123',
  });
});

it('does not infer a merge conflict from a false or unfinished mergeability result', async () => {
  const { provider, json } = fixture();
  const original = json.getMockImplementation()!;
  json.mockImplementation(async (path, ...args) => {
    const result = await original(path, ...args);
    return path.includes('/pulls?') && Array.isArray(result)
      ? result.map((row) => ({ ...(row as object), mergeable: false }))
      : result;
  });
  expect(await provider.prServiceFor('/checkout').prStatusForBranch('feature')).toMatchObject({
    mergeState: 'unknown',
    mergeable: null,
  });
});

it('treats warning as terminal and never duplicates checks with completed Actions runs', async () => {
  const { provider, json } = fixture();
  const original = json.getMockImplementation()!;
  json.mockImplementation((path, ...args) => {
    if (path.includes('/statuses/'))
      return Promise.resolve(
        path.includes('page=1') ? [{ context: 'lint', status: 'warning' }] : [],
      );
    if (path.includes('/actions/'))
      return Promise.resolve({
        workflow_runs: path.includes('page=1') ? [{ status: 'success', commit_sha: 'abc123' }] : [],
      });
    return original(path, ...args);
  });
  expect(await provider.prServiceFor('/checkout').prStatusForBranch('feature')).toMatchObject({
    pipeline: 'failure',
    checks: { total: 1, completed: 1, failed: 1, pending: 0 },
  });
});

it('propagates repository-list failures so credentials never look like an empty account', async () => {
  const { provider } = fixture();
  const spy = vi
    .spyOn(ForgejoTransport.prototype, 'repositories')
    .mockRejectedValueOnce(new ForgejoRequestError(403));
  await expect(provider.listRepositories()).rejects.toThrow('403');
  spy.mockRestore();
});
