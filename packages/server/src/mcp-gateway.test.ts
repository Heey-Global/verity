import { secretAuditEventInputSchema } from '@verity/secret-contracts';
import { TrustedCliDispatchError, type ExternalPermissionAnswer } from '@verity/session';
import { describe, expect, it, vi } from 'vitest';

import { DopplerSecretResolutionError } from './doppler-secret-resolver.js';

import {
  createMcpGateway,
  MCP_GATEWAY_PROTOCOL_VERSIONS,
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

describe('MCP gateway — handshake and discovery (ADR 0014 D1)', () => {
  it('echoes a protocol revision it speaks and falls back to its newest', async () => {
    const { gateway } = harness();
    const negotiated = async (asked: string): Promise<string> => {
      const response = await gateway.handle({
        projectId: 'p1',
        token: 'session-token',
        body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: asked } },
      });
      return (response.body as { result: { protocolVersion: string } }).result.protocolVersion;
    };
    expect(await negotiated('2024-11-05')).toBe('2024-11-05');
    expect(await negotiated('1999-01-01')).toBe(MCP_GATEWAY_PROTOCOL_VERSIONS[0]);
  });

  it('serves both brokered tools with the descriptions every channel shares', async () => {
    const { gateway } = harness();
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    const { tools } = (
      response.body as { result: { tools: { name: string; description: string }[] } }
    ).result;
    expect(tools.map((tool) => tool.name)).toEqual(['verity_http_request', 'verity_secret_run']);
    expect(tools[0]?.description).toContain('named Doppler secret');
    expect(tools[1]?.description).toContain('root-owned program');
  });

  it('offers delivery creation only to the Control project identity', async () => {
    const { gateway } = harness({
      extraToolsForProject: (projectId) =>
        projectId === 'verity-control' ? ['verity_create_delivery'] : [],
    });
    const list = async (projectId: string): Promise<string[]> => {
      const response = await gateway.handle({
        projectId,
        token: 'session-token',
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      });
      return (response.body as { result: { tools: { name: string }[] } }).result.tools.map(
        (tool) => tool.name,
      );
    };

    await expect(list('project-1')).resolves.toEqual(['verity_http_request', 'verity_secret_run']);
    await expect(list('verity-control')).resolves.toEqual([
      'verity_http_request',
      'verity_secret_run',
      'verity_create_delivery',
    ]);
  });

  it('offers the session tools only to the Control project, and refuses them elsewhere', async () => {
    const { gateway, invokeTool } = harness({
      extraToolsForProject: (projectId) =>
        projectId === 'verity-control' ? ['verity_list_sessions', 'verity_session_handoff'] : [],
    });
    const list = async (projectId: string): Promise<string[]> => {
      const response = await gateway.handle({
        projectId,
        token: 'session-token',
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      });
      return (response.body as { result: { tools: { name: string }[] } }).result.tools.map(
        (tool) => tool.name,
      );
    };

    // The listing enumerates the fleet, so it earns the negative assertion as much as the
    // handoff does — a project session must not learn which sessions exist elsewhere.
    await expect(list('project-1')).resolves.not.toContain('verity_list_sessions');
    await expect(list('project-1')).resolves.not.toContain('verity_session_handoff');
    await expect(list('verity-control')).resolves.toEqual([
      'verity_http_request',
      'verity_secret_run',
      'verity_list_sessions',
      'verity_session_handoff',
    ]);

    // A project session that knows the name anyway gets the unknown-tool answer, not a call.
    const refused = await gateway.handle({
      projectId: 'project-1',
      token: 'session-token',
      body: call(
        { target: { sessionId: 's' }, title: 't', briefing: 'b' },
        'verity_session_handoff',
      ),
    });
    expect((refused.body as { error: { message: string } }).error.message).toBe(
      'unknown tool verity_session_handoff',
    );
    const refusedListing = await gateway.handle({
      projectId: 'project-1',
      token: 'session-token',
      body: call({}, 'verity_list_sessions'),
    });
    expect((refusedListing.body as { error: { message: string } }).error.message).toBe(
      'unknown tool verity_list_sessions',
    );
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it('turns away a lifecycle request with no usable credential', async () => {
    const { gateway, records } = harness();
    const response = await gateway.handle({
      projectId: 'p1',
      token: undefined,
      body: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    });
    expect(response.status).toBe(401);
    // Nothing was called, so nothing is recorded — the trail is about calls, not probes.
    expect(records).toEqual([]);
  });

  it('acknowledges a notification without answering it', async () => {
    const { gateway } = harness();
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(response).toEqual({ status: 202 });
  });

  it('will not let an id-less tool call pass as a notification', async () => {
    const { gateway, records, invokeTool } = harness();
    const idLess = { ...call() };
    delete idLess['id'];
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: idLess,
    });
    expect((response.body as { error: { code: number } }).error.code).toBe(-32_600);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('refuses a batch and an unparsed body without recording a call', async () => {
    const { gateway, records } = harness();
    for (const body of [[{ jsonrpc: '2.0', id: 1, method: 'ping' }], 'nonsense', null]) {
      const response = await gateway.handle({ projectId: 'p1', token: 'session-token', body });
      expect(response.status).toBe(200);
      expect((response.body as { error: { code: number } }).error.code).toBeLessThan(-32_599);
    }
    expect(records).toEqual([]);
  });
});

describe('MCP gateway — every call is recorded (ADR 0014 D3)', () => {
  it('records the received call before it asks, and the served call after', async () => {
    let askedAfter: string[] = [];
    const { gateway, records, invokeTool } = harness({
      requestApproval: async () => {
        // The trail must already show the call at the moment approval is sought: an
        // operator answering a card is answering something already written down.
        askedAfter = records.map((record) => record.kind);
        return ALLOW;
      },
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
    });
    expect(resultOf(response.body).isError).toBeUndefined();
    expect(JSON.parse(resultOf(response.body).content[0]!.text)).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(records.map((record) => record.kind)).toEqual([
      'gateway_call_received',
      'gateway_call_served',
    ]);
    expect(records[1]).toMatchObject({
      projectId: 'p1',
      channel: 'acp-mcp',
      toolName: 'verity_http_request',
      decision: 'card',
      macKeyId: 'key-1',
    });
    // Both records key the same request, so one reconciles against the other.
    expect(records[0]?.requestMac).toBe(records[1]?.requestMac);
    expect(askedAfter).toEqual(['gateway_call_received']);
    expect(invokeTool).toHaveBeenCalledTimes(1);
  });

  it('hands the complete approved trusted CLI request to the turn-bound executor', async () => {
    const cli = {
      command: ['/usr/bin/kubectl', 'get', 'pods'],
      secrets: [{ secretAlias: 'KUBECONFIG_PROD', env: 'KUBECONFIG', injection: 'file' as const }],
    };
    const executeCli = vi.fn(async () => ({ exitCode: 0, stdout: 'pod-1\n', stderr: '' }));
    const { gateway, requestApproval } = harness({ invokeTool: executeCli });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(cli, 'verity_secret_run'),
    });

    expect(resultOf(response.body).isError).toBeUndefined();
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        sessionId: 'sess-1',
        toolName: 'verity_secret_run',
        input: cli,
      }),
    );
    expect(executeCli).toHaveBeenCalledWith({
      projectId: 'p1',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      callId: expect.any(String),
      invocationId: expect.any(String),
      toolName: 'verity_secret_run',
      request: cli,
    });
  });

  it('says a standing grant answered, not a card the operator never saw', async () => {
    const { gateway, records } = harness({
      requestApproval: vi.fn(async () => ({
        decision: { behavior: 'allow' as const },
        decidedBy: 'grant' as const,
      })),
    });
    await gateway.handle({ projectId: 'p1', token: 'session-token', body: call() });
    expect(records.at(-1)).toMatchObject({ kind: 'gateway_call_served', decision: 'grant' });
  });

  it('pairs the records of one call with an id no other call shares', async () => {
    // Two identical calls key to the same MAC, so the MAC alone cannot say which outcome
    // belongs to which start. The id is the gateway's own: it is minted before the body is
    // examined, is never shown to the caller, and is not the JSON-RPC id it chose.
    const { gateway, records } = harness();
    await gateway.handle({ projectId: 'p1', token: 'session-token', body: call() });
    await gateway.handle({ projectId: 'p1', token: 'session-token', body: call() });
    const [firstReceived, firstServed, secondReceived, secondServed] = records;
    expect(firstReceived?.callId).toBe(firstServed?.callId);
    expect(secondReceived?.callId).toBe(secondServed?.callId);
    expect(firstReceived?.callId).not.toBe(secondReceived?.callId);
    expect(firstReceived?.callId).not.toBe('7');
    expect(firstReceived?.requestMac).toBe(secondReceived?.requestMac);
  });

  it('keeps the executor invocation id stable across an MCP transport retry', async () => {
    const { gateway, invokeTool } = harness();
    await gateway.handle({ projectId: 'p1', token: 'session-token', body: call() });
    await gateway.handle({ projectId: 'p1', token: 'session-token', body: call() });

    const first = invokeTool.mock.calls[0]?.[0];
    const retry = invokeTool.mock.calls[1]?.[0];
    expect(first?.invocationId).toBe(retry?.invocationId);
    expect(first?.callId).not.toBe(retry?.callId);
  });

  it('gives a call that never named a served tool the same kind of id', async () => {
    // The rejection paths that fire before a tool is identified still produce a record, and
    // a record the trail cannot pair with anything is the gap the id closes.
    const { gateway, records } = harness();
    await gateway.handle({ projectId: 'p1', token: 'session-token', body: call({}, 'nope') });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'gateway_call_rejected', rejection: 'unknown_tool' });
    expect(records[0]?.callId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('writes records the audit log will accept, on every path that writes one', async () => {
    const allowing = harness();
    await allowing.gateway.handle({ projectId: 'p1', token: 'session-token', body: call() });
    const { gateway, records } = harness({
      requestApproval: vi.fn(async () => ({
        decision: { behavior: 'deny' as const, message: 'no' },
        decidedBy: 'card' as const,
      })),
    });
    await gateway.handle({ projectId: 'p1', token: 'session-token', body: call() });
    await gateway.handle({ projectId: 'p1', token: undefined, body: call() });
    await gateway.handle({ projectId: 'p1', token: 'session-token', body: call({}, 'nope') });
    await gateway.handle({ projectId: 'p1', token: 'session-token', body: call({ url: 5 }) });
    // Every kind and every rejection reason the gateway can write is in this set.
    const written = [...allowing.records, ...records];
    expect(new Set(written.map((record) => record.kind)).size).toBe(3);
    expect(new Set(written.map((record) => record.rejection))).toEqual(
      new Set([undefined, 'denied', 'unauthenticated', 'unknown_tool', 'malformed_request']),
    );
    for (const record of written) {
      // The whole event, not just the gateway payload: the cross-field invariants that make a
      // record reconcilable — MAC with key id, toolName, decision vs rejection — live on the
      // event schema, so a payload that parses alone can still be refused by the log.
      const { projectId, kind, ...gatewayCall } = record;
      expect(() =>
        secretAuditEventInputSchema.parse({
          projectId,
          kind,
          aliases: [],
          providerBindings: [],
          gateway: gatewayCall,
          recordedAt: '2026-08-09T00:00:00.000Z',
        }),
      ).not.toThrow();
    }
  });
});

describe('MCP gateway — refusals (ADR 0014 D2)', () => {
  it('refuses an unauthenticated call, keyed so the attempt is still reconcilable', async () => {
    const { gateway, records, invokeTool } = harness();
    const response = await gateway.handle({ projectId: 'p1', token: 'stolen', body: call() });
    expect(response.status).toBe(401);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'gateway_call_rejected',
      rejection: 'unauthenticated',
      // Which tool was attempted is the point of the record; only the answer withholds it.
      toolName: 'verity_http_request',
    });
    expect(records[0]?.requestMac).toEqual(expect.any(String));
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it('tells an unauthenticated caller nothing about which tools exist', async () => {
    const { gateway, records } = harness();
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'stolen',
      body: call({}, 'verity_secret_job'),
    });
    // Same 401 as a call for a tool that does exist — the served set is not probeable.
    expect(response).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(records[0]).toMatchObject({ rejection: 'unknown_tool' });
    expect(records[0]?.toolName).toBeUndefined();
  });

  it('refuses a tool it does not serve, and names no tool on the record', async () => {
    const { gateway, records } = harness();
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call({}, 'verity_secret_job'),
    });
    expect((response.body as { error: { code: number } }).error.code).toBe(-32_601);
    expect(records[0]).toMatchObject({ kind: 'gateway_call_rejected', rejection: 'unknown_tool' });
    expect(records[0]?.toolName).toBeUndefined();
    expect(records[0]?.requestMac).toEqual(expect.any(String));
  });

  it('refuses arguments the tool schema rejects, with nothing to key', async () => {
    const { gateway, records } = harness();
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call({ url: 'not a url' }),
    });
    expect((response.body as { error: { code: number } }).error.code).toBe(-32_602);
    expect(records[0]).toMatchObject({
      kind: 'gateway_call_rejected',
      rejection: 'malformed_request',
    });
    expect(records[0]?.requestMac).toBeUndefined();
    expect(records[0]?.macKeyId).toBeUndefined();
  });

  it('hands the operator denial back to the model and never runs the call', async () => {
    const { gateway, records, invokeTool } = harness({
      requestApproval: vi.fn(async () => ({
        decision: { behavior: 'deny' as const, message: 'Not this host.' },
        decidedBy: 'card' as const,
      })),
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
    });
    expect(resultOf(response.body)).toMatchObject({ isError: true });
    expect(resultOf(response.body).content[0]?.text).toBe('Not this host.');
    expect(invokeTool).not.toHaveBeenCalled();
    expect(records.map((record) => record.kind)).toEqual([
      'gateway_call_received',
      'gateway_call_rejected',
    ]);
    expect(records[1]).toMatchObject({ rejection: 'denied', toolName: 'verity_http_request' });
  });

  it('refuses an edited approval rather than serving a request it did not record', async () => {
    const { gateway, records, invokeTool } = harness({
      requestApproval: vi.fn(async () => ({
        decision: {
          behavior: 'allow' as const,
          updatedInput: { ...HTTP_ARGUMENTS, url: 'https://elsewhere.example/' },
        },
        decidedBy: 'card' as const,
      })),
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
    });
    expect(resultOf(response.body)).toMatchObject({ isError: true });
    expect(invokeTool).not.toHaveBeenCalled();
    expect(records.at(-1)).toMatchObject({ rejection: 'denied' });
  });

  it('refuses a call whose bearer was retired while its card was parked', async () => {
    // A card can sit open for minutes. If the caller's turn settles in the meantime the
    // bearer that admitted the call is retired, and serving the approval afterwards would
    // land a secret on a turn that no longer exists.
    let live = true;
    const { gateway, records, invokeTool } = harness({
      resolveCaller: async ({ token }) =>
        live && token === 'session-token' ? { sessionId: 'sess-1', turnId: 'turn-1' } : undefined,
      requestApproval: vi.fn(async () => {
        live = false;
        return ALLOW;
      }),
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
    });
    expect(response).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(invokeTool).not.toHaveBeenCalled();
    expect(records.map((record) => record.kind)).toEqual([
      'gateway_call_received',
      'gateway_call_rejected',
    ]);
    expect(records[1]).toMatchObject({
      rejection: 'unauthenticated',
      toolName: 'verity_http_request',
    });
  });

  it('refuses a call whose bearer now belongs to a different turn', async () => {
    // The same string resolving to another turn is the reuse case: a released bearer whose
    // digest was minted again is not the credential this call was admitted on.
    let turnId = 'turn-1';
    const { gateway, records, invokeTool } = harness({
      resolveCaller: async ({ token }) =>
        token === 'session-token' ? { sessionId: 'sess-1', turnId } : undefined,
      requestApproval: vi.fn(async () => {
        turnId = 'turn-2';
        return ALLOW;
      }),
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
    });
    expect(response.status).toBe(401);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(records.at(-1)).toMatchObject({ rejection: 'unauthenticated' });
  });

  it('does not ask, and does not run, when the received record cannot be written', async () => {
    const { gateway, requestApproval, invokeTool } = harness({
      recordCall: async (record) => {
        if (record.kind === 'gateway_call_received') throw new Error('audit chain unavailable');
      },
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
    });
    expect(resultOf(response.body)).toMatchObject({ isError: true });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it('reports an unserved call as unavailable without leaking why', async () => {
    const { gateway, records } = harness({
      invokeTool: vi.fn(async () => {
        throw new Error('doppler token missing for project p1');
      }),
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
    });
    expect(resultOf(response.body).content[0]?.text).not.toContain('doppler');
    expect(records.at(-1)).toMatchObject({
      kind: 'gateway_call_rejected',
      rejection: 'unavailable',
    });
  });

  it('returns a redacted Doppler resolution diagnosis to an ACP caller', async () => {
    const { gateway, records } = harness({
      invokeTool: vi.fn(async () => {
        throw new DopplerSecretResolutionError(
          'Secret resolution failed during Doppler request timeout, project configuration `binding-1@v1`. No secret value was exposed.',
          'Doppler request timeout',
          undefined,
          'binding-1@v1',
        );
      }),
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
    });
    expect(resultOf(response.body).content[0]?.text).toContain('Doppler request timeout');
    expect(resultOf(response.body).content[0]?.text).toContain('binding-1@v1');
    expect(records.at(-1)).toMatchObject({
      kind: 'gateway_call_rejected',
      rejection: 'unavailable',
    });
  });

  it('does not trust free text on a malformed Doppler resolution error', async () => {
    const leaked = 'dp.st.do-not-expose';
    const { gateway } = harness({
      invokeTool: vi.fn(async () => {
        throw new DopplerSecretResolutionError(leaked);
      }),
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
    });
    expect(resultOf(response.body).content[0]?.text).toBe('Verity could not serve this call.');
    expect(JSON.stringify(response.body)).not.toContain(leaked);
  });

  it.each([
    [false, 'The command was not started.'],
    ['unknown', 'do not retry a mutating command automatically.'],
  ] as const)(
    'returns a sanitized trusted CLI dispatch diagnosis to an ACP caller (%s)',
    async (executionStarted, expected) => {
      const { gateway, records } = harness({
        invokeTool: vi.fn(async () => {
          throw new TrustedCliDispatchError('runner supervisor response', executionStarted);
        }),
      });
      const response = await gateway.handle({
        projectId: 'p1',
        token: 'session-token',
        body: call(
          {
            command: ['/usr/bin/kubectl', 'get', 'pods'],
            secrets: [{ secretAlias: 'KUBECONFIG', env: 'KUBECONFIG', injection: 'file' }],
          },
          'verity_secret_run',
        ),
      });
      expect(resultOf(response.body).content[0]?.text).toContain(expected);
      expect(resultOf(response.body).content[0]?.text).toContain('No secret value was exposed.');
      expect(records.at(-1)).toMatchObject({
        kind: 'gateway_call_rejected',
        rejection: 'unavailable',
      });
    },
  );

  it('refuses a call it cannot key, rather than recording one it cannot reconcile', async () => {
    const { gateway, records, requestApproval, invokeTool } = harness({
      requestMac: async () => {
        throw new Error('gateway MAC key unavailable');
      },
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
    });
    expect(resultOf(response.body)).toMatchObject({ isError: true });
    // Every rejection the trail can hold except malformed_request carries a MAC, so an
    // unkeyable call is left out entirely rather than filed under the wrong reason.
    expect(records).toEqual([]);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it('withholds the result of a call it could not record, and says not to retry', async () => {
    const { gateway } = harness({
      recordCall: async (record) => {
        if (record.kind === 'gateway_call_served') throw new Error('audit chain unavailable');
      },
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
    });
    expect(resultOf(response.body)).toMatchObject({ isError: true });
    expect(resultOf(response.body).content[0]?.text).toContain('Do not retry');
  });
});

describe('MCP gateway — the session handoff cannot bypass the card', () => {
  const HANDOFF = {
    target: { sessionId: 'sess-web' },
    title: 'Overlay for the new site',
    briefing: 'Digest sha256:abc, port 8080, read-only rootfs.',
  };
  const controlHarness = () =>
    harness({
      extraToolsForProject: () => ['verity_list_sessions', 'verity_session_handoff'],
    });

  it('raises a card showing the full briefing before anything is dispatched', async () => {
    const { gateway, records, requestApproval, invokeTool } = controlHarness();
    const response = await gateway.handle({
      projectId: 'verity-control',
      token: 'session-token',
      body: call(HANDOFF, 'verity_session_handoff'),
    });
    expect(response.status).toBe(200);
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'verity_session_handoff', input: HANDOFF }),
    );
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'verity_session_handoff', request: HANDOFF }),
    );
    // One record before the call and one after it, like every other gateway tool.
    expect(records.map((record) => record.kind)).toEqual([
      'gateway_call_received',
      'gateway_call_served',
    ]);
  });

  it('dispatches nothing when the operator denies the handoff', async () => {
    const { gateway, records, invokeTool } = harness({
      extraToolsForProject: () => ['verity_session_handoff'],
      requestApproval: vi.fn(async () => ({
        decision: { behavior: 'deny' as const, message: 'Not into that session.' },
        decidedBy: 'card' as const,
      })),
    });
    const response = await gateway.handle({
      projectId: 'verity-control',
      token: 'session-token',
      body: call(HANDOFF, 'verity_session_handoff'),
    });
    expect(resultOf(response.body)).toMatchObject({ isError: true });
    expect(invokeTool).not.toHaveBeenCalled();
    expect(records.at(-1)).toMatchObject({
      kind: 'gateway_call_rejected',
      rejection: 'denied',
      toolName: 'verity_session_handoff',
    });
  });

  it('refuses an approval that edited the briefing rather than delivering either version', async () => {
    const { gateway, invokeTool } = harness({
      extraToolsForProject: () => ['verity_session_handoff'],
      requestApproval: vi.fn(async () => ({
        decision: {
          behavior: 'allow' as const,
          updatedInput: { ...HANDOFF, briefing: 'something else entirely' },
        },
        decidedBy: 'card' as const,
      })),
    });
    const response = await gateway.handle({
      projectId: 'verity-control',
      token: 'session-token',
      body: call(HANDOFF, 'verity_session_handoff'),
    });
    expect(resultOf(response.body).content[0]?.text).toContain('edits are not supported');
    expect(invokeTool).not.toHaveBeenCalled();
  });
});
