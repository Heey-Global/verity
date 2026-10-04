import { describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@verity/store';
import type { PullRequestStatus } from './github.js';
import { createSessionPrCache } from './session-pr-cache.js';

const session: SessionRecord = {
  sessionId: 's1',
  worktree: '/wt/s1',
  model: 'm',
  name: null,
  projectId: null,
  kind: 'normal',
  lastSeenEventCount: null,
};
const pr: PullRequestStatus = {
  number: 1,
  title: 'Example',
  url: 'https://github.com/example/repo/pull/1',
  phase: 'open',
  pipeline: 'running',
  mergeable: null,
  checks: { completed: 0, total: 1, successful: 0, failed: 0, pending: 1 },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('shared session PR cache', () => {
  it('shares an in-flight read and its result across foreground and background consumers', async () => {
    const read = deferred<PullRequestStatus>();
    const load = vi.fn(() => read.promise);
    const cache = createSessionPrCache({ load });
    const first = cache.get(session, { background: true });
    const second = cache.get(session);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    read.resolve(pr);
    expect(await first).toBe(pr);
    expect(await second).toBe(pr);
    expect(await cache.get(session)).toBe(pr);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('limits expensive discovery to one session at a time', async () => {
    const read = deferred<PullRequestStatus>();
    const load = vi
      .fn<(session: SessionRecord) => Promise<PullRequestStatus | null>>()
      .mockReturnValueOnce(read.promise)
      .mockResolvedValue(pr);
    const cache = createSessionPrCache({ load });
    const first = cache.get(session);
    const next = cache.get({ ...session, sessionId: 's2', worktree: '/wt/s2' });
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    read.resolve(pr);
    await Promise.all([first, next]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('prioritizes the opened session over queued overview or background discovery', async () => {
    const read = deferred<PullRequestStatus>();
    const load = vi
      .fn<(session: SessionRecord) => Promise<PullRequestStatus | null>>()
      .mockReturnValueOnce(read.promise)
      .mockResolvedValue(pr);
    const cache = createSessionPrCache({ load });
    const first = cache.get(session);
    await Promise.resolve();
    const background = { ...session, worktree: '/wt/background' };
    const viewed = { ...session, worktree: '/wt/viewed' };
    const slow = cache.get(background, { background: true });
    const view = cache.get(viewed);
    // A foreground request promotes an already queued read instead of duplicating it.
    const promoted = cache.get(viewed, { priority: true });
    read.resolve(pr);
    await Promise.all([first, slow, view, promoted]);
    expect(load.mock.calls.map(([value]) => value.worktree)).toEqual([
      session.worktree,
      viewed.worktree,
      background.worktree,
    ]);
  });

  it('refreshes active CI promptly but polls settled and terminal PRs less often', async () => {
    let now = 0;
    let status = pr;
    const load = vi.fn(async () => status);
    const cache = createSessionPrCache({ load, now: () => now });
    await cache.get(session);
    now = 10_000;
    await cache.get(session);
    expect(load).toHaveBeenCalledTimes(1);
    now = 15_000;
    status = { ...pr, pipeline: 'success' };
    await cache.get(session);
    now = 35_000;
    await cache.get(session);
    expect(load).toHaveBeenCalledTimes(2);
    now = 45_000;
    await cache.get(session);
    expect(load).toHaveBeenCalledTimes(3);
    now = 100_000;
    await cache.get(session, { background: true });
    expect(load).toHaveBeenCalledTimes(3);
    now = 165_000;
    status = { ...status, phase: 'merged' };
    await cache.get(session, { background: true });
    now = 300_000;
    await cache.get(session);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('backs off absent PRs in the background but discovers them quickly when viewed', async () => {
    let now = 0;
    const load = vi
      .fn<(session: SessionRecord) => Promise<PullRequestStatus | null>>()
      .mockResolvedValue(null);
    const cache = createSessionPrCache({ load, now: () => now });
    await cache.get(session, { background: true });
    now = 30_000;
    await cache.get(session, { background: true });
    now = 60_000;
    await cache.get(session, { background: true });
    expect(load).toHaveBeenCalledTimes(2);
    load.mockResolvedValue(pr);
    expect(await cache.get(session)).toBe(pr);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('backs off failures and removes stale repair/merge signals', async () => {
    let now = 0;
    const conflict = {
      ...pr,
      pipeline: 'failure' as const,
      mergeState: 'dirty' as const,
      mergeable: false,
    };
    const load = vi
      .fn<(session: SessionRecord) => Promise<PullRequestStatus | null>>()
      .mockResolvedValueOnce(conflict)
      .mockRejectedValue(new Error('offline'));
    const cache = createSessionPrCache({ load, now: () => now });
    await cache.get(session);
    now = 30_000;
    expect(await cache.get(session)).toMatchObject({ pipeline: 'unknown', mergeable: null });
    expect(await cache.get(session)).not.toHaveProperty('mergeState');
    now = 60_000;
    await cache.get(session);
    now = 90_000;
    await cache.get(session);
    expect(load).toHaveBeenCalledTimes(3);
    now = 120_000;
    load.mockResolvedValue(pr);
    expect(await cache.get(session)).toBe(pr);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('does not restore a result from before a switch or merge', async () => {
    const read = deferred<PullRequestStatus>();
    const load = vi
      .fn<(session: SessionRecord) => Promise<PullRequestStatus | null>>()
      .mockReturnValueOnce(read.promise)
      .mockResolvedValue(null);
    const cache = createSessionPrCache({ load });
    const first = cache.get(session);
    await Promise.resolve();
    cache.invalidate(session.worktree);
    const next = cache.get(session);
    read.resolve(pr);
    expect(await first).toBeNull();
    expect(await next).toBeNull();
    expect(await cache.get(session)).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('evicts deleted worktrees and skips their queued reads', async () => {
    const read = deferred<PullRequestStatus>();
    const load = vi
      .fn<(session: SessionRecord) => Promise<PullRequestStatus | null>>()
      .mockReturnValueOnce(read.promise)
      .mockResolvedValue(pr);
    const cache = createSessionPrCache({ load });
    const first = cache.get(session);
    const deleted = cache.get({ ...session, worktree: '/wt/deleted' });
    await Promise.resolve();
    cache.prune(new Set([session.worktree]));
    read.resolve(pr);
    await first;
    expect(await deleted).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    cache.prune(new Set());
    await cache.get(session);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
