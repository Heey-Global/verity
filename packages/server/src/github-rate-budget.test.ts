import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubRateBudget,
  githubRequestTarget,
  trackGitHubFetch,
  type GitHubLimitEvent,
} from './github-rate-budget.js';

const headers = (values: Record<string, string>) => ({
  get: (name: string) => values[name.toLowerCase()] ?? null,
});
const repoUrl = (owner: string, repo: string, path = 'pulls?head=x&state=all') =>
  `https://api.github.com/repos/${owner}/${repo}/${path}`;
const quota = (remaining: number, limit = 5000, reset = 3600) =>
  headers({
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(reset),
    'x-ratelimit-resource': 'core',
  });

describe('GitHub rate budget', () => {
  it('reduces a request to account, repository and endpoint class', () => {
    expect(githubRequestTarget(repoUrl('Team', 'App', 'commits/abc/check-runs?page=2'))).toEqual({
      account: 'team',
      repo: 'app',
      resource: 'core',
      endpoint: 'check-runs',
    });
    expect(githubRequestTarget('https://example.test/repos/team/app/pulls')).toBeUndefined();
  });

  it('defers background reads only below the quota floor and before the reset', () => {
    let now = 0;
    const budget = createGitHubRateBudget({ now: () => now });
    budget.observe({
      url: repoUrl('team', 'a'),
      category: 'other',
      status: 200,
      headers: quota(1001),
    });
    expect(budget.deferBackground('team')).toBe(false);
    budget.observe({
      url: repoUrl('team', 'a'),
      category: 'other',
      status: 200,
      headers: quota(999),
    });
    // The quota belongs to the installation, not to the repository that spent it.
    expect(budget.deferBackground('Team')).toBe(true);
    expect(budget.deferBackground('other-account')).toBe(false);
    now = 3_600_000;
    expect(budget.deferBackground('team')).toBe(false);
  });

  it('locks every repository of an account until the primary reset', () => {
    const now = 1_000_000;
    const budget = createGitHubRateBudget({ now: () => now });
    budget.observe({
      url: repoUrl('team', 'a'),
      category: 'session-status',
      status: 403,
      headers: quota(0, 5000, 2000),
    });
    expect(budget.lockedUntil(repoUrl('team', 'b', 'actions/runs'))).toBe(2_000_000);
    expect(budget.lockedUntil(repoUrl('elsewhere', 'b'))).toBe(0);
    // A search exhaustion does not stop core reads.
    expect(budget.lockedUntil('https://api.github.com/search/issues?q=x')).toBe(0);
    expect(budget.snapshot().events).toMatchObject([
      {
        kind: 'primary',
        category: 'session-status',
        account: 'team',
        repo: 'a',
        endpoint: 'pulls',
      },
    ]);
  });

  it('backs off secondary limits without Retry-After and resets after success', () => {
    let now = 0;
    const budget = createGitHubRateBudget({ now: () => now });
    const secondary = () =>
      budget.observe({
        url: repoUrl('team', 'a'),
        category: 'discovery',
        status: 403,
        headers: headers({}),
        bodyText: '{"message":"You have exceeded a secondary rate limit."}',
      });
    secondary();
    expect(budget.lockedUntil(repoUrl('team', 'a'))).toBe(60_000);
    now = 60_000;
    secondary();
    expect(budget.lockedUntil(repoUrl('team', 'a'))).toBe(180_000);
    now = 180_000;
    budget.observe({ url: repoUrl('team', 'a'), category: 'discovery', status: 200 });
    secondary();
    expect(budget.lockedUntil(repoUrl('team', 'a'))).toBe(240_000);
    expect(budget.snapshot().events.every((event) => event.kind === 'secondary')).toBe(true);
  });

  it('honors a longer Retry-After and caps runaway backoff', () => {
    let now = 0;
    const budget = createGitHubRateBudget({ now: () => now });
    budget.observe({
      url: repoUrl('team', 'a'),
      category: 'qa-analysis',
      status: 429,
      headers: headers({ 'retry-after': '300' }),
    });
    expect(budget.lockedUntil(repoUrl('team', 'a'))).toBe(300_000);
    for (let attempt = 0; attempt < 12; attempt++) {
      now = budget.lockedUntil(repoUrl('team', 'a'));
      budget.observe({ url: repoUrl('team', 'a'), category: 'qa-analysis', status: 429 });
    }
    expect(budget.lockedUntil(repoUrl('team', 'a')) - now).toBe(15 * 60_000);
  });

  it('treats a permission denial as an ordinary failure', () => {
    const budget = createGitHubRateBudget();
    budget.observe({
      url: repoUrl('team', 'a', 'commits/abc/status'),
      category: 'repository-status',
      status: 403,
      headers: quota(4000),
      bodyText: '{"message":"Resource not accessible by integration"}',
    });
    expect(budget.lockedUntil(repoUrl('team', 'a'))).toBe(0);
    expect(budget.snapshot().events).toEqual([]);
  });

  it('keeps bounded, credential-free evidence', () => {
    let now = 0;
    const budget = createGitHubRateBudget({ now: () => now });
    for (let index = 0; index < 30; index++) {
      // Each observation starts after the previous lock, so every one is a new event.
      now = index * 16 * 60_000;
      budget.observe({
        url: `${repoUrl('team', `repo-${index}`)}&access_token=secret-value`,
        category: 'session-status',
        status: 429,
        headers: headers({ 'retry-after': '1' }),
      });
    }
    budget.observe({ url: repoUrl('team', 'a'), category: 'release', status: 304 });
    const snapshot = budget.snapshot();
    expect(snapshot.events).toHaveLength(20);
    expect(snapshot.events.at(-1)).toMatchObject({ repo: 'repo-29' });
    expect(snapshot.categories.release.notModified).toBe(1);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret-value|access_token|\?/u);
  });

  it('logs at most one limit event per account and minute', () => {
    let now = 0;
    const logged: GitHubLimitEvent[] = [];
    const budget = createGitHubRateBudget({
      now: () => now,
      onLimit: (event) => logged.push(event),
    });
    const limit = (retry: string) =>
      budget.observe({
        url: repoUrl('team', 'a'),
        category: 'other',
        status: 429,
        headers: headers({ 'retry-after': retry }),
      });
    limit('1');
    now = 1000;
    limit('600');
    expect(budget.snapshot().events).toHaveLength(2);
    expect(logged).toHaveLength(1);
    now = 61_000;
    limit('1200');
    expect(logged).toHaveLength(2);
  });
});

describe('tracked GitHub fetch', () => {
  it('answers locally while the installation is locked and keeps counting', async () => {
    let now = 0;
    const budget = createGitHubRateBudget({ now: () => now });
    const base = vi.fn(async (url: string) => ({
      ok: false,
      status: 403,
      url,
      headers: quota(0, 5000, 600),
    }));
    const tracked = trackGitHubFetch(budget, 'repository-status', base, () => now);
    await tracked(repoUrl('team', 'a'));
    const answer = await tracked(repoUrl('team', 'b'));
    expect(base).toHaveBeenCalledTimes(1);
    expect(answer.status).toBe(429);
    expect(answer.headers?.get('retry-after')).toBe('600');
    expect(budget.snapshot().categories['repository-status']).toMatchObject({
      requests: 1,
      limited: 1,
      suppressed: 1,
    });
    now = 600_000;
    await tracked(repoUrl('team', 'b'));
    expect(base).toHaveBeenCalledTimes(2);
  });

  it('reads a cloned 403 body to recognize a secondary limit', async () => {
    const budget = createGitHubRateBudget();
    const tracked = trackGitHubFetch(
      budget,
      'discovery',
      async (url: string) =>
        new Response(`{"message":"You have exceeded a secondary rate limit for ${url}"}`, {
          status: 403,
        }),
    );
    const response = await tracked(repoUrl('team', 'a'));
    // The caller still receives an unread body.
    expect(await response.text()).toContain('secondary rate limit');
    expect(budget.lockedUntil(repoUrl('team', 'a'))).toBeGreaterThan(0);
  });
});
