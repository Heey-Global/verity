import { describe, expect, it, vi } from 'vitest';
import { createForgeStatusCache, selectBranchStatus } from './forge-status-cache.js';
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

it('preserves the forge-specific fallback when the first branch has no PR', () => {
  const merged: PullRequestStatus = { ...status, phase: 'merged' };
  expect(selectBranchStatus([null, merged], 'forgejo')).toBe(merged);
  expect(selectBranchStatus([null, merged], 'github')).toBeNull();
  expect(selectBranchStatus([merged, status], 'forgejo')).toBe(status);
});

it('keeps healthy unknown CI on the fast discovery cadence', async () => {
  let now = 0;
  const cache = createForgeStatusCache(() => now);
  const load = vi.fn(async () => ({
    ...status,
    pipeline: 'unknown' as const,
    mergeable: null,
    checks: { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 },
  }));
  for (now = 0; now <= 60_000; now += 15_000) await cache.read(id, 'x', load);
  expect(load).toHaveBeenCalledTimes(5);
});

it('does not start an invalidated read that was waiting for an upstream slot', async () => {
  const cache = createForgeStatusCache();
  let finish!: (value: PullRequestStatus) => void;
  const held = new Promise<PullRequestStatus>((resolve) => {
    finish = resolve;
  });
  const first = cache.read(id, 'first', () => held);
  const second = cache.read(id, 'second', () => held);
  const queuedLoad = vi.fn(async () => status);
  const queued = cache.read(id, 'queued', queuedLoad);
  await Promise.resolve();
  cache.invalidate(id);
  finish(status);
  await Promise.all([first, second, queued]);
  expect(queuedLoad).not.toHaveBeenCalled();
});

it('shares an opaque observation scope until mutation or credential change', async () => {
  const cache = createForgeStatusCache();
  const load = vi.fn(async (_scope: object) => null);
  await cache.read(id, 'a', load);
  await cache.read(id, 'b', load);
  const generation = load.mock.calls[0]![0];
  expect(generation).toBeDefined();
  expect(load.mock.calls[1]![0]).toBe(generation);
  cache.invalidate(id);
  await cache.read(id, 'a', load);
  expect(load.mock.calls[2]![0]).not.toBe(generation);
  await cache.read({ ...id, authority: 'new-credential' }, 'a', load);
  expect(load.mock.calls[3]![0]).not.toBe(load.mock.calls[2]![0]);
});

it('evicts idle observation scopes without disowning running scopes', async () => {
  const cache = createForgeStatusCache();
  let finish!: (value: null) => void;
  const pending = cache.read(
    id,
    'held',
    () =>
      new Promise<null>((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  let firstScope: object | undefined;
  const oldest = { ...id, repo: 'oldest' };
  await cache.read(oldest, 'x', async (scope) => {
    firstScope = scope;
    return null;
  });
  for (let index = 0; index < 4096; index++)
    await cache.read({ ...id, repo: `repo-${index}` }, 'x', async () => null);
  let nextScope: object | undefined;
  await cache.read(oldest, 'y', async (scope) => {
    nextScope = scope;
    return null;
  });
  expect(firstScope).toBeDefined();
  expect(nextScope).toBeDefined();
  expect(nextScope).not.toBe(firstScope);
  const unexpected = vi.fn(async () => null);
  const joined = cache.read(id, 'held', unexpected);
  finish(null);
  await Promise.all([pending, joined]);
  expect(unexpected).not.toHaveBeenCalled();
});

it('clears actionable fields on explicitly failed provider observations', async () => {
  let now = 0;
  const cache = createForgeStatusCache(() => now);
  const load = vi.fn(async () => ({
    ...status,
    observationFailed: true,
    mergeState: 'dirty' as const,
  }));
  expect(await cache.read(id, 'x', load)).toMatchObject({
    pipeline: 'unknown',
    observationFailed: true,
    mergeable: null,
    checks: { failed: 0 },
  });
  expect(await cache.read(id, 'x', load)).not.toHaveProperty('mergeState');
  now = 15_000;
  await cache.read(id, 'x', load);
  expect(load).toHaveBeenCalledTimes(1);
});
