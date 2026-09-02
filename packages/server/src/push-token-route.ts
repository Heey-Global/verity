import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearerToken, type AuthTokenRegistry } from './auth.js';

interface PushTokenStore {
  upsertDevicePushToken(input: {
    authTokenId: string;
    expoToken: string;
    platform: 'ios';
  }): Promise<unknown>;
}

export interface PushTokenRouteDeps {
  store: PushTokenStore;
  authRegistry?: AuthTokenRegistry | undefined;
  pushEnabled?: boolean | undefined;
}

const devicePushTokenBody = z.object({
  expoToken: z
    .string()
    .max(256)
    .regex(/^(?:ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]+\]$/),
  // ADR 0008 is iOS/watchOS first. Reject Android until its actions and delivery
  // behaviour are explicitly implemented instead of storing unusable rows.
  platform: z.literal('ios'),
});

/** Registers the authenticated device push-token endpoint. */
export function registerPushTokenRoute(app: FastifyInstance, deps: PushTokenRouteDeps): void {
  app.post('/devices/:id/push-token', async (request, reply) => {
    if (deps.pushEnabled !== true) {
      return reply.code(503).send({ error: 'Push notifications are not configured' });
    }
    const registry = deps.authRegistry;
    const rawToken = bearerToken(request.headers.authorization);
    const authTokenId = registry?.resolveId(rawToken);
    if (registry === undefined || !registry.isEnabled() || authTokenId === undefined) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { id } = request.params as { id: string };
    if (id !== authTokenId) {
      return reply.code(403).send({ error: 'device id does not match authenticated device' });
    }
    const body = devicePushTokenBody.parse(request.body);
    await deps.store.upsertDevicePushToken({ authTokenId, ...body });
    return { registered: true as const };
  });
}
