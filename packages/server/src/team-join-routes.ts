import type { FastifyInstance } from 'fastify';
import { ProjectTeamError, type EventStore } from '@verity/store';
import { z } from 'zod';

import type { AuthTokenRegistry } from './auth.js';

const bytes32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const joinBody = z
  .object({
    invitationId: bytes32,
    secret: bytes32,
    redemptionId: z.string().min(1).max(128),
    displayName: z.string().trim().min(1).max(80),
    deviceLabel: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

/**
 * Joining a project with an invitation (ADR 0023 §7; team contract): reached by
 * the invited person's app over the channel it pinned to this server. The
 * invitation's secret is the credential, so the route needs no operator token.
 * It redeems the invitation exactly once and pairs this device to the new
 * person; that person stays pending until Uplink confirms the join.
 */
export function registerTeamJoinRoutes(
  app: FastifyInstance,
  deps: { store: Pick<EventStore, 'projectTeam'>; authRegistry: AuthTokenRegistry | undefined },
): void {
  app.post('/team/join', { bodyLimit: 4_096 }, async (request, reply) => {
    const registry = deps.authRegistry;
    if (registry === undefined || !registry.isEnabled())
      return reply.code(409).send({ error: 'device pairing is not configured' });
    const parsed = joinBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid invitation' });
    const body = parsed.data;
    let joined: Awaited<ReturnType<EventStore['projectTeam']['redeemInvitation']>>;
    try {
      joined = await deps.store.projectTeam.redeemInvitation({
        invitationId: body.invitationId,
        secret: body.secret,
        redemptionId: body.redemptionId,
        displayName: body.displayName,
      });
    } catch (error) {
      if (!(error instanceof ProjectTeamError)) throw error;
      // One answer for every unusable invitation: a caller without the secret
      // learns nothing about which invitations exist.
      return reply.code(410).send({ error: error.message, code: 'invitation_unavailable' });
    }
    // A replay of the same redemption (its answer was lost) pairs the device
    // again; the membership is not touched.
    const { token, id } = await registry.mintFor(joined.userId, body.deviceLabel ?? null);
    reply.header('cache-control', 'no-store');
    return { token, tokenId: id, userId: joined.userId, projectId: joined.projectId };
  });
}
