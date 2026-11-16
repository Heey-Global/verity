import { afterEach, expect, it, vi } from 'vitest';
import { createGitHubPrService, type HttpFetch, type HttpResponse } from './github.js';
import { createGitHubForgeProvider } from './github-forge-provider.js';
import { GitHubPollCache, githubRetryDeadline } from './github-poll-cache.js';

const response = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): HttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});
const identity = () => Promise.resolve({ owner: 'owner', repo: 'repo' });
afterEach(() => vi.useRealTimers());

it.each([
  [429, { 'retry-after': '120' }],
  [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '121' }],
] as const)('honors the GitHub PR rate-limit deadline (%s)', async (status, headers) => {
  let at = 1000;
  const fetch = vi
    .fn<HttpFetch>()
    .mockResolvedValueOnce(response({}, status, headers))
    .mockResolvedValue(response([]));
  const service = createGitHubPrService({
    repoDir: '',
    identity,
    token: 'fixture',
    fetch,
    now: () => at,
  });
  expect(await service.prStatusForBranch('feature')).toBeNull();
  at = 61_001;
  await service.prStatusForBranch('feature');
  expect(fetch).toHaveBeenCalledTimes(1);
  at = 121_001;
  await service.prStatusForBranch('feature');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('accepts an HTTP-date Retry-After and ignores an unrelated permission denial', () => {
  expect(
    githubRetryDeadline(
      response({}, 429, { 'retry-after': 'Thu, 01 Jan 1970 00:02:00 GMT' }),
      1000,
    ),
  ).toBe(120_000);
  expect(githubRetryDeadline(response({}, 403), 1000)).toBe(0);
});

it('rotates credentials during an outage without returning the old PR identity', async () => {
  let token = 'old';
  const fetch = vi
    .fn<HttpFetch>()
    .mockResolvedValueOnce(response([{ number: 1 }]))
    .mockResolvedValueOnce(response({}, 500))
    .mockResolvedValueOnce(response([{ number: 2 }]));
  const service = createGitHubPrService({
    repoDir: '',
    identity,
    token: () => token,
    ttlMs: 0,
    fetch,
  });
  expect(await service.prStatusForBranch('feature')).toMatchObject({ number: 1 });
  const unavailable = await service.prStatusForBranch('feature');
  expect(unavailable).toMatchObject({ number: 1, pipeline: 'unknown' });
  token = 'new';
  expect(await service.prStatusForBranch('feature')).toMatchObject({ number: 2 });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls[2]?.[1]?.headers?.Authorization).toBe('Bearer new');
  expect(unavailable).toMatchObject({ observationFailed: true });
});

it('uses the configured legacy credential when the token broker rejects', async () => {
  const fetch = vi.fn<HttpFetch>().mockResolvedValue(response([{ number: 9 }]));
  const service = createGitHubPrService({
    repoDir: '',
    identity,
    asyncToken: async () => {
      throw new Error('broker offline');
    },
    token: 'legacy-fixture',
    fetch,
  });
  expect(await service.prStatusForBranch('feature')).toMatchObject({ number: 9 });
  expect(fetch.mock.calls[0]?.[1]?.headers?.Authorization).toBe('Bearer legacy-fixture');
});

it('preserves an explicit rate limit when credentials rotate', async () => {
  let token = 'old';
  const fetch = vi.fn<HttpFetch>().mockResolvedValue(response({}, 429, { 'retry-after': '120' }));
  const service = createGitHubPrService({ repoDir: '', identity, token: () => token, fetch });
  await service.prStatusForBranch('feature');
  token = 'new';
  await service.prStatusForBranch('feature');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('reports unavailable cold observations through the production bound service', async () => {
  const fetch = vi.fn<HttpFetch>().mockResolvedValue(response({}, 500));
  const mint = () => Promise.resolve('fixture');
  const provider = createGitHubForgeProvider({
    projectTokenMint: mint,
    issuesTokenMint: mint,
    installationToken: mint,
    fetch,
  });
  const service = provider.repositoryPrService!({ owner: 'owner', repo: 'repo' });
  await expect(service.prStatusForBranch('one')).rejects.toMatchObject({ category: 'unavailable' });
  await expect(service.prStatusForBranch('two')).rejects.toMatchObject({ category: 'unavailable' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps discovery suppressed by a rate limit observed by the PR service', async () => {
  const fetch = vi.fn<HttpFetch>().mockResolvedValue(response({}, 429, { 'retry-after': '120' }));
  const mint = () => Promise.resolve('fixture');
  const provider = createGitHubForgeProvider({
    projectTokenMint: mint,
    issuesTokenMint: mint,
    installationToken: mint,
    fetch,
  });
  await expect(
    provider.repositoryPrService!({ owner: 'owner', repo: 'repo' }).prStatusForBranch('feature'),
  ).rejects.toMatchObject({ category: 'unavailable' });
  await expect(provider.discover!({ owner: 'owner', repo: 'repo' }, 1)).rejects.toMatchObject({
    step: 'discovery-backoff',
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('bounds branch and ETag retention without sending an evicted conditional body', async () => {
  const fetch = vi
    .fn<HttpFetch>()
    .mockResolvedValue(response([{ number: 1 }], 200, { etag: 'fixture-etag' }));
  const service = createGitHubPrService({
    repoDir: '',
    identity,
    token: 'fixture',
    fetch,
    ttlMs: 0,
  });
  for (let branch = 0; branch <= 512; branch++) await service.prStatusForBranch(`branch-${branch}`);
  await service.prStatusForBranch('branch-0');
  expect(fetch.mock.calls.at(-1)?.[1]?.headers?.['If-None-Match']).toBeUndefined();
});

it('never evicts an active recovery probe to retain a newer idle observation', () => {
  const cache = new GitHubPollCache<string, { active: boolean }>(2, (value) => value.active);
  cache.set('probe', { active: true }).set('old', { active: false }).set('new', { active: false });
  expect([...cache.keys()]).toEqual(['probe', 'new']);
});

it('keeps simultaneous status and project token mints in their permission scopes', async () => {
  let finish!: (value: string) => void;
  const projectMint = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const statusMint = vi.fn(async () => 'read-only-fixture');
  const fetch = vi.fn<HttpFetch>().mockResolvedValue(response([]));
  const provider = createGitHubForgeProvider({
    projectTokenMint: projectMint,
    repositoryStatusTokenMint: statusMint,
    issuesTokenMint: statusMint,
    installationToken: statusMint,
    fetch,
    git: async () => 'https://github.com/owner/repo.git',
  });
  const projectRead = provider.prServiceFor('/checkout').prStatusForBranch('one');
  await vi.waitFor(() => expect(projectMint).toHaveBeenCalledOnce());
  await provider.repositoryPrService!({ owner: 'owner', repo: 'repo' }).prStatusForBranch('two');
  expect(statusMint).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[1]?.headers?.Authorization).toBe('Bearer read-only-fixture');
  finish('project-fixture');
  await projectRead;
});

it('retains all active recovery identities while the retention budget is saturated', () => {
  const cache = new GitHubPollCache<string, { active: boolean }>(1, (value) => value.active);
  const first = { active: true },
    second = { active: true };
  cache.set('first', first).set('second', second);
  expect(cache.get('first')).toBe(first);
  expect(cache.get('second')).toBe(second);
  first.active = false;
  cache.set('third', { active: false });
  expect(cache.has('first')).toBe(false);
  expect(cache.get('second')).toBe(second);
});
