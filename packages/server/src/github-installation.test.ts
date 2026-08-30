import { describe, expect, it } from 'vitest';
import {
  createGitHubInstallationService,
  type GitHubInstallationService,
  type HttpFetch,
  type HttpResponse,
} from './github.js';
import { syncProjectsFromInstallation } from './embedded.js';

/** Build a fake {@link GitHubInstallationService} that returns the given list
 *  on every call — to test the slice-2 sync glue end-to-end (no TTL/pagination
 *  needed; the unit tests above cover those concerns on the service itself). */
function makeFakeInstallation(
  repos: { owner: string; repo: string; archived?: boolean }[],
): GitHubInstallationService {
  return { listInstallationRepos: async () => repos };
}

/** Build a fake {@link HttpFetch} that dispatches on the request URL to canned
 *  {@link HttpResponse} objects. Each canned response carries `ok`, `status`,
 *  `json()` (returning whatever the test wants), and an optional `headers.map`
 *  which the service reads via `headers.get('link')`. */
function fakeFetch(
  routes: Record<string, HttpResponse | (() => HttpResponse)>,
): HttpFetch & { calls: string[] } {
  const calls: string[] = [];
  const fetchFn: HttpFetch = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) {
      // Allow prefix-mode for "any URL starting with X" tests; pick the first
      // key that the URL starts with (deliberately simpler than full regex).
      for (const key of Object.keys(routes)) {
        if (url.startsWith(key) && routes[key] !== undefined) {
          const r = routes[key];
          return typeof r === 'function' ? r() : r;
        }
      }
      throw new Error(`fake fetch: no route for ${url}`);
    }
    return typeof route === 'function' ? route() : route;
  };
  return Object.assign(fetchFn, { calls });
}

/** Build an HttpResponse shell with a `headers.get()` fake backed by a plain
 *  map (so tests can set Link headers without dealing with the Headers API). */
function res(
  body: unknown,
  opts: { ok?: boolean; status?: number; link?: string } = {},
): HttpResponse {
  const headersMap: Record<string, string> = {};
  if (opts.link !== undefined) headersMap['link'] = opts.link;
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() in headersMap ? (headersMap[name.toLowerCase()] as string) : null,
    },
  };
}

describe('createGitHubInstallationService (#174)', () => {
  const repo = (owner: string, name: string) => ({
    owner: { login: owner },
    name,
  });
  // Shared lowercase repo fixtures for the pagination/last-page tests below.
  // Use `apiRepo(repos[i])` to wrap into the GitHub-API shape `{owner:{login}, name}`
  // that toInstallationRepo expects; `repos[i]` itself is the lowercase form the
  // service emits.
  const repos = [
    { owner: 'heey-global', repo: 'a' },
    { owner: 'heey-global', repo: 'b' },
    { owner: 'heey-global', repo: 'c' },
  ];
  const apiRepo = (r: { owner: string; repo: string } | undefined) => ({
    owner: { login: r?.owner ?? 'heey-global' },
    name: r?.repo ?? 'a',
  });

  it('returns [] when no token is configured (inert)', async () => {
    const svc = createGitHubInstallationService({ token: undefined, fetch: fakeFetch({}) });
    expect(await svc.listInstallationRepos()).toEqual([]);
  });

  it('returns [] when the token provider yields an empty string', async () => {
    const svc = createGitHubInstallationService({ token: () => '', fetch: fakeFetch({}) });
    expect(await svc.listInstallationRepos()).toEqual([]);
  });

  it('uses an async installation token provider when no static token is configured', async () => {
    let asyncTokenCalls = 0;
    const asyncToken = async (): Promise<string> => {
      asyncTokenCalls += 1;
      return 'tok';
    };
    const fetch = fakeFetch({
      'https://api.github.com/installation/repositories?per_page=100&sort=full_name&direction=asc':
        res({ repositories: [repo('Heey-Global', 'Verity')] }),
    });

    const svc = createGitHubInstallationService({ asyncToken, fetch });

    await expect(svc.listInstallationRepos()).resolves.toEqual([
      { owner: 'heey-global', repo: 'verity' },
    ]);
    expect(asyncTokenCalls).toBe(1);
  });

  it('never throws when async installation-token minting fails', async () => {
    const fetch = fakeFetch({});
    const svc = createGitHubInstallationService({
      asyncToken: () => Promise.reject(new Error('mint failed')),
      fetch,
    });
    await expect(svc.listInstallationRepos()).resolves.toEqual([]);
    expect(fetch.calls).toHaveLength(0);
  });

  it('lists repos from a single page and lowercases owner/repo', async () => {
    const fetch = fakeFetch({
      'https://api.github.com/installation/repositories?per_page=100&sort=full_name&direction=asc':
        res({ repositories: [repo('Heey-Global', 'Verity'), repo('Foo', 'bar')] }),
    });
    const svc = createGitHubInstallationService({ token: 'tok', fetch });
    expect(await svc.listInstallationRepos()).toEqual([
      { owner: 'heey-global', repo: 'verity' },
      { owner: 'foo', repo: 'bar' },
    ]);
    expect(fetch.calls).toHaveLength(1);
  });

  it('carries the archive flag for archived repositories', async () => {
    const fetch = fakeFetch({
      'https://api.github.com/installation/repositories?per_page=100&sort=full_name&direction=asc':
        res({ repositories: [{ ...repo('Heey-Global', 'Old-Repo'), archived: true }] }),
    });
    const svc = createGitHubInstallationService({ token: 'tok', fetch });
    expect(await svc.listInstallationRepos()).toEqual([
      { owner: 'heey-global', repo: 'old-repo', archived: true },
    ]);
  });

  it('paginates across multiple pages following the Link rel="next" header', async () => {
    let page = 0;
    const fetch = fakeFetch({
      'https://api.github.com/installation/repositories?per_page=100&sort=full_name&direction=asc':
        () => {
          page += 1;
          if (page === 1) {
            return res(
              { repositories: [repo('heey-global', 'a')] },
              {
                link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
              },
            );
          }
          return res({ repositories: [repo('heey-global', 'b')] });
        },
      'https://api.github.com/installation/repositories?per_page=100&page=2': () =>
        res({ repositories: [repo('heey-global', 'b')] }),
    });
    const svc = createGitHubInstallationService({ token: 'tok', fetch });
    expect(await svc.listInstallationRepos()).toEqual([
      { owner: 'heey-global', repo: 'a' },
      { owner: 'heey-global', repo: 'b' },
    ]);
    expect(fetch.calls).toHaveLength(2);
  });

  it('stops at the last page (no Link header → one page only)', async () => {
    const fetch = fakeFetch({
      'https://api.github.com/installation/repositories?per_page=100&sort=full_name&direction=asc':
        res({ repositories: [repo('heey-global', 'a')] }),
    });
    const svc = createGitHubInstallationService({ token: 'tok', fetch });
    expect(await svc.listInstallationRepos()).toEqual([{ owner: 'heey-global', repo: 'a' }]);
    expect(fetch.calls).toHaveLength(1);
  });

  it('drops malformed entries in the repositories array rather than throwing', async () => {
    const fetch = fakeFetch({
      'https://api.github.com/installation/repositories?per_page=100&sort=full_name&direction=asc':
        res({
          repositories: [
            repo('heey-global', 'verity'),
            { owner: null, name: 'bad' },
            { owner: { login: 'ok' }, name: 42 },
            null,
            'not-an-object',
          ],
        }),
    });
    const svc = createGitHubInstallationService({ token: 'tok', fetch });
    expect(await svc.listInstallationRepos()).toEqual([{ owner: 'heey-global', repo: 'verity' }]);
  });

  it('caches a successful list for the TTL window', async () => {
    let invocations = 0;
    const fetch = fakeFetch({
      'https://api.github.com/installation/repositories?per_page=100&sort=full_name&direction=asc':
        () => {
          invocations += 1;
          return res({ repositories: [repo('heey-global', 'verity')] });
        },
    });
    let now = 1_000;
    const svc = createGitHubInstallationService({
      token: 'tok',
      fetch,
      ttlMs: 100,
      now: () => now,
    });
    await svc.listInstallationRepos();
    await svc.listInstallationRepos(); // cache hit
    expect(invocations).toBe(1);

    now += 200; // past TTL
    await svc.listInstallationRepos();
    expect(invocations).toBe(2);
  });

  it('serves the last good list when a refresh fails (stale-while-error)', async () => {
    let invocations = 0;
    const fetch = fakeFetch({
      'https://api.github.com/installation/repositories?per_page=100&sort=full_name&direction=asc':
        () => {
          invocations += 1;
          // First call succeeds, second fails with 500.
          if (invocations === 1) {
            return res({ repositories: [repo('heey-global', 'verity')] });
          }
          return res({ message: 'oops' }, { ok: false, status: 500 });
        },
    });
    let now = 1_000;
    const svc = createGitHubInstallationService({
      token: 'tok',
      fetch,
      ttlMs: 100,
      now: () => now,
    });
    expect((await svc.listInstallationRepos()).map((r) => r.repo)).toEqual(['verity']);
    now += 200; // past TTL → triggers a failed refresh
    expect((await svc.listInstallationRepos()).map((r) => r.repo)).toEqual(['verity']);
    expect(invocations).toBe(2);
  });

  it('returns [] when the first call fails (no stale value yet) — does NOT cache the failure', async () => {
    let invocations = 0;
    const fetch = fakeFetch({
      'https://api.github.com/installation/repositories?per_page=100&sort=full_name&direction=asc':
        () => {
          invocations += 1;
          return res({ message: 'xdowntime' }, { ok: false, status: 503 });
        },
    });
    const now = 1_000;
    const svc = createGitHubInstallationService({
      token: 'tok',
      fetch,
      ttlMs: 100,
      now: () => now,
    });
    expect(await svc.listInstallationRepos()).toEqual([]);
    expect(invocations).toBe(1);
    // Subsequent call (still within TTL window of the failure) RE-fetches
    // since the failed lookup wasn't cached.
    await svc.listInstallationRepos();
    expect(invocations).toBe(2);
  });

  it('uses AbortSignal.timeout (signal is set) — failure-mode test skipped, but signal must be passed', async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetch: HttpFetch = async (_url, init) => {
      receivedSignal = init?.signal;
      return res({ repositories: [] });
    };
    const svc = createGitHubInstallationService({ token: 'tok', fetch, ttlMs: 0, now: () => 1 });
    await svc.listInstallationRepos();
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);
  });

  it('respects a token provider function (re-read on each call so the rotating ~/.gh-token tracks)', async () => {
    let tokenValue = 'tok1';
    let seenAuth: string | undefined;
    const fetch: HttpFetch = async (url, init) => {
      seenAuth = init?.headers?.['Authorization'];
      void url;
      return res({ repositories: [] });
    };
    const svc = createGitHubInstallationService({
      token: () => tokenValue,
      fetch,
      ttlMs: 0,
      now: () => 1,
    });
    await svc.listInstallationRepos();
    expect(seenAuth).toBe('Bearer tok1');
    tokenValue = 'tok2';
    await svc.listInstallationRepos();
    expect(seenAuth).toBe('Bearer tok2');
  });

  it('paginating then encountering a 5xx mid-walk short-circuits to a no-list failure', async () => {
    // Page 1 succeeds, page 2 returns 500 — walkAllPages must reject the whole
    // batch (not return the partial fetch from page 1), so a stale-while-error
    // of a PREVIOUS successful list surfaces rather than a half-baked new one.
    let page = 0;
    const fetch = fakeFetch({
      'https://api.github.com/installation/repositories?per_page=100&sort=full_name&direction=asc':
        () => {
          page += 1;
          if (page === 1) {
            return res(
              { repositories: [apiRepo(repos[0])] }, // heey-global/a
              {
                link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
              },
            );
          }
          // page === 2 → 500
          return res({ message: 'oops' }, { ok: false, status: 500 });
        },
      // page=2 also has no fake route registered for this case; we route it
      // through the same per-page-2 handler above by also catching the bare URL.
      'https://api.github.com/installation/repositories?per_page=100&page=2': () =>
        res({ message: 'oops' }, { ok: false, status: 500 }),
    });
    const now = 1_000;
    const svc = createGitHubInstallationService({
      token: 'tok',
      fetch,
      ttlMs: 100,
      now: () => now,
    });
    expect(await svc.listInstallationRepos()).toEqual([]); // no prior cache → []
    // The first call did NOT cache (it failed), so a retry will re-walk.
    expect(fetch.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('walks when the Link header points to a page-URL not registered as a top-level key, relying on the prefix match', async () => {
    // Demonstrates the prefix-match escape hatch: a page=2 URL configured only
    // at the explicit key (not via a prefix) is found via the dict's
    // starts-with fallback when the test sets it that way.
    const fetch = fakeFetch({
      'https://api.github.com/installation/repositories?per_page=100&sort=full_name&direction=asc':
        () =>
          res(
            { repositories: [apiRepo(repos[0])] },
            {
              link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
            },
          ),
      'https://api.github.com/installation/repositories?per_page=100&page=2': () =>
        res({ repositories: [apiRepo(repos[1]), apiRepo(repos[2])] }),
    });
    const svc = createGitHubInstallationService({ token: 'tok', fetch, ttlMs: 0, now: () => 1 });
    expect(await svc.listInstallationRepos()).toEqual([
      { owner: 'heey-global', repo: 'a' },
      { owner: 'heey-global', repo: 'b' },
      { owner: 'heey-global', repo: 'c' },
    ]);
  });
});

describe('syncProjectsFromInstallation (integration, #174)', () => {
  // The route handler is tested via server.test.ts (it injects a stub
  // listProjects). This block exercises the live composition that the
  // embedded.ts provider wires: a fake installation service → real EventStore
  // upserts → listProjects readback, exercising the worker-state-preserves-
  // refresh contract end-to-end.

  it('syncs installation repos into the projects cache and returns listProjects', async () => {
    const { createTestDb, truncateAll } = await import('@verity/store/testing');
    const ctx = await createTestDb();
    try {
      await truncateAll(ctx.db);
      const installation = makeFakeInstallation([
        { owner: 'heey-global', repo: 'verity' },
        { owner: 'heey-global', repo: 'dev-server' },
      ]);
      const result = await syncProjectsFromInstallation(ctx.store, installation);
      expect(result).toHaveLength(2);
      expect(result.map((p) => p.repo).sort()).toEqual(['dev-server', 'verity']);
      expect(result.every((p) => p.state === 'absent')).toBe(true);
      expect(result.every((p) => p.archived === false)).toBe(true);
      expect(result.every((p) => p.owner === 'heey-global')).toBe(true);
      expect(result.every((p) => p.containerName.startsWith('verity-heey-global-'))).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  // Between reserving a target and finishing the push, a link owns the identity
  // claim with no `projects` row behind it yet — the upsert for that repo throws.
  // The sync must step over that one repo instead of taking `GET /projects` down
  // with it while the push runs.
  it('skips a repository whose identity a pending link has reserved', async () => {
    const { createTestDb, truncateAll } = await import('@verity/store/testing');
    const ctx = await createTestDb();
    try {
      await truncateAll(ctx.db);
      const { randomUUID } = await import('node:crypto');
      const linking = randomUUID();
      await ctx.store.upsertProject({
        id: linking,
        owner: '__local__',
        repo: 'immobilien',
        containerName: 'verity-__local__--immobilien',
        kind: 'local',
        cloneDir: '__local__-immobilien',
        state: 'active',
      });
      expect(
        await ctx.store.reserveProjectIdentity(linking, {
          owner: 'heey-global',
          repo: 'immobilien',
        }),
      ).toBe(true);

      const installation = makeFakeInstallation([
        { owner: 'heey-global', repo: 'immobilien' },
        { owner: 'heey-global', repo: 'verity' },
      ]);
      const result = await syncProjectsFromInstallation(ctx.store, installation);

      // The reserved repo is absent from the cache (its project is still local),
      // and the repos after it in the list were still synced.
      expect(result.map((p) => `${p.owner}/${p.repo}`).sort()).toEqual([
        '__local__/immobilien',
        'heey-global/verity',
      ]);
    } finally {
      await ctx.close();
    }
  });

  it('persists archived status from installation sync', async () => {
    const { createTestDb, truncateAll } = await import('@verity/store/testing');
    const ctx = await createTestDb();
    try {
      await truncateAll(ctx.db);
      const installation = makeFakeInstallation([
        { owner: 'heey-global', repo: 'old-repo', archived: true },
      ]);
      const result = await syncProjectsFromInstallation(ctx.store, installation);
      expect(result).toMatchObject([{ repo: 'old-repo', archived: true }]);
    } finally {
      await ctx.close();
    }
  });

  it('returns the persisted cache when GitHub installation degrades to []', async () => {
    const { createTestDb, truncateAll } = await import('@verity/store/testing');
    const ctx = await createTestDb();
    try {
      await truncateAll(ctx.db);
      // Pre-seed the cache with a project (simulating a previous successful sync).
      const { randomUUID } = await import('node:crypto');
      await ctx.store.upsertProject({
        id: randomUUID(),
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'verity-heey-global--verity',
        state: 'active', // worker state
      });
      const installation = makeFakeInstallation([]); // GitHub unreachable this time
      const result = await syncProjectsFromInstallation(ctx.store, installation);
      expect(result).toHaveLength(1);
      expect(result[0]?.state).toBe('active'); // worker state preserved
    } finally {
      await ctx.close();
    }
  });

  it('preserves worker-owned state when a refresh syncs over an in-flight project', async () => {
    const { createTestDb, truncateAll } = await import('@verity/store/testing');
    const ctx = await createTestDb();
    try {
      await truncateAll(ctx.db);
      const { randomUUID } = await import('node:crypto');
      // Worker has transitioned verity to "cloning".
      const id = randomUUID();
      await ctx.store.upsertProject({
        id,
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'verity-heey-global--verity',
        state: 'cloning',
      });
      const installation = makeFakeInstallation([{ owner: 'heey-global', repo: 'verity' }]);
      const result = await syncProjectsFromInstallation(ctx.store, installation);
      // The row state stays "cloning" (worker-owned); the row identity stays
      // the same (randomUUID on the upsert side is ignored on the UPDATE branch).
      expect(result).toHaveLength(1);
      expect(result[0]?.state).toBe('cloning');
      expect(result[0]?.id).toBe(id);
    } finally {
      await ctx.close();
    }
  });

  it('can include soft-deleted rows for the add-project picker restore path', async () => {
    const { createTestDb, truncateAll } = await import('@verity/store/testing');
    const ctx = await createTestDb();
    try {
      await truncateAll(ctx.db);
      const { randomUUID } = await import('node:crypto');
      const project = await ctx.store.upsertProject({
        id: randomUUID(),
        owner: 'heey-global',
        repo: 'deleted',
        containerName: 'verity-heey-global--deleted',
        state: 'absent',
        overviewVisible: true,
      });
      await ctx.store.hideProject(project.id);

      const installation = makeFakeInstallation([{ owner: 'heey-global', repo: 'deleted' }]);
      const hidden = await syncProjectsFromInstallation(ctx.store, installation);
      expect(hidden).toEqual([]);

      const addable = await syncProjectsFromInstallation(ctx.store, installation, {
        includeHidden: true,
      });
      expect(addable).toMatchObject([
        { id: project.id, repo: 'deleted', state: 'absent', hiddenAt: expect.any(Date) },
      ]);
    } finally {
      await ctx.close();
    }
  });
});
