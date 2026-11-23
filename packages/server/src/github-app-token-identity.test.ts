import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  createCachedProjectTokenMint,
  createGitHubAppProjectTokenMint,
  type GitHubRepositoryIdentity,
} from './github-app-token.js';
import type { HttpFetch, HttpResponse } from './github.js';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();

const API = 'https://api.github.com';
const TOKEN_URL = `${API}/app/installations/456/access_tokens`;

function response(status: number, body: unknown = {}, location?: string): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: { get: (name) => (name.toLowerCase() === 'location' ? (location ?? null) : null) },
  };
}

function repository(id: number, name: string) {
  return { id, name, owner: { login: 'Heey-Global' } };
}

/** A GitHub fake for one installation. `repositories` maps an ID to the name it
 *  has now; `redirects` maps an old name to the ID GitHub redirects it to. */
function github(state: { repositories: Map<number, string>; redirects?: Map<string, number> }) {
  const requests: { url: string; body?: Record<string, unknown>; redirect?: string }[] = [];
  const fetch: HttpFetch = (url, init) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({
      url,
      ...(body ? { body } : {}),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    });
    if (url === TOKEN_URL) {
      const ids = body?.repository_ids as number[] | undefined;
      const names = body?.repositories as string[] | undefined;
      if (ids === undefined && names === undefined)
        return Promise.resolve(response(201, { token: 'metadata-token' }));
      const matches = ids
        ? ids.map((id) => [id, state.repositories.get(id)] as const)
        : names!.map(
            (name) =>
              [...state.repositories].find(([, current]) => current === name) ??
              ([0, undefined] as const),
          );
      if (matches.some(([, name]) => name === undefined)) return Promise.resolve(response(422));
      return Promise.resolve(
        response(201, {
          token: `token-${matches.map(([id]) => id).join(',')}`,
          repositories: matches.map(([id, name]) => repository(id, name!)),
        }),
      );
    }
    const old = /^https:\/\/api\.github\.com\/repos\/heey-global\/([^/]+)$/.exec(url);
    if (old) {
      const target = state.redirects?.get(old[1]!);
      if (target !== undefined)
        return Promise.resolve(response(301, {}, `${API}/repositories/${String(target)}`));
      const current = [...state.repositories].find(([, name]) => name === old[1]);
      return Promise.resolve(current ? response(200, repository(...current)) : response(404));
    }
    return Promise.resolve(response(404));
  };
  return { fetch, requests };
}

function identity(known: Record<string, string> = {}) {
  const observations: Parameters<GitHubRepositoryIdentity['reconcile']>[0][] = [];
  const store: GitHubRepositoryIdentity = {
    lookup: (owner, repo) => Promise.resolve(known[`${owner}/${repo}`]),
    reconcile: (observation) => {
      observations.push(observation);
      return Promise.resolve();
    },
  };
  return { store, observations };
}

function mint(fetch: HttpFetch, repositoryIdentity?: GitHubRepositoryIdentity) {
  return createGitHubAppProjectTokenMint({
    resolveCreds: () => Promise.resolve({ appId: '123', privateKey, installationId: '456' }),
    fetch,
    retryDelaysMs: [],
    repositoryIdentity,
  });
}

const tokenRequests = (requests: { url: string; body?: Record<string, unknown> }[]) =>
  requests.filter((request) => request.url === TOKEN_URL).map((request) => request.body);

describe('rename-stable project token mint', () => {
  it('scopes by the recorded ID, so a renamed repository still gets a token', async () => {
    const gh = github({ repositories: new Map([[4242, 'ocr-engine']]) });
    const known = identity();
    await expect(
      mint(
        gh.fetch,
        known.store,
      )({
        owner: 'heey-global',
        repo: 'deep-ocr',
        githubRepositoryId: '4242',
      }),
    ).resolves.toBe('token-4242');
    expect(tokenRequests(gh.requests)).toEqual([{ repository_ids: [4242] }]);
    expect(known.observations).toEqual([
      {
        requestedOwner: 'heey-global',
        requestedRepo: 'deep-ocr',
        id: '4242',
        owner: 'heey-global',
        repo: 'ocr-engine',
      },
    ]);
  });

  it('looks the ID up for callers that only hold the coordinates', async () => {
    const gh = github({ repositories: new Map([[4242, 'deep-ocr']]) });
    const known = identity({ 'heey-global/deep-ocr': '4242' });
    await expect(
      mint(gh.fetch, known.store)({ owner: 'Heey-Global', repo: 'Deep-OCR' }),
    ).resolves.toBe('token-4242');
    expect(tokenRequests(gh.requests)).toEqual([{ repository_ids: [4242] }]);
    // Same name as stored: nothing to write on every mint.
    expect(known.observations).toEqual([]);
  });

  it('lets an unbound project learn its own ID instead of borrowing one by name', async () => {
    // Another project under `deep-ocr` is bound to 4242, which was renamed away; a
    // newcomer (9999) now holds the name and has a project of its own.
    const gh = github({
      repositories: new Map([
        [4242, 'ocr-engine'],
        [9999, 'deep-ocr'],
      ]),
    });
    const known = identity({ 'heey-global/deep-ocr': '4242' });
    await expect(
      mint(
        gh.fetch,
        known.store,
      )({
        owner: 'heey-global',
        repo: 'deep-ocr',
        githubRepositoryId: null,
      }),
    ).resolves.toBe('token-9999');
    expect(tokenRequests(gh.requests)).toEqual([{ repositories: ['deep-ocr'] }]);
    expect(known.observations).toEqual([
      {
        requestedOwner: 'heey-global',
        requestedRepo: 'deep-ocr',
        id: '9999',
        owner: 'heey-global',
        repo: 'deep-ocr',
      },
    ]);
  });

  it('learns the ID from the first token minted by name', async () => {
    const gh = github({ repositories: new Map([[4242, 'deep-ocr']]) });
    const known = identity();
    await expect(
      mint(gh.fetch, known.store)({ owner: 'heey-global', repo: 'deep-ocr' }),
    ).resolves.toBe('token-4242');
    expect(tokenRequests(gh.requests)).toEqual([{ repositories: ['deep-ocr'] }]);
    expect(known.observations).toEqual([
      {
        requestedOwner: 'heey-global',
        requestedRepo: 'deep-ocr',
        id: '4242',
        owner: 'heey-global',
        repo: 'deep-ocr',
      },
    ]);
  });

  it('records nothing when a name resolves under another owner', async () => {
    // The token request names only the repository; GitHub answers from the
    // installation's own account (`heey-global`), not the stored `someone-else`.
    const gh = github({ repositories: new Map([[4242, 'deep-ocr']]) });
    const known = identity();
    await expect(
      mint(gh.fetch, known.store)({ owner: 'someone-else', repo: 'deep-ocr' }),
    ).resolves.toBe('token-4242');
    expect(known.observations).toEqual([]);
  });

  it('recovers a project renamed before its ID was recorded through GitHub’s redirect', async () => {
    const gh = github({
      repositories: new Map([[4242, 'ocr-engine']]),
      redirects: new Map([['deep-ocr', 4242]]),
    });
    const known = identity();
    await expect(
      mint(gh.fetch, known.store)({ owner: 'heey-global', repo: 'deep-ocr' }),
    ).resolves.toBe('token-4242');
    expect(tokenRequests(gh.requests)).toEqual([
      { repositories: ['deep-ocr'] },
      // The lookup token reads metadata only.
      { permissions: { metadata: 'read' } },
      { repository_ids: [4242] },
    ]);
    expect(gh.requests.find((request) => request.url.includes('/repos/'))?.redirect).toBe('manual');
    expect(known.observations).toEqual([
      {
        requestedOwner: 'heey-global',
        requestedRepo: 'deep-ocr',
        id: '4242',
        owner: 'heey-global',
        repo: 'ocr-engine',
      },
    ]);
  });

  it('fails closed when the installation lost the recorded repository', async () => {
    // Access revoked, and another repository has taken the old name meanwhile:
    // the recorded ID must not be swapped for whatever answers to the name now.
    const gh = github({ repositories: new Map([[9999, 'deep-ocr']]) });
    const known = identity();
    await expect(
      mint(
        gh.fetch,
        known.store,
      )({
        owner: 'heey-global',
        repo: 'deep-ocr',
        githubRepositoryId: '4242',
      }),
    ).rejects.toThrow('GitHub App token mint failed: HTTP 422');
    expect(tokenRequests(gh.requests)).toEqual([{ repository_ids: [4242] }]);
    expect(known.observations).toEqual([]);
  });

  it('does not recover a name GitHub does not redirect', async () => {
    const gh = github({ repositories: new Map([[4242, 'ocr-engine']]) });
    const known = identity();
    await expect(
      mint(gh.fetch, known.store)({ owner: 'heey-global', repo: 'deep-ocr' }),
    ).rejects.toThrow('HTTP 422');
    expect(tokenRequests(gh.requests)).toEqual([
      { repositories: ['deep-ocr'] },
      { permissions: { metadata: 'read' } },
    ]);
    expect(known.observations).toEqual([]);
  });

  it('ignores a redirect that leaves the GitHub API', async () => {
    const gh = github({ repositories: new Map([[4242, 'ocr-engine']]) });
    const fetch: HttpFetch = (url, init) =>
      url.includes('/repos/')
        ? Promise.resolve(response(301, {}, 'https://evil.example/repositories/4242'))
        : gh.fetch(url, init);
    await expect(
      mint(fetch, identity().store)({ owner: 'heey-global', repo: 'deep-ocr' }),
    ).rejects.toThrow('HTTP 422');
    expect(tokenRequests(gh.requests)).not.toContainEqual({ repository_ids: [4242] });
  });

  it('fails closed when the stored name is bound to more than one repository', async () => {
    const gh = github({ repositories: new Map([[4242, 'deep-ocr']]) });
    const tokenMint = mint(gh.fetch, {
      lookup: () => Promise.reject(new Error('bound to more than one GitHub repository')),
      reconcile: () => Promise.resolve(),
    });
    await expect(tokenMint({ owner: 'heey-global', repo: 'deep-ocr' })).rejects.toThrow(
      'bound to more than one',
    );
    expect(tokenRequests(gh.requests)).toEqual([]);
  });

  it('keeps the name-only behaviour without an identity store', async () => {
    const gh = github({
      repositories: new Map([[4242, 'ocr-engine']]),
      redirects: new Map([['deep-ocr', 4242]]),
    });
    await expect(mint(gh.fetch)({ owner: 'heey-global', repo: 'deep-ocr' })).rejects.toThrow(
      'HTTP 422',
    );
    expect(gh.requests).toHaveLength(1);
  });

  it('returns the token even when recording the identity fails', async () => {
    const gh = github({ repositories: new Map([[4242, 'deep-ocr']]) });
    const failures: unknown[] = [];
    const tokenMint = createGitHubAppProjectTokenMint({
      resolveCreds: () => Promise.resolve({ appId: '123', privateKey, installationId: '456' }),
      fetch: gh.fetch,
      repositoryIdentity: {
        lookup: () => Promise.resolve(undefined),
        reconcile: () => Promise.reject(new Error('database unavailable')),
      },
      onIdentityError: (error) => failures.push(error),
    });
    await expect(tokenMint({ owner: 'heey-global', repo: 'deep-ocr' })).resolves.toBe('token-4242');
    expect(failures).toHaveLength(1);
  });
});

describe('cached project token mint', () => {
  it('never hands a token for one bound repository to another of the same name', async () => {
    const minted: (string | null | undefined)[] = [];
    const cached = createCachedProjectTokenMint((project) => {
      minted.push(project.githubRepositoryId);
      return Promise.resolve(`token-${String(project.githubRepositoryId)}`);
    });
    const name = { owner: 'heey-global', repo: 'deep-ocr' };
    await expect(cached({ ...name, githubRepositoryId: '4242' })).resolves.toBe('token-4242');
    await expect(cached({ ...name, githubRepositoryId: '9999' })).resolves.toBe('token-9999');
    await expect(cached({ ...name, githubRepositoryId: '4242' })).resolves.toBe('token-4242');
    expect(minted).toEqual(['4242', '9999']);
  });

  it('keeps a bare-coordinate caller apart from an unbound project of the same name', async () => {
    // The first borrows the ID recorded for the name, the second mints by name:
    // they can resolve to different repositories, so neither reuses the other's token.
    const minted: (string | null | undefined)[] = [];
    const cached = createCachedProjectTokenMint((project) => {
      minted.push(project.githubRepositoryId);
      return Promise.resolve(`token-${String(project.githubRepositoryId)}`);
    });
    const name = { owner: 'heey-global', repo: 'deep-ocr' };
    await expect(cached(name)).resolves.toBe('token-undefined');
    await expect(cached({ ...name, githubRepositoryId: null })).resolves.toBe('token-null');
    expect(minted).toEqual([undefined, null]);
  });
});
