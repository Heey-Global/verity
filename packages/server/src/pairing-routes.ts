import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearerToken, hashAuthToken, type AuthTokenRegistry } from './auth.js';
import { DevicePairingRejectedError, type DevicePairingManager } from './device-pairing.js';

export interface PairingRouteDeps {
  devicePairing?: DevicePairingManager | undefined;
  authRegistry?: AuthTokenRegistry | undefined;
}

const pairingRedeemBody = z.object({ code: z.string().min(32).max(128) }).strict();
const pairingIdentityQuery = z.object({ challenge: z.string().min(32).max(128) }).strict();
const pairingEnrollBody = z
  .object({
    code: z.string().min(32).max(128),
    deviceLabel: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const deviceParams = z.object({ id: z.string().min(1).max(128) });

/** Installer pairing and signed Server-identity challenge routes. */
export function registerPairingRoutes(app: FastifyInstance, deps: PairingRouteDeps): void {
  const completedEnrollments = new Map<
    string,
    { expiresAt: number; result: { token: string; tokenId: string } }
  >();
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

  app.post('/pair/enroll', { bodyLimit: 1_024 }, async (request, reply) => {
    const registry = deps.authRegistry;
    const pairing = deps.devicePairing;
    if (registry === undefined || pairing === undefined) {
      return reply.code(404).send({ error: 'not found' });
    }
    const { code, deviceLabel } = pairingEnrollBody.parse(request.body);
    const codeHash = hashAuthToken(code);
    const now = Date.now();
    for (const [hash, completed] of completedEnrollments) {
      if (completed.expiresAt <= now) completedEnrollments.delete(hash);
    }
    const completed = completedEnrollments.get(codeHash);
    if (completed !== undefined) return completed.result;
    const invitation = pairing.claimInvitation(code);
    if (invitation === undefined) {
      return reply.code(401).send({ error: 'invalid or expired pairing invitation' });
    }
    try {
      const minted = await registry.mint(deviceLabel ?? null);
      const result = { token: minted.token, tokenId: minted.id };
      completedEnrollments.set(codeHash, { expiresAt: invitation.expiresAt, result });
      return result;
    } catch (error) {
      invitation.release();
      throw error;
    }
  });

  app.get('/devices', async (request, reply) => {
    const registry = deps.authRegistry;
    if (registry === undefined || !registry.isEnabled()) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const currentId = registry.resolveId(bearerToken(request.headers.authorization));
    if (currentId === undefined) return reply.code(401).send({ error: 'unauthorized' });
    return {
      devices: (await registry.list()).map((device) => ({
        ...device,
        isCurrent: device.id === currentId,
      })),
    };
  });

  app.post('/devices/pairing-invitations', async (request, reply) => {
    const registry = deps.authRegistry;
    if (
      registry === undefined ||
      !registry.isEnabled() ||
      registry.resolveId(bearerToken(request.headers.authorization)) === undefined
    ) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (deps.devicePairing === undefined) {
      return reply.code(409).send({ error: 'device pairing is not configured' });
    }
    return deps.devicePairing.issueInvitation();
  });

  app.delete('/devices/:id', async (request, reply) => {
    const registry = deps.authRegistry;
    if (registry === undefined || !registry.isEnabled()) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { id } = deviceParams.parse(request.params);
    const currentId = registry.resolveId(bearerToken(request.headers.authorization));
    if (currentId === undefined) return reply.code(401).send({ error: 'unauthorized' });
    if (id === currentId) {
      return reply.code(409).send({ error: 'the current device cannot revoke itself' });
    }
    if (!(await registry.revoke(id))) return reply.code(404).send({ error: 'device not found' });
    return reply.code(204).send();
  });
}
