import type { Conductor } from '@verity/session';
import { InMemoryEventBus } from '@verity/session';
import { EventStore, createSealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_SESSION_COOKIE,
  BROWSER_SESSION_IDLE_MS,
  createAuthTokenRegistry,
} from './auth.js';
import { buildServer } from './server.js';
import {
  MANAGED_BROWSER_ORIGIN_HEADER,
  signManagedBrowserOrigin,
  verifyManagedBrowserOrigin,
} from './managed-browser-origin.js';

const conductor = {} as Conductor;
const password = 'correct-horse-battery';
const origin = { host: 'core.local', origin: 'http://core.local' };
const cookie = (token: string) => `${BROWSER_SESSION_COOKIE}=${token}`;

describe('browser authentication through the Core', () => {
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

  it('initializes and unlocks with HttpOnly cookies without returning a bearer token', async () => {
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
      expect((await app.inject('/auth/session')).statusCode).toBe(401);
      const init = await app.inject({
        method: 'POST',
        url: '/secret/init/browser',
        headers: origin,
        payload: { password, deviceLabel: 'Browser' },
      });
      expect(init.statusCode).toBe(200);
      expect(init.json()).not.toHaveProperty('token');
      const setCookie = String(init.headers['set-cookie']);
      expect(setCookie).toContain(`${BROWSER_SESSION_COOKIE}=`);
      for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'])
        expect(setCookie).toContain(attribute);
      const credential = setCookie.split(';')[0]!;
      expect(
        (await app.inject({ url: '/auth/session', headers: { cookie: credential } })).json(),
      ).toMatchObject({ authenticated: true, tokenId: init.json<{ tokenId: string }>().tokenId });
      cipher.seal();
      const unlock = await app.inject({
        method: 'POST',
        url: '/secret/unlock/browser',
        headers: { ...origin, cookie: credential },
        payload: { password },
      });
      expect(unlock.statusCode).toBe(200);
      expect(unlock.json()).not.toHaveProperty('token');
      expect(unlock.headers['set-cookie']).toBeDefined();
      const logout = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { ...origin, cookie: String(unlock.headers['set-cookie']).split(';')[0]! },
      });
      expect(logout.statusCode).toBe(204);
      expect(
        (
          await app.inject({
            url: '/auth/session',
            headers: { cookie: String(unlock.headers['set-cookie']).split(';')[0]! },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects cookie mutations with missing or foreign Origin while allowing native bearer authentication', async () => {
    const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    const browser = await registry.mint('Browser', true);
    const native = await registry.mint('Native');
    const app = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
      authRegistry: registry,
    });
    try {
      for (const headers of [
        { cookie: cookie(browser.token) },
        { ...origin, origin: 'http://evil.local', cookie: cookie(browser.token) },
        {
          ...origin,
          origin: 'https://evil.local',
          cookie: cookie(browser.token),
          'x-forwarded-host': 'evil.local',
          'x-forwarded-proto': 'https',
          'x-verity-managed-browser-origin': 'https://evil.local',
        },
      ]) {
        expect(
          (await app.inject({ method: 'POST', url: '/auth/logout', headers })).statusCode,
        ).toBe(403);
        expect(registry.verify(browser.token)).toBe(true);
      }
      expect(
        (
          await app.inject({
            url: '/devices',
            headers: { authorization: `Bearer ${native.token}` },
          })
        ).statusCode,
      ).toBe(200);
      // Mixed credentials must not replace the browser cookie with a native token.
      const mixed = await app.inject({
        url: '/devices',
        headers: { cookie: cookie(browser.token), authorization: `Bearer ${native.token}` },
      });
      expect(mixed.statusCode).toBe(200);
      expect(mixed.headers['set-cookie']).toBeUndefined();
      expect(
        (await app.inject({ url: '/devices', headers: { cookie: cookie(browser.token) } }))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/auth/logout',
            headers: { authorization: `Bearer ${native.token}` },
          })
        ).statusCode,
      ).toBe(204);
      expect(registry.verify(native.token)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('allows the login shell and preauth routes with expired cookies but rejects protected API calls', async () => {
    const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    const browser = await registry.mint('Browser', true);
    const root = await mkdtemp(join(tmpdir(), 'verity-auth-web-'));
    await writeFile(join(root, 'index.html'), '<html>login</html>');
    const app = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
      authRegistry: registry,
      webAppDir: root,
    });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + BROWSER_SESSION_IDLE_MS + 1);
    try {
      const headers = { cookie: cookie(browser.token) };
      expect((await app.inject({ url: '/app/', headers })).statusCode).toBe(200);
      expect((await app.inject({ url: '/secret/status', headers })).statusCode).toBe(200);
      expect((await app.inject({ url: '/auth/session', headers })).statusCode).toBe(401);
      expect((await app.inject({ url: '/devices', headers })).statusCode).toBe(401);
    } finally {
      clock.mockRestore();
      await app.close();
      await rm(root, { recursive: true });
    }
  });

  it('uses signed gateway origin for browser initialization and authenticated mutations', async () => {
    const secret = Buffer.alloc(32, 11);
    const cipher = createSealableSecretCipher();
    const store = new EventStore(ctx.db, cipher);
    const registry = await createAuthTokenRegistry(store, { enabled: false });
    const app = buildServer({
      eventStore: store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: cipher,
      authRegistry: registry,
      browserRequestOrigin: (request) =>
        verifyManagedBrowserOrigin(secret, request.headers[MANAGED_BROWSER_ORIGIN_HEADER], {
          method: request.method,
          url: request.raw.url ?? '/',
        }),
    });
    const forwarded = (url: string) => ({
      host: 'backend:3000',
      origin: 'https://core.local:9443',
      [MANAGED_BROWSER_ORIGIN_HEADER]: signManagedBrowserOrigin(secret, {
        origin: 'https://core.local:9443',
        method: 'POST',
        url,
      })!,
    });
    try {
      const init = await app.inject({
        method: 'POST',
        url: '/secret/init/browser',
        headers: forwarded('/secret/init/browser'),
        payload: { password },
      });
      expect(init.statusCode).toBe(200);
      const credential = String(init.headers['set-cookie']).split(';')[0]!;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/auth/logout',
            headers: { ...forwarded('/secret/init/browser'), cookie: credential },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/auth/logout',
            headers: { ...forwarded('/auth/logout'), cookie: credential },
          })
        ).statusCode,
      ).toBe(204);
    } finally {
      await app.close();
    }
  });

  it('checks the exact browser origin before consuming a live ticket', async () => {
    const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    const browser = await registry.mint('Browser', true);
    await ctx.store.createSession({
      sessionId: 'origin-session',
      worktree: '/wt/browser',
      model: 'm',
    });
    const app = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
      authRegistry: registry,
    });
    try {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = `127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
      const response = await app.inject({
        method: 'POST',
        url: '/live/ticket',
        headers: { host: address, origin: `http://${address}`, cookie: cookie(browser.token) },
      });
      expect(response.statusCode).toBe(200);
      const protocol = `verity-live-ticket.${response.json<{ ticket: string }>().ticket}`;
      for (const requestOrigin of [undefined, 'http://127.0.0.1:1']) {
        const socket = new WebSocket(`ws://${address}/live`, protocol, {
          headers: {
            cookie: cookie(browser.token),
            ...(requestOrigin === undefined ? {} : { origin: requestOrigin }),
          },
        });
        const code = await new Promise<number>((resolve, reject) => {
          socket.once('close', resolve);
          socket.once('message', () => {
            socket.terminate();
            reject(new Error('hostile origin received events'));
          });
          socket.once('error', reject);
        });
        expect(code).toBe(1008);
      }
      const socket = new WebSocket(`ws://${address}/live`, protocol, {
        headers: { cookie: cookie(browser.token), origin: `http://${address}` },
      });
      // Rejected origins must not burn the ticket before the legitimate browser retries.
      await new Promise<void>((resolve, reject) => {
        socket.once('message', () => resolve());
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('legitimate socket closed')));
      });
      socket.terminate();
    } finally {
      await app.close();
    }
  });
  it('closes a ticket-authenticated browser WebSocket when its device is revoked', async () => {
    const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    const browser = await registry.mint('Browser', true);
    const native = await registry.mint('Native');
    await ctx.store.createSession({
      sessionId: 'browser-session',
      worktree: '/wt/browser',
      model: 'm',
    });
    const app = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
      authRegistry: registry,
    });
    let socket: WebSocket | undefined;
    try {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const response = await app.inject({
        method: 'POST',
        url: '/live/ticket',
        headers: { ...origin, cookie: cookie(browser.token) },
      });
      expect(response.statusCode).toBe(200);
      socket = new WebSocket(
        `ws://127.0.0.1:${String((app.server.address() as AddressInfo).port)}/live`,
        `verity-live-ticket.${response.json<{ ticket: string }>().ticket}`,
      );
      await new Promise<void>((resolve, reject) => {
        socket!.once('open', resolve);
        socket!.once('error', reject);
      });
      const closed = new Promise<number>((resolve) => socket!.once('close', resolve));
      const revoke = await app.inject({
        method: 'DELETE',
        url: `/devices/${browser.id}`,
        headers: { authorization: `Bearer ${native.token}` },
      });
      expect(revoke.statusCode).toBe(204);
      expect(await closed).toBe(1008);
      expect(
        (await app.inject({ url: '/auth/session', headers: { cookie: cookie(browser.token) } }))
          .statusCode,
      ).toBe(401);
    } finally {
      socket?.terminate();
      await app.close();
    }
  });
});
