import { InMemoryEventBus, type Conductor } from '@verity/session';
import { EventStore, createSealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { startProjectInternalUnixListener } from './internal-listener.js';
import { createMcpGatewayTokens } from './mcp-gateway-tokens.js';
import { createGoogleDriveAgentTool, type GoogleDriveAgentApi } from './google-drive-agent-tool.js';

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

const deletion = { action: 'trash', fileId: 'file', name: 'Note', expectedVersion: 'v1' };
async function harness(
  run: (h: {
    store: EventStore;
    mutate: ReturnType<typeof vi.fn>;
    approvals: ReturnType<typeof vi.fn>;
    call: (args: unknown) => Promise<{ result?: { isError?: boolean }; error?: unknown }>;
  }) => Promise<void>,
  onApproval?: (store: EventStore) => Promise<void>,
  allow = true,
) {
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
    worktree: '/tmp/drive-gateway-s1',
    model: 'claude-opus-5',
  });
  await store.updateProjectSettings('p1', {
    googleDriveFolderId: 'root',
    googleDriveFolderName: 'Root',
    googleDriveAccessMode: 'read-write',
  });
  await store.updateVeritySettings({
    googleGrantedScopes: ['https://www.googleapis.com/auth/drive'],
    googleDriveRefreshToken: 'refresh',
    googleDriveAccountEmail: 'me@example.test',
  });
  const mutate = vi.fn().mockResolvedValue({ id: 'file', trashed: true });
  const drive: GoogleDriveAgentApi = {
    get: vi.fn(async (_token, id) => ({
      id,
      name: id === 'root' ? 'Root' : 'Note',
      mimeType:
        id === 'root'
          ? 'application/vnd.google-apps.folder'
          : id === 'shared'
            ? 'application/vnd.google-apps.document'
            : 'text/plain',
      parents: id === 'root' ? [] : ['root'],
      version: 'v1',
    })),
    list: vi.fn().mockResolvedValue({ files: [] }),
    download: vi.fn().mockResolvedValue(new Uint8Array()),
    export: vi.fn().mockResolvedValue(new TextEncoder().encode('# Shared document')),
    create: vi.fn(),
    mutate,
  };
  const tool = createGoogleDriveAgentTool({
    eventStore: store,
    drive,
    googleAccessToken: async () => 'token',
  });
  const approvals = vi.fn(async () => {
    await onApproval?.(store);
    return { decision: { behavior: allow ? 'allow' : 'deny' }, decidedBy: 'card' };
  });
  const tokens = createMcpGatewayTokens();
  const app = buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    secretCipher: cipher,
    conductor: { requestExternalPermission: approvals } as unknown as Conductor,
    mcpGateway: {
      servedTools: ['verity_google_drive'],
      resolveCaller: async (input) => tokens.resolve(input),
      invokeTool: (input) => tool.invoke(input),
      recordCall: async () => {},
      requestMac: async ({ request: input }) => ({
        requestMac: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        macKeyId: 'key-1',
      }),
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'verity-drive-gateway-'));
  await app.ready();
  const listener = await startProjectInternalUnixListener(app, {
    socketRoot: dir,
    identity: { projectId: 'p1', containerGeneration: 'generation-1' },
    ownerUid: process.getuid?.() ?? 1000,
    relayGid: process.getgid?.() ?? 1000,
  });
  let id = 0;
  try {
    await run({
      store,
      mutate,
      approvals,
      call: async (args) => {
        const token = tokens.issue({ projectId: 'p1', sessionId: 's1', turnId: 't1' });
        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: ++id,
          method: 'tools/call',
          params: { name: 'verity_google_drive', arguments: args },
        });
        return new Promise((resolve, reject) => {
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
        });
      },
    });
  } finally {
    await listener.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

it('requires a card for every destructive Drive action, but not reads', async () => {
  await harness(async ({ call, approvals, mutate }) => {
    expect((await call({ action: 'read', fileId: 'file' })).result?.isError).not.toBe(true);
    expect(approvals).not.toHaveBeenCalled();
    for (const args of [
      deletion,
      { ...deletion, action: 'rename', newName: 'Next' },
      { ...deletion, action: 'move', folderId: 'root' },
      { ...deletion, action: 'overwrite', content: 'new' },
    ])
      expect((await call(args)).result?.isError).not.toBe(true);
    expect(approvals).toHaveBeenCalledTimes(4);
    expect(mutate).toHaveBeenCalledTimes(4);
  });
});
it('does not mutate after access is revoked while approval is pending', async () => {
  await harness(
    async ({ call, mutate, approvals }) => {
      expect((await call(deletion)).result?.isError).toBe(true);
      expect(approvals).toHaveBeenCalledOnce();
      expect(mutate).not.toHaveBeenCalled();
    },
    async (store) => {
      await store.updateProjectSettings('p1', { googleDriveAccessMode: 'read-only' });
    },
  );
});
it('does not treat a denied card as permission to trash a file', async () => {
  await harness(
    async ({ call, mutate }) => {
      const result = await call(deletion);
      expect(result.error !== undefined || result.result?.isError === true).toBe(true);
      expect(mutate).not.toHaveBeenCalled();
    },
    undefined,
    false,
  );
});

it('allows a document URL read through the authenticated gateway without a project folder', async () => {
  await harness(async ({ store, call, approvals, mutate }) => {
    await store.updateProjectSettings('p1', { googleDriveFolderId: null });
    const result = await call({
      action: 'read_document_url',
      url: 'https://docs.google.com/document/d/shared/edit',
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
    expect(result.result?.isError).not.toBe(true);
    expect(approvals).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    const denied = await call({ action: 'list' });
    expect(denied.error !== undefined || denied.result?.isError === true).toBe(true);
  });
});
