import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { DevicePairingRejectedError, type DevicePairingManager } from './device-pairing.js';
import { registerPairingRoutes } from './pairing-routes.js';

function pairingManager(overrides: Partial<DevicePairingManager> = {}): DevicePairingManager {
  return {
    identity: () => ({ serverId: 'server-1', identityKey: 'identity-key' }),
    signChallenge: (challenge) => ({ serverId: 'server-1', signature: `signed:${challenge}` }),
    redeem: () => ({ bootstrapToken: 'bootstrap', expiresAt: '2030-01-01T00:00:00.000Z' }),
    consumeBootstrap: () => false,
    issueInvitation: () => ({ code: 'invitation', expiresAt: '2030-01-01T00:00:00.000Z' }),
    claimInvitation: () => undefined,
    enrollmentCredential: () => ({ token: 'token', id: 'token-id' }),
    ...overrides,
  };
}

describe('pairing routes', () => {
  it('registers both routes when pairing is unavailable', async () => {
    const app = Fastify();
    registerPairingRoutes(app, {});
    expect(
      (await app.inject({ method: 'GET', url: `/pair/identity?challenge=${'a'.repeat(32)}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/pair/redeem', payload: { code: 'a'.repeat(32) } }))
        .statusCode,
    ).toBe(404);
    await app.close();
  });

  it('returns the signed identity and redeems a valid code', async () => {
    const app = Fastify();
    registerPairingRoutes(app, { devicePairing: pairingManager() });
    const challenge = 'a'.repeat(32);
    expect(
      (await app.inject({ method: 'GET', url: `/pair/identity?challenge=${challenge}` })).json(),
    ).toEqual({
      serverId: 'server-1',
      identityKey: 'identity-key',
      signature: `signed:${challenge}`,
    });
    expect(
      (
        await app.inject({ method: 'POST', url: '/pair/redeem', payload: { code: 'b'.repeat(32) } })
      ).json(),
    ).toEqual({
      bootstrapToken: 'bootstrap',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    await app.close();
  });

  it('rate-limits repeated rejected redemptions from one IP', async () => {
    // The silent failure this guards: device-pairing.ts promises that invalid
    // guesses are bounded by a rate limit. Codes are 256-bit today, so nothing
    // ever fails without one — until a shorter code format arrives and the
    // promised brake turns out never to have existed.
    const rejected = () => {
      throw new DevicePairingRejectedError('rejected');
    };
    const app = Fastify();
    // Enrollment only checks the registry after the throttle gate, so a bare
    // stub is enough to reach the shared-budget 429 below.
    const registryStub = {} as import('./auth.js').AuthTokenRegistry;
    registerPairingRoutes(app, {
      devicePairing: pairingManager({ redeem: rejected }),
      authRegistry: registryStub,
    });
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/pair/redeem',
            payload: { code: 'b'.repeat(32) },
          })
        ).statusCode,
      ).toBe(401);
    }
    const locked = await app.inject({
      method: 'POST',
      url: '/pair/redeem',
      payload: { code: 'b'.repeat(32) },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
    // Enrollment shares the same per-IP budget: a guesser locked out of one
    // pre-auth pairing surface must not continue on the other.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/pair/enroll',
          payload: { code: 'b'.repeat(32), enrollmentId: 'c'.repeat(32) },
        })
      ).statusCode,
    ).toBe(429);
    await app.close();
  });

  it('maps rejected challenges and codes to their public status codes', async () => {
    const rejected = () => {
      throw new DevicePairingRejectedError('rejected');
    };
    const app = Fastify();
    registerPairingRoutes(app, {
      devicePairing: pairingManager({ signChallenge: rejected, redeem: rejected }),
    });
    expect(
      (await app.inject({ method: 'GET', url: `/pair/identity?challenge=${'a'.repeat(32)}` }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/pair/redeem', payload: { code: 'b'.repeat(32) } }))
        .statusCode,
    ).toBe(401);
    await app.close();
  });
});
