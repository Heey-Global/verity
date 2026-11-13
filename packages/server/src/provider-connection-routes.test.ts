import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AgentLoginPublic, AgentLoginService } from './agent-login.js';
import { authorizePairedRoute } from './paired-route-policy.js';
import { registerProviderConnectionRoutes } from './provider-connection-routes.js';

function harness() {
  const stored = new Map<
    string,
    { credential: string; baseUrl?: string | null; models?: string | null }
  >();
  const login = (sessionId: string): AgentLoginPublic => ({
    sessionId,
    provider: 'codex',
    status: 'ready',
    verificationUri: 'https://auth.openai.com/codex/device',
    userCode: 'K7QF-2MXR',
    needsCode: false,
    configured: false,
    message: null,
  });
  const agentLogin = {
    start: vi.fn(async () => login('s1')),
    get: vi.fn(async (sessionId: string, requester?: string) => {
      if (requester !== 'lena') throw new Error('login session not found');
      return login(sessionId);
    }),
    submitCode: vi.fn(async () => login('s1')),
    close: () => undefined,
  } satisfies AgentLoginService;
  const app = Fastify();
  app.decorateRequest('localUserId', null);
  app.addHook('onRequest', async (request) => {
    request.localUserId = String(request.headers['x-test-user']);
  });
  app.addHook('preHandler', async (request, reply) => {
    const outcome = await authorizePairedRoute(
      {
        isActiveLocalUser: async (id) => id !== 'disabled',
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
  registerProviderConnectionRoutes(app, {
    store: {
      isActiveAdministrator: async (id: string) => id === 'admin',
      userProviderConnections: {
        status: async (userId: string) =>
          [...stored.entries()]
            .filter(([key]) => key.startsWith(`${userId}/`))
            .map(([key, value]) => ({
              provider: key.split('/')[1],
              baseUrl: value.baseUrl ?? null,
              models: value.models ?? null,
              updatedAt: new Date(0),
            })),
        set: async (userId: string, provider: string, value: { credential: string }) => {
          stored.set(`${userId}/${provider}`, value);
        },
        delete: async (userId: string, provider: string) => {
          stored.delete(`${userId}/${provider}`);
        },
      },
    } as never,
    agentLogin,
    listOpenCodeModels: async (_baseUrl, apiKey) => {
      if (apiKey !== 'sk-good') throw new Error('401');
      return ['m1', 'm2'];
    },
  });
  return { app, agentLogin, stored };
}

const as = (
  app: FastifyInstance,
  user: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) => app.inject({ method, url, headers: { 'x-test-user': user }, ...(payload ? { payload } : {}) });

describe('personal provider connection routes', () => {
  // A login started by one person belongs to them: it is started for them, and
  // another person cannot read its code or finish it.
  it('starts a login for the signed-in person and keeps it from others', async () => {
    const { app, agentLogin } = harness();
    expect((await as(app, 'lena', 'POST', '/me/provider-connections/codex/login')).statusCode).toBe(
      200,
    );
    expect(agentLogin.start).toHaveBeenCalledWith('codex', 'lena');
    expect((await as(app, 'lena', 'GET', '/me/provider-connections/logins/s1')).statusCode).toBe(
      200,
    );
    expect((await as(app, 'mia', 'GET', '/me/provider-connections/logins/s1')).statusCode).toBe(
      404,
    );
    expect((await as(app, 'disabled', 'GET', '/me/provider-connections')).statusCode).toBe(403);
  });

  // An OpenCode key is stored only after it answered with models, for its owner
  // alone, and is never returned.
  it("checks and stores a person's OpenCode connection without returning the key", async () => {
    const { app, stored } = harness();
    const bad = await as(app, 'lena', 'PUT', '/me/provider-connections/opencode', {
      baseUrl: 'https://llm.example/v1',
      apiKey: 'sk-bad',
    });
    expect(bad.statusCode).toBe(400);
    expect(stored.size).toBe(0);
    const good = await as(app, 'lena', 'PUT', '/me/provider-connections/opencode', {
      baseUrl: 'https://llm.example/v1',
      apiKey: 'sk-good',
    });
    expect(good.statusCode).toBe(200);
    expect(good.body).not.toContain('sk-good');
    expect([...stored.keys()]).toEqual(['lena/opencode']);
    const listed = await as(app, 'lena', 'GET', '/me/provider-connections');
    expect(listed.json()).toEqual({
      connections: [
        {
          provider: 'opencode',
          baseUrl: 'https://llm.example/v1',
          models: ['m1', 'm2'],
          updatedAt: new Date(0).toISOString(),
        },
      ],
      usesInstanceLogins: false,
    });
    expect(listed.body).not.toContain('sk-good');
    expect((await as(app, 'lena', 'DELETE', '/me/provider-connections/opencode')).statusCode).toBe(
      204,
    );
    expect(stored.size).toBe(0);
  });
});
