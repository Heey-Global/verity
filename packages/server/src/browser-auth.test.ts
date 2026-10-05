import { generateKeyPairSync } from 'node:crypto';
import { createDevicePairingManager } from './device-pairing.js';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_SESSION_COOKIE,
  BROWSER_SESSION_IDLE_MS,
  createAuthTokenRegistry,
  cookieCredential,
  browserOriginAllowed,
  type AuthTokenStore,
} from './auth.js';
import { registerPairingRoutes } from './pairing-routes.js';

function tokenStore(): AuthTokenStore {
  const rows: Awaited<ReturnType<AuthTokenStore['listAuthTokens']>> = [];
  return {
    listAuthTokens: async () => rows,
    insertAuthToken: async (record) => {
      rows.push({ ...record, userId: 'user' });
      return 'user';
    },
    deleteAuthToken: async (id) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
    renameAuthToken: async () => true,
    touchAuthToken: async (id, expiresAt) => {
      const row = rows.find((r) => r.id === id);
      if (row && expiresAt !== undefined) row.expiresAt = expiresAt;
    },
  };
}

describe('browser sessions', () => {
  it('expires browser credentials and revokes live consumers while native tokens remain valid', async () => {
    vi.useFakeTimers();
    try {
      const registry = await createAuthTokenRegistry(tokenStore(), { enabled: true });
      const browser = await registry.mint('Browser', true);
      const native = await registry.mint('Native');
      const revoked = vi.fn();
      registry.onRevoke(revoked);
      expect(registry.isBrowserToken(browser.token)).toBe(true);
      expect(registry.isBrowserToken(native.token)).toBe(false);
      await vi.advanceTimersByTimeAsync(BROWSER_SESSION_IDLE_MS + 60_000);
      expect(registry.verify(browser.token)).toBe(false);
      expect(registry.verify(native.token)).toBe(true);
      expect(revoked).toHaveBeenCalledWith(browser.id);
    } finally {
      vi.useRealTimers();
    }
  });
  it('persists idle renewal and restores its expiry after restarting', async () => {
    vi.useFakeTimers();
    try {
      const store = tokenStore();
      const registry = await createAuthTokenRegistry(store, { enabled: true });
      const token = await registry.mint('Browser', true);
      await vi.advanceTimersByTimeAsync(BROWSER_SESSION_IDLE_MS - 60_000);
      registry.touch(token.token);
      await Promise.resolve();
      const restored = await createAuthTokenRegistry(store, { enabled: true });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(restored.verify(token.token)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('requires exact same-origin mutations and rejects ambiguous cookies', () => {
    expect(
      browserOriginAllowed({
        protocol: 'https',
        headers: { host: 'core.local', origin: 'https://core.local' },
      }),
    ).toBe(true);
    expect(browserOriginAllowed({ protocol: 'https', headers: { host: 'core.local' } })).toBe(
      false,
    );
    const value = 'a'.repeat(43);
    expect(cookieCredential({ headers: { cookie: `${BROWSER_SESSION_COOKIE}=${value}` } })).toBe(
      value,
    );
    expect(
      cookieCredential({
        headers: {
          cookie: `${BROWSER_SESSION_COOKIE}=${value}; ${BROWSER_SESSION_COOKIE}=${value}`,
        },
      }),
    ).toBeUndefined();
  });
  it('accepts a real invitation credential as a browser cookie', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pairing = createDevicePairingManager({
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      pairingCode: 'a'.repeat(43),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      loadConsumedCodeHash: () => undefined,
      storeConsumedCodeHash: () => true,
    });
    const registry = await createAuthTokenRegistry(tokenStore(), { enabled: true });
    const app = Fastify();
    registerPairingRoutes(app, { authRegistry: registry, devicePairing: pairing });
    const invitation = pairing.issueInvitation();
    const enrolled = await app.inject({
      method: 'POST',
      url: '/pair/enroll/browser',
      headers: { origin: 'http://localhost:80' },
      payload: { code: invitation.code, enrollmentId: 'e'.repeat(43) },
    });
    expect(enrolled.statusCode).toBe(200);
    // Invitation tokens are signatures, so a cookie parser limited to random-token length silently loses the login.
    const cookie = String(enrolled.headers['set-cookie']).split(';')[0]!;
    const session = await app.inject({ url: '/auth/session', headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json().tokenId).toBe(enrolled.json().tokenId);
    await app.close();
    registry.dispose?.();
  });
  it('returns cookie session state without exposing credentials and logout revokes it', async () => {
    const app = Fastify();
    const registry = await createAuthTokenRegistry(tokenStore(), { enabled: true });
    registerPairingRoutes(app, { authRegistry: registry });
    const token = await registry.mint('Browser', true);
    const headers = { cookie: `${BROWSER_SESSION_COOKIE}=${token.token}` };
    const session = await app.inject({ url: '/auth/session', headers });
    expect(session.json()).toEqual({ authenticated: true, tokenId: token.id, userId: 'user' });
    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    expect(registry.verify(token.token)).toBe(false);
    await app.close();
  });
});
