import { createForgeStatusCache } from './forge-status-cache.js';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import type { GitOutput } from './branches.js';
import type { HttpFetch, HttpResponse } from './github.js';
import { createGitHubForgeProvider } from './github-forge-provider.js';

const project = { id: 'p', owner: 'acme', repo: 'app', kind: 'github' } as ProjectRecord;

function json(body: unknown): HttpResponse {
  return { ok: true, status: 200, json: async () => body };
}

/** Records the bearer token each GitHub request carried, keyed by API path. */
function recordingFetch(): HttpFetch & { tokens: Map<string, string | undefined> } {
  const tokens = new Map<string, string | undefined>();
  const fn: HttpFetch = async (url, init) => {
    const path = new URL(url).pathname;
    const auth = init?.headers?.authorization ?? init?.headers?.Authorization;
    tokens.set(path, auth?.replace(/^Bearer /, ''));
    if (path.endsWith('/issues')) return json([]);
    if (path === '/installation/repositories') {
      return json({ repositories: [{ name: 'App', owner: { login: 'Acme' } }] });
    }
    if (path.endsWith('/pulls') && init?.method === 'POST') {
      return json({ number: 7, html_url: 'https://github.com/acme/app/pull/7' });
    }
    return json([]);
  };
  return Object.assign(fn, { tokens });
}

function provider(fetch: HttpFetch, git?: GitOutput) {
  return createGitHubForgeProvider({
    projectTokenMint: vi.fn(async () => 'project-token'),
    issuesTokenMint: vi.fn(async () => 'issues-token'),
    installationToken: async () => 'installation-token',
    fetch,
    ...(git !== undefined ? { git } : {}),
  });
}

describe('GitHub forge provider', () => {
  // Each service gets the least-privilege token it was granted. Swapping them still
  // returns data in a permissive test, so the token each request carried is the guard.
  it('reads issues with the read-only mint and lists repositories with the installation token', async () => {
    const fetch = recordingFetch();
    const forge = provider(fetch);

    expect(await forge.listIssues(project)).toEqual({
      connected: true,
      viewerLogin: null,
      issues: [],
    });
    expect(await forge.listRepositories()).toEqual([{ owner: 'acme', repo: 'app' }]);

    expect(fetch.tokens.get('/repos/acme/app/issues')).toBe('issues-token');
    expect(fetch.tokens.get('/installation/repositories')).toBe('installation-token');
  });

  it('opens pull requests with the caller-supplied one-shot token', async () => {
    const fetch = recordingFetch();
    const forge = provider(fetch);

    await expect(
      forge.openPullRequest({ owner: 'acme', repo: 'app' }, 'one-shot', {
        head: 'verity/import',
        base: 'main',
        title: 'Import',
        body: '',
      }),
    ).resolves.toEqual({ number: 7, url: 'https://github.com/acme/app/pull/7' });
    expect(fetch.tokens.get('/repos/acme/app/pulls')).toBe('one-shot');
  });

  // A fresh service per poll would drop the TTL cache and the failure cooldown, so
  // every app poll would hit GitHub again.
  it('reuses one PR service and one identity resolver per checkout', async () => {
    const git = vi.fn<GitOutput>(async () => 'https://github.com/acme/app.git\n');
    const forge = provider(recordingFetch(), git);

    expect(forge.prServiceFor('/w/a')).toBe(forge.prServiceFor('/w/a'));
    expect(forge.prServiceFor('/w/a')).not.toBe(forge.prServiceFor('/w/b'));
    expect(forge.identityFor('/w/a')).toBe(forge.identityFor('/w/a'));
    await expect(forge.identityFor('/w/a')()).resolves.toEqual({ owner: 'acme', repo: 'app' });
    await forge.identityFor('/w/a')();
    expect(git).toHaveBeenCalledTimes(1);
  });

  it('builds clone URLs it can parse back', () => {
    const forge = provider(recordingFetch());
    const ref = { owner: 'acme', repo: 'app' };
    expect(forge.parseRemote(forge.cloneUrl(ref))).toEqual(ref);
    expect(forge.parseRemote('https://codeberg.org/acme/app.git')).toBeNull();
  });
});

describe('repository supervision discovery', () => {
  it('uses the read-only mint, identifies forks and excludes non-default workflow branches', async () => {
    const fetch = vi.fn<HttpFetch>(async (url) => {
      if (url.includes('/pulls?'))
        return json([
          { number: 42, head: { ref: 'renovate/x', sha: 'abc', repo: { full_name: 'acme/app' } } },
          { number: 43, head: { ref: 'fork', sha: 'def', repo: { full_name: 'other/app' } } },
        ]);
      if (url.includes('/actions/runs?'))
        return json({
          workflow_runs: [
            {
              id: 1,
              workflow_id: 2,
              head_sha: 'abc',
              head_branch: 'main',
              event: 'push',
              head_repository: { full_name: 'acme/app' },
              conclusion: 'failure',
              html_url: 'https://github.com/acme/app/actions/runs/1',
            },
            {
              id: 3,
              workflow_id: 2,
              head_sha: 'def',
              head_branch: 'main',
              event: 'pull_request',
              head_repository: { full_name: 'fork/app' },
              conclusion: 'failure',
              html_url: 'https://github.com/acme/app/actions/runs/3',
            },
          ],
        });
      return json({ default_branch: 'main' });
    });
    const forge = createGitHubForgeProvider({
      projectTokenMint: () => Promise.resolve('write'),
      discoveryTokenMint: () => Promise.resolve('read'),
      issuesTokenMint: () => Promise.resolve('issues'),
      installationToken: () => Promise.resolve('installation'),
      fetch,
    });
    const page = await forge.discover!(project, 1);
    expect(page.pulls.map((p) => p.fork)).toEqual([false, true]);
    expect(page.runs.map((r) => r.id)).toEqual(['1']);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetch.mock.calls) {
      expect(init?.headers?.Authorization).toBe('Bearer read');
      expect(url).not.toContain('/logs');
    }
  });
  it('backs off repository discovery after rate limiting', async () => {
    const fetch = vi.fn<HttpFetch>(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        headers: { get: (name) => (name === 'retry-after' ? '120' : null) },
        json: () => Promise.resolve({}),
      }),
    );
    const forge = provider(fetch);
    expect((await forge.discover!(project, 1)).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'rate-limit' })]),
    );
    await expect(forge.discover!(project, 1)).rejects.toThrow('discovery-backoff');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 429, headers: {} },
    { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
    { status: 403, headers: { 'retry-after': '120' } },
  ])('shares actual rate limiting with PR readers (%j)', async ({ status, headers }) => {
    const fetch = vi.fn<HttpFetch>(async () => ({
      ok: false,
      status,
      headers: { get: (name) => (headers as Record<string, string>)[name] ?? null },
      json: async () => ({}),
    }));
    const forge = provider(fetch);
    expect((await forge.discover!(project, 1)).errors?.length).toBeGreaterThan(0);
    await forge.repositoryPrService!(project).prStatusForBranch('feature');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404, 500])(
    'keeps PR status readable when workflow discovery fails with %s',
    async (status) => {
      const fetch = vi.fn<HttpFetch>(async (url) => {
        if (url.includes('/actions/runs?')) return { ok: false, status, json: async () => ({}) };
        if (url.includes('/pulls?'))
          return json([
            {
              number: 7,
              state: 'open',
              title: 'Feature',
              head: { sha: 'abc', ref: 'feature', repo: { full_name: 'acme/app' } },
            },
          ]);
        if (url.endsWith('/pulls/7')) return json({ mergeable: true, mergeable_state: 'clean' });
        if (url.includes('/check-runs?'))
          return json({ check_runs: [{ status: 'completed', conclusion: 'success' }] });
        if (url.includes('/status?')) return { ok: false, status: 403, json: async () => ({}) };
        return json({ default_branch: 'main' });
      });
      const forge = provider(fetch, async () => 'https://github.com/acme/app.git\n');
      const services = [
        forge.repositoryPrService!(project),
        forge.prServiceFor('/sessions/one'),
        forge.prServiceFor('/sessions/two'),
      ];
      for (const service of services)
        expect((await service.prStatusForBranch('feature'))?.pipeline).toBe('success');

      const observed = await forge.discover!(project, 1);
      expect(observed.pulls).toHaveLength(1);
      expect(observed.runs).toHaveLength(0);
      expect(observed.errors).toEqual([
        expect.objectContaining({
          category: status === 403 ? 'forbidden' : 'unavailable',
          step: 'actions/runs',
        }),
      ]);
      expect((await forge.discover!(project, 1)).pulls).toHaveLength(1);

      // A failing Actions endpoint must not erase readable checks and mergeability
      // in the PR bar, even when discovery keeps retrying in the background.
      for (const service of services)
        expect(await service.prStatusForBranch('feature')).toMatchObject({
          pipeline: 'success',
          mergeable: true,
        });
      expect(await forge.prServiceFor('/sessions/new').prStatusForBranch('feature')).toMatchObject({
        pipeline: 'success',
        mergeable: true,
      });
    },
  );
});

it('refetches repository status after the shared cache is invalidated', async () => {
  const fetch = vi.fn<HttpFetch>(async () => json([]));
  const forge = provider(fetch);
  const service = forge.repositoryPrService!(project);
  const cache = createForgeStatusCache();
  const identity = { authority: 'test', owner: 'acme', repo: 'app' };
  const read = () => cache.read(identity, 'feature', () => service.prStatusForBranch('feature'));
  await read();
  const first = fetch.mock.calls.length;
  expect(first).toBeGreaterThan(0);
  await read();
  expect(fetch).toHaveBeenCalledTimes(first);
  cache.invalidate(identity);
  await read();
  expect(fetch.mock.calls.length).toBeGreaterThan(first);
});

it('preserves PR discovery when the installation cannot mint Actions credentials', async () => {
  const fetch = vi.fn<HttpFetch>(async (url, init) => {
    expect(init?.headers?.Authorization).toBe('Bearer read-prs');
    return url.includes('/pulls?')
      ? json([{ number: 1, head: { ref: 'feature', sha: 'abc', repo: { full_name: 'acme/app' } } }])
      : json({ default_branch: 'main' });
  });
  const forge = createGitHubForgeProvider({
    projectTokenMint: async () => undefined,
    discoveryTokenMint: async () => undefined,
    discoveryPrTokenMint: async () => 'read-prs',
    issuesTokenMint: async () => undefined,
    installationToken: async () => undefined,
    fetch,
  });
  const page = await forge.discover!(project, 1);
  expect(page.pulls).toHaveLength(1);
  expect(page.errors).toEqual([
    expect.objectContaining({ category: 'credentials', step: 'actions/runs' }),
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
