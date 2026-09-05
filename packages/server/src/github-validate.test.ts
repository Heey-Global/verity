// Live GitHub-App validation (#320, onboarding PR 2a). Two layers:
//   1. `POST /github/app/validate` route: sealed → {ok:false,error:'locked'};
//      not-configured → 'not configured'; injected-fake mint success → {ok:true};
//      injected-fake mint failure → {ok:false} with a redacted error. The route's
//      own decrypting read + sealed gate are exercised against a real cipher.
//   2. `validateGitHubAppCreds` (the real mint used in production): a fake fetch
//      drives success + each failure status, asserting the PEM and any token
//      string NEVER appear in the returned result.
import type { Conductor } from '@verity/session';
import { InMemoryEventBus } from '@verity/session';
import { EventStore, createSealableSecretCipher, type SealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';
import { validateGitHubAppCreds, type GitHubAppCreds } from './github-app-token.js';
import type { HttpFetch, HttpResponse } from './github.js';

const conductor = {} as unknown as Conductor;

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

const PASSWORD = 'correct-horse-battery';

/** A real RSA PEM (computed at runtime — never a hard-coded key literal, so
 *  gitleaks has nothing to trip on). Used as the stored App private key. */
function pemString(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
}

function build(
  cipher: SealableSecretCipher,
  githubAppValidate?: (creds: GitHubAppCreds) => Promise<{
    ok: boolean;
    accountLogin?: string;
    error?: string;
  }>,
): FastifyInstance {
  const store = new EventStore(ctx.db, cipher);
  return buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    conductor,
    secretCipher: cipher,
    ...(githubAppValidate ? { githubAppValidate } : {}),
  });
}

async function unlock(app: FastifyInstance): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/secret/init',
    payload: { password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
}

describe('POST /github/app/validate route', () => {
  it('returns {ok:false,error:"locked"} while the store is sealed (never throws)', async () => {
    const cipher = createSealableSecretCipher();
    const app = build(cipher, () => Promise.resolve({ ok: true }));
    try {
      // Sealed (no init) → locked, and the injected validator must NOT be called.
      const res = await app.inject({ method: 'POST', url: '/github/app/validate' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: false, error: 'locked' });
    } finally {
      await app.close();
    }
  });

  it('returns {ok:false,error:"not configured"} when creds are missing', async () => {
    const cipher = createSealableSecretCipher();
    const app = build(cipher, () => Promise.resolve({ ok: true }));
    try {
      await unlock(app);
      const res = await app.inject({ method: 'POST', url: '/github/app/validate' });
      expect(res.json()).toEqual({ ok: false, error: 'not configured' });
    } finally {
      await app.close();
    }
  });

  it('returns {ok:true, accountLogin} when the injected mint succeeds', async () => {
    const cipher = createSealableSecretCipher();
    let seen: GitHubAppCreds | undefined;
    const app = build(cipher, (creds) => {
      seen = creds;
      return Promise.resolve({ ok: true, accountLogin: 'acme-org' });
    });
    try {
      await unlock(app);
      const pem = pemString();
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          githubAppId: '123456',
          githubAppInstallationId: '78901234',
          githubAppPrivateKey: pem,
        },
      });
      const res = await app.inject({ method: 'POST', url: '/github/app/validate' });
      expect(res.json()).toEqual({ ok: true, accountLogin: 'acme-org' });
      // The route decrypted + forwarded the stored creds to the validator. The
      // store trims the stored value, so compare on trimmed PEM (not the raw input
      // which may carry a trailing newline).
      expect(seen?.appId).toBe('123456');
      expect(seen?.installationId).toBe('78901234');
      expect(seen?.privateKey).toBe(pem.trim());
    } finally {
      await app.close();
    }
  });

  it('returns {ok:false} with a redacted error when the injected mint fails', async () => {
    const cipher = createSealableSecretCipher();
    const app = build(cipher, () =>
      Promise.resolve({ ok: false, error: 'GitHub rejected the App credentials' }),
    );
    try {
      await unlock(app);
      const pem = pemString();
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { githubAppId: '1', githubAppInstallationId: '2', githubAppPrivateKey: pem },
      });
      const res = await app.inject({ method: 'POST', url: '/github/app/validate' });
      const body = res.json<{ ok: boolean; error?: string }>();
      expect(body.ok).toBe(false);
      expect(body.error).toBe('GitHub rejected the App credentials');
      // The PEM must never surface in the response.
      expect(JSON.stringify(body)).not.toContain(pem);
    } finally {
      await app.close();
    }
  });

  it('reports "not configured" when no validator is wired', async () => {
    const cipher = createSealableSecretCipher();
    const app = build(cipher); // no githubAppValidate dep
    try {
      await unlock(app);
      const res = await app.inject({ method: 'POST', url: '/github/app/validate' });
      expect(res.json()).toEqual({ ok: false, error: 'not configured' });
    } finally {
      await app.close();
    }
  });
});

describe('validateGitHubAppCreds (production mint, faked transport)', () => {
  const creds = (): GitHubAppCreds => ({
    appId: '123456',
    installationId: '78901234',
    privateKey: pemString(),
  });

  it('succeeds and lifts only the safe account login — never the token', async () => {
    const c = creds();
    const TOKEN = 'ghs_fake_installation_token_value';
    const bodies: Array<string | undefined> = [];
    const fetch: HttpFetch = (_url, init) => {
      bodies.push(init?.body);
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ token: TOKEN, account: { login: 'acme-org' } }),
      } as HttpResponse);
    };
    const result = await validateGitHubAppCreds(c, { fetch });
    expect(result).toEqual({ ok: true, accountLogin: 'acme-org' });
    expect(bodies[0] === undefined ? undefined : JSON.parse(bodies[0])).toEqual({
      permissions: {
        contents: 'write',
        pull_requests: 'write',
        checks: 'read',
        actions: 'write',
        workflows: 'write',
        organization_projects: 'write',
        issues: 'write',
      },
    });
    // The minted token and the PEM must not leak into the result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(c.privateKey);
  });

  it('maps 401 to a fixed redacted message (no GitHub body echoed)', async () => {
    const c = creds();
    // A hostile body that echoes the JWT — the validator must ignore it entirely.
    const fetch: HttpFetch = () =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ message: 'jwt eyJhbGciOiJSUzI1NiJ9.LEAK.sig' }),
      } as HttpResponse);
    const result = await validateGitHubAppCreds(c, { fetch });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'GitHub rejected the App credentials (check the App ID and private key)',
    );
    expect(JSON.stringify(result)).not.toContain('LEAK');
    expect(JSON.stringify(result)).not.toContain(c.privateKey);
  });

  it('maps 404 to an installation-not-found message', async () => {
    const c = creds();
    const fetch: HttpFetch = () =>
      Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as HttpResponse);
    const result = await validateGitHubAppCreds(c, { fetch });
    expect(result).toEqual({
      ok: false,
      error: 'installation not found (check the Installation ID)',
    });
  });

  it('maps 422 to a missing-permissions upgrade message', async () => {
    const c = creds();
    const fetch: HttpFetch = () =>
      Promise.resolve({
        ok: false,
        status: 422,
        json: () => Promise.resolve({ message: 'permissions leak eyJhbGciOiJSUzI1NiJ9.LEAK.sig' }),
      } as HttpResponse);
    const result = await validateGitHubAppCreds(c, { fetch });
    expect(result).toEqual({
      ok: false,
      error:
        'GitHub App is missing required permissions (approve Contents, Pull requests, Checks, Actions, Workflows, Issues, and Organization projects)',
    });
    expect(JSON.stringify(result)).not.toContain('LEAK');
  });

  it('maps an unexpected status to a generic message (no body echoed)', async () => {
    const c = creds();
    const fetch: HttpFetch = () =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ message: 'boom eyJhbGciOiJSUzI1NiJ9.LEAK.sig' }),
      } as HttpResponse);
    const result = await validateGitHubAppCreds(c, { fetch });
    expect(result).toEqual({ ok: false, error: 'GitHub returned an unexpected status (500)' });
    expect(JSON.stringify(result)).not.toContain('LEAK');
  });

  it('reports a missing token when a 2xx response carries no token', async () => {
    const c = creds();
    const fetch: HttpFetch = () =>
      Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ token: '', account: { login: 'acme-org' } }),
      } as HttpResponse);
    const result = await validateGitHubAppCreds(c, { fetch });
    expect(result).toEqual({ ok: false, error: 'GitHub did not return a token' });
  });

  it('reports an unreachable-GitHub error on a transport failure', async () => {
    const c = creds();
    const fetch: HttpFetch = () => Promise.reject(new Error('boom'));
    const result = await validateGitHubAppCreds(c, { fetch });
    expect(result).toEqual({ ok: false, error: 'could not reach GitHub' });
  });

  it('reports invalid-private-key when the PEM cannot sign a JWT', async () => {
    const fetch: HttpFetch = () => {
      throw new Error('fetch should not be reached for a bad key');
    };
    const result = await validateGitHubAppCreds(
      { appId: '1', installationId: '2', privateKey: 'not-a-pem' },
      { fetch },
    );
    expect(result).toEqual({ ok: false, error: 'invalid private key' });
  });
});
