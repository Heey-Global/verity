import { createAuthTokenRegistry } from './auth.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryEventBus, type Conductor } from '@verity/session';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { requestArrivedInternally, startProjectInternalUnixListener } from './internal-listener.js';
import { createMcpGatewayTokens } from './mcp-gateway-tokens.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'test',
    repo: 'knowledge',
    containerName: 'test',
    state: 'absent',
  });
  await ctx.store.createSession({
    sessionId: 's',
    projectId: 'p',
    worktree: '/test',
    model: 'test',
  });
});

async function setup() {
  const authRegistry = await createAuthTokenRegistry(ctx.store, { enabled: true });
  await authRegistry.register('device-token', 'knowledge-test-device');
  const tokens = createMcpGatewayTokens();
  const token = tokens.issue({ projectId: 'p', sessionId: 's', turnId: 't' });
  const permission = vi.fn(async () => ({ decision: { behavior: 'deny' }, decidedBy: 'card' }));
  const fallback = vi.fn(async () => {
    throw new Error('knowledge must use server executor');
  });
  const closeSession = vi.fn();
  const app = buildServer({
    eventStore: ctx.store,
    bus: new InMemoryEventBus(),
    conductor: {
      requestExternalPermission: permission,
      runBackendHandoff: async (_id: string, operation: () => Promise<unknown>) => operation(),
      clearQueue: async () => {},
      closeSession,
    } as unknown as Conductor,
    internalPathGuard: requestArrivedInternally,
    authRegistry,
    mcpGateway: {
      servedTools: ['verity_knowledge'],
      resolveCaller: async (input) => tokens.resolve(input),
      invokeTool: fallback,
      recordCall: async () => {},
      requestMac: async ({ request: input }) => ({
        requestMac: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        macKeyId: 'test',
      }),
    },
  });
  await app.ready();
  const root = mkdtempSync(join(tmpdir(), 'verity-knowledge-integration-'));
  const listener = await startProjectInternalUnixListener(app, {
    socketRoot: root,
    identity: { projectId: 'p', containerGeneration: 'generation' },
    ownerUid: process.getuid?.() ?? 1000,
    relayGid: process.getgid?.() ?? 1000,
  });
  let id = 0;
  const agent = async (
    input: unknown,
    bearer = token,
  ): Promise<{ isError?: boolean; content: { text: string }[] }> => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: ++id,
      method: 'tools/call',
      params: { name: 'verity_knowledge', arguments: input },
    });
    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          socketPath: listener.socketPath,
          path: '/internal/mcp',
          method: 'POST',
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              statusCode: res.statusCode ?? 500,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.once('error', reject);
      req.end(body);
    });
    if (response.statusCode >= 400)
      throw Object.assign(new Error('Gateway request rejected'), {
        statusCode: response.statusCode,
      });
    const envelope = JSON.parse(response.body) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    return envelope.result;
  };
  return {
    app,
    agent,
    token,
    tokens,
    permission,
    fallback,
    closeSession,
    async close() {
      await listener.close();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('uses project grants without per-call approval and attributes writes to the trusted turn', async () => {
  const h = await setup();
  try {
    const folderResponse = await h.app.inject({
      method: 'POST',
      url: '/knowledge/folders',
      headers: { authorization: 'Bearer device-token' },
      payload: { name: 'Shared', parentId: null },
    });
    expect(folderResponse.statusCode).toBe(200);
    const { folder } = folderResponse.json();
    const grantResponse = await h.app.inject({
      method: 'PUT',
      url: '/projects/p/knowledge-grants',
      headers: { authorization: 'Bearer device-token' },
      payload: { grants: [{ folderId: folder.id, mode: 'read_write' }] },
    });
    expect(grantResponse.statusCode).toBe(200);
    const created = await h.agent({
      operation: 'create',
      folderId: folder.id,
      title: 'Notes.md',
      bodyMarkdown: '# Shared',
    });
    expect(created.isError).toBeUndefined();
    const doc = JSON.parse(created.content[0]!.text) as { id: string; currentRevisionId: string };
    const revisions = await ctx.store.knowledge.listRevisions(doc.id);
    expect(revisions[0]).toMatchObject({ projectId: 'p', sessionId: 's', turnId: 't' });
    await ctx.store.knowledge.setGrants('p', [{ folderId: folder.id, mode: 'read' }]);
    expect((await h.agent({ operation: 'read', documentId: doc.id })).isError).toBeUndefined();
    expect(
      (
        await h.agent({
          operation: 'edit',
          documentId: doc.id,
          expectedRevisionId: doc.currentRevisionId,
          title: 'Changed',
          bodyMarkdown: 'changed',
        })
      ).isError,
    ).toBe(true);
    expect((await ctx.store.knowledge.getDocument(doc.id)).bodyMarkdown).toBe('# Shared');
    expect(h.permission).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
    await ctx.store.knowledge.setGrants('p', []);
    await expect(h.agent({ operation: 'read', documentId: doc.id })).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(await ctx.store.knowledge.isSessionInvalidated('s')).toBe(true);
  } finally {
    await h.close();
  }
});

it('keeps management APIs behind device authentication and returns bounded validation errors', async () => {
  const h = await setup();
  try {
    for (const authorization of [undefined, `Bearer ${h.token}`]) {
      for (const method of ['GET', 'POST'] as const) {
        const response = await h.app.inject({
          method,
          url: '/knowledge/folders',
          ...(authorization === undefined ? {} : { headers: { authorization } }),
          ...(method === 'POST' ? { payload: { name: 'Forbidden', parentId: null } } : {}),
        });
        expect(response.statusCode).toBe(401);
      }
    }
    const invalid = await h.app.inject({
      method: 'POST',
      url: '/knowledge/folders',
      headers: { authorization: 'Bearer device-token' },
      payload: { name: 'bad/name', parentId: null },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'invalid' });
    const folder = await ctx.store.knowledge.createFolder({ name: 'Shared' });
    await ctx.store.knowledge.setGrants('p', [{ folderId: folder.id, mode: 'read_write' }]);
    const agentError = await h.agent({
      operation: 'create',
      folderId: folder.id,
      title: 'bad/name',
      bodyMarkdown: '',
    });
    expect(agentError.isError).toBe(true);
    expect(agentError.content[0]!.text).toContain('Names must');
    const forged = h.tokens.issue({
      projectId: 'p',
      sessionId: 'nonexistent-session',
      turnId: 'forged-turn',
    });
    expect((await h.agent({ operation: 'list' }, forged)).isError).toBe(true);
  } finally {
    await h.close();
  }
});
