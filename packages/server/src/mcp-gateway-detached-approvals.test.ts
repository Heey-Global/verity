import { expect, it, vi } from 'vitest';
import { DopplerSecretResolutionError } from './doppler-secret-resolver.js';
import { secretAuditEventInputSchema } from '@verity/secret-contracts';
import type { ExternalPermissionAnswer } from '@verity/session';
import type { BrokeredToolApprovalInput } from './brokered-tool-approval-store.js';
import {
  createMcpGateway,
  type McpGatewayAuditRecord,
  type McpGatewayDeps,
} from './mcp-gateway.js';

const HTTP_ARGUMENTS = {
  method: 'GET',
  url: 'https://api.revenuecat.com/v2/projects',
  secretAlias: 'REVENUECAT_ADMIN_KEY',
  auth: { header: 'authorization', scheme: 'Bearer' },
};

const ALLOW: ExternalPermissionAnswer = { decision: { behavior: 'allow' }, decidedBy: 'card' };

function harness(overrides: Partial<McpGatewayDeps> = {}) {
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
      // `embedded-mcp-gateway.ts` performs. Without it a branch that writes an unpersistable record passes
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

const call = (
  args: unknown = HTTP_ARGUMENTS,
  name = 'verity_http_request',
): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name, arguments: args },
});

function resultOf(body: unknown): { content: { text: string }[]; isError?: boolean } {
  return (body as { result: { content: { text: string }[]; isError?: boolean } }).result;
}

it('reports a missing Doppler binding before asking for approval', async () => {
  const message =
    'Doppler binding `billing/dev` is no longer connected to this project (connected: portal/prd). No secret value was exposed.';
  const { gateway, invokeTool, requestApproval } = harness({
    authorizationSnapshot: async () => {
      throw new DopplerSecretResolutionError(message, 'Doppler binding');
    },
  });
  const response = await gateway.handle({
    projectId: 'p1',
    token: 'session-token',
    body: call(),
  });
  expect(resultOf(response.body).content[0]?.text).toBe(message);
  expect(requestApproval).not.toHaveBeenCalled();
  expect(invokeTool).not.toHaveBeenCalled();
});

it('checks standing consent against the same provider snapshot revalidated before execution', async () => {
  const hasStandingAuthorization = vi.fn(async () => true);
  const { gateway, invokeTool, requestApproval } = harness({
    authorizationSnapshot: async () => 'provider-snapshot',
    hasStandingAuthorization,
  });
  await gateway.handle({ projectId: 'p1', token: 'session-token', body: call() });
  expect(hasStandingAuthorization).toHaveBeenCalledWith(
    expect.objectContaining({ authorizationSnapshot: 'provider-snapshot' }),
  );
  expect(requestApproval).not.toHaveBeenCalled();
  expect(invokeTool).toHaveBeenCalledOnce();
});

it.each(['caller', 'generation'] as const)(
  'cancels approval when the %s retires',
  async (source) => {
    const cancellation = new AbortController();
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const { gateway, invokeTool } = harness({
      requestApproval: async ({ signal }) =>
        new Promise((resolve) => {
          const deny = () =>
            resolve({
              decision: { behavior: 'deny' as const, message: 'Approval cancelled; nothing ran.' },
              decidedBy: 'card' as const,
            });
          if (signal.aborted) deny();
          else signal.addEventListener('abort', deny, { once: true });
          ready();
        }),
    });
    const response = gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
      ...(source === 'caller'
        ? { signal: cancellation.signal }
        : {
            transport: {
              identity: {
                projectId: 'p1',
                containerGeneration: 'g1',
                userId: 'alice',
                projectDefault: false,
              },
              signal: cancellation.signal,
            },
          }),
    });
    await waiting;
    cancellation.abort();
    expect(resultOf((await response).body).content[0]?.text).toContain('Approval cancelled');
    expect(invokeTool).not.toHaveBeenCalled();
  },
);

it('returns an explicit durable waiting result without executing or holding the tool call open', async () => {
  const createOrFindPending = vi.fn(async (input: BrokeredToolApprovalInput) => ({
    ...input,
    id: 'receipt-1',
    status: 'pending',
    scope: null,
    decidedBy: null,
    createdAt: new Date().toISOString(),
    decidedAt: null,
  }));
  const surface = vi.fn(async () => {});
  const { gateway, invokeTool, requestApproval } = harness({
    authorizationSnapshot: async () => 'provider-snapshot',
    detachedApprovals: {
      createOrFindPending,
    } as unknown as import('./brokered-tool-approval-store.js').BrokeredToolApprovalStore,
    surfaceDetachedApproval: surface,
  });
  const response = await gateway.handle({ projectId: 'p1', token: 'session-token', body: call() });
  expect(resultOf(response.body).isError).not.toBe(true);
  expect(JSON.parse(resultOf(response.body).content[0]!.text)).toMatchObject({
    status: 'awaiting_approval',
    approvalId: 'receipt-1',
  });
  expect(createOrFindPending).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: 'p1',
      sessionId: 'sess-1',
      toolName: 'verity_http_request',
      authorizationSnapshot: 'provider-snapshot',
      canonicalInput: expect.any(String),
    }),
    expect.any(String),
  );
  expect(surface).toHaveBeenCalledWith('sess-1');
  expect(invokeTool).not.toHaveBeenCalled();
  expect(requestApproval).not.toHaveBeenCalled();
});

it('consumes an exact detached approval once immediately before dispatch', async () => {
  let used = false;
  const createOrFindPending = vi.fn(async (input: BrokeredToolApprovalInput) => ({
    ...input,
    id: 'receipt-1',
    status: 'approved',
    scope: 'once',
    decidedBy: 'user',
    createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
  }));
  const consume = vi.fn(async () => {
    if (used) return undefined;
    used = true;
    return { id: 'receipt-1' };
  });
  const { gateway, invokeTool } = harness({
    authorizationSnapshot: async () => 'provider-snapshot',
    detachedApprovals: {
      createOrFindPending,
      consume,
    } as unknown as import('./brokered-tool-approval-store.js').BrokeredToolApprovalStore,
  });
  const responses = await Promise.all(
    [1, 2].map(() => gateway.handle({ projectId: 'p1', token: 'session-token', body: call() })),
  );
  expect(invokeTool).toHaveBeenCalledTimes(1);
  expect(responses.filter((response) => resultOf(response.body).isError === true)).toHaveLength(1);
  expect(consume).toHaveBeenCalledWith(
    'receipt-1',
    expect.objectContaining({
      projectId: 'p1',
      sessionId: 'sess-1',
      toolName: 'verity_http_request',
      authorizationSnapshot: 'provider-snapshot',
      canonicalInput: expect.any(String),
    }),
    expect.any(String),
  );
});

it('does not consume detached consent after provider authority changes', async () => {
  const consume = vi.fn();
  let snapshots = 0;
  const { gateway, invokeTool } = harness({
    authorizationSnapshot: async () => (++snapshots === 1 ? 'original' : 'replacement'),
    detachedApprovals: {
      createOrFindPending: async (
        input: import('./brokered-tool-approval-store.js').BrokeredToolApprovalInput,
      ) => ({
        ...input,
        id: 'r',
        status: 'approved',
        scope: 'once',
        decidedBy: 'user',
        createdAt: '',
        decidedAt: '',
      }),
      consume,
    } as unknown as import('./brokered-tool-approval-store.js').BrokeredToolApprovalStore,
  });
  const response = await gateway.handle({ projectId: 'p1', token: 'session-token', body: call() });
  expect(resultOf(response.body).isError).toBe(true);
  expect(consume).not.toHaveBeenCalled();
  expect(invokeTool).not.toHaveBeenCalled();
});

it('rechecks cancellation after consuming a detached receipt before dispatch', async () => {
  const cancellation = new AbortController();
  const { gateway, invokeTool } = harness({
    authorizationSnapshot: async () => 'original',
    detachedApprovals: {
      createOrFindPending: async (
        input: import('./brokered-tool-approval-store.js').BrokeredToolApprovalInput,
      ) => ({
        ...input,
        id: 'r',
        status: 'approved',
        scope: 'once',
        decidedBy: 'user',
        createdAt: '',
        decidedAt: '',
      }),
      consume: async () => {
        cancellation.abort();
        return { id: 'r' };
      },
    } as unknown as import('./brokered-tool-approval-store.js').BrokeredToolApprovalStore,
  });
  const response = await gateway.handle({
    projectId: 'p1',
    token: 'session-token',
    body: call(),
    signal: cancellation.signal,
  });
  expect(resultOf(response.body).isError).toBe(true);
  expect(invokeTool).not.toHaveBeenCalled();
});

it.each([
  [null, 'You denied this exact secret request'],
  ['session', 'Choose Review again on the original approval card'],
  ['project', 'Choose Review again on the original approval card'],
] as const)(
  'reports the outcome of a stopped secret request with scope %s',
  async (scope, message) => {
    const consume = vi.fn();
    const { gateway, invokeTool } = harness({
      authorizationSnapshot: async () => 'original',
      detachedApprovals: {
        createOrFindPending: async (input: BrokeredToolApprovalInput) => ({
          ...input,
          id: 'r',
          status: 'denied',
          scope,
          decidedBy: 'user',
          createdAt: '',
          decidedAt: '',
        }),
        consume,
      } as unknown as import('./brokered-tool-approval-store.js').BrokeredToolApprovalStore,
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
    });
    const result = resultOf(response.body);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(message);
    expect(consume).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
  },
);

it('names an expired granted receipt and asks for explicit review without executing', async () => {
  const consume = vi.fn();
  const { gateway, invokeTool } = harness({
    authorizationSnapshot: async () => 'original',
    detachedApprovals: {
      createOrFindPending: async (
        input: import('./brokered-tool-approval-store.js').BrokeredToolApprovalInput,
      ) => ({
        ...input,
        id: 'r',
        status: 'approved',
        scope: 'once',
        decidedBy: 'user',
        createdAt: '',
        decidedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
      consume,
    } as unknown as import('./brokered-tool-approval-store.js').BrokeredToolApprovalStore,
  });
  const response = await gateway.handle({ projectId: 'p1', token: 'session-token', body: call() });
  expect(resultOf(response.body).content[0]?.text).toContain('approval_expired');
  expect(resultOf(response.body).content[0]?.text).toContain('Previous secret requests');
  expect(consume).not.toHaveBeenCalled();
  expect(invokeTool).not.toHaveBeenCalled();
});

it('does not let another person consume a detached receipt from the same session', async () => {
  const consume = vi.fn(async () => ({ id: 'r' }));
  const authorizeDetachedApproval = vi.fn(async ({ decidedBy }: { decidedBy: string | null }) => {
    if (decidedBy !== 'current-person')
      throw new Error('This approval belongs to a different person. Nothing ran.');
  });
  const { gateway, invokeTool } = harness({
    authorizationSnapshot: async () => 'provider',
    authorizeDetachedApproval,
    detachedApprovals: {
      createOrFindPending: async (input: BrokeredToolApprovalInput) => ({
        ...input,
        id: 'r',
        status: 'approved',
        scope: 'once',
        decidedBy: 'another-person',
        createdAt: new Date().toISOString(),
        decidedAt: new Date().toISOString(),
      }),
      consume,
    } as unknown as import('./brokered-tool-approval-store.js').BrokeredToolApprovalStore,
  });
  const response = await gateway.handle({ projectId: 'p1', token: 'session-token', body: call() });
  expect(resultOf(response.body).isError).toBe(true);
  expect(authorizeDetachedApproval).toHaveBeenCalledWith({
    projectId: 'p1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    decidedBy: 'another-person',
  });
  expect(consume).not.toHaveBeenCalled();
  expect(invokeTool).not.toHaveBeenCalled();
});

it('refuses to dispatch when the bearer retires during the final standing grant lookup', async () => {
  let active = true;
  const hasStandingAuthorization = vi.fn(async () => true).mockImplementationOnce(async () => true);
  hasStandingAuthorization.mockImplementation(async () => {
    active = false;
    return true;
  });
  const { gateway, invokeTool } = harness({
    authorizationSnapshot: async () => 'provider-snapshot',
    resolveCaller: async () => (active ? { sessionId: 'sess-1', turnId: 'turn-1' } : undefined),
    hasStandingAuthorization,
  });
  const response = await gateway.handle({ projectId: 'p1', token: 'session-token', body: call() });
  expect(resultOf(response.body).content[0]?.text).toContain('no longer active');
  expect(invokeTool).not.toHaveBeenCalled();
});
