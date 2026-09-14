import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { bearerToken, type AuthTokenRegistry } from './auth.js';
import { DevicePairingRejectedError, type DevicePairingManager } from './device-pairing.js';
import { createUnlockThrottle } from './unlock-throttle.js';

export interface PairingRouteDeps {
  devicePairing?: DevicePairingManager | undefined;
  authRegistry?: AuthTokenRegistry | undefined;
}

const pairingRedeemBody = z.object({ code: z.string().min(32).max(128) }).strict();
const pairingIdentityQuery = z.object({ challenge: z.string().min(32).max(128) }).strict();
const pairingEnrollBody = z
  .object({
    code: z.string().min(32).max(128),
    enrollmentId: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    deviceLabel: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const deviceParams = z.object({ id: z.string().min(1).max(128) });

/** Installer pairing and signed Server-identity challenge routes. */
export function registerPairingRoutes(app: FastifyInstance, deps: PairingRouteDeps): void {
  // Redemption and enrollment take pre-auth guesses at one-shot codes. The
  // codes are 256-bit and compared timing-safely, so guessing cannot succeed —
  // this throttle exists so that property never silently becomes the only
  // defence (e.g. a future shorter human-typable code format).
  const pairingThrottle = createUnlockThrottle();
  const rejectThrottled = (reply: FastifyReply, retryAfterMs: number | undefined): unknown => {
    if (retryAfterMs !== undefined)
      reply.header('retry-after', String(Math.ceil(retryAfterMs / 1000)));
    reply.code(429);
    return { error: 'too many attempts — try again later' };
  };
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
    const gate = pairingThrottle.check(request.ip);
    if (!gate.allowed) return rejectThrottled(reply, gate.retryAfterMs);
    try {
      const redeemed = deps.devicePairing.redeem(pairingRedeemBody.parse(request.body).code);
      pairingThrottle.recordSuccess(request.ip);
      return redeemed;
    } catch (error) {
      if (error instanceof DevicePairingRejectedError) {
        pairingThrottle.recordFailure(request.ip);
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
    const gate = pairingThrottle.check(request.ip);
    if (!gate.allowed) return rejectThrottled(reply, gate.retryAfterMs);
    const { code, enrollmentId, deviceLabel } = pairingEnrollBody.parse(request.body);
    const credential = pairing.enrollmentCredential(code, enrollmentId);
    if (registry.resolveId(credential.token) === credential.id) {
      pairingThrottle.recordSuccess(request.ip);
      return { token: credential.token, tokenId: credential.id };
    }
    const invitation = pairing.claimInvitation(code);
    if (invitation === undefined) {
      pairingThrottle.recordFailure(request.ip);
      return reply.code(401).send({ error: 'invalid or expired pairing invitation' });
    }
    try {
      const enrolled = await registry.register(
        credential.token,
        credential.id,
        deviceLabel ?? null,
      );
      pairingThrottle.recordSuccess(request.ip);
      return { token: enrolled.token, tokenId: enrolled.id };
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
