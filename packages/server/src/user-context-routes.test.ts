import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ContextConflictError, type UserContextStore } from '@verity/store';
import { registerUserContextRoutes } from './user-context-routes.js';

describe('personal context routes', () => {
  it('takes identity only from authentication and preserves conflicting drafts', async () => {
    const app = Fastify();
    app.decorateRequest('localUserId', null);
    app.addHook('onRequest', async (request) => {
      if (request.headers.authorization === 'Bearer paired') request.localUserId = 'u1';
    });
    const store = {
      read: vi.fn(async () => ({ instructions: '', memory: '', revision: 0 })),
      replace: vi.fn(async () => {
        throw new ContextConflictError('changed');
      }),
    };
    registerUserContextRoutes(app, store as unknown as UserContextStore);
    expect((await app.inject('/me/context')).statusCode).toBe(401);
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
