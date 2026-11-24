import { canonicalJson } from '@verity/secret-contracts';
import {
  brokeredExecutionClaimId,
  createBrokeredHttpConsumptionStore,
} from './brokered-http-consumption.js';
import type { McpGatewayDeps } from './mcp-gateway.js';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { Conductor, InMemoryEventBus } from '@verity/session';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import {
  brokeredDopplerBindingId,
  brokeredDopplerSnapshot,
  parseBrokeredDopplerBinding,
} from './brokered-doppler-binding.js';
import { createBrokeredHttpGrantStore } from './brokered-http-grants.js';
import { createBrokeredToolApprovalStore } from './brokered-tool-approval-store.js';
import { markInternalConnections } from './internal-listener.js';
import { createMcpGatewayTokens } from './mcp-gateway-tokens.js';
import { buildServer } from './server.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
beforeEach(async () => truncateAll(ctx.db));
afterAll(async () => ctx.close());

const requests = {
  verity_http_request: {
    method: 'GET',
    url: 'https://api.example.com/health',
    secretAlias: 'TEST_API_KEY',
    auth: { header: 'authorization', scheme: 'Bearer' },
  },
  verity_secret_run: {
    command: ['/usr/local/bin/test-health'],
    secrets: [
      { secretAlias: 'TEST_API_KEY', env: 'API_KEY_FILE', injection: 'file' },
      { secretAlias: 'TEST_CONFIG', env: 'CONFIG_FILE', injection: 'file' },
    ],
  },
};
type Tool = keyof typeof requests;

// Built by the production helper: a hand-written snapshot in an outdated shape
// fails to parse and turns every call into "Tool access changed".
const dopplerSnapshot = (dopplerConfig: string) =>
  JSON.stringify(
    brokeredDopplerSnapshot([
      {
        bindingId: 'synthetic-binding',
        connectionId: 'synthetic-connection',
        dopplerProject: 'synthetic-project',
        dopplerConfig,
      },
    ]),
  );

async function harness(toolName: Tool, recordExecution = false) {
  const store = ctx.store;
  await ctx.db
    .insertInto('users')
    .values([
      { id: 'alice', role: 'administrator', status: 'active' },
      { id: 'bob', role: 'administrator', status: 'active' },
    ])
    .execute();
  await store.createProject({
    id: 'p1',
    kind: 'local',
    owner: 'test',
    repo: 'test',
    cloneDir: 'test',
    containerName: 'verity-test',
    state: 'active',
  });
  await ctx.db
    .insertInto('project_memberships')
    .values(
      ['alice', 'bob'].map((userId) => ({
        project_id: 'p1',
        user_id: userId,
        can_read: true,
        can_execute: true,
        can_manage: true,
      })),
    )
    .execute();
  for (const sessionId of ['s1', 's2']) {
    await store.createSession({
      sessionId,
      projectId: 'p1',
      worktree: `/work/synthetic-test/${sessionId}`,
      model: 'claude-opus-5',
    });
  }
  const callers = new Map<string, string>();
  const setCaller = async (userId: string, sessionId = 's1') => {
    callers.set(sessionId, userId);
    const prompt = await store.appendEvent(sessionId, {
      t: 'prompt',
      text: 'Run the synthetic health check',
      initiatedBy: { userId },
    });
    await store.markTurnRunning({ sessionId, promptSeq: prompt.seq });
    await store.bindTurnIdentity(sessionId, { turnId: 't1', startCommandId: 'start' });
  };
  await setCaller('alice');
  const grants = createBrokeredHttpGrantStore(ctx.db);
  const approvals = createBrokeredToolApprovalStore(ctx.db);
  const bus = new InMemoryEventBus();
  const persist = vi.fn(async (input: Parameters<typeof grants.grant>[0]) => grants.grant(input));
  const conductor = new Conductor({
    store,
    bus,
    worktreeExists: async () => true,
    checkBrokeredHttpGrant: async (input) =>
      input.bindingId === undefined || input.userId === null || input.channel !== 'acp'
        ? false
        : grants.check({
            ...input,
            userId: input.userId,
            channel: input.channel,
            bindingId: input.bindingId,
          }),
    persistBrokeredHttpGrant: async (input) => {
      if (input.bindingId === undefined) throw new Error('missing provider binding');
      const approvedBinding = parseBrokeredDopplerBinding(input.bindingId);
      await persist({
        ...input,
        bindingId: brokeredDopplerBindingId(approvedBinding),
        approvedBinding,
      });
    },
  });
  // Keep backend execution out of this route-composition test; the actual
  // continuation still has to be requested after the scoped grant is saved.
  const resumed = vi.spyOn(conductor, 'resumeDetachedPermission').mockResolvedValue();
  const tokens = createMcpGatewayTokens();
  const claims = createBrokeredHttpConsumptionStore(ctx.db);
  const invokeTool = vi.fn<McpGatewayDeps['invokeTool']>(async (input) => {
    if (recordExecution) {
      expect(
        await claims.consume({
          projectId: input.projectId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          callId: brokeredExecutionClaimId(input.invocationId),
          requestHash: 'synthetic-request',
        }),
      ).toBe(true);
    }
    return { ok: true };
  });
  let config = 'test';
  const authorizeExecution = vi.fn(async () => {});
  let auditKey = 'first-audit-key';
  const app = buildServer({
    eventStore: store,
    bus,
    conductor,
    mcpGateway: {
      servedTools: [toolName],
      resolveCaller: async (input) => tokens.resolve(input),
      authorizationSnapshot: async () => dopplerSnapshot(config),
      detachedApprovals: approvals,
      hasSecretExecutionClaim: claims.has,
      authorizeExecution,
      invokeTool,
      recordCall: async () => {},
      requestMac: async ({ request }) => ({
        requestMac: createHash('sha256')
          .update(auditKey)
          .update(JSON.stringify(request))
          .digest('hex'),
        macKeyId: auditKey,
      }),
    },
  });
  const connections = new EventEmitter();
  markInternalConnections(connections as unknown as Server, {
    projectId: 'p1',
    userId: 'alice',
    projectDefault: true,
    containerGeneration: 'test-generation',
  });
  app.addHook('onRequest', async (request) => {
    connections.emit('connection', request.raw.socket);
  });
  let id = 0;
  const call = async (
    args: unknown = requests[toolName],
    sessionId = 's1',
    allowError = false,
    requestId?: number,
  ): Promise<{ status?: string; approvalId?: string; error?: string }> => {
    // Each invocation models a new turn attributed to its actual caller.
    await setCaller(callers.get(sessionId) ?? 'alice', sessionId);
    const token = tokens.issue({ projectId: 'p1', sessionId, turnId: 't1' });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        jsonrpc: '2.0',
        id: requestId ?? ++id,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ result: { content: { text: string }[]; isError?: boolean } }>();
    if (!allowError) expect(body.result.isError, body.result.content[0]?.text).not.toBe(true);
    if (body.result.isError) return { error: body.result.content[0]!.text };
    return JSON.parse(body.result.content[0]!.text) as {
      status?: string;
      approvalId?: string;
      error?: string;
    };
  };
  const approve = async (scope: 'once' | 'session' | 'project') => {
    const pending = await call();
    expect(pending.status).toBe('awaiting_approval');
    expect(invokeTool).not.toHaveBeenCalled();
    expect(
      await conductor.decidePermission(
        's1',
        pending.approvalId!,
        { behavior: 'allow' },
        {
          scope,
          decidedByUser: 'alice',
          actorId: 'alice',
        },
      ),
    ).toBe(true);
    expect(persist).toHaveBeenCalledTimes(
      scope === 'once' ? 0 : toolName === 'verity_secret_run' ? 2 : 1,
    );
    expect(resumed).toHaveBeenCalled();
  };
  return {
    app,
    db: ctx.db,
    authorizeExecution,
    call,
    approve,
    invokeTool,
    approvals,
    setCaller,
    conductor,
    rotateAuditKey: () => {
      auditKey = 'second-audit-key';
    },
    changeProvider: () => {
      config = 'other';
    },
  };
}

it.each([
  ['verity_http_request', 'session'],
  ['verity_http_request', 'project'],
  ['verity_secret_run', 'session'],
  ['verity_secret_run', 'project'],
] as const)('reuses saved %s %s consent through the detached route', async (tool, scope) => {
  const h = await harness(tool);
  try {
    await h.approve(scope);
    expect((await h.call()).status).not.toBe('awaiting_approval');
    expect((await h.call()).status).not.toBe('awaiting_approval');
    expect(h.invokeTool).toHaveBeenCalledTimes(2);
    expect(await h.approvals.listPending('s1')).toEqual([]);
    await h.setCaller('alice', 's2');
    expect((await h.call(requests[tool], 's2')).status).toBe(
      scope === 'project' && tool === 'verity_http_request' ? undefined : 'awaiting_approval',
    );
    expect(h.invokeTool).toHaveBeenCalledTimes(
      scope === 'project' && tool === 'verity_http_request' ? 3 : 2,
    );
  } finally {
    await h.app.close();
  }
});

it.each(['alias', 'user', 'provider'] as const)(
  'requires fresh consent when the trusted CLI %s changes',
  async (changed) => {
    const h = await harness('verity_secret_run');
    try {
      await h.approve('session');
      let args = requests.verity_secret_run;
      if (changed === 'alias') {
        args = {
          ...args,
          secrets: [
            ...args.secrets,
            {
              secretAlias: 'UNAPPROVED',
              env: 'OTHER_FILE',
              injection: 'file',
            },
          ],
        };
      }
      if (changed === 'user') await h.setCaller('bob');
      if (changed === 'provider') h.changeProvider();
      const pending = await h.call(args);
      expect(pending.status).toBe('awaiting_approval');
      expect(h.invokeTool).not.toHaveBeenCalled();
      expect((await h.call(args)).approvalId).toBe(pending.approvalId);
      expect(await h.approvals.listPending('s1')).toHaveLength(1);
    } finally {
      await h.app.close();
    }
  },
);

it.each(['verity_http_request', 'verity_secret_run'] as const)(
  'redeems %s once consent without creating standing access',
  async (tool) => {
    const h = await harness(tool);
    try {
      await h.approve('once');
      expect((await h.call()).status).not.toBe('awaiting_approval');
      expect(h.invokeTool).toHaveBeenCalledOnce();
      expect((await h.call()).status).toBe('awaiting_approval');
      expect(h.invokeTool).toHaveBeenCalledOnce();
    } finally {
      await h.app.close();
    }
  },
);

it('retains a denied request without executing or creating another approval', async () => {
  const h = await harness('verity_secret_run');
  try {
    const pending = await h.call();
    expect(
      await h.conductor.decidePermission(
        's1',
        pending.approvalId!,
        { behavior: 'deny', message: 'Synthetic request denied' },
        {
          actorId: 'alice',
        },
      ),
    ).toBe(true);
    expect((await h.call(undefined, 's1', true)).error).toContain('denied');
    expect(h.invokeTool).not.toHaveBeenCalled();
    expect(await h.approvals.listPending('s1')).toEqual([]);
  } finally {
    await h.app.close();
  }
});

it.each(['denied', 'consumed', 'legacy consumed'] as const)(
  'preserves a %s receipt when another session grants standing access',
  async (status) => {
    const h = await harness('verity_http_request');
    try {
      if (status !== 'denied') {
        await h.approve('once');
        expect((await h.call(undefined, 's1', false, 100)).status).toBeUndefined();
        if (status === 'legacy consumed') {
          const receipt = await h.db
            .selectFrom('brokered_tool_approvals')
            .select('consumed_invocation_id')
            .where('session_id', '=', 's1')
            .executeTakeFirstOrThrow();
          await h.db
            .updateTable('brokered_tool_approvals')
            .set({
              consumed_invocation_id: receipt.consumed_invocation_id!.replace(
                /[0-9a-f]{64}(?=:[0-9a-f]{64}$)/u,
                'a'.repeat(64),
              ),
            })
            .where('session_id', '=', 's1')
            .execute();
        }
      } else {
        const pending = await h.call();
        expect(
          await h.conductor.decidePermission(
            's1',
            pending.approvalId!,
            { behavior: 'deny', message: 'Synthetic request denied' },
            { actorId: 'alice' },
          ),
        ).toBe(true);
      }
      const pending = await h.call(undefined, 's2');
      expect(pending.status).toBe('awaiting_approval');
      expect(
        await h.conductor.decidePermission(
          's2',
          pending.approvalId!,
          { behavior: 'allow' },
          { scope: 'project', actorId: 'alice', decidedByUser: 'alice' },
        ),
      ).toBe(true);
      h.rotateAuditKey();
      expect((await h.call(undefined, 's1', true, 100)).error).toContain(
        status === 'denied' ? 'denied' : 'consumed',
      );
      expect(h.invokeTool).toHaveBeenCalledTimes(status === 'denied' ? 0 : 1);
      if (status === 'denied') {
        const denied = (await h.approvals.listReopenable('s1'))[0]!;
        const reopened = await h.approvals.reopen(denied.id, 's1');
        expect(reopened).toBeDefined();
        expect(await h.call()).toMatchObject({
          status: 'awaiting_approval',
          approvalId: reopened!.id,
        });
        expect(h.invokeTool).not.toHaveBeenCalled();
      }
    } finally {
      await h.app.close();
    }
  },
);

it("uses the caller's project grant when another user owns the session receipt", async () => {
  const h = await harness('verity_http_request');
  try {
    await h.approve('project');
    await h.setCaller('bob', 's2');
    const pending = await h.call(undefined, 's2');
    expect(pending.status).toBe('awaiting_approval');
    expect(
      await h.conductor.decidePermission(
        's2',
        pending.approvalId!,
        { behavior: 'allow' },
        { scope: 'once', actorId: 'bob', decidedByUser: 'bob' },
      ),
    ).toBe(true);
    await h.setCaller('alice', 's2');
    expect((await h.call(undefined, 's2')).status).toBeUndefined();
    expect(h.invokeTool).toHaveBeenCalledOnce();
    expect((await h.approvals.get(pending.approvalId!, 's2'))?.status).toBe('approved');
  } finally {
    await h.app.close();
  }
});

it('uses a later project grant when an earlier one-time receipt expired', async () => {
  const h = await harness('verity_http_request');
  try {
    await h.approve('once');
    await h.db
      .updateTable('brokered_tool_approvals')
      .set({ decided_at: new Date(0) })
      .where('session_id', '=', 's1')
      .execute();
    expect((await h.call(undefined, 's1', true)).error).toContain('approval_expired');
    const pending = await h.call(undefined, 's2');
    expect(pending.status).toBe('awaiting_approval');
    expect(
      await h.conductor.decidePermission(
        's2',
        pending.approvalId!,
        { behavior: 'allow' },
        { scope: 'project', actorId: 'alice', decidedByUser: 'alice' },
      ),
    ).toBe(true);
    expect((await h.call()).status).toBeUndefined();
    expect(h.invokeTool).toHaveBeenCalledOnce();
  } finally {
    await h.app.close();
  }
});

it('does not create a new card for a consumed invocation after its grant is revoked', async () => {
  const h = await harness('verity_http_request', true);
  try {
    await h.approve('project');
    expect((await h.call(undefined, 's1', false, 100)).status).toBeUndefined();
    await h.db.updateTable('secret_provider_permissions').set({ state: 'revoked' }).execute();
    expect((await h.call(undefined, 's1', true, 100)).error).toContain('already consumed');
    expect(h.invokeTool).toHaveBeenCalledOnce();
    expect(await h.approvals.listPending('s1')).toEqual([]);
    expect((await h.call()).status).toBe('awaiting_approval');
  } finally {
    await h.app.close();
  }
});

it('rechecks a standing grant before dispatch', async () => {
  const h = await harness('verity_http_request');
  try {
    await h.approve('project');
    h.authorizeExecution.mockImplementationOnce(async () => {
      await h.db.updateTable('secret_provider_permissions').set({ state: 'revoked' }).execute();
    });
    expect((await h.call(undefined, 's1', true)).error).toContain('revoked or expired');
    expect(h.invokeTool).not.toHaveBeenCalled();
  } finally {
    await h.app.close();
  }
});

it('honors a denial saved while a standing-grant invocation is preparing to dispatch', async () => {
  const h = await harness('verity_http_request');
  try {
    await h.approve('project');
    h.authorizeExecution.mockImplementationOnce(async () => {
      const receipt = await h.approvals.createOrFindPending({
        projectId: 'p1',
        sessionId: 's1',
        toolName: 'verity_http_request',
        canonicalInput: canonicalJson(requests.verity_http_request),
        authorizationSnapshot: dopplerSnapshot('test'),
        invocationId: 'concurrent-call',
        requestMac: 'synthetic-mac',
        macKeyId: 'synthetic-key',
      });
      await h.approvals.decide(receipt.id, 's1', false, 'alice');
    });
    expect((await h.call(undefined, 's1', true)).error).toContain('Nothing ran');
    expect(h.invokeTool).not.toHaveBeenCalled();
  } finally {
    await h.app.close();
  }
});
