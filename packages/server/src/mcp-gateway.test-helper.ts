// Shared by the MCP gateway suites: a gateway wired to recording fakes, and the request
// and result shapes every suite builds.
import { secretAuditEventInputSchema } from '@verity/secret-contracts';
import type { ExternalPermissionAnswer } from '@verity/session';
import { vi } from 'vitest';
import {
  createMcpGateway,
  type McpGatewayAuditRecord,
  type McpGatewayDeps,
} from './mcp-gateway.js';

export const SANDBOX_USER = '00000000-0000-4000-8000-000000000001';

export const HTTP_ARGUMENTS = {
  method: 'GET',
  url: 'https://api.revenuecat.com/v2/projects',
  secretAlias: 'REVENUECAT_ADMIN_KEY',
  auth: { header: 'authorization', scheme: 'Bearer' },
};

export const ALLOW: ExternalPermissionAnswer = {
  decision: { behavior: 'allow' },
  decidedBy: 'card',
};

export function harness(overrides: Partial<McpGatewayDeps> = {}) {
  const records: McpGatewayAuditRecord[] = [];
  const invokeTool = vi.fn<McpGatewayDeps['invokeTool']>(async () => ({
    status: 200,
    body: { ok: true },
  }));
  const requestApproval = vi.fn(async () => ALLOW);
  const deps: McpGatewayDeps = {
    resolveCaller: async ({ token }) =>
      token === 'session-token' ? { sessionId: 'sess-1', turnId: 'turn-1' } : undefined,
    requestApproval,
    invokeTool,
    recordCall: async ({ projectId, kind, ...gateway }) => {
      // The audit event schema is where a gateway record's real invariants live: which
      // rejections must carry a MAC, which may name a tool, which decisions exist. This file
      // drives every one of those branches, so it parses each record through the same mapping
      // `embedded.ts` performs. Without it a branch that writes an unpersistable record passes
      // here and fails on the first production append.
      secretAuditEventInputSchema.parse({
        projectId,
        kind,
        aliases: [],
        providerBindings: [],
        gateway,
        recordedAt: new Date().toISOString(),
      });
      records.push({ projectId, kind, ...gateway });
    },
    requestMac: async ({ request }) => ({
      // Distinct per request shape, so a test can tell the raw call and the validated one
      // apart without reimplementing the real HMAC.
      requestMac: Buffer.from(JSON.stringify(request)).toString('hex').slice(0, 64).padEnd(64, '0'),
      macKeyId: 'key-1',
    }),
    ...overrides,
  };
  return { gateway: createMcpGateway(deps), records, invokeTool, requestApproval };
}

export const call = (
  args: unknown = HTTP_ARGUMENTS,
  name = 'verity_http_request',
): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name, arguments: args },
});

export function resultOf(body: unknown): { content: { text: string }[]; isError?: boolean } {
  return (body as { result: { content: { text: string }[]; isError?: boolean } }).result;
}
