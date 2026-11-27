import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appDocument, registerMcpAppsRoutes } from './mcp-apps-routes.js';
import { connectionFingerprint, type McpAppEvent } from './mcp-apps.js';
import { dashboardFixture } from './mcp-apps-fixture.test-helper.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(userId?: string) {
  const fixture = dashboardFixture();
  const connection = { id: 'c', url: 'https://mcp.example.com', authorization: 'Bearer account-a' };
  const event: McpAppEvent = {
    t: 'mcp_app',
    appId: '00000000-0000-4000-8000-000000000001',
    projectId: 'p',
    sessionId: 's',
    turnId: 'finished-turn',
    connectionId: 'c',
    connectionFingerprint: connectionFingerprint(connection),
    toolName: 'dashboard',
    resourceUri: 'ui://dashboard',
    input: { city: 'Berlin' },
    result: { content: [{ type: 'text', text: 'Count: 0' }], structuredContent: { count: 0 } },
  };
  const events = [event];
  const resolveConnection = vi.fn(async () => connection as typeof connection | undefined);
  const authorizeRequest = vi.fn(async () => true);
  const approve = vi.fn(async () => true);
  const closeSession = vi.fn(async () => undefined);
  const app = Fastify();
  apps.push(app);
  if (userId !== undefined) {
    app.decorateRequest('localUserId', null);
    app.addHook('onRequest', async (request) => {
      request.localUserId = userId;
    });
  }
  registerMcpAppsRoutes(app, {
    authorizeRequest,
    captureDocumentAccess: () => () => authorizeRequest(),
    resolveConnection,
    getProjectId: async (sessionId) => (sessionId === 's' ? 'p' : undefined),
    getApp: async (_sessionId, appId) => events.findLast((candidate) => candidate.appId === appId),
    emit: async (_sessionId, next) => {
      events.push(next);
    },
    approve,
    settled: vi.fn(async () => undefined),
    rpc: fixture.rpc,
    closeSession,
  });
  const url = `/sessions/s/mcp-apps/${event.appId}`;
  const refresh = () =>
    app.inject({ method: 'POST', url: `${url}/call`, payload: { name: 'refresh', arguments: {} } });
  return {
    app,
    fixture,
    connection,
    events,
    event,
    resolveConnection,
    approve,
    authorizeRequest,
    closeSession,
    url,
    refresh,
  };
}

describe('MCP Apps scoped routes', () => {
  it('loads the resource, refreshes after the originating turn, and persists the new snapshot without replay', async () => {
    const f = setup();
    const page = await f.app.inject({ method: 'GET', url: f.url });
    expect(page.statusCode).toBe(200);
    expect(page.json().document).toContain('Dashboard');
    expect(f.fixture.calls.filter((call) => call.method === 'tools/call')).toHaveLength(0);
    const refreshed = await f.refresh();
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().structuredContent.count).toBe(1);
    expect(f.events.at(-1)?.result.structuredContent).toEqual({ count: 1 });
    expect(f.events.at(-1)?.appId).toBe(f.event.appId);
    expect(f.events.at(-1)?.input).toEqual({ city: 'Berlin' });
    expect(f.approve).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's',
        input: { appId: f.event.appId, tool: 'refresh', arguments: {} },
      }),
    );
    await f.app.inject({ method: 'GET', url: f.url });
    expect(f.fixture.calls.filter((call) => call.method === 'tools/call')).toHaveLength(1);
    expect(f.fixture.calls.some((call) => call.method === 'notifications/initialized')).toBe(true);
    expect(f.closeSession).toHaveBeenCalledTimes(3);
  });

  it('rejects model-only, foreign-server and forged-session requests before approval', async () => {
    const f = setup();
    for (const name of ['model_only', 'foreign_tool']) {
      const response = await f.app.inject({
        method: 'POST',
        url: `${f.url}/call`,
        payload: { name },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: f.url.replace('/sessions/s/', '/sessions/foreign/'),
        })
      ).statusCode,
    ).toBe(404);
    expect(f.approve).not.toHaveBeenCalled();
    expect(f.fixture.calls.some((call) => call.method === 'tools/call')).toBe(false);
  });

  it('denies tool execution when approval is refused', async () => {
    const f = setup();
    f.approve.mockResolvedValue(false);
    expect((await f.refresh()).statusCode).toBe(403);
    expect(f.fixture.calls.some((call) => call.method === 'tools/call')).toBe(false);
    expect(f.events).toHaveLength(1);
  });

  it('rechecks revocation while approval is pending', async () => {
    const f = setup();
    f.approve.mockImplementation(async () => {
      f.resolveConnection.mockResolvedValue(undefined);
      return true;
    });
    expect((await f.refresh()).statusCode).toBe(404);
    expect(f.fixture.calls.some((call) => call.method === 'tools/call')).toBe(false);
  });

  it('rechecks requester access after approval before executing', async () => {
    const f = setup();
    f.approve.mockImplementation(async () => {
      f.authorizeRequest.mockResolvedValue(false);
      return true;
    });
    expect((await f.refresh()).statusCode).toBe(403);
    expect(f.authorizeRequest).toHaveBeenCalledOnce();
    expect(f.fixture.calls.some((call) => call.method === 'tools/call')).toBe(false);
    expect(f.events).toHaveLength(1);
  });

  it('rejects removed bindings and replaced credentials for reads and actions', async () => {
    const f = setup();
    f.connection.authorization = 'Bearer account-b';
    expect((await f.refresh()).statusCode).toBe(404);
    expect((await f.app.inject({ method: 'GET', url: f.url })).statusCode).toBe(404);
    expect(f.fixture.calls).toHaveLength(0);
    f.resolveConnection.mockResolvedValue(undefined);
    expect((await f.refresh()).statusCode).toBe(404);
  });

  it('rejects a changed originating tool resource even when another tool remains app-visible', async () => {
    const f = setup();
    f.fixture.tools[0]!._meta.ui.resourceUri = 'ui://another';
    expect((await f.refresh()).statusCode).toBe(403);
    expect(f.approve).not.toHaveBeenCalled();
  });
});

describe('MCP Apps connection rights', () => {
  // The app was rendered by someone's turn, but the person using it now may be
  // another member. Resolving by the originating turn would let them act with
  // that turn's credentialed connection.
  it('resolves the connection for the person using the app, not the originating turn', async () => {
    const f = setup('bob');
    expect((await f.app.inject({ method: 'GET', url: f.url })).statusCode).toBe(200);
    expect((await f.refresh()).statusCode).toBe(200);
    expect(f.resolveConnection).toHaveBeenCalled();
    for (const [input] of f.resolveConnection.mock.calls as unknown as [{ principal: unknown }][])
      expect(input.principal).toEqual({ userId: 'bob' });
  });
});

describe('MCP Apps document sandbox policy', () => {
  it('puts a restrictive policy before untrusted HTML and disables forms, frames and workers', () => {
    const html = appDocument('<script>window.parent.document.cookie</script>', {});
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'));
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "worker-src 'none'",
    ])
      expect(html).toContain(directive);
  });

  it('allows only declared HTTPS origins and rejects CSP injection', () => {
    const html = appDocument('', {
      ui: {
        csp: {
          resourceDomains: ['https://cdn.example.com'],
          connectDomains: ['https://api.example.com'],
        },
      },
    });
    expect(html).toContain('connect-src https://api.example.com');
    expect(html).toContain("script-src 'unsafe-inline' https://cdn.example.com");
    for (const origin of [
      'https://example.com; *',
      'http://example.com',
      'https://example.com/path',
      'https://example.com/" onload="bad',
    ])
      expect(() => appDocument('', { ui: { csp: { resourceDomains: [origin] } } })).toThrow();
  });
});

it('serves a sandboxed HTML document once without replaying tools', async () => {
  const f = setup('viewer');
  const minted = await f.app.inject({ method: 'POST', url: `${f.url}/document` });
  expect(minted.statusCode).toBe(200);
  expect(minted.headers['cache-control']).toBe('no-store');
  const path = minted.json<{ path: string }>().path;
  expect(path).toMatch(/^\/mcp-app-document\?ticket=[A-Za-z0-9_-]{43}$/);
  const page = await f.app.inject(path);
  expect(page.statusCode).toBe(200);
  expect(page.headers['content-type']).toContain('text/html');
  expect(page.headers['content-security-policy']).toContain('sandbox allow-scripts;');
  expect(page.headers['content-security-policy']).not.toContain('allow-same-origin');
  expect(page.headers['content-security-policy']).toContain("script-src 'unsafe-inline'");
  expect(page.headers['cache-control']).toBe('no-store');
  expect(page.headers['referrer-policy']).toBe('no-referrer');
  expect(page.headers['x-content-type-options']).toBe('nosniff');
  expect(page.body).toContain('ui/initialize');
  expect((await f.app.inject(path)).statusCode).toBe(404);
  expect(f.fixture.calls.some((call) => call.method === 'tools/call')).toBe(false);
  expect(f.resolveConnection).toHaveBeenLastCalledWith(
    expect.objectContaining({
      principal: { userId: 'viewer' },
    }),
  );
});

it('rejects missing, malformed and expired document tickets', async () => {
  const f = setup();
  for (const path of [
    '/mcp-app-document',
    '/mcp-app-document?ticket=no',
    `/mcp-app-document?ticket=${'x'.repeat(43)}`,
  ]) {
    expect((await f.app.inject(path)).statusCode).toBe(404);
  }
  const minted = await f.app.inject({ method: 'POST', url: `${f.url}/document` });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001);
  try {
    expect((await f.app.inject(minted.json<{ path: string }>().path)).statusCode).toBe(404);
  } finally {
    clock.mockRestore();
  }
  expect(f.fixture.calls).toHaveLength(0);
});

it('rejects foreign sessions and rechecks access and connection revocation at redemption', async () => {
  const f = setup();
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: f.url.replace('/sessions/s/', '/sessions/foreign/') + '/document',
      })
    ).statusCode,
  ).toBe(404);
  const mint = async () =>
    (await f.app.inject({ method: 'POST', url: `${f.url}/document` })).json().path as string;
  const denied = await mint();
  f.authorizeRequest.mockResolvedValue(false);
  expect((await f.app.inject(denied)).statusCode).toBe(404);
  expect((await f.app.inject({ method: 'POST', url: `${f.url}/document` })).statusCode).toBe(403);
  f.authorizeRequest.mockResolvedValue(true);
  const revoked = await mint();
  f.resolveConnection.mockResolvedValue(undefined);
  expect((await f.app.inject(revoked)).statusCode).toBe(404);
  expect(f.fixture.calls).toHaveLength(0);
});

it('rechecks access after reading HTML before releasing it', async () => {
  const f = setup();
  const minted = await f.app.inject({ method: 'POST', url: `${f.url}/document` });
  f.authorizeRequest.mockResolvedValueOnce(true).mockResolvedValue(false);
  expect((await f.app.inject(minted.json<{ path: string }>().path)).statusCode).toBe(404);
});
