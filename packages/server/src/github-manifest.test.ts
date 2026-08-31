// GitHub App manifest one-click onboarding (#320, PR A — server endpoints).
// Two layers:
//   1. Pure helpers (buildManifest / state store / escapeHtml) — no server.
//   2. The three browser-facing routes driven via `app.inject`, with an injected
//      fake `manifestConvert` and a real cipher so the sealed gates are exercised.
// Invariants asserted throughout: the PEM / app id NEVER reach any HTML body;
// the CSRF `state` is single-use + TTL-bounded; interpolated values are escaped.
import type { Conductor } from '@verity/session';
import { InMemoryEventBus } from '@verity/session';
import { EventStore, createSealableSecretCipher, type SealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';
import { createAuthTokenRegistry } from './auth.js';
import {
  buildManifest,
  createManifestStateStore,
  defaultManifestConvert,
  escapeHtml,
  type ManifestConvert,
} from './github-manifest.js';
import type { HttpFetch, HttpResponse } from './github.js';

// ── Pure helpers ──────────────────────────────────────────────────────────

describe('buildManifest', () => {
  it('requests package read access needed for private GHCR artifacts', () => {
    expect(buildManifest('https://verity.example').default_permissions).toMatchObject({
      packages: 'read',
    });
  });

  it('disables the webhook (Verity is pull-based)', () => {
    const m = buildManifest('https://verity.example');
    expect(m.hook_attributes).toEqual({
      url: 'https://verity.example/github/webhook',
      active: false,
    });
    expect(m.default_events).toEqual([]);
  });

  it('derives redirect_url and setup_url from the base', () => {
    const m = buildManifest('https://verity.example');
    expect(m.redirect_url).toBe('https://verity.example/github/app/manifest/callback');
    expect(m.setup_url).toBe('https://verity.example/github/app/manifest/installed');
    expect(m.url).toBe('https://verity.example');
  });

  it('normalizes a trailing slash on the base', () => {
    const m = buildManifest('https://verity.example/');
    expect(m.redirect_url).toBe('https://verity.example/github/app/manifest/callback');
    expect(m.url).toBe('https://verity.example');
  });

  it('uses a random globally-unique-ish name instead of reserved plain Verity', () => {
    const first = buildManifest('http://dev-server:8090');
    const second = buildManifest('http://dev-server:8090/');
    const other = buildManifest('http://dev-server:8082');

    expect(first.name).toMatch(/^Verity-[a-z0-9]{8}$/);
    expect(second.name).toMatch(/^Verity-[a-z0-9]{8}$/);
    expect(other.name).toMatch(/^Verity-[a-z0-9]{8}$/);
    expect(new Set([first.name, second.name, other.name]).size).toBe(3);
  });

  it('requests least-privilege permissions and stays private', () => {
    const m = buildManifest('https://verity.example');
    expect(m.default_permissions).toEqual({
      contents: 'write',
      pull_requests: 'write',
      // Read-only CI visibility for the sandbox token: check-run status + Actions
      // workflow runs/jobs/logs (`gh run view/watch`). Scoped down per-token in embedded.ts.
      checks: 'read',
      actions: 'read',
      // Push .github/workflows/* files (GitHub blocks bot workflow-file pushes otherwise).
      workflows: 'write',
      // Create issues from task-board drafts / inbox items.
      issues: 'write',
      metadata: 'read',
      // Pull digest-pinned private runner/toolkit images during provisioning.
      packages: 'read',
      // Org Projects v2 read+write so the App can provision + manage the task board (ADR 0007).
      organization_projects: 'write',
    });
    expect(m.public).toBe(false);
    expect(m.setup_on_update).toBe(false);
    expect(m.name).toMatch(/^Verity-[a-z0-9]{8}$/);
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" y='z'>&`)).toBe(
      '&lt;a href=&quot;x&quot; y=&#39;z&#39;&gt;&amp;',
    );
  });
});

describe('manifest state store', () => {
  it('issues a token that consumes exactly once', () => {
    const store = createManifestStateStore();
    const token = store.issueState();
    expect(store.consumeState(token)).toBe(true);
    // Second consume of the same token → false (single-use).
    expect(store.consumeState(token)).toBe(false);
  });

  it('returns false for an unknown token', () => {
    const store = createManifestStateStore();
    expect(store.consumeState('never-issued')).toBe(false);
  });

  it('returns false once the TTL has elapsed (injected clock)', () => {
    let now = 1_000;
    const store = createManifestStateStore({ now: () => now, ttlMs: 10_000 });
    const token = store.issueState();
    now += 10_001; // just past the TTL
    expect(store.consumeState(token)).toBe(false);
  });

  it('accepts a token consumed just within the TTL', () => {
    let now = 1_000;
    const store = createManifestStateStore({ now: () => now, ttlMs: 10_000 });
    const token = store.issueState();
    now += 10_000; // exactly the TTL (not past it)
    expect(store.consumeState(token)).toBe(true);
  });

  it('purges expired states and caps abandoned live states', () => {
    let now = 1_000;
    const store = createManifestStateStore({ now: () => now, ttlMs: 100, maxStates: 2 });
    const expired = store.issueState();
    now += 101;
    const oldestLive = store.issueState();
    const newestLive = store.issueState();
    const replacement = store.issueState();
    expect(store.consumeState(expired)).toBe(false);
    expect(store.consumeState(oldestLive)).toBe(false);
    expect(store.consumeState(newestLive)).toBe(true);
    expect(store.consumeState(replacement)).toBe(true);
  });
});

describe('defaultManifestConvert (production conversion, faked transport)', () => {
  it('POSTs to the conversions endpoint and maps { id, slug, pem }', async () => {
    const pem = pemString();
    let seenUrl: string | undefined;
    let seenMethod: string | undefined;
    const fetch: HttpFetch = (url, init) => {
      seenUrl = url;
      seenMethod = init?.method;
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ id: 424242, slug: 'verity-abc', pem }),
      } as HttpResponse);
    };
    const convert = defaultManifestConvert({ fetch });
    const result = await convert('the-code');
    expect(seenMethod).toBe('POST');
    expect(seenUrl).toBe('https://api.github.com/app-manifests/the-code/conversions');
    // Numeric id is stringified; pem passes through as the private key.
    expect(result).toEqual({ appId: '424242', slug: 'verity-abc', privateKey: pem });
  });

  it('throws a redaction-safe message on a non-2xx (no body read)', async () => {
    const fetch: HttpFetch = () =>
      Promise.resolve({
        ok: false,
        status: 422,
        // A hostile body — must never be read or surfaced.
        json: () => Promise.reject(new Error('json() must not be called on error')),
      } as unknown as HttpResponse);
    const convert = defaultManifestConvert({ fetch });
    await expect(convert('c')).rejects.toThrow(
      'GitHub rejected the App manifest conversion (HTTP 422)',
    );
  });

  it('throws a redaction-safe message on a transport failure', async () => {
    const fetch: HttpFetch = () => Promise.reject(new Error('boom'));
    const convert = defaultManifestConvert({ fetch });
    await expect(convert('c')).rejects.toThrow(
      'could not reach GitHub to convert the App manifest',
    );
  });

  it('throws (without echoing the body) when the 2xx shape is unexpected', async () => {
    const pem = pemString();
    const fetch: HttpFetch = () =>
      Promise.resolve({
        ok: true,
        status: 201,
        // Missing slug — invalid shape. The pem present here must not leak.
        json: () => Promise.resolve({ id: 1, pem }),
      } as HttpResponse);
    const convert = defaultManifestConvert({ fetch });
    await expect(convert('c')).rejects.toThrow(
      'GitHub returned an unexpected App manifest conversion response',
    );
    // Prove the thrown message never carries the pem.
    await convert('c').catch((err: unknown) => {
      expect(String(err)).not.toContain(pem);
    });
  });
});

// ── Routes ────────────────────────────────────────────────────────────────

const conductor = {} as unknown as Conductor;

let ctx: TestDb;
const ORIGINAL_GITHUB_APP_ENV = {
  VERITY_GH_APP_ID: process.env.VERITY_GH_APP_ID,
  VERITY_GH_DEFAULT_INSTALLATION_ID: process.env.VERITY_GH_DEFAULT_INSTALLATION_ID,
};
function restoreEnv(name: keyof typeof ORIGINAL_GITHUB_APP_ENV): void {
  const value = ORIGINAL_GITHUB_APP_ENV[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  restoreEnv('VERITY_GH_APP_ID');
  restoreEnv('VERITY_GH_DEFAULT_INSTALLATION_ID');
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  delete process.env.VERITY_GH_APP_ID;
  delete process.env.VERITY_GH_DEFAULT_INSTALLATION_ID;
});

const PASSWORD = 'correct-horse-battery';

/** A real RSA PEM computed at runtime — never a hard-coded key literal, so
 *  gitleaks has nothing to trip on. Stands in for the App private key. */
function pemString(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
}

function build(
  cipher: SealableSecretCipher,
  opts: { manifestConvert?: ManifestConvert } = {},
): { app: FastifyInstance; store: EventStore } {
  const store = new EventStore(ctx.db, cipher);
  const app = buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    conductor,
    secretCipher: cipher,
    ...(opts.manifestConvert ? { manifestConvert: opts.manifestConvert } : {}),
  });
  return { app, store };
}

async function unlock(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/secret/init',
    payload: { password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}

describe('GET /github/app/manifest/start', () => {
  it('renders an auto-submitting form with the escaped manifest + state (personal)', async () => {
    const cipher = createSealableSecretCipher();
    const { app } = build(cipher);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/github/app/manifest/start?base=https://verity.example',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      const html = res.body;
      expect(html).toContain('action="https://github.com/settings/apps/new?state=');
      expect(html).toContain('document.forms[0].submit()');
      expect(html).toContain('name="manifest"');
      expect(html).toContain('Verity GitHub setup');
      expect(html).toContain('Continue to GitHub');
      // The manifest JSON is inside a single-quoted value='...' attribute; its
      // structural `"` characters are escaped to &quot; (no attribute breakout).
      expect(html).toContain('&quot;url&quot;');
      expect(html).toContain('&quot;hook_attributes&quot;');
      expect(html).toContain('&quot;redirect_url&quot;');
    } finally {
      await app.close();
    }
  });

  it('targets the org App-creation URL when owner is given', async () => {
    const cipher = createSealableSecretCipher();
    const { app } = build(cipher);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/github/app/manifest/start?base=https://verity.example&owner=acme',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(
        'action="https://github.com/organizations/acme/settings/apps/new?state=',
      );
    } finally {
      await app.close();
    }
  });

  it('rejects a missing base', async () => {
    const cipher = createSealableSecretCipher();
    const { app } = build(cipher);
    try {
      const res = await app.inject({ method: 'GET', url: '/github/app/manifest/start' });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('<form');
    } finally {
      await app.close();
    }
  });

  it('rejects a non-http(s) base', async () => {
    const cipher = createSealableSecretCipher();
    const { app } = build(cipher);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/github/app/manifest/start?base=' + encodeURIComponent('javascript:alert(1)'),
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('<form');
    } finally {
      await app.close();
    }
  });

  it('HTML-escapes a hostile owner so no attribute breakout occurs', async () => {
    const cipher = createSealableSecretCipher();
    const { app } = build(cipher);
    try {
      // A `"`/`<` bearing owner must appear only in escaped form.
      const owner = 'a"><script>x';
      const res = await app.inject({
        method: 'GET',
        url:
          '/github/app/manifest/start?base=https://verity.example&owner=' +
          encodeURIComponent(owner),
      });
      expect(res.statusCode).toBe(200);
      // The raw injection payload must not appear unescaped in the HTML.
      expect(res.body).not.toContain('"><script>x');
      expect(res.body).not.toContain('<script>x');
    } finally {
      await app.close();
    }
  });

  it('escapes the manifest JSON so its structural quotes cannot break out of the attr', async () => {
    const cipher = createSealableSecretCipher();
    const { app } = build(cipher);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/github/app/manifest/start?base=https://verity.example',
      });
      expect(res.statusCode).toBe(200);
      // The manifest sits inside a single-quoted value='...' attribute. Its many
      // structural double-quotes are escaped to &quot;, so a raw `"` from the JSON
      // never appears inside the attribute value (no attribute breakout). We scope
      // the check to the manifest input line to avoid the page's other `"` attrs.
      const inputLine = /<input[^>]*name="manifest"[^>]*>/.exec(res.body)?.[0] ?? '';
      expect(inputLine).toMatch(/value='\{&quot;name&quot;:&quot;Verity-[a-z0-9]{8}&quot;/);
      // No raw JSON quote survived inside the manifest value.
      expect(inputLine).not.toContain('{"name"');
    } finally {
      await app.close();
    }
  });
});

describe('GET /github/app/manifest/callback', () => {
  async function issueState(
    app: FastifyInstance,
    base = 'https://verity.example',
  ): Promise<string> {
    const res = await app.inject({
      method: 'GET',
      url: '/github/app/manifest/start?base=' + encodeURIComponent(base),
    });
    const match = /state=([A-Za-z0-9_-]+)/.exec(res.body);
    if (match === null) throw new Error('no state issued');
    return match[1] as string;
  }

  it('stores app id + PEM and 302-redirects to the install URL; no secret in the response', async () => {
    const cipher = createSealableSecretCipher();
    const pem = pemString();
    let seenCode: string | undefined;
    const convert: ManifestConvert = (code) => {
      seenCode = code;
      return Promise.resolve({ appId: '424242', slug: 'verity-abc', privateKey: pem });
    };
    const { app, store } = build(cipher, { manifestConvert: convert });
    try {
      await unlock(app);
      const state = await issueState(app);
      const res = await app.inject({
        method: 'GET',
        url: `/github/app/manifest/callback?code=the-code&state=${state}`,
      });
      expect(res.statusCode).toBe(302);
      // Redirect to the public install URL, carrying a FRESH single-use state that
      // gates the `installed` callback (no secret in the URL).
      expect(res.headers.location).toMatch(
        /^https:\/\/github\.com\/apps\/verity-abc\/installations\/new\?state=[A-Za-z0-9_-]+$/,
      );
      expect(seenCode).toBe('the-code');
      // The PEM and app id must NEVER appear in the response (body or headers).
      const serialized = res.body + JSON.stringify(res.headers);
      expect(serialized).not.toContain(pem);
      expect(serialized).not.toContain('424242');
      // But they WERE persisted (read back via the decrypting store).
      const settings = await store.getVeritySettings();
      expect(settings?.githubAppId).toBe('424242');
      expect(settings?.githubAppPrivateKey).toBe(pem.trim());
      // Installation id not set yet — that's the second round-trip.
      expect(settings?.githubAppInstallationId).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid state with no store write and no convert call', async () => {
    const cipher = createSealableSecretCipher();
    let called = false;
    const convert: ManifestConvert = () => {
      called = true;
      return Promise.resolve({ appId: '1', slug: 's', privateKey: pemString() });
    };
    const { app, store } = build(cipher, { manifestConvert: convert });
    try {
      await unlock(app);
      const res = await app.inject({
        method: 'GET',
        url: '/github/app/manifest/callback?code=c&state=bogus',
      });
      expect(res.statusCode).toBe(400);
      expect(called).toBe(false);
      const settings = await store.getVeritySettings();
      expect(settings?.githubAppId ?? null).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('rejects a reused state (single-use) — second callback does nothing', async () => {
    const cipher = createSealableSecretCipher();
    let calls = 0;
    const convert: ManifestConvert = () => {
      calls += 1;
      return Promise.resolve({ appId: '7', slug: 's', privateKey: pemString() });
    };
    const { app } = build(cipher, { manifestConvert: convert });
    try {
      await unlock(app);
      const state = await issueState(app);
      const first = await app.inject({
        method: 'GET',
        url: `/github/app/manifest/callback?code=c&state=${state}`,
      });
      expect(first.statusCode).toBe(302);
      const second = await app.inject({
        method: 'GET',
        url: `/github/app/manifest/callback?code=c&state=${state}`,
      });
      expect(second.statusCode).toBe(400);
      expect(calls).toBe(1); // convert ran only for the first, valid callback
    } finally {
      await app.close();
    }
  });

  it('renders a locked page and does NOT convert while sealed', async () => {
    const cipher = createSealableSecretCipher();
    let called = false;
    const convert: ManifestConvert = () => {
      called = true;
      return Promise.resolve({ appId: '1', slug: 's', privateKey: pemString() });
    };
    const { app } = build(cipher, { manifestConvert: convert });
    try {
      // Issue a state while unlocked, then re-create a sealed app to test the
      // sealed gate. Simpler: never unlock — but state issuance doesn't need the
      // cipher, so issue directly against the sealed app.
      const state = await issueState(app); // start route needs no cipher
      const res = await app.inject({
        method: 'GET',
        url: `/github/app/manifest/callback?code=c&state=${state}`,
      });
      expect(res.statusCode).toBe(503);
      expect(res.body.toLowerCase()).toContain('unlock');
      expect(called).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('renders an error page when no convert seam is wired', async () => {
    const cipher = createSealableSecretCipher();
    const { app } = build(cipher); // no manifestConvert
    try {
      await unlock(app);
      const state = await issueState(app);
      const res = await app.inject({
        method: 'GET',
        url: `/github/app/manifest/callback?code=c&state=${state}`,
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).toContain('not configured');
    } finally {
      await app.close();
    }
  });
});

describe('GET /github/app/manifest/installed', () => {
  // The install `state` is minted at the END of a successful callback and echoed
  // by GitHub on the post-install redirect. Mint one here via a full start→callback
  // so the `installed` CSRF gate has a valid, single-use token to consume.
  async function mintInstallState(app: FastifyInstance): Promise<string> {
    const startRes = await app.inject({
      method: 'GET',
      url: '/github/app/manifest/start?base=' + encodeURIComponent('https://verity.example'),
    });
    const s1 = /state=([A-Za-z0-9_-]+)/.exec(startRes.body);
    if (s1 === null) throw new Error('no start state');
    const cb = await app.inject({
      method: 'GET',
      url: `/github/app/manifest/callback?code=c&state=${s1[1]}`,
    });
    const s2 = /[?&]state=([A-Za-z0-9_-]+)/.exec(String(cb.headers.location));
    if (s2 === null) throw new Error('no install state in redirect');
    return s2[1] as string;
  }

  const convert: ManifestConvert = () =>
    Promise.resolve({ appId: '1', slug: 'verity-abc', privateKey: pemString() });

  it('stores the installation id (with a valid state) and renders a return-to-Verity page', async () => {
    const cipher = createSealableSecretCipher();
    const { app, store } = build(cipher, { manifestConvert: convert });
    try {
      await unlock(app);
      const state = await mintInstallState(app);
      const res = await app.inject({
        method: 'GET',
        url: `/github/app/manifest/installed?installation_id=99887766&setup_action=install&state=${state}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('installed');
      expect(res.body).toContain('GitHub connected');
      expect(res.body).toContain('Return to Verity');
      const settings = await store.getVeritySettings();
      expect(settings?.githubAppInstallationId).toBe('99887766');
    } finally {
      await app.close();
    }
  });

  it('rejects a forged installed (no/invalid state) with NO store write', async () => {
    const cipher = createSealableSecretCipher();
    const { app, store } = build(cipher, { manifestConvert: convert });
    try {
      await unlock(app);
      // An attacker-supplied installation id without a valid state must not persist.
      const res = await app.inject({
        method: 'GET',
        url: '/github/app/manifest/installed?installation_id=666&state=forged',
      });
      expect(res.statusCode).toBe(400);
      const settings = await store.getVeritySettings();
      expect(settings?.githubAppInstallationId ?? null).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('rejects a missing installation_id even with a valid state', async () => {
    const cipher = createSealableSecretCipher();
    const { app } = build(cipher, { manifestConvert: convert });
    try {
      await unlock(app);
      const state = await mintInstallState(app);
      const res = await app.inject({
        method: 'GET',
        url: `/github/app/manifest/installed?state=${state}`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('renders a locked page while sealed and does not store', async () => {
    const cipher = createSealableSecretCipher();
    const { app, store } = build(cipher);
    try {
      // Sealed (no unlock) → locked page, no write. Sealed is checked before the
      // state gate, so no valid state is needed to exercise it.
      const res = await app.inject({
        method: 'GET',
        url: '/github/app/manifest/installed?installation_id=55',
      });
      expect(res.statusCode).toBe(503);
      expect(res.body.toLowerCase()).toContain('unlock');
      await unlock(app);
      const settings = await store.getVeritySettings();
      expect(settings?.githubAppInstallationId ?? null).toBeNull();
    } finally {
      await app.close();
    }
  });
});

// ── Onboarding hardening (audit C1 follow-up, "Strang 2") ────────────────────

/** Build a server whose API auth gate is ARMED, plus a minted device token. */
async function buildGated(
  cipher: SealableSecretCipher,
  opts: { manifestConvert?: ManifestConvert } = {},
): Promise<{ app: FastifyInstance; store: EventStore; token: string }> {
  const store = new EventStore(ctx.db, cipher);
  const registry = await createAuthTokenRegistry(store, { enabled: true });
  const { token } = await registry.mint('test-device');
  const app = buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    conductor,
    secretCipher: cipher,
    authRegistry: registry,
    ...(opts.manifestConvert ? { manifestConvert: opts.manifestConvert } : {}),
  });
  return { app, store, token };
}

describe('manifest /start one-time-token auth (gate armed)', () => {
  it('rejects start without a prepared token, accepts it once with one', async () => {
    const cipher = createSealableSecretCipher();
    const { app, token } = await buildGated(cipher);
    try {
      // No token → 403 (the gate is armed, so start now demands a prepared token).
      const noOtt = await app.inject({
        method: 'GET',
        url: '/github/app/manifest/start?base=https://verity.example',
      });
      expect(noOtt.statusCode).toBe(403);

      // /prepare is authenticated (not in the pre-auth allowlist): 401 without a bearer.
      const unauth = await app.inject({ method: 'POST', url: '/github/app/manifest/prepare' });
      expect(unauth.statusCode).toBe(401);

      // With the device token → a single-use start token.
      const prep = await app.inject({
        method: 'POST',
        url: '/github/app/manifest/prepare',
        headers: { authorization: `Bearer ${token}` },
        payload: { baseUrl: 'https://verity.example' },
      });
      expect(prep.statusCode).toBe(200);
      const startToken = prep.json().startToken as string;
      expect(startToken.length).toBeGreaterThan(0);

      // start with the token → 200 (renders the auto-submit form).
      const ok = await app.inject({
        method: 'GET',
        url: `/github/app/manifest/start?base=https://attacker.example&ott=${startToken}`,
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toContain('document.forms[0].submit()');
      expect(ok.body).toContain('https://verity.example/github/app/manifest/callback');

      // The token is single-use → a replay is refused.
      const reused = await app.inject({
        method: 'GET',
        url: `/github/app/manifest/start?base=https://verity.example&ott=${startToken}`,
      });
      expect(reused.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe('manifest refuse-overwrite lock', () => {
  const convert: ManifestConvert = () =>
    Promise.resolve({ appId: 'attacker-app', slug: 'verity-evil', privateKey: pemString() });

  async function connectApp(store: EventStore): Promise<void> {
    await store.updateVeritySettings({
      githubAppId: '99',
      githubAppInstallationId: '5',
      githubAppPrivateKey: pemString(),
    });
  }

  it('callback refuses to overwrite an already-connected App', async () => {
    const cipher = createSealableSecretCipher();
    const { app, store } = build(cipher, { manifestConvert: convert });
    try {
      await unlock(app);
      await connectApp(store);
      const startRes = await app.inject({
        method: 'GET',
        url: '/github/app/manifest/start?base=https://verity.example',
      });
      const state = /state=([A-Za-z0-9_-]+)/.exec(startRes.body)?.[1] ?? '';
      const cb = await app.inject({
        method: 'GET',
        url: `/github/app/manifest/callback?code=the-code&state=${state}`,
      });
      expect(cb.statusCode).toBe(409);
      expect(cb.body).toContain('GitHub connected');
      // The stored (legitimate) app id is untouched — no overwrite happened.
      expect((await store.getVeritySettings())?.githubAppId).toBe('99');
    } finally {
      await app.close();
    }
  });

  it('installed refuses to overwrite an already-connected App', async () => {
    const cipher = createSealableSecretCipher();
    const { app, store } = build(cipher);
    try {
      await unlock(app);
      await connectApp(store);
      // Mint a valid install state via a start round-trip, then try to reuse the
      // flow to change the installation id — refused because already connected.
      const startRes = await app.inject({
        method: 'GET',
        url: '/github/app/manifest/start?base=https://verity.example',
      });
      const state = /state=([A-Za-z0-9_-]+)/.exec(startRes.body)?.[1] ?? '';
      const res = await app.inject({
        method: 'GET',
        url: `/github/app/manifest/installed?installation_id=777&state=${state}`,
      });
      expect(res.statusCode).toBe(409);
      expect((await store.getVeritySettings())?.githubAppInstallationId).toBe('5');
    } finally {
      await app.close();
    }
  });

  it('permits the legitimate two-phase first-run flow through the lock', async () => {
    // Guards against a future regression that tightens isGithubAppConfigured to a
    // 2-of-3 check: after callback stores app id + PEM (2 fields), `installed`
    // must still proceed to write the installation id — the lock only refuses a
    // fully-configured (3-of-3) re-onboarding.
    const cipher = createSealableSecretCipher();
    const okConvert: ManifestConvert = () =>
      Promise.resolve({ appId: '123', slug: 'verity-ok', privateKey: pemString() });
    const { app } = build(cipher, { manifestConvert: okConvert });
    try {
      const token = await unlock(app);
      const startRes = await app.inject({
        method: 'GET',
        url: '/github/app/manifest/start?base=https://verity.example',
      });
      const state1 = /state=([A-Za-z0-9_-]+)/.exec(startRes.body)?.[1] ?? '';
      // Phase 1: callback stores app id + PEM (2 of 3) and redirects to install.
      const cb = await app.inject({
        method: 'GET',
        url: `/github/app/manifest/callback?code=the-code&state=${state1}`,
      });
      expect(cb.statusCode).toBe(302);
      const state2 = /state=([A-Za-z0-9_-]+)/.exec(String(cb.headers.location))?.[1] ?? '';
      // Phase 2: installed writes the installation id (3rd field) — NOT blocked.
      const inst = await app.inject({
        method: 'GET',
        url: `/github/app/manifest/installed?installation_id=456&state=${state2}`,
      });
      expect(inst.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/onboarding/status',
            headers: { authorization: `Bearer ${token}` },
          })
        ).json().githubAppConfigured,
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('POST /settings/github/disconnect', () => {
  it('clears the creds and reopens onboarding', async () => {
    const cipher = createSealableSecretCipher();
    const { app, store } = build(cipher);
    try {
      const token = await unlock(app);
      await store.updateVeritySettings({
        githubAppId: '99',
        githubAppInstallationId: '5',
        githubAppPrivateKey: pemString(),
      });
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/onboarding/status',
            headers: { authorization: `Bearer ${token}` },
          })
        ).json().githubAppConfigured,
      ).toBe(true);

      const dis = await app.inject({ method: 'POST', url: '/settings/github/disconnect' });
      expect(dis.statusCode).toBe(200);
      expect(dis.json()).toEqual({ disconnected: true });

      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/onboarding/status',
            headers: { authorization: `Bearer ${token}` },
          })
        ).json().githubAppConfigured,
      ).toBe(false);
      const settings = await store.getVeritySettings();
      expect(settings?.githubAppId ?? null).toBeNull();
      expect(settings?.githubAppPrivateKey ?? null).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('returns 503 while sealed', async () => {
    const cipher = createSealableSecretCipher();
    const { app } = build(cipher);
    try {
      const dis = await app.inject({ method: 'POST', url: '/settings/github/disconnect' });
      expect(dis.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});
