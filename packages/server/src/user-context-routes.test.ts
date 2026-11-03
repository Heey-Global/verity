import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ContextConflictError, type UserContextStore } from '@verity/store';
import { registerUserContextRoutes } from './user-context-routes.js';
import { authorizePairedRoute } from './paired-route-policy.js';

describe('personal context routes', () => {
  it('takes identity only from authentication and preserves conflicting drafts', async () => {
    const app = Fastify();
    app.decorateRequest('localUserId', null);
    app.addHook('onRequest', async (request) => {
      if (request.headers.authorization === 'Bearer paired') request.localUserId = 'u1';
      if (request.headers.authorization === 'Bearer disabled') request.localUserId = 'disabled';
    });
    app.addHook('preHandler', async (request, reply) => {
      if (!request.localUserId) return;
      const outcome = await authorizePairedRoute(
        {
          isActiveLocalUser: async (id) => id === 'u1',
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
    const store = {
      read: vi.fn(async () => ({ instructions: '', memory: '', revision: 0 })),
      replace: vi.fn(async () => {
        throw new ContextConflictError('changed');
      }),
    };
    registerUserContextRoutes(app, store as unknown as UserContextStore);
    expect((await app.inject('/me/context')).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/me/context', headers: { authorization: 'Bearer disabled' } }))
        .statusCode,
    ).toBe(403);
    const authenticated = { authorization: 'Bearer paired' };
    expect((await app.inject({ url: '/me/context', headers: authenticated })).statusCode).toBe(200);
    expect(store.read).toHaveBeenCalledWith('u1');
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/me/context',
          headers: authenticated,
          payload: { revision: 0, instructions: '', memory: '', userId: 'other' },
        })
      ).statusCode,
    ).toBe(400);
    expect(store.replace).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/me/context',
          headers: authenticated,
          payload: { revision: 0, instructions: '', memory: '' },
        })
      ).statusCode,
    ).toBe(409);
    expect(store.replace).toHaveBeenCalledWith('u1', 0, expect.anything());
    await app.close();
  });
});
