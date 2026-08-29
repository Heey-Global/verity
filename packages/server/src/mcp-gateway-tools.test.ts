import { createServer, type Server, type Socket } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMcpGatewayToolExecutor } from './mcp-gateway-tools.js';
import { createTrustedCliTool } from './trusted-cli-tool.js';

let dir: string;
const servers: Server[] = [];
const sockets = new Set<Socket>();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verity-mcp-cli-integration-'));
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await rm(dir, { recursive: true, force: true });
});

describe('MCP gateway trusted CLI integration', () => {
  it('consumes the approval and resolves the secret before the live-turn supervisor executes', async () => {
    const runtime = join(dir, 'project-1');
    const socketPath = join(runtime, 'supervisor.sock');
    await mkdir(runtime, { recursive: true });
    let supervisorRequest: Record<string, unknown> | undefined;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.once('data', (data) => {
        supervisorRequest = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        socket.end(`${JSON.stringify({ ok: true, exitCode: 0, stdout: 'pod-1\n', stderr: '' })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const order: string[] = [];
    const trustedCli = createTrustedCliTool({
      getProjectBinding: async () => ({
        dopplerToken: 'binding-marker',
        dopplerProject: 'project',
        dopplerConfig: 'prod',
      }),
      consumeApproval: async (input) => {
        order.push('consume');
        expect(input).toEqual({
          projectId: 'project-1',
          sessionId: 'session-1',
          turnId: 'turn-1',
          callId: 'call-1',
          requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        });
        return true;
      },
      resolveSecret: async ({ secretName }) => {
        order.push('resolve');
        expect(secretName).toBe('KUBECONFIG_PROD');
        return Buffer.from('kubeconfig-marker');
      },
    });
    const invoke = createMcpGatewayToolExecutor({
      brokeredHttpTool: vi.fn(async () => ({ status: 200, body: null })),
      trustedCliTool: trustedCli,
      runnerRoot: dir,
    });

    await expect(
      invoke({
        projectId: 'project-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        invocationId: 'invocation-1',
        toolName: 'verity_secret_run',
        request: {
          command: ['/usr/bin/kubectl', 'get', 'pods'],
          secrets: [{ secretAlias: 'KUBECONFIG_PROD', env: 'KUBECONFIG', injection: 'file' }],
        },
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: 'pod-1\n', stderr: '' });

    expect(order).toEqual(['consume', 'resolve']);
    expect(supervisorRequest).toEqual({
      protocolVersion: 1,
      kind: 'run-trusted-cli',
      turnId: 'turn-1',
      secrets: [
        {
          secretAlias: 'KUBECONFIG_PROD',
          env: 'KUBECONFIG',
          injection: 'file',
          secret: 'kubeconfig-marker',
        },
      ],
      command: ['/usr/bin/kubectl', 'get', 'pods'],
    });
  });
});

describe('MCP gateway Control delivery integration', () => {
  it('passes the authenticated caller identity to the delivery executor', async () => {
    const createDelivery = vi.fn(async () => ({ workflowId: 'wf_1', state: 'running' }));
    const invoke = createMcpGatewayToolExecutor({
      brokeredHttpTool: vi.fn(async () => ({ status: 200, body: null })),
      trustedCliTool: vi.fn(),
      createDelivery,
    });
    const request = { serviceId: 'api', environment: 'staging', objective: 'Ship it' };

    await expect(
      invoke({
        projectId: 'verity-control',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        invocationId: 'invocation-1',
        toolName: 'verity_create_delivery',
        request,
      }),
    ).resolves.toEqual({ workflowId: 'wf_1', state: 'running' });
    expect(createDelivery).toHaveBeenCalledWith({
      projectId: 'verity-control',
      sessionId: 'session-1',
      turnId: 'turn-1',
      callId: 'invocation-1',
      request,
    });
  });
});

describe('MCP gateway control-plane session tools', () => {
  it('refuses to serve them from this executor, which has no conductor to dispatch through', async () => {
    const invoke = createMcpGatewayToolExecutor({
      brokeredHttpTool: vi.fn(async () => ({ status: 200, body: null })),
      trustedCliTool: vi.fn(),
    });
    for (const toolName of ['verity_list_sessions', 'verity_session_handoff'] as const) {
      await expect(
        invoke({
          projectId: 'verity-control',
          sessionId: 'session-1',
          turnId: 'turn-1',
          callId: 'call-1',
          invocationId: 'invocation-1',
          toolName,
          request: {},
        }),
      ).rejects.toThrow('control-plane session tools are unavailable');
    }
  });
});
