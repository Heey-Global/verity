import type { Conductor } from '@verity/session';
import { generateKeyPairSync } from 'node:crypto';
import { InMemoryEventBus } from '@verity/session';
import { EventStore, createSealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bearerToken,
  createAuthTokenRegistry,
  hashAuthToken,
  wsOriginAllowed,
  type AuthTokenStore,
} from './auth.js';
import { createGhTokenCapabilityRegistry } from './github-token-broker.js';
import { createDevicePairingManager, type DevicePairingManager } from './device-pairing.js';
import { buildServer } from './server.js';

const conductor = {} as unknown as Conductor;
const PASSWORD = 'correct-horse-battery';

interface FakeRow {
  id: string;
  tokenHash: string;
  label: string | null;
  createdAt: number;
  lastSeenAt: number | null;
}

/** An in-memory {@link AuthTokenStore} so the registry unit tests need no DB.
 *  `touches` counts the writes the registry actually issued — the throttle has
 *  no other observable effect. */
function fakeStore(): AuthTokenStore & {
  rows: FakeRow[];
  touches: string[];
  failTouch?: boolean;
} {
  const rows: FakeRow[] = [];
  const store = {
    rows,
    touches: [] as string[],
    failTouch: false,
    listAuthTokens: () => Promise.resolve([...rows]),
    insertAuthToken: (r: {
      id: string;
      tokenHash: string;
      label?: string | null;
    }): Promise<void> => {
      rows.push({
        id: r.id,
        tokenHash: r.tokenHash,
        label: r.label ?? null,
        createdAt: 1,
        lastSeenAt: null,
      });
      return Promise.resolve();
    },
    deleteAuthToken: (id: string): Promise<boolean> => {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return Promise.resolve(false);
      rows.splice(index, 1);
      return Promise.resolve(true);
    },
    renameAuthToken: (id: string, label: string): Promise<boolean> => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row === undefined) return Promise.resolve(false);
      row.label = label;
      return Promise.resolve(true);
    },
    touchAuthToken: (id: string): Promise<void> => {
      if (store.failTouch) return Promise.reject(new Error('write failed'));
      store.touches.push(id);
      const row = rows.find((candidate) => candidate.id === id);
      if (row !== undefined) row.lastSeenAt = Date.now();
      return Promise.resolve();
    },
  };
  return store;
}

describe('bearerToken parsing', () => {
  it('extracts the token from a Bearer header (case-insensitive), else undefined', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer   xyz')).toBe('xyz');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken('Bearer')).toBeUndefined();
    expect(bearerToken(`Bearer${' '.repeat(100_000)}token`)).toBe('token');
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
        payload: {
          code: invitation.json().code,
          enrollmentId: 'enrollment_attempt_abcdefghijklmnopqrstuvwxyz',
          deviceLabel: 'Mac',
        },
      });
      expect(enrollment.statusCode).toBe(200);
      const enrollmentRetry = await app.inject({
        method: 'POST',
        url: '/pair/enroll',
        payload: {
          code: invitation.json().code,
          enrollmentId: 'enrollment_attempt_abcdefghijklmnopqrstuvwxyz',
        },
      });
      expect(enrollmentRetry.statusCode).toBe(200);
      expect(enrollmentRetry.json()).toEqual(enrollment.json());
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/pair/enroll',
            payload: {
              code: invitation.json().code,
              enrollmentId: 'different_attempt_abcdefghijklmnopqrstuvwxyz',
            },
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

      // A household of identically-named iPads is the whole reason rename
      // exists, so the list must show the new name, not the enrollment one.
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/devices/${secondId}`,
            headers: { authorization },
            payload: { label: '  Studio Mac  ' },
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (await app.inject({ method: 'GET', url: '/devices', headers: { authorization } })).json()
          .devices,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: secondId, label: 'Studio Mac' })]),
      );
      // Renaming this device is allowed — unlike revoking it, it cannot lock the
      // operator out.
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/devices/${current.id}`,
            headers: { authorization },
            payload: { label: 'Desk iPad' },
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/devices/never-paired',
            headers: { authorization },
            payload: { label: 'Ghost' },
          })
        ).statusCode,
      ).toBe(404);
      // A label the schema refuses has to come back as a 400 the app can show,
      // not as the 500 an unhandled ZodError would produce — and an empty or
      // over-long name must not reach the column at all.
      for (const label of ['', '   ', 'x'.repeat(101)]) {
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `/devices/${secondId}`,
              headers: { authorization },
              payload: { label },
            })
          ).statusCode,
        ).toBe(400);
      }
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/devices/${secondId}`,
            headers: { authorization },
            payload: { label: 'Studio Mac', admin: true },
          })
        ).statusCode,
      ).toBe(400);

      // The device id is a public handle, so an unauthenticated PATCH would let
      // anyone on the LAN relabel devices. This is refused by the global gate
      // rather than by the handler, which is exactly what makes it worth
      // pinning: declaring this route pre-auth would leave no other trace.
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/devices/${secondId}`,
            payload: { label: 'Intruder' },
          })
        ).statusCode,
      ).toBe(401);

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

  it('stamps last-seen after an authenticated response, so the list can show real activity', async () => {
    const store = new EventStore(ctx.db);
    const registry = await createAuthTokenRegistry(store, { enabled: true });
    const current = await registry.mint('iPad');
    const app = buildServer({
      eventStore: store,
      bus: new InMemoryEventBus(),
      conductor,
      authRegistry: registry,
    });
    try {
      const authorization = `Bearer ${current.token}`;
      // Before any authenticated request the column is null — which the app
      // renders as the pairing date, not as activity.
      expect((await store.listAuthTokens())[0]?.lastSeenAt).toBeNull();

      await app.inject({ method: 'GET', url: '/devices', headers: { authorization } });
      // The stamp is fire-and-forget, so it may land after the response. Poll
      // the row rather than assuming the write raced ahead of the reply.
      await vi.waitFor(async () =>
        expect((await store.listAuthTokens())[0]?.lastSeenAt).toEqual(expect.any(Number)),
      );

      // And the response hook's stamp has to survive the trip through the list route —
      // a column written but never serialized leaves the app showing "Paired"
      // forever with nothing in the server to point at.
      const listed = (
        await app.inject({ method: 'GET', url: '/devices', headers: { authorization } })
      ).json<{ devices: Array<{ id: string; lastSeenAt: number | null }> }>();
      expect(listed.devices.find((device) => device.id === current.id)?.lastSeenAt).toEqual(
        expect.any(Number),
      );
    } finally {
      await app.close();
    }
  });

  it('parses long runs of separator spaces in linear time', () => {
    expect(bearerToken(`Bearer${' '.repeat(100_000)}token`)).toBe('token');
    expect(bearerToken(`Bearer${' '.repeat(100_000)}`)).toBeUndefined();
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

  it('recovers a deterministic enrollment token after a registry restart', async () => {
    const store = fakeStore();
    const first = await createAuthTokenRegistry(store, { enabled: true });
    await first.register('deterministic-token', 'device-id', 'iPad');

    const restarted = await createAuthTokenRegistry(store, { enabled: true });
    await expect(restarted.register('deterministic-token', 'device-id', 'iPad')).resolves.toEqual({
      token: 'deterministic-token',
      id: 'device-id',
    });
    expect(restarted.resolveId('deterministic-token')).toBe('device-id');
    expect(store.rows).toHaveLength(1);
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
      { id: first.id, label: 'iPad', createdAt: 1, lastSeenAt: null },
      { id: second.id, label: 'Mac', createdAt: 1, lastSeenAt: null },
    ]);
    expect(await registry.revoke(first.id)).toBe(true);
    expect(registry.verify(first.token)).toBe(false);
    expect(registry.verify(second.token)).toBe(true);
    expect(await registry.revoke(first.id)).toBe(false);
  });

  it('renames a known device and refuses an id it does not hold', async () => {
    const registry = await createAuthTokenRegistry(fakeStore(), { enabled: true });
    const device = await registry.mint('iPad');
    expect(await registry.rename(device.id, 'Kitchen iPad')).toBe(true);
    expect(await registry.list()).toEqual([
      expect.objectContaining({ id: device.id, label: 'Kitchen iPad' }),
    ]);
    // An unknown id has to come back false rather than succeed silently: the
    // route turns this into a 404, which is how a phone learns the device it
    // was renaming was revoked from somewhere else in the meantime.
    expect(await registry.rename('not-a-device', 'Nope')).toBe(false);
  });

  it('stamps last-seen once per interval, not once per request', async () => {
    // Move the clock rather than installing fake timers: the throttle only reads
    // Date.now() and schedules nothing, and this file also drives the shared
    // PostgreSQL harness, which fake timers cannot serve (see
    // scripts/test-db-harness.test.ts).
    const clock = vi.spyOn(Date, 'now');
    const startedAt = Date.now();
    clock.mockReturnValue(startedAt);
    try {
      const store = fakeStore();
      const registry = await createAuthTokenRegistry(store, { enabled: true });
      const device = await registry.mint('iPad');

      // The gate calls touch() on EVERY authenticated request. A row update per
      // request is the failure this throttle exists to prevent, and nothing else
      // about the system would look wrong if it regressed.
      for (let i = 0; i < 50; i += 1) registry.touch(device.token);
      await Promise.resolve();
      expect(store.touches).toEqual([device.id]);

      clock.mockReturnValue(startedAt + 5 * 60_000);
      registry.touch(device.token);
      await Promise.resolve();
      expect(store.touches).toEqual([device.id, device.id]);

      // An unknown token resolves to no device, so there is nothing to stamp.
      registry.touch('not-a-token');
      registry.touch(undefined);
      await Promise.resolve();
      expect(store.touches).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('re-opens the interval when the stamp write fails, and never throws', async () => {
    const store = fakeStore();
    const registry = await createAuthTokenRegistry(store, { enabled: true });
    const device = await registry.mint('iPad');

    store.failTouch = true;
    // A rejected write inside a fire-and-forget call is an unhandled rejection
    // unless it is caught — which would take the whole process down in prod.
    expect(() => registry.touch(device.token)).not.toThrow();
    await Promise.resolve();
    expect(store.touches).toEqual([]);

    // Without re-opening, the device would show no activity for five minutes
    // after a single transient write failure.
    store.failTouch = false;
    registry.touch(device.token);
    await Promise.resolve();
    expect(store.touches).toEqual([device.id]);
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

  it('rate-limits invalid bearer probing without throttling valid devices', async () => {
    const store = new EventStore(ctx.db);
    const registry = await createAuthTokenRegistry(store, { enabled: true });
    const current = await registry.mint('iPad');
    const app = buildServer({
      eventStore: store,
      bus: new InMemoryEventBus(),
      conductor,
      authRegistry: registry,
    });
    try {
      let limited;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await app.inject({
          method: 'GET',
          url: '/settings',
          headers: { authorization: 'Bearer invalid' },
        });
        if (response.statusCode === 429) {
          limited = response;
          break;
        }
      }
      expect(limited?.statusCode).toBe(429);
      expect(limited?.headers['retry-after']).toBeDefined();
      const websocketUpgrade = await app.inject({
        method: 'GET',
        url: '/sessions/not-found/stream',
        headers: { upgrade: 'websocket', connection: 'upgrade' },
      });
      expect(websocketUpgrade.statusCode).not.toBe(429);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/devices',
            headers: { authorization: `Bearer ${current.token}` },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
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

  // The token broker must stay protected even when only its capability registry is wired.
  for (const capabilities of [false, true]) {
    it(`keeps unconfigured routes closed (capabilities: ${capabilities})`, async () => {
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
        ...(capabilities ? { ghTokenCapabilities: createGhTokenCapabilityRegistry(ctx.db) } : {}),
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
        // including the capabilities-only case, which wires the GitHub-token
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

  it('admits only one concurrent pre-auth password derivation', async () => {
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
      cipher.seal();

      // A check-then-record throttle alone lets every request in this burst
      // queue a scrypt before the first wrong password records its failure.
      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          app.inject({
            method: 'POST',
            url: '/secret/unlock',
            payload: { password: 'definitely-wrong' },
          }),
        ),
      );

      expect(responses.filter((response) => response.statusCode === 401)).toHaveLength(1);
      expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(5);
      for (const busy of responses.filter((response) => response.statusCode === 429)) {
        expect(busy.headers['retry-after']).toBe('1');
      }
    } finally {
      await app.close();
    }
  });

  it('does not consume a pairing bootstrap when password derivation is busy', async () => {
    const cipher = createSealableSecretCipher();
    const store = new EventStore(ctx.db, cipher);
    const bootstraps = new Set(['first-bootstrap', 'retryable-bootstrap']);
    const pairing = {
      consumeBootstrap(token: string): boolean {
        if (!bootstraps.has(token)) return false;
        bootstraps.delete(token);
        return true;
      },
    } as unknown as DevicePairingManager;
    const app = buildServer({
      eventStore: store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: cipher,
      devicePairing: pairing,
    });
    try {
      const first = app.inject({
        method: 'POST',
        url: '/secret/init',
        headers: { 'x-verity-pairing': 'first-bootstrap' },
        payload: { password: PASSWORD },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const busy = await app.inject({
        method: 'POST',
        url: '/secret/init',
        headers: { 'x-verity-pairing': 'retryable-bootstrap' },
        payload: { password: PASSWORD },
      });

      expect(busy.statusCode).toBe(429);
      expect(bootstraps.has('retryable-bootstrap')).toBe(true);
      expect((await first).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('rate-limits /secret/init after repeated rejected attempts from one IP', async () => {
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
      // Initialization is pre-auth and each attempt that reaches the scrypt
      // derivation burns ~100 ms of CPU and ~64 MB. The silent failure this
      // guards: a throttle wired only to /secret/unlock leaves init as an
      // unauthenticated derivation sink on any deployment without pairing.
      await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
      cipher.seal(); // back to sealed so re-init reaches the derivation path

      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/secret/init',
          payload: { password: PASSWORD },
        });
        expect(res.statusCode).toBe(409); // password already set — a recorded failure
      }
      const locked = await app.inject({
        method: 'POST',
        url: '/secret/init',
        payload: { password: PASSWORD },
      });
      expect(locked.statusCode).toBe(429);
      expect(locked.headers['retry-after']).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('rate-limits invalid unlock bootstraps after a correct password', async () => {
    const cipher = createSealableSecretCipher();
    const store = new EventStore(ctx.db, cipher);
    let initializationBootstrap = true;
    const pairing = {
      consumeBootstrap(token: string): boolean {
        if (token !== 'initialization-bootstrap' || !initializationBootstrap) return false;
        initializationBootstrap = false;
        return true;
      },
    } as unknown as DevicePairingManager;
    const app = buildServer({
      eventStore: store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: cipher,
      devicePairing: pairing,
    });
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/secret/init',
            headers: { 'x-verity-pairing': 'initialization-bootstrap' },
            payload: { password: PASSWORD },
          })
        ).statusCode,
      ).toBe(200);
      cipher.seal();

      for (let i = 0; i < 5; i++) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/secret/unlock',
              headers: { 'x-verity-pairing': 'invalid-bootstrap' },
              payload: { password: PASSWORD },
            })
          ).statusCode,
        ).toBe(401);
      }
      const locked = await app.inject({
        method: 'POST',
        url: '/secret/unlock',
        headers: { 'x-verity-pairing': 'invalid-bootstrap' },
        payload: { password: PASSWORD },
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
