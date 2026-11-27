import type { HTTPMethods } from 'fastify';
import { expect, it, vi } from 'vitest';
import { createServerApp, installHttpGuards } from './server-http.js';
import type { ServerContext } from './server-context.js';
import type { ServerDeps } from './server-deps.js';
import { LOCKOUT_CRITICAL_KEYS } from './route-scopes.js';
import { registerMcpAppsRoutes } from './mcp-apps-routes.js';
import { createMcpAppAuthorization } from './mcp-apps-authorization.js';
import { connectionFingerprint, type McpAppEvent } from './mcp-apps.js';
import { dashboardFixture } from './mcp-apps-fixture.test-helper.js';

it('admits only document tickets through the real global gate and rechecks requester revocation', async () => {
  let active = true;
  const registry = {
    isEnabled: () => true,
    verify: (token: string | undefined) => active && token === 'device-token',
    resolveUserId: () => 'viewer',
    touch: vi.fn(),
  };
  const store = {
    isActiveLocalUser: async () => true,
    isActiveAdministrator: async () => false,
    hasProjectPermission: async (_user: string, project: string, permission: string) =>
      project === 'p' && permission === 'read',
    getSession: async (id: string) => (id === 's' ? { projectId: 'p' } : undefined),
  };
  const deps = { authRegistry: registry, eventStore: store } as unknown as ServerDeps;
  const { app, lifecycle, preAuthKeys } = createServerApp(deps);
  installHttpGuards(app, { deps, lifecycle } as ServerContext, { preAuthKeys });
  for (const key of LOCKOUT_CRITICAL_KEYS) {
    const [method, url] = key.split(' ');
    app.route({ method: method as HTTPMethods, url: url!, handler: async () => ({}) });
  }
  const connection = { id: 'c', url: 'https://fixture.example' };
  const event: McpAppEvent = {
    t: 'mcp_app',
    appId: '00000000-0000-4000-8000-000000000001',
    projectId: 'p',
    sessionId: 's',
    turnId: 't',
    connectionId: 'c',
    connectionFingerprint: connectionFingerprint(connection),
    toolName: 'dashboard',
    resourceUri: 'ui://dashboard',
    input: {},
    result: { content: [] },
  };
  registerMcpAppsRoutes(app, {
    ...createMcpAppAuthorization(deps),
    resolveConnection: async () => connection,
    getProjectId: async () => 'p',
    getApp: async () => event,
    emit: async () => {},
    approve: async () => true,
    settled: async () => {},
    closeSession: async () => {},
    rpc: dashboardFixture().rpc,
  });
  const url = `/sessions/s/mcp-apps/${event.appId}`;
  const headers = { authorization: 'Bearer device-token' };
  try {
    expect((await app.inject({ method: 'POST', url: `${url}/document` })).statusCode).toBe(401);
    expect((await app.inject('/mcp-app-document')).statusCode).toBe(404);
    const mint = async () =>
      (await app.inject({ method: 'POST', url: `${url}/document`, headers })).json().path as string;
    const first = await mint();
    expect((await app.inject(first)).statusCode).toBe(200);
    expect((await app.inject(first)).statusCode).toBe(404);
    const revoked = await mint();
    active = false;
    expect((await app.inject(revoked)).statusCode).toBe(404);
    active = true;
    // Read access can mint a document but cannot execute app tools.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${url}/call`,
          headers,
          payload: { name: 'refresh' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${url}/document`,
          headers: {
            authorization: `Bearer ${new URL(first, 'https://verity.example').searchParams.get('ticket')}`,
          },
        })
      ).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
  }
});
