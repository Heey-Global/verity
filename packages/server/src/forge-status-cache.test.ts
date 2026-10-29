import { describe, expect, it, vi } from 'vitest';
import { createForgeStatusCache } from './forge-status-cache.js';
import type { PullRequestStatus } from './forge-provider.js';
const id = { authority: 'connection:v1', owner: 'team', repo: 'app' };
const status: PullRequestStatus = {
  number: 1,
  title: 'Update',
  url: 'https://example.test/1',
  phase: 'open',
  pipeline: 'failure',
  mergeable: false,
  checks: { completed: 1, total: 1, failed: 1, pending: 0, successful: 0 },
};
describe('shared forge status', () => {
  it('coalesces UI and repair readers across worktrees', async () => {
    const cache = createForgeStatusCache();
    const load = vi.fn(async () => status);
    await Promise.all([cache.read(id, 'renovate/x', load), cache.read(id, 'renovate/x', load)]);
    await cache.read(id, 'renovate/x', load);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('does not share status across credentials or repositories', async () => {
    const cache = createForgeStatusCache();
    const load = vi.fn(async () => status);
    await cache.read(id, 'x', load);
    await cache.read({ ...id, authority: 'connection:v2' }, 'x', load);
    await cache.read({ ...id, repo: 'other' }, 'x', load);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('clears actionable stale failures on errors and backs off', async () => {
    let now = 0;
    const cache = createForgeStatusCache(() => now);
    await cache.read(id, 'x', async () => status);
    now = 31_000;
    const fail = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await cache.read(id, 'x', fail)).toMatchObject({
      pipeline: 'unknown',
      checks: { failed: 0 },
    });
    now += 10_000;
    await cache.read(id, 'x', fail);
    expect(fail).toHaveBeenCalledTimes(1);
  });
});

it('disowns a pending response after a repository mutation', async () => {
  const cache = createForgeStatusCache();
  let finish!: (value: PullRequestStatus) => void;
  const old = cache.read(
    id,
    'x',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  cache.invalidate(id);
  await cache.read(id, 'x', () => Promise.resolve({ ...status, headSha: 'new' }));
  finish(status);
  expect(await old).toMatchObject({ pipeline: 'unknown' });
  const load = vi.fn(() => Promise.resolve(status));
  expect(await cache.read(id, 'x', load)).toMatchObject({ headSha: 'new' });
  expect(load).not.toHaveBeenCalled();
});
