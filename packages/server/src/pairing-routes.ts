import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DevicePairingRejectedError, type DevicePairingManager } from './device-pairing.js';

export interface PairingRouteDeps {
  devicePairing?: DevicePairingManager | undefined;
}

const pairingRedeemBody = z.object({ code: z.string().min(32).max(128) }).strict();
const pairingIdentityQuery = z.object({ challenge: z.string().min(32).max(128) }).strict();

/** Installer pairing and signed Server-identity challenge routes. */
export function registerPairingRoutes(app: FastifyInstance, deps: PairingRouteDeps): void {
  // Register both routes even when pairing is not wired. The lockout declaration
  // depends on these paths always existing so another device can obtain a bearer.
  app.get('/pair/identity', (request, reply) => {
    if (deps.devicePairing === undefined) {
      reply.code(404);
      return { error: 'not found' };
    }
    try {
      const { challenge } = pairingIdentityQuery.parse(request.query);
      return { ...deps.devicePairing.identity(), ...deps.devicePairing.signChallenge(challenge) };
    } catch (error) {
      if (error instanceof DevicePairingRejectedError) {
        reply.code(400);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.post('/pair/redeem', { bodyLimit: 1_024 }, (request, reply) => {
    if (deps.devicePairing === undefined) {
      reply.code(404);
      return { error: 'not found' };
    }
    try {
      return deps.devicePairing.redeem(pairingRedeemBody.parse(request.body).code);
    } catch (error) {
      if (error instanceof DevicePairingRejectedError) {
        reply.code(401);
        return { error: error.message };
      }
      throw error;
    }
  });
}
