import Fastify from 'fastify';
import { createIsolatedTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuthTokenRegistry } from './auth.js';
import { registerTeamJoinRoutes } from './team-join-routes.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const INVITATION = 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM';
let ctx: TestDb;
beforeAll(async () => {
  ctx = await createIsolatedTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'acme',
    repo: 'app',
    containerName: 'verity-acme--app',
    state: 'active',
  });
});

describe('team join route', () => {
  // The invitation's secret is the only credential: it must pair the device to
  // the new person once, never to the administrator, and say nothing about
  // invitations a caller cannot open.
  it('pairs the joining device to the new person and refuses anything else alike', async () => {
    const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    const app = Fastify();
    registerTeamJoinRoutes(app, { store: ctx.store, authRegistry: registry });
    const { invitation, secret } = await ctx.store.projectTeam.createInvitation({
      projectId: 'p1',
      inviterUserId: ADMIN,
      inviteeName: 'Lena',
      canExecute: true,
    });
    await ctx.store.projectTeam.markInvitationCreated(
      invitation.id,
      INVITATION,
      new Date(Date.now() + 3_600_000),
    );
    const join = (overrides: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/team/join',
        payload: {
          invitationId: INVITATION,
          secret,
          redemptionId: 'r1',
          displayName: 'Lena',
          ...overrides,
        },
      });
    const first = await join();
    expect(first.statusCode).toBe(200);
    const { token, userId } = first.json<{ token: string; userId: string }>();
    expect(registry.resolveUserId(token)).toBe(userId);
    expect(userId).not.toBe(ADMIN);

    // The same redemption again, as after a lost answer: same person, new device token.
    const again = await join();
    expect(again.json<{ userId: string }>().userId).toBe(userId);

    const wrongSecret = await join({ secret: 'A'.repeat(43), redemptionId: 'r2' });
    const otherRedemption = await join({ redemptionId: 'r3' });
    const unknown = await join({ invitationId: 'B'.repeat(43), redemptionId: 'r4' });
    for (const refused of [wrongSecret, otherRedemption, unknown]) {
      expect(refused.statusCode).toBe(410);
      expect(refused.json()).toEqual(wrongSecret.json());
    }
  });
});
