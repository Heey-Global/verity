import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { normalizeDisplayName } from '@verity/store';
import { authorizePairedRoute } from './paired-route-policy.js';
import { registerUserProfileRoutes } from './user-profile-routes.js';

describe('personal profile routes', () => {
  it('lets every active user name themself, and only themself', async () => {
    const app = Fastify();
    app.decorateRequest('localUserId', null);
    app.addHook('onRequest', async (request) => {
      if (request.headers.authorization === 'Bearer member') request.localUserId = 'member';
      if (request.headers.authorization === 'Bearer disabled') request.localUserId = 'disabled';
    });
    // The real member policy: a member is neither administrator nor project
    // member here, so only an active-user route can reach the handler.
    app.addHook('preHandler', async (request, reply) => {
      if (!request.localUserId) return;
      const outcome = await authorizePairedRoute(
        {
          isActiveLocalUser: async (id) => id === 'member',
          isActiveAdministrator: async () => false,
          hasProjectPermission: async () => false,
          getSession: async () => undefined,
        },
        request.localUserId,
        request.method,
        request.routeOptions.url!,
        request.params as Record<string, unknown>,
      );
      if (outcome !== 'allow') return reply.code(403).send();
    });
    const names = new Map<string, string | null>([['member', null]]);
    const store = {
      read: vi.fn(async (userId: string) =>
        names.has(userId)
          ? { userId, role: 'member' as const, displayName: names.get(userId) ?? null }
          : undefined,
      ),
      setDisplayName: vi.fn(async (userId: string, input: string) => {
        names.set(userId, normalizeDisplayName(input));
        return { userId, role: 'member' as const, displayName: names.get(userId) ?? null };
      }),
    };
    registerUserProfileRoutes(app, store);
    const member = { authorization: 'Bearer member' };

    expect((await app.inject('/me/profile')).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/me/profile', headers: { authorization: 'Bearer disabled' } }))
        .statusCode,
    ).toBe(403);
    expect((await app.inject({ url: '/me/profile', headers: member })).json()).toEqual({
      userId: 'member',
      role: 'member',
      displayName: null,
    });

    // A body naming another person is rejected outright, not silently ignored.
    const foreign = await app.inject({
      method: 'PUT',
      url: '/me/profile',
      headers: member,
      payload: { displayName: 'Mallory', userId: 'admin' },
    });
    expect(foreign.statusCode).toBe(400);
    expect(store.setDisplayName).not.toHaveBeenCalled();

    const blank = await app.inject({
      method: 'PUT',
      url: '/me/profile',
      headers: member,
      payload: { displayName: '   ' },
    });
    expect(blank.statusCode).toBe(400);

    const saved = await app.inject({
      method: 'PUT',
      url: '/me/profile',
      headers: member,
      payload: { displayName: '  Lena ' },
    });
    expect(saved.json()).toMatchObject({ userId: 'member', displayName: 'Lena' });
    expect(store.setDisplayName).toHaveBeenLastCalledWith('member', '  Lena ');
  });
});
