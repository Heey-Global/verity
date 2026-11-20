import Fastify from 'fastify';
import { InMemoryEventBus, type Conductor } from '@verity/session';
import { buildServer } from './server.js';
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
    const app = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: {} as Conductor,
      authRegistry: registry,
    });
    try {
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
      // Core accepted this join's tunnel; the route takes only its redemption.
      await ctx.store.projectTeam.admitJoin({
        sessionId: 'session_1',
        invitationId: INVITATION,
        redemptionId: 'r1',
        projectId: 'p1',
        permissions: ['read', 'execute'],
      });
      const join = (overrides: Record<string, string> = {}) =>
        app.inject({
          method: 'POST',
          url: '/team/join',
          payload: {
            completionProtocol: 1,
            invitationId: INVITATION,
            secret,
            redemptionId: 'r1',
            displayName: 'Lena',
            ...overrides,
          },
        });
      const first = await join();
      expect(first.statusCode, first.body).toBe(200);
      const { token, userId } = first.json<{ token: string; userId: string }>();
      expect(registry.resolveUserId(token)).toBe(userId);
      expect(userId).not.toBe(ADMIN);
      for (const url of ['/projects', '/settings', '/me/providers']) {
        const protectedRead = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(protectedRead.statusCode, url).toBe(403);
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/team/join',
            payload: { invitationId: INVITATION, secret, redemptionId: 'r1', displayName: 'Lena' },
          })
        ).statusCode,
      ).toBe(409);

      expect(
        (await ctx.store.projectTeam.dueOperations()).some((op) => op.kind === 'team.join.commit'),
      ).toBe(false);
      expect(await ctx.store.projectTeam.confirmJoin('r1')).toBe(false);
      expect((await app.inject({ method: 'GET', url: '/team/join/capabilities' })).json()).toEqual({
        completion: 1,
      });
      expect((await app.inject({ method: 'POST', url: '/team/join/complete' })).statusCode).toBe(
        401,
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/team/join/complete',
            headers: { authorization: `Bearer ${secret}` },
          })
        ).statusCode,
      ).toBe(410);
      const complete = () =>
        app.inject({
          method: 'POST',
          url: '/team/join/complete',
          headers: { authorization: `Bearer ${token}` },
        });
      expect((await complete()).json()).toEqual({ projectId: 'p1', confirmed: false });
      expect((await complete()).json()).toEqual({ projectId: 'p1', confirmed: false });
      expect(
        (await ctx.store.projectTeam.dueOperations()).filter(
          (op) => op.kind === 'team.join.commit',
        ),
      ).toHaveLength(1);
      // A lost answer must not create another device or change its bearer.
      const again = await join();
      expect(again.json()).toEqual(first.json());
      expect(await registry.list()).toHaveLength(1);
      const restartedRegistry = await createAuthTokenRegistry(ctx.store, { enabled: true });
      const restarted = Fastify();
      registerTeamJoinRoutes(restarted, { store: ctx.store, authRegistry: restartedRegistry });
      try {
        const replay = await restarted.inject({
          method: 'POST',
          url: '/team/join',
          payload: {
            completionProtocol: 1,
            invitationId: INVITATION,
            secret,
            redemptionId: 'r1',
            displayName: 'Lena',
          },
        });
        expect(replay.json()).toEqual(first.json());
        expect(restartedRegistry.resolveUserId(token)).toBe(userId);
      } finally {
        await restarted.close();
        restartedRegistry.dispose?.();
      }

      expect(await ctx.store.projectTeam.confirmJoin('r1')).toBe(true);
      expect((await complete()).json()).toEqual({ projectId: 'p1', confirmed: true });
      expect((await join()).statusCode).toBe(410);
      const wrongSecret = await join({ secret: 'A'.repeat(43), redemptionId: 'r2' });
      const otherRedemption = await join({ redemptionId: 'r3' });
      const unknown = await join({ invitationId: 'B'.repeat(43), redemptionId: 'r4' });
      // A redemption no accepted tunnel carries, as an app inventing one would send.
      const invented = await join({ redemptionId: 'invented' });
      for (const refused of [wrongSecret, otherRedemption, unknown, invented]) {
        expect(refused.statusCode).toBe(410);
        expect(refused.json()).toEqual(wrongSecret.json());
      }
    } finally {
      await app.close();
      registry.dispose?.();
    }
  });
});
