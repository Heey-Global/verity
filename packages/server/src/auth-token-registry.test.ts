import { describe, expect, it, vi } from 'vitest';
import { createAuthTokenRegistry, hashAuthToken, type AuthTokenStore } from './auth.js';

interface FakeRow {
  id: string;
  userId: string;
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
    }): Promise<string> => {
      const userId = '00000000-0000-4000-8000-000000000001';
      rows.push({
        id: r.id,
        userId,
        tokenHash: r.tokenHash,
        label: r.label ?? null,
        createdAt: 1,
        lastSeenAt: null,
      });
      return Promise.resolve(userId);
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

describe('auth token registry', () => {
  it('mints a token whose raw value verifies, and rejects anything else', async () => {
    const store = fakeStore();
    const registry = await createAuthTokenRegistry(store, { enabled: false });
    const { token, id } = await registry.mint('iPhone');
    expect(typeof token).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(registry.verify(token)).toBe(true);
    expect(registry.resolveId(token)).toBe(id);
    expect(registry.resolveUserId(token)).toBe(store.rows[0]?.userId);
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
    expect(second.resolveUserId(token)).toBe(store.rows[0]?.userId);
    expect(second.resolveUserId('unknown')).toBeUndefined();
  });

  it('forget() drops one hash and clear() drops all from the in-memory set', async () => {
    const registry = await createAuthTokenRegistry(fakeStore(), { enabled: true });
    const a = await registry.mint(null);
    const b = await registry.mint(null);
    registry.forget(hashAuthToken(a.token));
    expect(registry.verify(a.token)).toBe(false);
    expect(registry.resolveUserId(a.token)).toBeUndefined();
    expect(registry.verify(b.token)).toBe(true);
    registry.clear();
    expect(registry.verify(b.token)).toBe(false);
    expect(registry.resolveUserId(b.token)).toBeUndefined();
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
    expect(registry.resolveUserId(first.token)).toBeUndefined();
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
