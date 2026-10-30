import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createMcpAppsInterceptor, connectionFingerprint, type McpAppEvent } from './mcp-apps.js';
import { transformMcpResponse } from './mcp-apps-stream.js';
import { dashboardFixture } from './mcp-apps-fixture.test-helper.js';

const connection = { id: 'c', url: 'https://mcp.example.com', authorization: 'Bearer fixture' };
const context = { projectId: 'p', caller: { sessionId: 's', turnId: 't' }, connection };

describe('MCP Apps host', () => {
  it('negotiates Apps while preserving existing capabilities and filters app-only tools', async () => {
    const fixture = dashboardFixture();
    const intercept = createMcpAppsInterceptor({ rpc: fixture.rpc, emit: vi.fn() });
    const initialize = await intercept({
      ...context,
      body: {
        id: 1,
        method: 'initialize',
        params: { capabilities: { roots: {}, extensions: { other: {} } } },
      },
    });
    expect(initialize.body).toMatchObject({
      params: {
        capabilities: {
          roots: {},
          extensions: {
            other: {},
            'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
          },
        },
      },
    });
    const list = await intercept({ ...context, body: { id: 2, method: 'tools/list' } });
    expect(
      await list.transform({ id: 2, result: { tools: fixture.tools, nextCursor: 'next' } }),
    ).toMatchObject({
      result: { tools: [fixture.tools[0], fixture.tools[2]], nextCursor: 'next' },
    });
    await expect(
      intercept({ ...context, body: { id: 3, method: 'tools/call', params: { name: 'refresh' } } }),
    ).rejects.toThrow('model-visible');
  });

  it.each([false, true])(
    'captures complete app data from %s SSE without backend events or model metadata leaks',
    async (sse) => {
      const fixture = dashboardFixture();
      const events: McpAppEvent[] = [];
      const intercept = createMcpAppsInterceptor({
        rpc: fixture.rpc,
        emit: async (_session, event) => {
          events.push(event);
        },
      });
      const call = await intercept({
        ...context,
        protocolSessionId: 'agent-session',
        body: {
          id: 77,
          method: 'tools/call',
          params: { name: 'dashboard', arguments: { city: 'Berlin' } },
        },
      });
      const { result } = await fixture.rpc(connection, 'tools/call', {});
      const envelope = { jsonrpc: '2.0', id: 77, result };
      const wire = sse
        ? `event: message\r\nid: resume-1\r\ndata: ${JSON.stringify(envelope)}\r\n\r\n`
        : JSON.stringify(envelope);
      let output = '';
      for await (const chunk of transformMcpResponse(
        Readable.from([...Buffer.from(wire)].map((byte) => Buffer.from([byte]))),
        sse,
        call.transform,
      ))
        output += chunk;
      expect(output).not.toContain('privateToApp');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        sessionId: 's',
        turnId: 't',
        connectionId: 'c',
        connectionFingerprint: connectionFingerprint(connection),
        input: { city: 'Berlin' },
        result: { _meta: { privateToApp: true } },
      });
      expect(fixture.calls[0]?.sessionId).toBe('agent-session');
      if (sse) expect(output).toContain('id: resume-1');
    },
  );

  it('keeps concurrent identical calls distinct, including reused protocol ids on different sessions', async () => {
    const events: McpAppEvent[] = [];
    const intercept = createMcpAppsInterceptor({
      rpc: dashboardFixture().rpc,
      emit: async (_session, event) => {
        events.push(event);
      },
    });
    const request = {
      ...context,
      body: { id: 1, method: 'tools/call', params: { name: 'dashboard' } },
    };
    const calls = await Promise.all([
      intercept(request),
      intercept({ ...request, caller: { sessionId: 'other', turnId: 't2' } }),
    ]);
    await Promise.all(calls.map((call) => call.transform({ id: 1, result: { content: [] } })));
    expect(new Set(events.map((event) => event.appId)).size).toBe(2);
    expect(events.map((event) => event.sessionId).sort()).toEqual(['other', 's']);
  });

  it('does not mistake unrelated JSON-RPC notifications for results', async () => {
    const emit = vi.fn();
    const call = await createMcpAppsInterceptor({ rpc: dashboardFixture().rpc, emit })({
      ...context,
      body: { id: 1, method: 'tools/call', params: { name: 'dashboard' } },
    });
    const unrelated = { method: 'notifications/progress', params: { progress: 1 } };
    expect(await call.transform(unrelated)).toEqual(unrelated);
    expect(emit).not.toHaveBeenCalled();
  });
  it('correlates deferred SSE GET results and sanitizes replayed results even after capture', async () => {
    const events: McpAppEvent[] = [];
    const intercept = createMcpAppsInterceptor({
      rpc: dashboardFixture().rpc,
      emit: async (_session, event) => {
        events.push(event);
      },
    });
    await intercept({
      ...context,
      protocolSessionId: 'upstream',
      body: { id: 77, method: 'tools/call', params: { name: 'dashboard' } },
    });
    const get = await intercept({ ...context, protocolSessionId: 'upstream', body: undefined });
    const result = { id: 77, result: { content: [], _meta: { privateToApp: true } } };
    expect(await get.transform(result)).toEqual({ id: 77, result: { content: [] } });
    expect(events).toHaveLength(1);
    expect(await get.transform(result)).toEqual({ id: 77, result: { content: [] } });
    expect(events).toHaveLength(1);
    const foreign = await intercept({
      ...context,
      caller: { sessionId: 'other', turnId: 'other' },
      protocolSessionId: 'upstream',
      body: undefined,
    });
    expect(await foreign.transform(result)).toEqual({ id: 77, result: { content: [] } });
    expect(events).toHaveLength(1);
  });
});
