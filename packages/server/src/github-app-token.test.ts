import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createCachedInstallationTokenMint,
  createCachedProjectTokenMint,
  createGitHubAppInstallationTokenMint,
  createGitHubAppProjectTokenMint,
  resolveGitHubAppIdentity,
  PROJECT_GITHUB_TOKEN_PERMISSIONS,
} from './github-app-token.js';
import type { HttpFetch, HttpResponse } from './github.js';

const ok = (body: unknown): HttpResponse => ({
  ok: true,
  status: 201,
  json: () => Promise.resolve(body),
});

const fail = (status: number): HttpResponse => ({
  ok: false,
  status,
  json: () => Promise.resolve({}),
});

function writePrivateKey(): { dir: string; privateKeyPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'verity-gh-app-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPath = join(dir, 'app.pem');
  writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }).toString());
  return { dir, privateKeyPath };
}

/** A valid RSA private key as a PEM string (as the DB resolver would return it). */
function pemString(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
}

describe('createGitHubAppProjectTokenMint', () => {
  // `mintGitHubAppInstallationToken` THROWS on any GitHub non-2xx, and the
  // session-spawn path awaits the mint unguarded — so a project with no GitHub
  // repository must degrade here, at the single choke point, not at GitHub.
  it('returns undefined for a project with no GitHub repository, without calling GitHub', async () => {
    const { dir, privateKeyPath } = writePrivateKey();
    try {
      let called = 0;
      const fetch: HttpFetch = () => {
        called += 1;
        return Promise.resolve(fail(404));
      };
      const mint = createGitHubAppProjectTokenMint({
        appId: '123',
        privateKeyPath,
        defaultInstallationId: '456',
        fetch,
      });

      await expect(
        mint({ owner: '__local__', repo: 'my-project', kind: 'local' }),
      ).resolves.toBeUndefined();
      await expect(
        mint({ owner: 'verity', repo: 'control', kind: 'control_plane' }),
      ).resolves.toBeUndefined();
      // The gh-token broker resolves a capability to `{owner, repo}` only, with no
      // `kind` to read; the reserved owner covers that caller too.
      await expect(mint({ owner: '__local__', repo: 'my-project' })).resolves.toBeUndefined();
      expect(called).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mints a repo-scoped installation token without exposing the private key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-gh-app-'));
    try {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const privateKeyPath = join(dir, 'app.pem');
      writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }).toString());
      const calls: Array<{
        url: string;
        headers?: Record<string, string> | undefined;
        body?: string | undefined;
      }> = [];
      const fetch: HttpFetch = (url, init) => {
        calls.push({ url, headers: init?.headers, body: init?.body });
        return Promise.resolve(ok({ token: 'ghs_project' }));
      };
      const mint = createGitHubAppProjectTokenMint({
        appId: '123',
        privateKeyPath,
        defaultInstallationId: '456',
        apiBaseUrl: 'https://github.example/api',
        fetch,
        now: () => 1_700_000_000_000,
      });

      await expect(mint({ owner: 'Example-Org', repo: 'sample-app' })).resolves.toBe('ghs_project');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('https://github.example/api/app/installations/456/access_tokens');
      expect(calls[0]?.headers?.Authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      expect(calls[0]?.body).toBe(JSON.stringify({ repositories: ['sample-app'] }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes the least-privilege permissions subset in the mint body when configured', async () => {
    const { dir, privateKeyPath } = writePrivateKey();
    try {
      const bodies: Array<string | undefined> = [];
      const fetch: HttpFetch = (_url, init) => {
        bodies.push(init?.body);
        return Promise.resolve(ok({ token: 'ghs_scoped' }));
      };
      const mint = createGitHubAppProjectTokenMint({
        appId: '123',
        privateKeyPath,
        defaultInstallationId: '456',
        permissions: { organization_projects: 'write', issues: 'write' },
        fetch,
      });

      await expect(mint({ owner: 'Heey-Global', repo: 'Verity' })).resolves.toBe('ghs_scoped');
      // Assert the parsed wire contract, not key-emission order.
      expect(bodies[0] === undefined ? undefined : JSON.parse(bodies[0])).toEqual({
        repositories: ['Verity'],
        permissions: { organization_projects: 'write', issues: 'write' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requests repository management permissions for project/container tokens', async () => {
    const { dir, privateKeyPath } = writePrivateKey();
    try {
      const bodies: Array<string | undefined> = [];
      const fetch: HttpFetch = (_url, init) => {
        bodies.push(init?.body);
        return Promise.resolve(ok({ token: 'ghs_project_checks' }));
      };
      const mint = createGitHubAppProjectTokenMint({
        appId: '123',
        privateKeyPath,
        defaultInstallationId: '456',
        permissions: PROJECT_GITHUB_TOKEN_PERMISSIONS,
        fetch,
      });

      await expect(mint({ owner: 'Heey-Global', repo: 'Verity' })).resolves.toBe(
        'ghs_project_checks',
      );
      expect(bodies[0] === undefined ? undefined : JSON.parse(bodies[0])).toEqual({
        repositories: ['Verity'],
        permissions: {
          contents: 'write',
          pull_requests: 'write',
          issues: 'write',
          checks: 'read',
          actions: 'write',
          workflows: 'write',
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mints an installation-scoped token without a repositories filter', async () => {
    const { dir, privateKeyPath } = writePrivateKey();
    try {
      const bodies: Array<string | undefined> = [];
      const fetch: HttpFetch = (_url, init) => {
        bodies.push(init?.body);
        return Promise.resolve(ok({ token: 'ghs_board' }));
      };
      const mint = createGitHubAppInstallationTokenMint({
        appId: '123',
        privateKeyPath,
        defaultInstallationId: '456',
        permissions: { organization_projects: 'write', issues: 'write' },
        fetch,
      });

      await expect(mint()).resolves.toBe('ghs_board');
      expect(bodies[0] === undefined ? undefined : JSON.parse(bodies[0])).toEqual({
        permissions: { organization_projects: 'write', issues: 'write' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a terse error when GitHub rejects the installation-token request', async () => {
    const { dir, privateKeyPath } = writePrivateKey();
    try {
      const fetch: HttpFetch = () => Promise.resolve(fail(403));
      const mint = createGitHubAppProjectTokenMint({
        appId: '123',
        privateKeyPath,
        defaultInstallationId: '456',
        fetch,
      });

      await expect(mint({ owner: 'Example-Org', repo: 'sample-app' })).rejects.toThrow(
        'GitHub App token mint failed: HTTP 403',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when GitHub responds without a token field', async () => {
    const { dir, privateKeyPath } = writePrivateKey();
    try {
      const fetch: HttpFetch = () => Promise.resolve(ok({}));
      const mint = createGitHubAppProjectTokenMint({
        appId: '123',
        privateKeyPath,
        defaultInstallationId: '456',
        fetch,
      });

      await expect(mint({ owner: 'Example-Org', repo: 'sample-app' })).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers resolveCreds (app-configured DB) over the static file config', async () => {
    const { dir, privateKeyPath } = writePrivateKey();
    try {
      const calls: string[] = [];
      const fetch: HttpFetch = (url) => {
        calls.push(url);
        return Promise.resolve(ok({ token: 'ghs_db' }));
      };
      const mint = createGitHubAppProjectTokenMint({
        appId: 'static-app',
        privateKeyPath,
        defaultInstallationId: 'static-inst',
        resolveCreds: () =>
          Promise.resolve({ appId: 'db-app', privateKey: pemString(), installationId: 'db-inst' }),
        apiBaseUrl: 'https://github.example/api',
        fetch,
      });

      await expect(mint({ owner: 'o', repo: 'r' })).resolves.toBe('ghs_db');
      // The DB installation is used, not the static-config one.
      expect(calls[0]).toBe('https://github.example/api/app/installations/db-inst/access_tokens');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the static file config when resolveCreds yields nothing', async () => {
    const { dir, privateKeyPath } = writePrivateKey();
    try {
      const calls: string[] = [];
      const fetch: HttpFetch = (url) => {
        calls.push(url);
        return Promise.resolve(ok({ token: 'ghs_file' }));
      };
      const mint = createGitHubAppProjectTokenMint({
        appId: 'static-app',
        privateKeyPath,
        defaultInstallationId: 'static-inst',
        resolveCreds: () => Promise.resolve(undefined),
        apiBaseUrl: 'https://github.example/api',
        fetch,
      });

      await expect(mint({ owner: 'o', repo: 'r' })).resolves.toBe('ghs_file');
      expect(calls[0]).toBe(
        'https://github.example/api/app/installations/static-inst/access_tokens',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined without calling GitHub when no creds are configured', async () => {
    let called = false;
    const fetch: HttpFetch = () => {
      called = true;
      return Promise.resolve(ok({ token: 'x' }));
    };
    const mint = createGitHubAppProjectTokenMint({ fetch });

    await expect(mint({ owner: 'o', repo: 'r' })).resolves.toBeUndefined();
    expect(called).toBe(false);
  });
});

describe('createCachedProjectTokenMint', () => {
  const R = { owner: 'o', repo: 'r' } as const;
  const R2 = { owner: 'o', repo: 'other' } as const;

  it('mints once per repo and serves the cached token within the TTL', async () => {
    let mints = 0;
    let clock = 1_000;
    const cached = createCachedProjectTokenMint(
      () => {
        mints += 1;
        return Promise.resolve(`ghs_${String(mints)}`);
      },
      { ttlMs: 1_000, now: () => clock },
    );

    await expect(cached(R)).resolves.toBe('ghs_1');
    clock += 999; // still inside the TTL window
    await expect(cached(R)).resolves.toBe('ghs_1');
    expect(mints).toBe(1);
  });

  it('re-mints after the TTL elapses', async () => {
    let mints = 0;
    let clock = 1_000;
    const cached = createCachedProjectTokenMint(
      () => {
        mints += 1;
        return Promise.resolve(`ghs_${String(mints)}`);
      },
      { ttlMs: 1_000, now: () => clock },
    );

    await expect(cached(R)).resolves.toBe('ghs_1');
    clock += 1_000; // TTL boundary reached → cache is stale
    await expect(cached(R)).resolves.toBe('ghs_2');
    expect(mints).toBe(2);
  });

  it('caches independently per owner/repo key', async () => {
    const mints: string[] = [];
    const cached = createCachedProjectTokenMint(
      (p) => {
        mints.push(`${p.owner}/${p.repo}`);
        return Promise.resolve(`ghs_${p.repo}`);
      },
      { ttlMs: 60_000, now: () => 0 },
    );

    await expect(cached(R)).resolves.toBe('ghs_r');
    await expect(cached(R2)).resolves.toBe('ghs_other'); // different key → its own mint
    await expect(cached(R)).resolves.toBe('ghs_r'); // first key still cached
    expect(mints).toEqual(['o/r', 'o/other']);
  });

  it('does not cache an undefined result (transient failure retries next call)', async () => {
    const results: Array<string | undefined> = [undefined, 'ghs_ok'];
    let mints = 0;
    const cached = createCachedProjectTokenMint(() => Promise.resolve(results[mints++]), {
      ttlMs: 60_000,
      now: () => 0,
    });

    await expect(cached(R)).resolves.toBeUndefined();
    await expect(cached(R)).resolves.toBe('ghs_ok'); // not short-circuited by a cached undefined
    expect(mints).toBe(2);
  });

  it('degrades a throwing mint to undefined and retries (never propagates)', async () => {
    let mints = 0;
    const cached = createCachedProjectTokenMint(
      () => {
        mints += 1;
        if (mints === 1) return Promise.reject(new Error('GitHub App token mint failed: HTTP 422'));
        return Promise.resolve('ghs_after_recovery');
      },
      { ttlMs: 60_000, now: () => 0 },
    );

    await expect(cached(R)).resolves.toBeUndefined(); // a throw must not propagate
    await expect(cached(R)).resolves.toBe('ghs_after_recovery'); // failure was not cached
    expect(mints).toBe(2);
  });

  it('single-flights concurrent callers for the same key into one mint', async () => {
    let mints = 0;
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const cached = createCachedProjectTokenMint(
      () => {
        mints += 1;
        return gate; // stays pending until released → both callers overlap
      },
      { ttlMs: 60_000, now: () => 0 },
    );

    const a = cached(R);
    const b = cached(R); // arrives while the first mint is still in flight
    release('ghs_shared');
    await expect(a).resolves.toBe('ghs_shared');
    await expect(b).resolves.toBe('ghs_shared');
    expect(mints).toBe(1); // only ONE mint despite two concurrent callers
  });

  it('keeps authority-key failures inside the nonthrowing boundary', async () => {
    let calls = 0;
    const mint = async () => {
      calls += 1;
      return 'token';
    };
    const cached = createCachedProjectTokenMint(mint, {
      authorityKey: async () => Promise.reject(new Error('sealed')),
    });
    await expect(cached(R)).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe('createCachedInstallationTokenMint', () => {
  it('keeps authority-key failures inside the nonthrowing boundary', async () => {
    let calls = 0;
    const mint = async () => {
      calls += 1;
      return 'token';
    };
    const cached = createCachedInstallationTokenMint(mint, {
      authorityKey: async () => Promise.reject(new Error('sealed')),
    });
    await expect(cached()).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });
  it('memoizes a successful installation token and single-flights concurrent calls', async () => {
    let calls = 0;
    let resolve!: (value: string) => void;
    const mint = () =>
      new Promise<string>((r) => {
        calls += 1;
        resolve = r;
      });
    const cached = createCachedInstallationTokenMint(mint);

    const a = cached();
    const b = cached();
    resolve('ghs_installation');
    await expect(a).resolves.toBe('ghs_installation');
    await expect(b).resolves.toBe('ghs_installation');
    await expect(cached()).resolves.toBe('ghs_installation');
    expect(calls).toBe(1);
  });
});

describe('resolveGitHubAppIdentity', () => {
  const creds = { appId: '123', privateKey: pemString(), installationId: '456' };

  it('derives name + no-reply email from a user installation', async () => {
    const calls: Array<{
      url: string;
      method?: string | undefined;
      headers?: Record<string, string> | undefined;
    }> = [];
    const fetch: HttpFetch = (url, init) => {
      calls.push({ url, method: init?.method, headers: init?.headers });
      return Promise.resolve(ok({ account: { login: 'octocat', id: 583231, type: 'User' } }));
    };
    const result = await resolveGitHubAppIdentity(creds, {
      fetch,
      apiBaseUrl: 'https://github.example/api',
      now: () => 1_700_000_000_000,
    });
    expect(result).toEqual({
      ok: true,
      name: 'octocat',
      email: '583231+octocat@users.noreply.github.com',
    });
    // Reads the installation object (GET), authenticated with an App JWT.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://github.example/api/app/installations/456');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers?.Authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
  });

  it('rejects an organization installation (no signing-key slot)', async () => {
    const fetch: HttpFetch = () =>
      Promise.resolve(ok({ account: { login: 'acme', id: 42, type: 'Organization' } }));
    const result = await resolveGitHubAppIdentity(creds, { fetch });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/organization/i);
    expect(result.email).toBeUndefined();
  });

  it('maps a 404 to an installation-not-found error without echoing the body', async () => {
    const fetch: HttpFetch = () => Promise.resolve(fail(404));
    const result = await resolveGitHubAppIdentity(creds, { fetch });
    expect(result).toEqual({
      ok: false,
      error: 'installation not found (check the Installation ID)',
    });
  });

  it('maps a 401/403 to a credential-rejected error', async () => {
    const fetch: HttpFetch = () => Promise.resolve(fail(403));
    const result = await resolveGitHubAppIdentity(creds, { fetch });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rejected the App credentials/i);
  });

  it('fails cleanly when the account object is missing', async () => {
    const fetch: HttpFetch = () => Promise.resolve(ok({}));
    const result = await resolveGitHubAppIdentity(creds, { fetch });
    expect(result).toEqual({ ok: false, error: 'GitHub did not return the installation account' });
  });

  it('reports an invalid private key without reaching the network', async () => {
    let called = false;
    const fetch: HttpFetch = () => {
      called = true;
      return Promise.resolve(ok({}));
    };
    const result = await resolveGitHubAppIdentity(
      { appId: '1', privateKey: 'not-a-pem', installationId: '2' },
      { fetch },
    );
    expect(result).toEqual({ ok: false, error: 'invalid private key' });
    expect(called).toBe(false);
  });
});
