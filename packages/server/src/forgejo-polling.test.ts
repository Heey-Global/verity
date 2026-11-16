import { afterEach, expect, it, vi } from 'vitest';
import { createForgejoForgeProvider } from './forgejo-forge-provider.js';
import { ForgejoRequestError, ForgejoTransport } from './forgejo-transport.js';
import { createForgejoStatusReads } from './forgejo-status-cache.js';

afterEach(() => vi.useRealTimers());

function fixture() {
  let credential = 'first';
  const token = () => Promise.resolve(credential);
  const transport = new ForgejoTransport('https://forge.test', token);
  const pulls = Array.from({ length: 7 }, (_, index) => ({
    number: index + 1,
    title: `Change ${index}`,
    html_url: `https://forge.test/team/repo/pulls/${index + 1}`,
    state: 'closed',
    merged: false,
    head: { ref: `old-${index}`, sha: 'abc', repo: { full_name: 'team/repo' } },
    base: { ref: 'main', sha: 'base' },
  }));
  const json = vi.spyOn(transport, 'json').mockImplementation(async (path) => {
    if (path.includes('/pulls?')) return path.includes('page=1') ? pulls : [];
    if (path.includes('/actions/')) return { workflow_runs: [] };
    return [];
  });
  const provider = createForgejoForgeProvider({
    transport,
    token,
    identityFor: () => () => Promise.resolve({ owner: 'team', repo: 'repo' }),
  });
  const ref = { owner: 'team', repo: 'repo' };
  return {
    provider,
    ref,
    json,
    pulls,
    rotate: () => {
      credential = 'second';
    },
  };
}

it('shares the real repository-bound snapshot across 27 sequential branches and sessions', async () => {
  vi.useFakeTimers();
  const { provider, ref, json } = fixture();
  const scope = {};
  for (let i = 0; i < 27; i++)
    expect(
      await provider.repositoryPrService!(ref, scope).prStatusForBranch(`missing-${i}`),
    ).toBeNull();
  expect(json.mock.calls.filter(([path]) => path.includes('/pulls?'))).toHaveLength(2);
  await Promise.all(
    Array.from({ length: 27 }, (_, i) =>
      provider.repositoryPrService!(ref, scope).prStatusForBranch(`missing-${i}`),
    ),
  );
  expect(json).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(2_001);
  await provider.repositoryPrService!(ref, scope).prStatusForBranch('missing');
  expect(json).toHaveBeenCalledTimes(4);
});

it('shares status loads without making healthy zero-check PRs failed observations', async () => {
  const { provider, ref, json } = fixture();
  const scope = {};
  const values = await Promise.all(
    Array.from({ length: 5 }, () =>
      provider.repositoryPrService!(ref, scope).prStatusForBranch('old-0'),
    ),
  );
  expect(values.every((value) => value?.pipeline === 'unknown' && !value.observationFailed)).toBe(
    true,
  );
  expect(json.mock.calls.filter(([path]) => path.includes('/statuses/'))).toHaveLength(1);
});

it('separates repositories, invalidation generations and credentials even during cooldown', async () => {
  const { provider, ref, json, rotate } = fixture();
  const scope = {};
  await provider.repositoryPrService!(ref, scope).prStatusForBranch('missing');
  await provider.repositoryPrService!({ ...ref, repo: 'other' }, scope).prStatusForBranch(
    'missing',
  );
  expect(json).toHaveBeenCalledTimes(4);
  await provider.repositoryPrService!(ref, {}).prStatusForBranch('missing');
  expect(json).toHaveBeenCalledTimes(6);
  const outageScope = {};
  json.mockRejectedValueOnce(new ForgejoRequestError(503));
  await expect(
    provider.repositoryPrService!(ref, outageScope).prStatusForBranch('missing'),
  ).rejects.toThrow();
  const before = json.mock.calls.length;
  rotate();
  await expect(
    provider.repositoryPrService!(ref, outageScope).prStatusForBranch('missing'),
  ).resolves.toBeNull();
  expect(json).toHaveBeenCalledTimes(before + 2);
});

it('coalesces outages and a single recovery probe across different branches', async () => {
  vi.useFakeTimers();
  const { provider, ref, json } = fixture();
  const scope = {};
  const implementation = json.getMockImplementation()!;
  json.mockRejectedValue(new ForgejoRequestError(503));
  await Promise.allSettled(
    Array.from({ length: 27 }, (_, i) =>
      provider.repositoryPrService!(ref, scope).prStatusForBranch(`missing-${i}`),
    ),
  );
  expect(json).toHaveBeenCalledTimes(1);
  await expect(
    provider.repositoryPrService!(ref, scope).prStatusForBranch('another'),
  ).rejects.toThrow();
  expect(json).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(30_001);
  json.mockImplementation(implementation);
  const results = await Promise.all(
    Array.from({ length: 27 }, (_, i) =>
      provider.repositoryPrService!(ref, scope).prStatusForBranch(`missing-${i}`),
    ),
  );
  expect(results).toEqual(Array(27).fill(null));
  expect(json).toHaveBeenCalledTimes(3);
});

it('does not expose actionable checks or mergeability after incomplete inspection', async () => {
  const { provider, ref, json, pulls } = fixture();
  pulls[0]!.state = 'open';
  const implementation = json.getMockImplementation()!;
  json.mockImplementation((path, ...args) =>
    path.includes('/actions/')
      ? Promise.reject(new ForgejoRequestError(500))
      : implementation(path, ...args),
  );
  expect(await provider.repositoryPrService!(ref, {}).prStatusForBranch('old-0')).toMatchObject({
    observationFailed: true,
    pipeline: 'unknown',
    mergeable: null,
    mergeState: 'unknown',
  });
});

it('does not evict an in-flight snapshot when the retained snapshot bound is reached', async () => {
  const reads = createForgejoStatusReads().repository({}, 'credential', 'team/repo');
  let release!: (value: string) => void;
  const first = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const pending = reads.read('pending', first);
  await Promise.resolve();
  for (let i = 0; i < 250; i++) await reads.read(`settled-${i}`, async () => 'settled');
  const again = reads.read('pending', first);
  expect(first).toHaveBeenCalledTimes(1);
  release('fresh');
  expect(await pending).toBe('fresh');
  expect(await again).toBe('fresh');
  const reload = vi.fn(async () => 'reloaded');
  expect(await reads.read('settled-0', reload)).toBe('reloaded');
  expect(reload).toHaveBeenCalledTimes(1);
  const stillCached = vi.fn(async () => 'not cached');
  expect(await reads.read('settled-249', stillCached)).toBe('settled');
  expect(stillCached).not.toHaveBeenCalled();
});

it('discards snapshots when credentials change while the transport is reading', async () => {
  const { provider, ref, json, rotate } = fixture();
  const implementation = json.getMockImplementation()!;
  json.mockImplementationOnce(async (path, ...args) => {
    rotate();
    return implementation(path, ...args);
  });
  const scope = {};
  await expect(
    provider.repositoryPrService!(ref, scope).prStatusForBranch('missing'),
  ).rejects.toMatchObject({
    category: 'credentials',
    step: 'credential-changed',
  });
  expect(json).toHaveBeenCalledTimes(2);
  await expect(
    provider.repositoryPrService!(ref, scope).prStatusForBranch('missing'),
  ).resolves.toBeNull();
  expect(json).toHaveBeenCalledTimes(4);
});

it('does not reintroduce a snapshot that completes after all snapshots were invalidated', async () => {
  const cache = createForgejoStatusReads();
  const scope = {};
  let release!: (value: string) => void;
  const old = cache.repository(scope, 'credential', 'repo').read(
    'pulls',
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  cache.clear();
  const current = cache.repository(scope, 'credential', 'repo');
  expect(await current.read('pulls', async () => 'new')).toBe('new');
  release('old');
  expect(await old).toBe('old');
  expect(
    await cache.repository(scope, 'credential', 'repo').read('pulls', async () => 'wrong'),
  ).toBe('new');
});
