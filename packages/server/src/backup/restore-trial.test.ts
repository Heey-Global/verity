import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupDeviceReview } from './device-review.js';
import { createRestoreTrial } from './restore-trial.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('isolated recovery trial', () => {
  it('bounds malformed authentication traffic before password verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trial-rate-'));
    roots.push(root);
    const authenticate = vi.fn(async () => false);
    const app = createRestoreTrial({
      review: new BackupDeviceReview(root),
      authenticate,
      inventory: async () => ({ devices: [], revokedIds: [], findings: [] }),
      removeOtherTokens: async () => {},
    });
    try {
      for (let attempt = 0; attempt < 30; attempt++)
        expect(
          (await app.inject({ method: 'POST', url: '/recovery/authenticate', payload: {} }))
            .statusCode,
        ).toBe(400);
      const limited = await app.inject({
        method: 'POST',
        url: '/recovery/authenticate',
        payload: {},
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('requires password and explicit device review, never retains revoked devices or serves ordinary routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trial-'));
    roots.push(root);
    const removeOtherTokens = vi.fn(async (_allowed: readonly string[]) => {
      void _allowed;
    });
    const review = new BackupDeviceReview(root);
    let clock = 10000;
    const app = createRestoreTrial(
      {
        review,
        authenticate: async (password) => password === 'master',
        inventory: async () => ({
          devices: ['kept', 'revoked'],
          revokedIds: ['revoked'],
          findings: [],
        }),
        removeOtherTokens,
      },
      () => clock,
    );
    try {
      expect((await app.inject('/api/projects')).statusCode).toBe(404);
      expect((await app.inject('/recovery/devices')).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/recovery/authenticate',
            payload: { password: 'wrong' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/recovery/authenticate',
            payload: { password: 'master' },
          })
        ).statusCode,
      ).toBe(429);
      clock += 5000;
      const authenticated = await app.inject({
        method: 'POST',
        url: '/recovery/authenticate',
        payload: { password: 'master' },
      });
      expect(authenticated.statusCode).toBe(200);
      const { token } = authenticated.json<{ token: string }>();
      const headers = { authorization: `Bearer ${token}` };
      expect((await app.inject({ url: '/recovery/devices', headers })).json()).toEqual({
        devices: ['kept', 'revoked'],
        revokedIds: ['revoked'],
        findings: [],
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/recovery/devices',
            headers,
            payload: { keepIds: ['revoked'] },
          })
        ).statusCode,
      ).toBe(403);
      expect(removeOtherTokens).not.toHaveBeenCalled();
      expect(await review.blocksDevices()).toBe(true);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/recovery/devices',
            headers,
            payload: { keepIds: ['kept'] },
          })
        ).statusCode,
      ).toBe(200);
      expect(removeOtherTokens).toHaveBeenCalledWith(['kept']);
      expect(await review.blocksDevices()).toBe(false);
      expect((await app.inject({ url: '/recovery/devices', headers })).statusCode).toBe(401);
      clock += 5000;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/recovery/authenticate',
            payload: { password: 'master' },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
});
