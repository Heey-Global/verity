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
