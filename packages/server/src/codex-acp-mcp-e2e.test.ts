import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { AcpCodexBackend, nodeSpawner } from '@verity/session';
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

describe('installed codex-acp MCP gateway integration', () => {
  it('translates the turn gateway into Codex config and reaches Verity with its bearer', async () => {
    const token = 'turn-bound-e2e-bearer';
    const gateway = createMcpGateway({
      // Both brokered tools — see the note in claude-acp-mcp-e2e.test.ts. This transport
      // only lists them; `invokeTool` below stays a trap.
      servedTools: ['verity_http_request', 'verity_secret_run'],
      resolveCaller: ({ token: presented }) =>
        Promise.resolve(presented === token ? { sessionId: 's1', turnId: 't1' } : undefined),
      requestApproval: () =>
        Promise.resolve({
          decision: { behavior: 'deny', message: 'not called' },
          decidedBy: 'card',
        }),
      invokeTool: () => Promise.reject(new Error('tools/list must not invoke a tool')),
      requestMac: () => Promise.resolve({ requestMac: '0'.repeat(64), macKeyId: 'test-mac-key' }),
      recordCall: () => Promise.resolve(),
    });
    const server = createServer((request, response) => {
      // POST plus the 405 on GET — see the note in claude-acp-mcp-e2e.test.ts.
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
      const result = await new AcpCodexBackend().run({
        store: ctx.store,
        storeSessionId: 'verity-e2e',
        worktree: process.cwd(),
        cwd: process.cwd(),
        prompt: 'finish after opening the session',
        command: process.execPath,
        extraArgs: [fileURLToPath(import.meta.resolve('@agentclientprotocol/codex-acp'))],
        spawner: nodeSpawner,
        env: {
          ...process.env,
          CODEX_PATH: resolve('scripts/probes/codex-app-server-mcp-fixture.mjs'),
          EXPECTED_MCP_URL: url,
          EXPECTED_MCP_TOKEN: token,
        },
        mcpGateway: { url, token },
      });
      expect(result.sessionId).toBe('real-codex-acp-e2e');
      expect(result.exitCode).toBe(0);
    } finally {
      await new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose(undefined))),
      );
    }
  }, 30_000);
});
