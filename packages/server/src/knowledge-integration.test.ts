import { createAuthTokenRegistry } from './auth.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryEventBus, type Conductor } from '@verity/session';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { requestArrivedInternally, startProjectInternalUnixListener } from './internal-listener.js';
import { createMcpGatewayTokens } from './mcp-gateway-tokens.js';

let ctx: TestDb;
let sessionWorktree: string;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  sessionWorktree = mkdtempSync(join(tmpdir(), 'verity-knowledge-worktree-'));
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
    worktree: sessionWorktree,
    model: 'test',
  });
});
afterEach(() => rmSync(sessionWorktree, { recursive: true, force: true }));

async function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'verity-knowledge-data-'));
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
    dataRoot,
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
      result?: { isError?: boolean; content: { text: string }[] };
      error?: { code: number; message: string };
    };
    if (envelope.result === undefined)
      throw Object.assign(new Error(envelope.error?.message ?? 'Missing tool result'), {
        rpcCode: envelope.error?.code,
      });
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
    dataRoot,
    async close() {
      await listener.close();
      await app.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

it('publishes an explicitly requested project insight to Shared', async () => {
  const h = await setup();
  try {
    const projectInsights = join(h.dataRoot, 'knowledge/p/insights');
    mkdirSync(projectInsights, { recursive: true });
    writeFileSync(join(projectInsights, 'profile.md'), '# Distilled profile\n');

    const published = await h.agent({ operation: 'publish_shared', path: 'profile.md' });

    expect(published.isError).toBeUndefined();
    expect(readFileSync(join(h.dataRoot, 'knowledge/shared/insights/profile.md'), 'utf8')).toBe(
      '# Distilled profile\n',
    );
    expect(h.permission).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

it('imports a worktree transcript into project Sources through the bound tool', async () => {
  const h = await setup();
  try {
    mkdirSync(join(sessionWorktree, 'docs/meetings'), { recursive: true });
    writeFileSync(join(sessionWorktree, 'docs/meetings/planning.md'), '# Planning\n');
    const imported = await h.agent({
      operation: 'import_source',
      sourcePath: 'docs/meetings/planning.md',
      destination: 'meetings',
      path: 'planning.md',
    });
    expect(imported.isError).toBeUndefined();
    expect(readFileSync(join(h.dataRoot, 'knowledge/p/sources/meetings/planning.md'), 'utf8')).toBe(
      '# Planning\n',
    );
    expect(h.permission).not.toHaveBeenCalled();
    const conflict = await h.agent({
      operation: 'import_source',
      sourcePath: 'docs/meetings/planning.md',
      destination: 'meetings',
      path: 'planning.md',
    });
    expect(conflict.isError).toBeUndefined();
    writeFileSync(join(sessionWorktree, 'docs/meetings/planning.md'), '# Changed\n');
    const changed = await h.agent({
      operation: 'import_source',
      sourcePath: 'docs/meetings/planning.md',
      destination: 'meetings',
      path: 'planning.md',
    });
    expect(changed.isError).toBe(true);
    expect(readFileSync(join(h.dataRoot, 'knowledge/p/sources/meetings/planning.md'), 'utf8')).toBe(
      '# Planning\n',
    );
  } finally {
    await h.close();
  }
});

it('refuses the retired managed-library operations even where a grant would allow them', async () => {
  const h = await setup();
  try {
    const folder = await ctx.store.knowledge.createFolder({ name: 'Shared' });
    await ctx.store.knowledge.setGrants('p', [{ folderId: folder.id, mode: 'read_write' }]);
    const document = await ctx.store.knowledge.createDocument({
      folderId: folder.id,
      title: 'Notes.md',
      bodyMarkdown: '# Shared',
    });
    for (const request of [
      { operation: 'list' },
      { operation: 'read', documentId: document.id },
      { operation: 'create', folderId: folder.id, title: 'New.md', bodyMarkdown: 'text' },
    ]) {
      // An unknown operation fails argument validation, which the gateway answers
      // as a JSON-RPC invalid-params error rather than a tool result.
      await expect(h.agent(request)).rejects.toMatchObject({ rpcCode: -32602 });
    }
    expect(await ctx.store.knowledge.listDocuments({ folderId: folder.id })).toHaveLength(1);
    expect(await ctx.store.knowledge.hasSessionKnowledgeExposure('s')).toBe(false);
    expect(h.fallback).not.toHaveBeenCalled();
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
    // The insight exists, so the publication could only fail on the caller.
    const projectInsights = join(h.dataRoot, 'knowledge/p/insights');
    mkdirSync(projectInsights, { recursive: true });
    writeFileSync(join(projectInsights, 'profile.md'), '# Distilled profile\n');
    const forged = h.tokens.issue({
      projectId: 'p',
      sessionId: 'nonexistent-session',
      turnId: 'forged-turn',
    });
    const refused = await h.agent({ operation: 'publish_shared', path: 'profile.md' }, forged);
    expect(refused.isError).toBe(true);
    expect(existsSync(join(h.dataRoot, 'knowledge/shared/insights/profile.md'))).toBe(false);
    writeFileSync(join(sessionWorktree, 'transcript.md'), '# Private meeting\n');
    const refusedImport = await h.agent(
      {
        operation: 'import_source',
        sourcePath: 'transcript.md',
        destination: 'meetings',
        path: 'transcript.md',
      },
      forged,
    );
    expect(refusedImport.isError).toBe(true);
    expect(existsSync(join(h.dataRoot, 'knowledge/p/sources/meetings/transcript.md'))).toBe(false);
  } finally {
    await h.close();
  }
});
