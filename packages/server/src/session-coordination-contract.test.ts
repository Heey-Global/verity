import { describe, expect, it, vi } from 'vitest';
import { createMcpGateway, type McpGatewayDeps } from './mcp-gateway.js';

function harness() {
  const invokeTool = vi.fn<McpGatewayDeps['invokeTool']>(async () => ({
    status: 200,
    body: { status: 'linked' },
  }));
  const gateway = createMcpGateway({
    capabilityVersion: 2,
    servedTools: ['verity_session_coordinate'],
    resolveCaller: async () => ({ sessionId: 'source', turnId: 'turn' }),
    invokeTool,
    requestApproval: async () => ({
      decision: { behavior: 'allow' },
      decidedBy: 'card',
    }),
    recordCall: async () => undefined,
    requestMac: async () => ({ requestMac: 'a'.repeat(64), macKeyId: 'key' }),
  });
  const call = (name: string, args: unknown) =>
    gateway.handle({
      projectId: 'source-project',
      token: 'bound-token',
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      },
    });
  return { gateway, invokeTool, call };
}

const link = {
  requestId: 'stable-request',
  targetProjectId: 'target-project',
  targetSessionId: 'target',
};

describe('session coordination gateway contracts', () => {
  it('advertises separate discovery and mutation schemas without caller identity inputs', async () => {
    const { gateway } = harness();
    const listed = await gateway.handle({
      projectId: 'source-project',
      token: 'bound-token',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    const tools = (
      listed.body as {
        result: { tools: { name: string; inputSchema: Record<string, unknown> }[] };
      }
    ).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'verity_session_coordinate_discover',
      'verity_session_coordinate_link',
      'verity_session_coordinate_start',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).not.toHaveProperty('userId');
      expect(tool.inputSchema.properties).not.toHaveProperty('sourceSessionId');
      expect(tool.inputSchema.properties).not.toHaveProperty('operation');
    }
  });

  it('binds focused operations to their advertised target and authenticated source', async () => {
    const { call, invokeTool } = harness();
    await call('verity_session_coordinate_link', link);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'verity_session_coordinate',
        projectId: 'source-project',
        sessionId: 'source',
        turnId: 'turn',
        request: { operation: 'link', ...link },
      }),
    );
  });

  it.each([
    ['verity_session_coordinate_discover', { limit: 51 }],
    ['verity_session_coordinate_discover', { query: ' ' }],
    ['verity_session_coordinate_link', { ...link, targetProjectId: undefined }],
    ['verity_session_coordinate_link', { ...link, userId: 'another-user' }],
    ['verity_session_coordinate_link', { ...link, sourceSessionId: 'another-source' }],
    ['verity_session_coordinate_link', { ...link, operation: 'start' }],
    ['verity_session_coordinate_start', { requestId: 'r', targetProjectId: 'p', name: 'n' }],
    [
      'verity_session_coordinate_start',
      { requestId: 'r', targetProjectId: 'p', name: 'n'.repeat(81), message: 'Task' },
    ],
  ])('rejects invalid coordination input before dispatch: %s', async (name, args) => {
    const { call, invokeTool } = harness();
    const response = await call(name, args);
    expect(response.body).toHaveProperty('error');
    expect(invokeTool).not.toHaveBeenCalled();
  });
});
