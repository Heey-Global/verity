import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerDopplerConnectionRoutes } from './doppler-connection-routes.js';
import { authorizePairedRoute } from './paired-route-policy.js';

function harness() {
  const tokens = new Map<string, string>();
  const store = {
    getProjectSettings: async (projectId: string) =>
      projectId === 'p1' ? { dopplerProject: 'demo', dopplerConfig: 'dev' } : undefined,
    isActiveAdministrator: async (userId: string) => userId === 'admin',
    userDopplerConnections: {
      status: async (userId: string, projectId: string) =>
        tokens.has(`${userId}/${projectId}`) ? { updatedAt: new Date(0) } : undefined,
      set: async (userId: string, projectId: string, token: string) => {
        tokens.set(`${userId}/${projectId}`, token);
      },
      delete: async (userId: string, projectId: string) => {
        tokens.delete(`${userId}/${projectId}`);
      },
    },
  };
  const listNames = vi.fn(async ({ token }: { token: Uint8Array }) => {
    if (Buffer.from(token).toString() !== 'dp.st.good') throw new Error('403');
    return ['API_KEY'];
  });
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
        hasProjectPermission: async (userId, _projectId, permission) =>
          userId !== 'reader' || permission === 'read',
        getSession: async () => undefined,
      },
      request.localUserId!,
      request.method,
      request.routeOptions.url!,
      request.params as Record<string, unknown>,
    );
    if (outcome !== 'allow') return reply.code(403).send();
  });
  registerDopplerConnectionRoutes(app, { store: store as never, listNames });
  return { app, tokens, listNames };
}

const put = (app: FastifyInstance, user: string, payload: unknown) =>
  app.inject({
    method: 'PUT',
    url: '/projects/p1/doppler/connection',
    headers: { 'x-test-user': user },
    payload: payload as object,
  });

describe('personal Doppler connection routes', () => {
  // The token is the person's own credential: it is stored for them alone, checked
  // against the project's config first, and never returned.
  it('stores a working token for the signed-in person only and never returns it', async () => {
    const { app, tokens } = harness();
    expect((await put(app, 'lena', { token: 'dp.st.wrong' })).statusCode).toBe(400);
    expect(tokens.size).toBe(0);
    expect((await put(app, 'lena', { token: 'dp.st.good', userId: 'admin' })).statusCode).toBe(400);

    const saved = await put(app, 'lena', { token: 'dp.st.good' });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('dp.st.good');
    expect(saved.json()).toMatchObject({
      connected: true,
      binding: { dopplerProject: 'demo', dopplerConfig: 'dev' },
      usesInstanceToken: false,
    });
    expect([...tokens.keys()]).toEqual(['lena/p1']);

    const admin = await app.inject({
      url: '/projects/p1/doppler/connection',
      headers: { 'x-test-user': 'admin' },
    });
    expect(admin.json()).toMatchObject({ connected: false, usesInstanceToken: true });

    const removed = await app.inject({
      method: 'DELETE',
      url: '/projects/p1/doppler/connection',
      headers: { 'x-test-user': 'lena' },
    });
    expect(removed.statusCode).toBe(204);
    expect(tokens.size).toBe(0);
  });

  it('needs execute permission on the project', async () => {
    const { app } = harness();
    expect((await put(app, 'reader', { token: 'dp.st.good' })).statusCode).toBe(403);
  });
});
