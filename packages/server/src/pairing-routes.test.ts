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
