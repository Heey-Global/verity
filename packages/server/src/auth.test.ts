import type { Conductor } from '@verity/session';
import { InMemoryEventBus } from '@verity/session';
import { EventStore, createSealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearerToken,
  createAuthTokenRegistry,
  hashAuthToken,
  wsOriginAllowed,
  type AuthTokenStore,
} from './auth.js';
import { buildServer } from './server.js';

const conductor = {} as unknown as Conductor;
const PASSWORD = 'correct-horse-battery';

/** An in-memory {@link AuthTokenStore} so the registry unit tests need no DB. */
function fakeStore(): AuthTokenStore & { rows: { id: string; tokenHash: string }[] } {
  const rows: { id: string; tokenHash: string }[] = [];
  return {
    rows,
    listAuthTokens: (): Promise<Array<{ id: string; tokenHash: string }>> =>
      Promise.resolve([...rows]),
    insertAuthToken: (r): Promise<void> => {
      rows.push({ id: r.id, tokenHash: r.tokenHash });
      return Promise.resolve();
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
