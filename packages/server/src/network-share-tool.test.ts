import { EventStore, createSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectorToolAvailable } from './agent-tool-availability.js';
import { NetworkShareError, type NetworkShareClient, type SmbTarget } from './network-share-smb.js';
import { createNetworkShareTool } from './network-share-tool.js';
import {
  ControlPlaneSessionAuthorityError,
  ControlPlaneSessionToolError,
} from './session-handoff-tool.js';

let ctx: TestDb;
let store: EventStore;
let connectionId: string;
beforeAll(async () => {
  ctx = await createTestDb();
  store = new EventStore(ctx.db, createSecretCipher('12'.repeat(32)));
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  for (const id of ['p1', 'p2']) {
    await store.upsertProject({
      id,
      owner: 'acme',
      repo: id,
      containerName: `dev-acme-${id}`,
      state: 'active',
    });
    await store.createSession({
      sessionId: `s-${id}`,
      projectId: id,
      worktree: `/${id}`,
      model: 't',
    });
  }
  connectionId = await store.networkShares.createConnection({
    label: 'Studio NAS',
    host: 'nas.lan',
    port: null,
    share: 'team',
    username: 'verity',
    password: 'pw',
  });
});

/** A share holding Projects/Briefs/kickoff.md ("hello", version v1) and a binary file. */
function fakeClient() {
  const calls: { op: string; path: string; password: string }[] = [];
  const record = (op: string, target: SmbTarget, path: string) =>
    calls.push({ op, path, password: target.password.toString() });
  const client: NetworkShareClient = {
    test: vi.fn(),
    info: vi.fn(),
    list: vi.fn(async (target: SmbTarget, path: string) => {
      record('list', target, path);
      return [{ name: 'kickoff.md', kind: 'file' as const, size: 5 }];
    }),
    read: vi.fn(async (target: SmbTarget, path: string) => {
      record('read', target, path);
      if (path.endsWith('.bin')) return { content: Buffer.from([0xff, 0x00, 0xfe]), version: 'b1' };
      return { content: Buffer.from('hello'), version: 'v1' };
    }),
    create: vi.fn(async (target: SmbTarget, path: string, content: Buffer) => {
      record('create', target, path);
      if (path.endsWith('kickoff.md')) throw new NetworkShareError('already_exists');
      return { kind: 'file' as const, size: content.byteLength, version: 'n1' };
    }),
    update: vi.fn(async (target: SmbTarget, path: string, content: Buffer, expected: string) => {
      record('update', target, path);
      if (expected !== 'v1') throw new NetworkShareError('conflict');
      return { kind: 'file' as const, size: content.byteLength, version: 'v2' };
    }),
  };
  return { client, calls };
}

const grant = (accessMode: 'read-only' | 'read-write', projectId = 'p1') =>
  store.networkShares.grantFolder({
    projectId,
    connectionId,
    path: 'Projects/Briefs',
    name: 'Briefs',
    accessMode,
  }) as Promise<string>;

const input = (request: object, projectId = 'p1') => ({
  projectId,
  sessionId: `s-${projectId}`,
  turnId: 't1',
  request,
});

describe('network share agent tool', () => {
  it('lists only this project’s current folders', async () => {
    const { client } = fakeClient();
    const tool = createNetworkShareTool({ store, client });
    await grant('read-write');
    await store.networkShares.grantFolder({
      projectId: 'p2',
      connectionId,
      path: 'Other',
      name: 'Other',
      accessMode: 'read-only',
    });
    expect(await tool.invoke(input({ action: 'folders' }))).toEqual({
      folders: [
        {
          folderId: expect.any(String),
          name: 'Briefs',
          location: 'Studio NAS › Projects › Briefs',
          access: 'read-write',
        },
      ],
    });
  });

  it('refuses folders of other projects and calls from another project’s session', async () => {
    const { client } = fakeClient();
    const tool = createNetworkShareTool({ store, client });
    const folderId = await grant('read-write', 'p2');
    await expect(tool.authorize(input({ action: 'list', folderId }))).rejects.toThrow(
      ControlPlaneSessionAuthorityError,
    );
    await expect(
      tool.authorize({ ...input({ action: 'list', folderId }, 'p2'), sessionId: 's-p1' }),
    ).rejects.toThrow('session project changed');
    expect(client.list).not.toHaveBeenCalled();
  });

  // Normalization must reject `..` before the path is joined to the grant;
  // a resolved path would let `Briefs/../Secret` pass as inside `Briefs`.
  it.each(['../Secret/a.md', 'a/../../x', '..\\Other\\a.md', 'a.md:stream'])(
    'keeps %j inside the folder',
    async (path) => {
      const { client } = fakeClient();
      const tool = createNetworkShareTool({ store, client });
      const folderId = await grant('read-write');
      await expect(tool.authorize(input({ action: 'read', folderId, path }))).rejects.toThrow(
        ControlPlaneSessionToolError,
      );
    },
  );

  it('reads files relative to the folder, as text or base64', async () => {
    const { client, calls } = fakeClient();
    const tool = createNetworkShareTool({ store, client });
    const folderId = await grant('read-only');
    expect(await tool.invoke(input({ action: 'read', folderId, path: '/kickoff.md' }))).toEqual({
      path: 'kickoff.md',
      version: 'v1',
      size: 5,
      encoding: 'utf8',
      content: 'hello',
    });
    expect(await tool.invoke(input({ action: 'read', folderId, path: 'x.bin' }))).toMatchObject({
      encoding: 'base64',
      content: Buffer.from([0xff, 0x00, 0xfe]).toString('base64'),
    });
    expect(calls[0]).toEqual({ op: 'read', path: 'Projects/Briefs/kickoff.md', password: 'pw' });
  });

  // An empty or root-only path names the granted folder itself; a file action
  // on it would start replacing the folder.
  it.each(['', '/', '//'])('refuses file actions on the folder itself (%j)', async (path) => {
    const { client } = fakeClient();
    const tool = createNetworkShareTool({ store, client });
    const folderId = await grant('read-write');
    await expect(
      tool.authorize(
        input({ action: 'update', folderId, path, content: 'x', expectedVersion: 'v1' }),
      ),
    ).rejects.toThrow(ControlPlaneSessionToolError);
    expect(client.update).not.toHaveBeenCalled();
  });

  it('refuses writes to read-only folders before asking anyone', async () => {
    const { client } = fakeClient();
    const tool = createNetworkShareTool({ store, client });
    const folderId = await grant('read-only');
    for (const request of [
      { action: 'create', folderId, path: 'new.md', content: 'x' },
      { action: 'update', folderId, path: 'kickoff.md', content: 'x', expectedVersion: 'v1' },
    ])
      await expect(tool.authorize(input(request))).rejects.toThrow('may only read this folder');
    expect(client.create).not.toHaveBeenCalled();
  });

  it('creates new files under the grant and logs the write without its content', async () => {
    const { client } = fakeClient();
    const logWrite = vi.fn();
    const tool = createNetworkShareTool({ store, client, logWrite });
    const folderId = await grant('read-write');
    const create = input({
      action: 'create',
      folderId,
      path: 'notes/plan.md',
      content: 'secret plan',
    });
    expect(await tool.standing(create)).toBe(true);
    expect(await tool.invoke(create)).toEqual({ path: 'notes/plan.md', version: 'n1', size: 11 });
    expect(logWrite).toHaveBeenCalledWith({
      projectId: 'p1',
      sessionId: 's-p1',
      folderId,
      path: 'Projects/Briefs/notes/plan.md',
      action: 'create',
      bytes: 11,
    });
    expect(JSON.stringify(logWrite.mock.calls)).not.toContain('secret plan');
    await expect(
      tool.invoke(input({ action: 'create', folderId, path: 'kickoff.md', content: 'x' })),
    ).rejects.toThrow('already exists');
  });

  it('asks before replacing a file and binds the approval to the grant', async () => {
    const { client } = fakeClient();
    const tool = createNetworkShareTool({ store, client });
    const folderId = await grant('read-write');
    const update = input({
      action: 'update',
      folderId,
      path: 'kickoff.md',
      content: 'new',
      expectedVersion: 'v1',
    });
    expect(await tool.standing(update)).toBe(false);
    const snapshot = await tool.snapshot(update);
    // Without the card, or with a card for an older grant, nothing is written.
    await expect(tool.invoke(update)).rejects.toThrow('Ask again');
    await store.networkShares.setFolderAccess('p1', folderId, 'read-write');
    await expect(
      tool.invoke({ ...update, approvedByCard: true, authorizationSnapshot: snapshot! }),
    ).rejects.toThrow('Ask again');
    expect(client.update).not.toHaveBeenCalled();
    const fresh = await tool.snapshot(update);
    expect(
      await tool.invoke({ ...update, approvedByCard: true, authorizationSnapshot: fresh! }),
    ).toEqual({ path: 'kickoff.md', version: 'v2', size: 3 });
    await expect(
      tool.invoke({
        ...input({ ...update.request, expectedVersion: 'old' }),
        approvedByCard: true,
        authorizationSnapshot: fresh!,
      }),
    ).rejects.toThrow('changed on the share');
  });

  // Running sessions keep their tool list; the grant must be checked per call.
  it('stops working for running sessions when access ends or the target moves', async () => {
    const { client } = fakeClient();
    const tool = createNetworkShareTool({ store, client });
    const folderId = await grant('read-write');
    const read = input({ action: 'read', folderId, path: 'kickoff.md' });
    await tool.invoke(read);
    await store.networkShares.updateConnection(connectionId, { host: 'other-nas.lan' });
    await expect(tool.invoke(read)).rejects.toThrow('not shared with the project');
    const again = await grant('read-write');
    await store.networkShares.removeFolder('p1', again);
    await expect(
      tool.invoke(input({ action: 'read', folderId: again, path: 'kickoff.md' })),
    ).rejects.toThrow('not shared with the project');
  });

  // Creating needs no card, so the grant read at authorization is the only
  // gate; a downgrade landing before the SMB call must still stop the write.
  it('stops a write when the folder is downgraded during the call', async () => {
    const { client } = fakeClient();
    const folderId = await grant('read-write');
    let reads = 0;
    const shares = store.networkShares;
    // Everything else reads through to the real store.
    const racing = Object.assign(Object.create(shares) as typeof shares, {
      projectFolder: async (projectId: string, id: string) => {
        // The second read is the recheck right before the SMB call.
        if (++reads === 2) await shares.setFolderAccess(projectId, id, 'read-only');
        return shares.projectFolder(projectId, id);
      },
    });
    const tool = createNetworkShareTool({
      store: {
        getSession: (id) => store.getSession(id),
        getProject: (id) => store.getProject(id),
        networkShares: racing,
      },
      client,
    });
    await expect(
      tool.invoke(input({ action: 'create', folderId, path: 'new.md', content: 'x' })),
    ).rejects.toThrow('no longer shared');
    expect(client.create).not.toHaveBeenCalled();
  });

  it('is offered only to projects with a current folder', async () => {
    const available = (projectId: string) =>
      connectorToolAvailable(store, {
        projectId,
        sessionId: `s-${projectId}`,
        toolName: 'verity_network_shares',
        userId: undefined,
      });
    expect(await available('p1')).toBe(false);
    await grant('read-only');
    expect(await available('p1')).toBe(true);
    expect(await available('p2')).toBe(false);
    await store.networkShares.updateConnection(connectionId, { share: 'archive' });
    expect(await available('p1')).toBe(false);
  });
});
