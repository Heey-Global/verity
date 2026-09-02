import type { Conductor } from '@verity/session';
import { generateKeyPairSync } from 'node:crypto';
import { InMemoryEventBus } from '@verity/session';
import { EventStore, WorkflowStore, createSealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearerToken,
  createAuthTokenRegistry,
  hashAuthToken,
  wsOriginAllowed,
  type AuthTokenStore,
} from './auth.js';
import { createGhTokenCapabilityRegistry } from './github-token-broker.js';
import { createDevicePairingManager } from './device-pairing.js';
import { buildServer } from './server.js';

const conductor = {} as unknown as Conductor;
const PASSWORD = 'correct-horse-battery';

/** An in-memory {@link AuthTokenStore} so the registry unit tests need no DB. */
function fakeStore(): AuthTokenStore & {
  rows: { id: string; tokenHash: string; label: string | null; createdAt: number }[];
} {
  const rows: { id: string; tokenHash: string; label: string | null; createdAt: number }[] = [];
  return {
    rows,
    listAuthTokens: () => Promise.resolve([...rows]),
    insertAuthToken: (r): Promise<void> => {
      rows.push({ id: r.id, tokenHash: r.tokenHash, label: r.label ?? null, createdAt: 1 });
      return Promise.resolve();
    },
    deleteAuthToken: (id): Promise<boolean> => {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return Promise.resolve(false);
      rows.splice(index, 1);
      return Promise.resolve(true);
    },
  };
}

describe('bearerToken parsing', () => {
  it('extracts the token from a Bearer header (case-insensitive), else undefined', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer   xyz')).toBe('xyz');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken('Bearer')).toBeUndefined();
  });
});

describe('paired device management', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await createTestDb();
  });
  afterAll(async () => ctx.close());
  beforeEach(async () => truncateAll(ctx.db));

  it('lets an authenticated device invite, list, and revoke another device', async () => {
    const store = new EventStore(ctx.db);
    const registry = await createAuthTokenRegistry(store, { enabled: true });
    const current = await registry.mint('iPad');
    const { privateKey } = generateKeyPairSync('ed25519');
    const pairing = createDevicePairingManager({
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      pairingCode: 'abcdefghijklmnopqrstuvwxyz_0123456789',
      expiresAt: '2099-01-01T00:00:00.000Z',
      loadConsumedCodeHash: () => [],
      storeConsumedCodeHash: () => true,
    });
    const app = buildServer({
      eventStore: store,
      bus: new InMemoryEventBus(),
      conductor,
      authRegistry: registry,
      devicePairing: pairing,
    });
    try {
      const authorization = `Bearer ${current.token}`;
      const invitation = await app.inject({
        method: 'POST',
        url: '/devices/pairing-invitations',
        headers: { authorization },
      });
      expect(invitation.statusCode).toBe(200);
      const enrollment = await app.inject({
        method: 'POST',
        url: '/pair/enroll',
        payload: { code: invitation.json().code, deviceLabel: 'Mac' },
      });
      expect(enrollment.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/pair/enroll',
            payload: { code: invitation.json().code },
          })
        ).statusCode,
      ).toBe(401);

      const listed = await app.inject({
        method: 'GET',
        url: '/devices',
        headers: { authorization },
      });
      expect(listed.json().devices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'iPad', isCurrent: true }),
          expect.objectContaining({ label: 'Mac', isCurrent: false }),
        ]),
      );
      const secondId = enrollment.json().tokenId as string;
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/devices/${secondId}`,
            headers: { authorization },
          })
        ).statusCode,
      ).toBe(204);
      expect(registry.verify(enrollment.json().token as string)).toBe(false);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/devices/${current.id}`,
            headers: { authorization },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
});

describe('wsOriginAllowed (anti-CSWSH)', () => {
  it('allows everything when no allowlist is configured', () => {
    expect(wsOriginAllowed(undefined, 'https://evil.example')).toBe(true);
    expect(wsOriginAllowed([], 'https://evil.example')).toBe(true);
  });

  it('enforces a present Origin against a non-empty allowlist', () => {
    const allow = ['https://verity.example.com'];
    expect(wsOriginAllowed(allow, 'https://verity.example.com')).toBe(true);
    expect(wsOriginAllowed(allow, 'https://evil.example')).toBe(false);
  });

  it('lets a missing Origin (native clients) through even with an allowlist', () => {
    expect(wsOriginAllowed(['https://verity.example.com'], undefined)).toBe(true);
  });
});

describe('auth token registry', () => {
  it('mints a token whose raw value verifies, and rejects anything else', async () => {
    const registry = await createAuthTokenRegistry(fakeStore(), { enabled: false });
    const { token, id } = await registry.mint('iPhone');
    expect(typeof token).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(registry.verify(token)).toBe(true);
    expect(registry.resolveId(token)).toBe(id);
    expect(registry.verify('not-a-token')).toBe(false);
    expect(registry.verify(undefined)).toBe(false);
    expect(registry.verify('')).toBe(false);
    expect(registry.verify(null)).toBe(false);
  });

  it('is disabled until enabled (env-key/headless mode gates nothing)', async () => {
    const registry = await createAuthTokenRegistry(fakeStore(), { enabled: false });
    expect(registry.isEnabled()).toBe(false);
    registry.enable();
    expect(registry.isEnabled()).toBe(true);
  });

  it('persists across restart: a fresh registry over the same store still verifies', async () => {
    const store = fakeStore();
    const first = await createAuthTokenRegistry(store, { enabled: true });
    const { token, id } = await first.mint(null);
    // "Restart": a brand-new registry seeded from the same durable rows.
    const second = await createAuthTokenRegistry(store, { enabled: true });
    expect(second.verify(token)).toBe(true);
    expect(second.resolveId(token)).toBe(id);
  });

  it('forget() drops one hash and clear() drops all from the in-memory set', async () => {
    const registry = await createAuthTokenRegistry(fakeStore(), { enabled: true });
    const a = await registry.mint(null);
    const b = await registry.mint(null);
    registry.forget(hashAuthToken(a.token));
    expect(registry.verify(a.token)).toBe(false);
    expect(registry.verify(b.token)).toBe(true);
    registry.clear();
    expect(registry.verify(b.token)).toBe(false);
  });

  it('lists safe device metadata and revokes the selected token', async () => {
    const registry = await createAuthTokenRegistry(fakeStore(), { enabled: true });
    const first = await registry.mint('iPad');
    const second = await registry.mint('Mac');
    expect(await registry.list()).toEqual([
      { id: first.id, label: 'iPad', createdAt: 1 },
      { id: second.id, label: 'Mac', createdAt: 1 },
    ]);
    expect(await registry.revoke(first.id)).toBe(true);
    expect(registry.verify(first.token)).toBe(false);
    expect(registry.verify(second.token)).toBe(true);
    expect(await registry.revoke(first.id)).toBe(false);
  });
});

describe('global auth gate (onRequest)', () => {
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

  it('is off until a master password is set, then protects every non-allowlisted route', async () => {
    const cipher = createSealableSecretCipher();
    const store = new EventStore(ctx.db, cipher);
    const registry = await createAuthTokenRegistry(store, { enabled: false });
    const app = buildServer({
      eventStore: store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: cipher,
      authRegistry: registry,
    });
    try {
      // Gate disabled → a protected route is reachable with no token.
      expect((await app.inject({ method: 'GET', url: '/settings' })).statusCode).not.toBe(401);
      // Device administration is stricter than the bootstrap gate: no paired
      // bearer exists yet, so it must remain closed before first initialization.
      expect((await app.inject({ method: 'GET', url: '/devices' })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'POST', url: '/devices/pairing-invitations' })).statusCode,
      ).toBe(401);

      // Init sets the password, mints this device's token, and arms the gate.
      const init = await app.inject({
        method: 'POST',
        url: '/secret/init',
        payload: { password: PASSWORD, deviceLabel: 'iPhone' },
      });
      expect(init.statusCode).toBe(200);
      const token = init.json().token as string;
      expect(typeof token).toBe('string');
      expect(init.json().tokenId.length).toBeGreaterThan(0);

      // Now the gate enforces: no token → 401. Assert the BODY too, not just the
      // status: a bare `return {error}` from the async onRequest hook is DISCARDED
      // by Fastify — the route handler would still run and leak its payload (e.g.
      // the settings object) under a 401 status. The gate must reply.send() to
      // truly short-circuit, so the body here is exactly the gate's error.
      const blocked = await app.inject({ method: 'GET', url: '/settings' });
      expect(blocked.statusCode).toBe(401);
      expect(blocked.json()).toEqual({ error: 'unauthorized' });
      // Wrong token → 401.
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/settings',
            headers: { authorization: 'Bearer nope' },
          })
        ).statusCode,
      ).toBe(401);

      // A spoofed `Upgrade: websocket` header on a NON-WS route must NOT bypass the
      // gate. The WS carve-out (reply.send can't abort a real handshake) is scoped
      // to the actual /sessions/:id/stream path, so /settings still 401s with the
      // gate's body — the handler never runs.
      const spoof = await app.inject({
        method: 'GET',
        url: '/settings',
        headers: { upgrade: 'websocket', connection: 'upgrade' },
      });
      expect(spoof.statusCode).toBe(401);
      expect(spoof.json()).toEqual({ error: 'unauthorized' });

      // Pre-auth allowlist stays reachable without a token.
      for (const url of ['/healthz', '/secret/status', '/onboarding/status']) {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
      }
      // …and the exemption is scoped to the METHOD that was declared, not to the
      // pathname. The declarations are keyed by method, but that only reaches the
      // request if the gate looks itself up by method too — so assert it here,
      // where a regression to a pathname-keyed set shows up as the router's 404
      // instead of the gate's 401 (the root hooks run on the not-found path too).
      const siblingMethod = await app.inject({ method: 'POST', url: '/secret/status' });
      expect(siblingMethod.statusCode).toBe(401);
      expect(siblingMethod.json()).toEqual({ error: 'unauthorized' });
      // A HEAD request inherits its GET's declaration (Fastify auto-adds the
      // route, sharing the handler), so it must not start needing a token.
      expect((await app.inject({ method: 'HEAD', url: '/healthz' })).statusCode).toBe(200);
      // OPTIONS is the one method the old pathname-keyed set exempted and this
      // one does not. Pinned rather than fixed: nothing here answers OPTIONS, so
      // a browser preflight got a 404 from the router before and gets a 401 from
      // the gate now — no on-ramp is lost. It would be lost the moment a CORS
      // plugin arrives, which `route-scopes.test.ts` refuses for this reason.
      expect((await app.inject({ method: 'OPTIONS', url: '/secret/unlock' })).statusCode).toBe(401);

      // Valid token in the Authorization header → allowed.
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/settings',
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(200);

      // Query credentials are reserved for the actual WebSocket stream handshake;
      // accepting them on HTTP routes would leak bearer tokens through URLs.
      expect(
        (await app.inject({ method: 'GET', url: `/settings?access_token=${token}` })).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  // Deriving the exemption set from route registrations widened it for the four
  // routes that register unconditionally and refuse themselves in the handler:
  // the old static list made their exemption conditional on the same deps the
  // handler checks. That is only harmless if each handler's FIRST statement,
  // ahead of any use of the body or of store state, is to refuse. What that does
  // not buy back is Fastify's own body parsing, which runs before any handler:
  // on a half-configured deployment those POSTs now parse an unauthenticated
  // body (bounded by `bodyLimit`) before answering 404, where the gate used to
  // 401 them in `onRequest`. Cost, not exposure — nothing reads the parsed body,
  // and on the webhook the digest-capturing `preParsing` hook is conditional on
  // the very deps these shapes are missing, so it does not run either.
  // Two of those conditions are
  // conjunctions — the webhook wants a store AND an HMAC secret, the workflow
  // result wants a store AND capabilities — so a half-configured deployment is
  // the interesting case, not the empty one: if a handler checked only one
  // conjunct, the other half-configuration would now reach the handler body
  // unauthenticated where it used to get a 401. Hence a case per combination.
  const halfConfigurations = [
    { label: 'no workflow deps at all', workflowStore: false, secret: false, capabilities: false },
    {
      label: 'webhook secret but no store',
      workflowStore: false,
      secret: true,
      capabilities: false,
    },
    {
      label: 'store but neither webhook secret nor capabilities',
      workflowStore: true,
      secret: false,
      capabilities: false,
    },
    { label: 'capabilities but no store', workflowStore: false, secret: false, capabilities: true },
  ] as const;

  for (const shape of halfConfigurations) {
    it(`exposes nothing new on the newly unconditional exemptions — ${shape.label}`, async () => {
      const cipher = createSealableSecretCipher();
      const store = new EventStore(ctx.db, cipher);
      const registry = await createAuthTokenRegistry(store, { enabled: false });
      const app = buildServer({
        eventStore: store,
        bus: new InMemoryEventBus(),
        conductor,
        secretCipher: cipher,
        authRegistry: registry,
        // `devicePairing` is absent throughout: the pairing routes have a single
        // condition, so the empty case is the whole of their surface.
        ...(shape.workflowStore ? { workflowStore: new WorkflowStore(ctx.db) } : {}),
        ...(shape.secret ? { workflowGithubWebhookSecret: 'not-a-real-secret' } : {}),
        ...(shape.capabilities
          ? { ghTokenCapabilities: createGhTokenCapabilityRegistry(ctx.db) }
          : {}),
      });
      try {
        const init = await app.inject({
          method: 'POST',
          url: '/secret/init',
          payload: { password: PASSWORD, deviceLabel: 'iPhone' },
        });
        expect(init.statusCode).toBe(200);
        // The gate is armed now, and an ordinary route proves it.
        expect((await app.inject({ method: 'GET', url: '/settings' })).statusCode).toBe(401);

        for (const [method, url] of [
          ['GET', '/pair/identity'],
          ['POST', '/pair/redeem'],
          ['POST', '/providers/github/webhook'],
          ['POST', '/internal/workflow/result'],
        ] as const) {
          // 404, not 200 and not a parse error: the handler refuses before it
          // reads anything the caller sent. An unauthenticated caller saw 401
          // here before this change and sees 404 now, which is the whole of the
          // difference.
          const response = await app.inject({ method, url, payload: {} });
          expect(response.statusCode, `${method} ${url}`).toBe(404);
          expect(response.json(), `${method} ${url}`).toEqual({ error: 'not found' });
        }

        // The other half of deriving exemptions from registration: for the
        // conditionally-registered `/internal/*` routes an exemption exists only
        // where the route does. None of their deps are wired in any shape here —
        // including `capabilities but no store`, which wires the GitHub-token
        // capability registry WITHOUT the mint that registration also requires —
        // so the gate must still demand the operator token. This is what pins
        // the claim that each registration condition matches the exemption
        // condition the old static list spelled out: a registration that drifted
        // looser would answer 404 (route absent, but exempt) instead of 401.
        for (const [method, url] of [
          ['POST', '/internal/git/sign'],
          ['POST', '/internal/github/token'],
          ['POST', '/internal/project/memory'],
          ['POST', '/internal/mcp'],
          ['GET', '/internal/mcp'],
          ['POST', '/internal/control-plane/mcp'],
          ['GET', '/internal/control-plane/mcp'],
        ] as const) {
          const response = await app.inject({
            method,
            url,
            ...(method === 'POST' ? { payload: {} } : {}),
          });
          expect(response.statusCode, `${method} ${url}`).toBe(401);
        }
      } finally {
        await app.close();
      }
    });
  }

  it('rate-limits /secret/unlock after repeated wrong passwords from one IP', async () => {
    const cipher = createSealableSecretCipher();
    const store = new EventStore(ctx.db, cipher);
    const registry = await createAuthTokenRegistry(store, { enabled: false });
    const app = buildServer({
      eventStore: store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: cipher,
      authRegistry: registry,
    });
    try {
      await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
      cipher.seal(); // back to sealed so unlock is exercised

      // The default per-IP threshold is 5: five wrong attempts each 401, the
      // sixth is locked out with 429 + Retry-After (inject shares one client IP).
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/secret/unlock',
          payload: { password: 'definitely-wrong' },
        });
        expect(res.statusCode).toBe(401);
      }
      const locked = await app.inject({
        method: 'POST',
        url: '/secret/unlock',
        payload: { password: 'definitely-wrong' },
      });
      expect(locked.statusCode).toBe(429);
      expect(locked.headers['retry-after']).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('keeps managed-gateway unlock throttles separate per authenticated client', async () => {
    const cipher = createSealableSecretCipher();
    const store = new EventStore(ctx.db, cipher);
    const app = buildServer({
      eventStore: store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: cipher,
      unlockClientIdentity: (request) =>
        typeof request.headers['x-test-verified-client'] === 'string'
          ? request.headers['x-test-verified-client']
          : undefined,
    });
    try {
      await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
      cipher.seal();
      for (let i = 0; i < 5; i++) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/secret/unlock',
              headers: { 'x-test-verified-client': 'device-a' },
              payload: { password: 'definitely-wrong' },
            })
          ).statusCode,
        ).toBe(401);
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/secret/unlock',
            headers: { 'x-test-verified-client': 'device-a' },
            payload: { password: 'definitely-wrong' },
          })
        ).statusCode,
      ).toBe(429);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/secret/unlock',
            headers: { 'x-test-verified-client': 'device-b' },
            payload: { password: 'definitely-wrong' },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects a too-weak master password at init (strength gate)', async () => {
    const cipher = createSealableSecretCipher();
    const store = new EventStore(ctx.db, cipher);
    const app = buildServer({
      eventStore: store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: cipher,
      authRegistry: await createAuthTokenRegistry(store, { enabled: false }),
    });
    try {
      // Under 12 chars → 400.
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/secret/init',
            payload: { password: 'short-pw' },
          })
        ).statusCode,
      ).toBe(400);
      // 12+ chars but only one distinct character → 400 (entropy floor).
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/secret/init',
            payload: { password: 'aaaaaaaaaaaaaa' },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('unlock after a restart re-issues a working device token', async () => {
    const cipher1 = createSealableSecretCipher();
    const store1 = new EventStore(ctx.db, cipher1);
    const reg1 = await createAuthTokenRegistry(store1, { enabled: false });
    const app1 = buildServer({
      eventStore: store1,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: cipher1,
      authRegistry: reg1,
    });
    await app1.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
    await app1.close();

    // "Restart": fresh sealed cipher + registry seeded from the same DB. The gate
    // is armed because a master password already exists.
    const cipher2 = createSealableSecretCipher();
    const store2 = new EventStore(ctx.db, cipher2);
    const reg2 = await createAuthTokenRegistry(store2, { enabled: true });
    const app2 = buildServer({
      eventStore: store2,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: cipher2,
      authRegistry: reg2,
    });
    try {
      // Old device tokens survive the restart (loaded from the durable table).
      // A new device unlocks with the password and gets its own token.
      const unlock = await app2.inject({
        method: 'POST',
        url: '/secret/unlock',
        payload: { password: PASSWORD, deviceLabel: 'iPad' },
      });
      expect(unlock.statusCode).toBe(200);
      const token = unlock.json().token as string;
      expect(
        (
          await app2.inject({
            method: 'GET',
            url: '/settings',
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app2.close();
    }
  });

  it('rejects an oversized body on the pre-auth /secret/init route with 413 (M7)', async () => {
    const cipher = createSealableSecretCipher();
    const store = new EventStore(ctx.db, cipher);
    const registry = await createAuthTokenRegistry(store, { enabled: false });
    const app = buildServer({
      eventStore: store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: cipher,
      authRegistry: registry,
    });
    try {
      // ~8 KiB payload — over the 4 KiB per-route limit, well under the ~71 MiB
      // global one. Must be refused at the body-parse layer, not buffered whole.
      const huge = { password: PASSWORD, deviceLabel: 'x'.repeat(8192) };
      const res = await app.inject({ method: 'POST', url: '/secret/init', payload: huge });
      expect(res.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });
});
