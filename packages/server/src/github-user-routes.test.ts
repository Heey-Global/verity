import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { GitHubUserAuthorization } from './github-user-authorization.js';
import { registerGitHubUserRoutes } from './github-user-routes.js';
import { authorizePairedRoute } from './paired-route-policy.js';

describe('GitHub user routes', () => {
  it('let a member manage only their own GitHub, and only the administrator the App client', async () => {
    const app = Fastify();
    app.decorateRequest('localUserId', null);
    app.addHook('onRequest', async (request) => {
      request.localUserId = String(request.headers['x-test-user']);
    });
    app.addHook('preHandler', async (request, reply) => {
      const outcome = await authorizePairedRoute(
        {
          isActiveLocalUser: async () => true,
          isActiveAdministrator: async (id) => id === 'admin',
          hasProjectPermission: async () => false,
          getSession: async () => undefined,
        },
        request.localUserId!,
        request.method,
        request.routeOptions.url!,
        request.params as Record<string, unknown>,
      );
      if (outcome !== 'allow') return reply.code(403).send();
    });
    const authorization = {
      start: vi.fn(async () => ({ authorizeUrl: 'https://github.com/login/oauth/authorize' })),
      complete: vi.fn(async () => ({ login: 'lena-dev' })),
      status: vi.fn(async () => ({ configured: true, connected: false, login: null })),
      disconnect: vi.fn(async () => undefined),
      accessToken: vi.fn(async () => undefined),
    } satisfies GitHubUserAuthorization;
    const updateVeritySettings = vi.fn(async () => undefined);
    registerGitHubUserRoutes(app, {
      authorization,
      store: { updateVeritySettings } as never,
    });
    const lena = { 'x-test-user': 'lena' };
    const state = 'Ab_-'.repeat(10) + 'xyz';

    expect((await app.inject({ url: '/me/github', headers: lena })).statusCode).toBe(200);
    expect(authorization.status).toHaveBeenCalledWith('lena');
    expect(
      (await app.inject({ method: 'POST', url: '/me/github/authorize', headers: lena })).statusCode,
    ).toBe(200);
    expect(authorization.start).toHaveBeenCalledWith('lena');
    // A body naming another person is rejected, not silently ignored.
    const foreign = await app.inject({
      method: 'POST',
      url: '/me/github/authorize/complete',
      headers: lena,
      payload: { code: 'c', state, userId: 'admin' },
    });
    expect(foreign.statusCode).toBe(400);
    await app.inject({
      method: 'POST',
      url: '/me/github/authorize/complete',
      headers: lena,
      payload: { code: 'c', state },
    });
    expect(authorization.complete).toHaveBeenCalledWith('lena', { code: 'c', state });
    expect(
      (await app.inject({ method: 'DELETE', url: '/me/github', headers: lena })).statusCode,
    ).toBe(204);
    expect(authorization.disconnect).toHaveBeenCalledWith('lena');

    const client = { clientId: 'Iv1.client', clientSecret: 'secret' };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/settings/github/oauth-client',
          headers: lena,
          payload: client,
        })
      ).statusCode,
    ).toBe(403);
    expect(updateVeritySettings).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/settings/github/oauth-client',
          headers: { 'x-test-user': 'admin' },
          payload: client,
        })
      ).statusCode,
    ).toBe(200);
    expect(updateVeritySettings).toHaveBeenCalledWith({
      githubAppClientId: 'Iv1.client',
      githubAppClientSecret: 'secret',
    });
  });
});
