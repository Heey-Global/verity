import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { READ_ONLY_GRANT_MS, registerMcpAppsRoutes } from './mcp-apps-routes.js';
import { connectionFingerprint, type McpAppEvent } from './mcp-apps.js';
import { dashboardFixture } from './mcp-apps-fixture.test-helper.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const APP_A = '00000000-0000-4000-8000-00000000000a';
const APP_B = '00000000-0000-4000-8000-00000000000b';

function setup() {
  const fixture = dashboardFixture();
  // An app-only tool the server declares read-only, next to the fixture's write-capable refresh.
  const preview = {
    name: 'preview',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true as boolean },
    _meta: { ui: { visibility: ['app'] } },
  };
  (fixture.tools as Record<string, unknown>[]).push(preview);
  const connection = { id: 'c', url: 'https://mcp.example.com', authorization: 'Bearer a' };
  const card = (appId: string): McpAppEvent => ({
    t: 'mcp_app',
    appId,
    projectId: 'p',
    sessionId: 's',
    turnId: 't',
    connectionId: 'c',
    connectionFingerprint: connectionFingerprint(connection),
    toolName: 'dashboard',
    resourceUri: 'ui://dashboard',
    input: {},
    result: { content: [] },
  });
  const events = [card(APP_A), card(APP_B)];
  let clock = 1_000_000;
  let user: string | null = 'user-a';
  const authorizeRequest = vi.fn(async () => true);
  const approve = vi.fn<(input: { input: Record<string, unknown> }) => Promise<boolean>>(
    async () => true,
  );
  const settled = vi.fn(async () => undefined);
  const app = Fastify();
  apps.push(app);
  app.decorateRequest('localUserId', null);
  app.addHook('onRequest', async (request) => {
    request.localUserId = user;
  });
  registerMcpAppsRoutes(app, {
    authorizeRequest,
    captureDocumentAccess: () => () => authorizeRequest(),
    resolveConnection: async () => connection,
    getProjectId: async () => 'p',
    getApp: async (_sessionId, appId) => events.findLast((event) => event.appId === appId),
    emit: async () => undefined,
    approve,
    settled,
    rpc: fixture.rpc,
    closeSession: async () => undefined,
    now: () => clock,
  });
  const call = (name: string, appId = APP_A) =>
    app.inject({
      method: 'POST',
      url: `/sessions/s/mcp-apps/${appId}/call`,
      payload: { name, arguments: {} },
    });
  const executed = () => fixture.calls.filter((c) => c.method === 'tools/call').length;
  return {
    call,
    approve,
    settled,
    authorizeRequest,
    preview,
    executed,
    advance: (ms: number) => (clock += ms),
    actAs: (id: string | null) => (user = id),
  };
}

describe('MCP Apps read-only grants', () => {
  it('one approval covers repeated read-only calls of the same tool, card and person', async () => {
    const f = setup();
    expect((await f.call('preview')).statusCode).toBe(200);
    expect(f.approve).toHaveBeenCalledOnce();
    // The card has to say that the answer covers more than this one call.
    expect(f.approve.mock.calls[0]![0].input.approvalCovers).toMatch(/30 minutes/);
    expect((await f.call('preview')).statusCode).toBe(200);
    expect((await f.call('preview')).statusCode).toBe(200);
    expect(f.approve).toHaveBeenCalledOnce();
    expect(f.settled).toHaveBeenCalledOnce();
    expect(f.executed()).toBe(3);
    // Every covered call still rechecks the caller's current access.
    expect(f.authorizeRequest).toHaveBeenCalledTimes(3);
  });

  it('asks again for another card, another person, after expiry, and for write tools', async () => {
    const f = setup();
    await f.call('preview');
    await f.call('preview', APP_B);
    expect(f.approve).toHaveBeenCalledTimes(2);
    f.actAs('user-b');
    await f.call('preview');
    expect(f.approve).toHaveBeenCalledTimes(3);
    f.actAs('user-a');
    f.advance(READ_ONLY_GRANT_MS);
    await f.call('preview');
    expect(f.approve).toHaveBeenCalledTimes(4);
    await f.call('refresh');
    await f.call('refresh');
    expect(f.approve).toHaveBeenCalledTimes(6);
    expect(f.approve.mock.calls[4]![0].input).not.toHaveProperty('approvalCovers');
  });

  it('never covers repeats for a caller without a known person', async () => {
    const f = setup();
    f.actAs(null);
    await f.call('preview');
    await f.call('preview');
    expect(f.approve).toHaveBeenCalledTimes(2);
    expect(f.approve.mock.calls[0]![0].input).not.toHaveProperty('approvalCovers');
  });

  it('drops the grant when the tool stops declaring itself read-only', async () => {
    const f = setup();
    await f.call('preview');
    f.preview.annotations.readOnlyHint = false;
    expect((await f.call('preview')).statusCode).toBe(200);
    expect(f.approve).toHaveBeenCalledTimes(2);
    f.preview.annotations.readOnlyHint = true;
    await f.call('preview');
    expect(f.approve).toHaveBeenCalledTimes(3);
  });

  it('does not execute a covered call once the caller lost access, and forgets the grant', async () => {
    const f = setup();
    await f.call('preview');
    f.authorizeRequest.mockResolvedValueOnce(false);
    expect((await f.call('preview')).statusCode).toBe(403);
    expect(f.executed()).toBe(1);
    await f.call('preview');
    expect(f.approve).toHaveBeenCalledTimes(2);
  });
});

describe('MCP Apps call queue', () => {
  it('queues a second call behind a pending approval instead of rejecting it', async () => {
    const f = setup();
    let answer!: (allowed: boolean) => void;
    f.approve.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const first = f.call('refresh');
    await vi.waitFor(() => expect(f.approve).toHaveBeenCalledOnce());
    const second = f.call('refresh');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Still one approval: the second call waits for the lane, it does not ask in parallel.
    expect(f.approve).toHaveBeenCalledOnce();
    answer(true);
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    expect(f.approve).toHaveBeenCalledTimes(2);
  });

  it('bounds the number of waiting calls per session', async () => {
    const f = setup();
    let answer!: (allowed: boolean) => void;
    f.approve.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const running = f.call('refresh');
    await vi.waitFor(() => expect(f.approve).toHaveBeenCalledOnce());
    const waiting = Array.from({ length: 7 }, () => f.call('refresh'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const overflow = await f.call('refresh');
    expect(overflow.statusCode).toBe(409);
    answer(true);
    expect((await running).statusCode).toBe(200);
    expect((await Promise.all(waiting)).map((r) => r.statusCode)).toEqual(Array(7).fill(200));
  });
});
