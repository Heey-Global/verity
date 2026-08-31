import { AcpClaudeBackend, nodeSpawner } from '@verity/session';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMcpGateway } from './mcp-gateway.js';

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

describe('installed claude-agent-acp MCP gateway integration', () => {
  it('translates the turn gateway into Claude config and reaches Verity with its bearer', async () => {
    const token = 'turn-bound-claude-e2e-bearer';
    const approvals: Array<{ sessionId: string; toolName: string }> = [];
    const invocations: Array<{ sessionId: string; turnId: string; toolName: string }> = [];
    const gateway = createMcpGateway({
      // Both brokered tools, because both are what a supervised deployment serves
      // (packages/server/src/embedded.ts). Serving only the simpler one here left the
      // trusted-CLI declaration — the elaborate schema of the two — never once rendered
      // for a real MCP client.
      servedTools: ['verity_http_request', 'verity_secret_run'],
      resolveCaller: ({ token: presented }) =>
        Promise.resolve(presented === token ? { sessionId: 's1', turnId: 't1' } : undefined),
      requestApproval: ({ sessionId, toolName }) => {
        approvals.push({ sessionId, toolName });
        return Promise.resolve({
          decision: { behavior: 'allow' },
          decidedBy: 'card',
        });
      },
      invokeTool: ({ sessionId, turnId, toolName }) => {
        invocations.push({ sessionId, turnId, toolName });
        return Promise.resolve({
          status: 200,
          body: { reached: true },
        });
      },
      requestMac: () => Promise.resolve({ requestMac: '0'.repeat(64), macKeyId: 'test-mac-key' }),
      recordCall: () => Promise.resolve(),
    });
    const methods: string[] = [];
    const server = createServer((request, response) => {
      methods.push(request.method ?? '');
      // The two methods the deployment answers on `/internal/mcp`: POST carries the calls,
      // and GET — the Streamable HTTP stream of server-initiated messages, which the gateway
      // does not offer — gets the 405 that says so. A stand-in that parsed every method as
      // JSON would answer requests the deployment never serves.
      if (request.method === 'GET') {
        response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'method_not_allowed' }));
        request.resume();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'not found' }));
        request.resume();
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        void gateway
          .handle({
            projectId: 'p1',
            token: request.headers.authorization?.replace(/^Bearer /u, ''),
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          })
          .then((result) => {
            response.writeHead(result.status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(result.body));
          });
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('gateway did not bind TCP');
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const result = await new AcpClaudeBackend().run({
        store: ctx.store,
        storeSessionId: 'verity-claude-e2e',
        worktree: process.cwd(),
        cwd: process.cwd(),
        prompt: 'finish after opening the session',
        command: process.execPath,
        extraArgs: [
          fileURLToPath(import.meta.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')),
        ],
        spawner: nodeSpawner,
        env: {
          ...process.env,
          CLAUDE_CODE_EXECUTABLE: resolve('scripts/probes/claude-cli-mcp-fixture.mjs'),
          EXPECTED_MCP_URL: url,
          EXPECTED_MCP_TOKEN: token,
        },
        mcpGateway: { url, token },
      });
      expect(result.exitCode).toBe(0);
      expect(await ctx.store.getEvents('verity-claude-e2e')).toContainEqual(
        expect.objectContaining({ t: 'text', delta: 'Claude ACP gateway reached' }),
      );
      // Each served tool was approved and invoked exactly once, in the order the fixture
      // called them — an approval that never reached `invokeTool` (or the reverse) is the
      // failure this pairing exists to catch.
      expect(approvals).toEqual([
        { sessionId: 's1', toolName: 'verity_http_request' },
        { sessionId: 's1', toolName: 'verity_secret_run' },
      ]);
      expect(invocations).toEqual([
        { sessionId: 's1', turnId: 't1', toolName: 'verity_http_request' },
        { sessionId: 's1', turnId: 't1', toolName: 'verity_secret_run' },
      ]);
      // The client really did open the stream the 405 above exists to refuse. Without this
      // the fixture's "no transport error" check would hold trivially on a client that
      // never asked.
      expect(methods).toContain('GET');
    } finally {
      await new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose(undefined))),
      );
    }
  }, 30_000);
});
