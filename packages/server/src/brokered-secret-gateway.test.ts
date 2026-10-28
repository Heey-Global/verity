import { InMemoryEventBus, type Conductor } from '@verity/session';
import { EventStore, createSealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { createBrokeredHttpTool } from './brokered-http-tool.js';
import { brokeredDopplerBindingId } from './brokered-doppler-binding.js';
import { startProjectInternalUnixListener } from './internal-listener.js';
import { createMcpGatewayToolExecutor } from './mcp-gateway-tools.js';
import { createMcpGatewayTokens } from './mcp-gateway-tokens.js';
import { buildServer } from './server.js';
import { createTrustedCliTool } from './trusted-cli-tool.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

const tools = ['verity_http_request', 'verity_secret_run'] as const;
type Tool = (typeof tools)[number];
type Drift = 'none' | 'approval' | 'invocation' | 'resolution' | 'consumption';

async function exercise(toolName: Tool, drift: Drift, snapshotAvailable = true) {
  const cipher = createSealableSecretCipher();
  cipher.unlock('ab'.repeat(32));
  const store = new EventStore(ctx.db, cipher);
  await store.createProject({
    id: 'p1',
    kind: 'local',
    owner: '__local__',
    repo: 'p1',
    cloneDir: 'p1',
    containerName: 'verity-p1',
    state: 'active',
  });
  await store.createSession({
    sessionId: 's1',
    projectId: 'p1',
    worktree: '/work/secret-gateway-s1',
    model: 'claude-opus-5',
  });
  await store.updateProjectSettings('p1', { dopplerProject: 'project', dopplerConfig: 'staging' });
  const changeBinding = () => store.updateProjectSettings('p1', { dopplerConfig: 'production' });
  const getProjectBinding = async (projectId: string) => {
    const settings = await store.getProjectSettings(projectId);
    if (!settings?.dopplerProject || !settings.dopplerConfig) return undefined;
    return { dopplerProject: settings.dopplerProject, dopplerConfig: settings.dopplerConfig };
  };
  const resolveSecret = vi.fn(async () => {
    if (drift === 'resolution') await changeBinding();
    return Buffer.from('synthetic-secret');
  });
  const transmitted = vi.fn();
  const consumeApproval = async () => {
    if (drift === 'consumption') await changeBinding();
    return true;
  };
  const brokeredHttpTool = createBrokeredHttpTool({
    requireApprovalBinding: true,
    getProjectBinding,
    resolveSecret,
    consumeApproval,
    transport: async (input) => {
      await input.authorizeRequest();
      transmitted();
      return { status: 200, body: '{"ok":true}' };
    },
  });
  const trustedCliTool = createTrustedCliTool({
    requireApprovalBinding: true,
    getProjectBinding,
    resolveSecret,
    consumeApproval,
  });
  const executed = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
  const approvals = vi.fn(async () => {
    if (drift === 'approval') await changeBinding();
    return { decision: { behavior: 'allow' }, decidedBy: 'card' };
  });
  const invokeTool = createMcpGatewayToolExecutor({
    brokeredHttpTool,
    trustedCliTool,
    runnerRoot: '/work/test-runner',
    runTrustedCli: executed,
  });
  const tokens = createMcpGatewayTokens();
  const app = buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    secretCipher: cipher,
    conductor: { requestExternalPermission: approvals } as unknown as Conductor,
    mcpGateway: {
      servedTools: [toolName],
      resolveCaller: async (input) => tokens.resolve(input),
      authorizationSnapshot: async () =>
        snapshotAvailable ? JSON.stringify(await getProjectBinding('p1')) : undefined,
      invokeTool: async (input) => {
        if (drift === 'invocation') await changeBinding();
        return invokeTool(input);
      },
      recordCall: async () => {},
      requestMac: async ({ request: input }) => ({
        requestMac: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        macKeyId: 'key-1',
      }),
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'v-secret-'));
  await app.ready();
  const listener = await startProjectInternalUnixListener(app, {
    socketRoot: dir,
    identity: { projectId: 'p1', containerGeneration: 'generation-1' },
    ownerUid: process.getuid?.() ?? 1000,
    relayGid: process.getgid?.() ?? 1000,
  });
  try {
    const token = tokens.issue({ projectId: 'p1', sessionId: 's1', turnId: 't1' });
    const args =
      toolName === 'verity_http_request'
        ? {
            method: 'GET',
            url: 'https://api.example.com/test',
            secretAlias: 'API_KEY',
            auth: { header: 'authorization', scheme: 'Bearer' },
          }
        : {
            command: ['/usr/bin/printenv', 'API_KEY'],
            secrets: [{ secretAlias: 'API_KEY', env: 'API_KEY' }],
          };
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    });
    const response = await new Promise<{ result?: { isError?: boolean }; error?: unknown }>(
      (resolve, reject) => {
        const req = request(
          {
            socketPath: listener.socketPath,
            method: 'POST',
            path: '/internal/mcp',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              try {
                resolve(
                  JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                    result?: { isError?: boolean };
                    error?: unknown;
                  },
                );
              } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
              }
            });
          },
        );
        req.on('error', reject);
        req.end(payload);
      },
    );
    if (snapshotAvailable) {
      expect(approvals).toHaveBeenCalledWith(
        expect.objectContaining({
          brokeredGrantBindingId: brokeredDopplerBindingId({
            dopplerProject: 'project',
            dopplerConfig: 'staging',
          }),
        }),
      );
    }
    return { response, resolveSecret, transmitted, executed, approvals };
  } finally {
    await listener.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

it.each(tools)('keeps unchanged %s authority usable', async (toolName) => {
  const h = await exercise(toolName, 'none');
  expect(h.response.error).toBeUndefined();
  expect(h.response.result?.isError).not.toBe(true);
  expect(h.approvals).toHaveBeenCalledOnce();
  expect(h.resolveSecret).toHaveBeenCalledOnce();
  expect(toolName === 'verity_http_request' ? h.transmitted : h.executed).toHaveBeenCalledOnce();
});

it.each(tools)(
  'rejects %s when its Doppler binding changes while approval waits',
  async (toolName) => {
    const h = await exercise(toolName, 'approval');
    expect(h.approvals).toHaveBeenCalledOnce();
    expect(h.response.result?.isError).toBe(true);
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(h.transmitted).not.toHaveBeenCalled();
    expect(h.executed).not.toHaveBeenCalled();
  },
);

it.each(tools)(
  'rejects %s when its Doppler binding changes after the gateway recheck',
  async (toolName) => {
    const h = await exercise(toolName, 'invocation');
    expect(h.approvals).toHaveBeenCalledOnce();
    expect(h.response.result?.isError).toBe(true);
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(h.transmitted).not.toHaveBeenCalled();
    expect(h.executed).not.toHaveBeenCalled();
  },
);

it.each(tools)(
  'rejects %s when its Doppler binding changes during secret resolution',
  async (toolName) => {
    const h = await exercise(toolName, 'resolution');
    expect(h.resolveSecret).toHaveBeenCalledOnce();
    expect(h.response.result?.isError).toBe(true);
    expect(h.transmitted).not.toHaveBeenCalled();
    expect(h.executed).not.toHaveBeenCalled();
  },
);

it.each(tools)(
  'refuses %s when its approval has no Doppler authority snapshot',
  async (toolName) => {
    const h = await exercise(toolName, 'none', false);
    expect(h.response.result?.isError).toBe(true);
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(h.transmitted).not.toHaveBeenCalled();
    expect(h.executed).not.toHaveBeenCalled();
  },
);

it.each(tools)(
  'rejects %s when its Doppler binding changes while consumption commits',
  async (toolName) => {
    const h = await exercise(toolName, 'consumption');
    expect(h.response.result?.isError).toBe(true);
    expect(h.transmitted).not.toHaveBeenCalled();
    expect(h.executed).not.toHaveBeenCalled();
  },
);
