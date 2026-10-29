import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appDocument, registerMcpAppsRoutes } from './mcp-apps-routes.js';
import { connectionFingerprint, type McpAppEvent } from './mcp-apps.js';
import { dashboardFixture } from './mcp-apps-fixture.test-helper.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup() {
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
  const approve = vi.fn(async () => true);
  const closeSession = vi.fn(async () => undefined);
  const app = Fastify();
  apps.push(app);
  registerMcpAppsRoutes(app, {
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
