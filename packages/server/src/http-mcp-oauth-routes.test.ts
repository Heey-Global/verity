import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventStore, HttpMcpConnectionRecord } from '@verity/store';
import { registerHttpMcpConnectionRoutes } from './http-mcp-connections-route.js';
import { completeHttpMcpOAuth } from './http-mcp-oauth.js';
import { discoverMcpOAuth, registerMcpOAuthClient } from './http-mcp-oauth-discovery.js';

vi.mock('./http-mcp-oauth.js', () => ({ completeHttpMcpOAuth: vi.fn(async () => undefined) }));
vi.mock('./http-mcp-oauth-discovery.js', () => ({
  discoverMcpOAuth: vi.fn(),
  registerMcpOAuthClient: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
const discovery = {
  authorizationEndpoint: 'https://identity.example/authorize',
  tokenEndpoint: 'https://identity.example/token',
  scopes: 'read',
  registrationAvailable: true,
};
const record: HttpMcpConnectionRecord = {
  id: 'tools',
  name: 'tools',
  ownerUserId: 'owner',
  enabled: true,
  url: 'https://tools.example/mcp',
  authorization: null,
  authType: 'oauth',
  oauthClientId: 'client',
  oauthClientSecret: 'secret',
  oauthAuthorizationEndpoint: discovery.authorizationEndpoint,
  oauthTokenEndpoint: discovery.tokenEndpoint,
  oauthScopes: 'read',
};
function harness() {
  const records = new Map([[record.id, record]]);
  const upsert = vi.fn(async (item: HttpMcpConnectionRecord) => {
    records.set(item.id, item);
  });
  const store = {
    listHttpMcpConnections: async (ownerId?: string) =>
      [...records.values()].filter((item) => ownerId === undefined || item.ownerUserId === ownerId),
    upsertHttpMcpConnection: upsert,
  } as unknown as EventStore;
  const app = Fastify();
  app.decorateRequest('localUserId', null);
  app.addHook('onRequest', async (request) => {
    request.localUserId = String(request.headers['x-user'] ?? 'owner');
  });
  app.setErrorHandler((_error, _request, reply) =>
    reply.code(400).send({ error: 'Invalid request' }),
  );
  registerHttpMcpConnectionRoutes(app, store, {
    browserRequestOrigin: () => 'https://trusted.tail.example',
  });
  return { app, store, records, upsert };
}
describe('MCP OAuth API', () => {
  it('uses the trusted gateway origin instead of an arbitrary callback or forwarded host', async () => {
    const { app } = harness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/mcp-connections/tools/oauth/start',
        headers: { host: 'internal.invalid', 'x-forwarded-host': 'evil.example' },
        payload: { platform: 'web' },
      });
      expect(response.statusCode).toBe(200);
      const flow = response.json<{ state: string; redirectUri: string }>();
      expect(flow.redirectUri).toBe('https://trusted.tail.example/app/mcp/oauth/callback');
      expect(response.body).not.toContain('secret');
      expect(response.headers['cache-control']).toBe('no-store');
      const finished = await app.inject({
        method: 'POST',
        url: '/mcp-connections/tools/oauth/complete',
        payload: { code: 'code', state: flow.state },
      });
      expect(finished.statusCode).toBe(200);
      expect(completeHttpMcpOAuth).toHaveBeenCalledTimes(1);
      const replay = await app.inject({
        method: 'POST',
        url: '/mcp-connections/tools/oauth/complete',
        payload: { code: 'code', state: flow.state },
      });
      expect(replay.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('prevents another user from starting, consuming or cancelling a flow', async () => {
    const { app } = harness();
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/mcp-connections/tools/oauth/start',
        payload: { platform: 'native' },
      });
      const flow = first.json<{ state: string }>();
      for (const suffix of ['start', 'complete']) {
        const response = await app.inject({
          method: 'POST',
          url: `/mcp-connections/tools/oauth/${suffix}`,
          headers: { 'x-user': 'other' },
          payload:
            suffix === 'start' ? { platform: 'native' } : { code: 'code', state: flow.state },
        });
        expect(response.statusCode).toBe(404);
      }
      await app.inject({
        method: 'POST',
        url: '/mcp-connections/tools/oauth/cancel',
        headers: { 'x-user': 'other' },
        payload: { state: flow.state },
      });
      const response = await app.inject({
        method: 'POST',
        url: '/mcp-connections/tools/oauth/complete',
        payload: { code: 'code', state: flow.state },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
  it('rejects caller-supplied redirect URIs, verifiers and callbacks without a server state', async () => {
    const { app } = harness();
    try {
      for (const payload of [
        {
          code: 'code',
          codeVerifier: 'v'.repeat(43),
          redirectUri: 'https://verity.build/mcp/oauth/callback',
        },
        { code: 'code', state: 'unknown' },
      ]) {
        const result = await app.inject({
          method: 'POST',
          url: '/mcp-connections/tools/oauth/complete',
          payload,
        });
        expect(result.statusCode).toBe(400);
      }
      expect(completeHttpMcpOAuth).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('registers a client for native and web callbacks without returning its secret', async () => {
    const { app, upsert } = harness();
    vi.mocked(discoverMcpOAuth).mockResolvedValue({
      discovery,
      authority: {
        issuer: 'https://identity.example/',
        authorization_endpoint: discovery.authorizationEndpoint,
        token_endpoint: discovery.tokenEndpoint,
        registration_endpoint: 'https://identity.example/register',
      },
    });
    vi.mocked(registerMcpOAuthClient).mockResolvedValue({
      clientId: 'registered',
      clientSecret: 'registered-secret',
      tokenAuthMethod: 'client_secret_basic',
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/mcp-connections',
        payload: { name: 'automatic', url: 'https://tools.example/mcp', authType: 'oauth' },
      });
      expect(response.statusCode).toBe(201);
      expect(registerMcpOAuthClient).toHaveBeenCalledWith(
        expect.anything(),
        [
          'https://verity.build/mcp/oauth/callback',
          'https://trusted.tail.example/app/mcp/oauth/callback',
        ],
        'read',
      );
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          oauthClientSecret: 'registered-secret',
          oauthTokenAuthMethod: 'client_secret_basic',
        }),
      );
      expect(response.body).not.toContain('registered-secret');
      const listed = await app.inject('/mcp-connections');
      expect(listed.body).not.toContain('registered-secret');
    } finally {
      await app.close();
    }
  });
  it('preserves manual OAuth setup and unmodified provider scopes without discovery', async () => {
    const { app, upsert } = harness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/mcp-connections',
        payload: {
          name: 'manual',
          url: 'https://tools.example/mcp',
          authType: 'oauth',
          oauthClientId: 'manual',
          oauthClientSecret: 'manual-secret',
          oauthAuthorizationEndpoint: discovery.authorizationEndpoint,
          oauthTokenEndpoint: discovery.tokenEndpoint,
          oauthScopes: 'read,write',
        },
      });
      expect(response.statusCode).toBe(201);
      expect(discoverMcpOAuth).not.toHaveBeenCalled();
      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ oauthScopes: 'read,write' }));
    } finally {
      await app.close();
    }
  });
});
