import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { McpOAuthAuthorizationRequired } from './http-mcp-oauth-errors.js';
import { registerHttpMcpProxyRoute } from './http-mcp-proxy.js';
vi.mock('./internal-listener.js', () => ({
  internalConnectionIdentity: () => ({ projectId: 'project', containerGeneration: 'generation' }),
}));

it.each(['POST', 'GET', 'DELETE'] as const)(
  'reports missing OAuth authority as 401 on %s',
  async (method) => {
    const app = Fastify();
    const resolveConnection = vi.fn(async () => {
      throw new McpOAuthAuthorizationRequired();
    });
    registerHttpMcpProxyRoute(app, {
      resolveCaller: async () => ({ sessionId: 'session', turnId: 'turn' }),
      resolveConnection,
    });
    try {
      const response = await app.inject({
        method,
        url: '/internal/mcp-proxy',
        headers: { authorization: 'Bearer turn-token', 'x-verity-mcp-binding': 'tools' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: 'mcp_oauth_authorization_required',
        message: expect.stringContaining('Reconnect OAuth'),
      });
      expect(resolveConnection).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  },
);
it('keeps upstream resolution failures distinct from authorization failures', async () => {
  const app = Fastify();
  registerHttpMcpProxyRoute(app, {
    resolveCaller: async () => ({ sessionId: 'session', turnId: 'turn' }),
    resolveConnection: async () => {
      throw new Error('network failure');
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/mcp-proxy',
      headers: { authorization: 'Bearer turn-token', 'x-verity-mcp-binding': 'tools' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('network failure');
  } finally {
    await app.close();
  }
});
