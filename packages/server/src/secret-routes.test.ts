import type { Conductor } from '@verity/session';
import { InMemoryEventBus } from '@verity/session';
import { EventStore, createSealableSecretCipher, type SealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

// The /secret routes never touch the conductor; a bare stub satisfies the dep.
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

/** Build an app whose secret store is backed by a fresh sealable cipher. */
function buildWithCipher(
  cipher: SealableSecretCipher,
  onSecretUnlocked?: () => Promise<void>,
): FastifyInstance {
  const store = new EventStore(ctx.db, cipher);
  return buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    conductor,
    secretCipher: cipher,
    ...(onSecretUnlocked !== undefined ? { onSecretUnlocked } : {}),
  });
}

const PASSWORD = 'correct-horse-battery';

describe('secret store lifecycle routes', () => {
  it('activates deferred encrypted services after init and unlock', async () => {
    const cipher = createSealableSecretCipher();
    const onSecretUnlocked = vi.fn(async () => undefined);
    const app = buildWithCipher(cipher, onSecretUnlocked);
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/secret/init',
            payload: { password: PASSWORD },
          })
        ).statusCode,
      ).toBe(200);
      expect(onSecretUnlocked).toHaveBeenCalledOnce();

      cipher.seal();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/secret/unlock',
            payload: { password: PASSWORD },
          })
        ).statusCode,
      ).toBe(200);
      expect(onSecretUnlocked).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('surfaces a post-unlock broker activation failure', async () => {
    const cipher = createSealableSecretCipher();
    const app = buildWithCipher(cipher, () => Promise.reject(new Error('cutover failed')));
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/secret/init',
        payload: { password: PASSWORD },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: 'secret store unlocked, but broker activation is still pending',
      });
      expect(cipher.isSealed()).toBe(true);

      const retry = await app.inject({
        method: 'POST',
        url: '/secret/unlock',
        payload: { password: PASSWORD },
      });
      expect(retry.statusCode).toBe(503);
      expect(cipher.isSealed()).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('walks uninitialized → init → unlocked → seal(503) → unlock', async () => {
    const cipher = createSealableSecretCipher();
    const app = buildWithCipher(cipher);
    try {
      // 1. Uninitialized (sealed, no password set yet).
      let res = await app.inject({ method: 'GET', url: '/secret/status' });
      expect(res.json()).toEqual({ status: 'uninitialized' });

      // 2. Unlock before init → 409.
      res = await app.inject({
        method: 'POST',
        url: '/secret/unlock',
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(409);

      // 3. Short password rejected (zod min length).
      res = await app.inject({
        method: 'POST',
        url: '/secret/init',
        payload: { password: 'short' },
      });
      expect(res.statusCode).toBe(400);

      // 4. Init sets the password and unlocks.
      res = await app.inject({
        method: 'POST',
        url: '/secret/init',
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'unlocked' });
      expect(cipher.isSealed()).toBe(false);
      expect((await app.inject({ method: 'GET', url: '/secret/status' })).json()).toEqual({
        status: 'unlocked',
      });

      // 5. Init again → 409 (already set / unlocked).
      res = await app.inject({
        method: 'POST',
        url: '/secret/init',
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(409);

      // 6. Store a secret, then re-seal → status 'sealed'.
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { gitSshPrivateKey: 'my-key' },
      });
      cipher.seal();
      expect((await app.inject({ method: 'GET', url: '/secret/status' })).json()).toEqual({
        status: 'sealed',
      });
      // GET /settings still works while sealed (raw read) and reports the secret
      // as configured — without decrypting or leaking it.
      const sealedRead = await app.inject({ method: 'GET', url: '/settings' });
      expect(sealedRead.statusCode).toBe(200);
      expect(sealedRead.json().settings).toMatchObject({ gitSshPrivateKeyConfigured: true });
      expect(JSON.stringify(sealedRead.json())).not.toContain('my-key');
      // But a settings WRITE while sealed is refused up front (no partial commit).
      const sealedWrite = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { gitUserName: 'nope' },
      });
      expect(sealedWrite.statusCode).toBe(503);

      // 7. Wrong password → 401, cipher stays sealed.
      res = await app.inject({
        method: 'POST',
        url: '/secret/unlock',
        payload: { password: 'wrong-password' },
      });
      expect(res.statusCode).toBe(401);
      expect(cipher.isSealed()).toBe(true);

      // 8. Correct password → unlocked; secret reads work again.
      res = await app.inject({
        method: 'POST',
        url: '/secret/unlock',
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      const okRead = await app.inject({ method: 'GET', url: '/settings' });
      expect(okRead.statusCode).toBe(200);
      expect(okRead.json().settings).toMatchObject({ gitSshPrivateKeyConfigured: true });
    } finally {
      await app.close();
    }
  });

  it('reports unmanaged and rejects init/unlock when no cipher is wired', async () => {
    const app = buildServer({ eventStore: ctx.store, bus: new InMemoryEventBus(), conductor });
    try {
      expect((await app.inject({ method: 'GET', url: '/secret/status' })).json()).toEqual({
        status: 'unmanaged',
      });
      expect(
        (await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } }))
          .statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/secret/unlock',
            payload: { password: PASSWORD },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('unlocks with the correct password after a restart (re-derives from stored salt)', async () => {
    // First cipher: init a password, which persists salt + verifier.
    const first = createSealableSecretCipher();
    const app1 = buildWithCipher(first);
    await app1.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
    await app1.close();

    // "Restart": a brand-new sealed cipher over the SAME db unlocks with the password.
    const second = createSealableSecretCipher();
    const app2 = buildWithCipher(second);
    try {
      expect((await app2.inject({ method: 'GET', url: '/secret/status' })).json()).toEqual({
        status: 'sealed',
      });
      const res = await app2.inject({
        method: 'POST',
        url: '/secret/unlock',
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      expect(second.isSealed()).toBe(false);
    } finally {
      await app2.close();
    }
  });
});

/**
 * The condition the attention banner exists for: a Server that restarted into a
 * sealed state serves `/sessions` perfectly well and cannot give a single
 * sandbox a signing key or a GitHub token. Nothing on the session list said so
 * for hours.
 */
describe('GET /sessions?envelope=1 attention (sealed)', () => {
  it('is silent while unlocked and names the seal after a restart', async () => {
    const first = createSealableSecretCipher();
    const app1 = buildWithCipher(first);
    await app1.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
    const unlocked = await app1.inject({ method: 'GET', url: '/sessions?envelope=1' });
    expect(unlocked.json()).toEqual({ sessions: [] }); // no `attention` key at all
    await app1.close();

    // "Restart": a brand-new sealed cipher over the same database.
    const app2 = buildWithCipher(createSealableSecretCipher());
    try {
      const sealed = await app2.inject({ method: 'GET', url: '/sessions?envelope=1' });
      expect(sealed.statusCode).toBe(200);
      expect(sealed.json().attention).toEqual([
        { code: 'secret_sealed', message: expect.stringContaining('sealed') },
      ]);

      // Without the opt-in it is still the bare array every existing app parses.
      const legacy = await app2.inject({ method: 'GET', url: '/sessions' });
      expect(legacy.json()).toEqual([]);
    } finally {
      await app2.close();
    }
  });

  it('says nothing about a Server that has never been initialized', async () => {
    const app = buildWithCipher(createSealableSecretCipher());
    try {
      const res = await app.inject({ method: 'GET', url: '/sessions?envelope=1' });
      expect(res.json()).toEqual({ sessions: [] });
    } finally {
      await app.close();
    }
  });
});
