import { EventStore, createSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { networkShareRequestSchema } from './network-share-request.js';
import { NetworkShareError, type NetworkShareClient } from './network-share-smb.js';
import { createNetworkShareTool } from './network-share-tool.js';

let ctx: TestDb;
let store: EventStore;
let connectionId: string;
beforeAll(async () => {
  ctx = await createTestDb();
  store = new EventStore(ctx.db, createSecretCipher('34'.repeat(32)));
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

function fakeClient(): NetworkShareClient {
  return {
    test: vi.fn(),
    info: vi.fn(),
    list: vi.fn(),
    read: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    createFolder: vi.fn(),
    rename: vi.fn(),
    deleteFile: vi.fn(async (_target, _path, expected: string) => {
      if (expected !== 'v1') throw new NetworkShareError('conflict');
    }),
    deleteFolder: vi.fn(),
  };
}

const grant = (
  path: string,
  accessMode: 'read-only' | 'read-write' = 'read-write',
  projectId = 'p1',
  connection = connectionId,
) =>
  store.networkShares.grantFolder({
    projectId,
    connectionId: connection,
    path,
    name: path.split('/').at(-1)!,
    accessMode,
  }) as Promise<string>;

const input = (request: object, projectId = 'p1') => ({
  projectId,
  sessionId: `s-${projectId}`,
  turnId: 't1',
  request,
});

/** Runs a request the way an approved card does: snapshot first, then invoke under it. */
async function approved(tool: ReturnType<typeof createNetworkShareTool>, request: object) {
  const call = input(request);
  const snapshot = await tool.snapshot(call);
  return tool.invoke({ ...call, approvedByCard: true, authorizationSnapshot: snapshot! });
}

describe('network share changes', () => {
  it('creates folders under the grant without asking', async () => {
    const client = fakeClient();
    const logWrite = vi.fn();
    const tool = createNetworkShareTool({ store, client, logWrite });
    const folderId = await grant('Projects/Briefs');
    const call = input({ action: 'create_folder', folderId, path: 'Reviews/2026' });
    expect(await tool.standing(call)).toBe(true);
    expect(await tool.invoke(call)).toEqual({ path: 'Reviews/2026', kind: 'folder' });
    expect(client.createFolder).toHaveBeenCalledWith(
      expect.anything(),
      'Projects/Briefs/Reviews/2026',
    );
    expect(logWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'create_folder', path: 'Projects/Briefs/Reviews/2026' }),
    );
  });

  // Every change to something that exists is the user's decision, and a
  // read-only grant must refuse it before a card could even be shown.
  it('asks before every rename, move and delete, and refuses them on read-only folders', async () => {
    const client = fakeClient();
    const tool = createNetworkShareTool({ store, client });
    const folderId = await grant('Projects/Briefs');
    const readOnly = await grant('Projects/Archive', 'read-only');
    const requests = [
      { action: 'rename', folderId, path: 'a.md', kind: 'file', newName: 'b.md' },
      { action: 'move', folderId, path: 'a.md', kind: 'file', toPath: 'old/a.md' },
      { action: 'delete', folderId, path: 'a.md', kind: 'file', expectedVersion: 'v1' },
      { action: 'delete', folderId, path: 'Empty', kind: 'folder' },
    ];
    for (const request of requests) {
      expect(await tool.standing(input(request))).toBe(false);
      await expect(tool.invoke(input(request))).rejects.toThrow('Ask again');
      await expect(tool.authorize(input({ ...request, folderId: readOnly }))).rejects.toThrow(
        'may only read this folder',
      );
    }
    await expect(
      tool.authorize(input({ action: 'create_folder', folderId: readOnly, path: 'x' })),
    ).rejects.toThrow('may only read this folder');
    expect(client.rename).not.toHaveBeenCalled();
    expect(client.deleteFile).not.toHaveBeenCalled();
    expect(client.deleteFolder).not.toHaveBeenCalled();
  });

  it('renames and moves within the grant and binds the card to source and destination', async () => {
    const client = fakeClient();
    const logWrite = vi.fn();
    const tool = createNetworkShareTool({ store, client, logWrite });
    const folderId = await grant('Projects/Briefs');
    expect(
      await approved(tool, {
        action: 'rename',
        folderId,
        path: 'drafts/a.md',
        kind: 'file',
        newName: 'b.md',
      }),
    ).toEqual({ folderId, path: 'drafts/b.md', kind: 'file' });
    expect(client.rename).toHaveBeenLastCalledWith(
      expect.anything(),
      'file',
      'Projects/Briefs/drafts/a.md',
      'Projects/Briefs/drafts/b.md',
    );
    expect(logWrite).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'rename', toPath: 'Projects/Briefs/drafts/b.md' }),
    );

    const move = input({
      action: 'move',
      folderId,
      path: 'Reviews',
      kind: 'folder',
      toPath: 'Archive/Reviews',
    });
    const snapshot = (await tool.snapshot(move))!;
    // The card names a destination; another one under it must not run.
    await expect(
      tool.invoke({
        ...input({ ...move.request, toPath: 'Elsewhere/Reviews' }),
        approvedByCard: true,
        authorizationSnapshot: snapshot,
      }),
    ).rejects.toThrow('Ask again');
    await tool.invoke({ ...move, approvedByCard: true, authorizationSnapshot: snapshot });
    expect(client.rename).toHaveBeenLastCalledWith(
      expect.anything(),
      'folder',
      'Projects/Briefs/Reviews',
      'Projects/Briefs/Archive/Reviews',
    );
  });

  it('moves to another granted folder only when it is writable and on the same share', async () => {
    const client = fakeClient();
    const tool = createNetworkShareTool({ store, client });
    const folderId = await grant('Projects/Briefs');
    const archive = await grant('Archive');
    const readOnly = await grant('Reference', 'read-only');
    const otherShare = await store.networkShares.createConnection({
      label: 'Backup NAS',
      host: 'backup.lan',
      port: null,
      share: 'team',
      username: 'verity',
      password: 'pw',
    });
    const elsewhere = await grant('Inbox', 'read-write', 'p1', otherShare);
    const foreign = await grant('Theirs', 'read-write', 'p2');
    const move = (toFolderId: string) => ({
      action: 'move',
      folderId,
      path: 'a.md',
      kind: 'file',
      toFolderId,
      toPath: 'a.md',
    });
    expect(await approved(tool, move(archive))).toEqual({
      folderId: archive,
      path: 'a.md',
      kind: 'file',
    });
    expect(client.rename).toHaveBeenLastCalledWith(
      expect.anything(),
      'file',
      'Projects/Briefs/a.md',
      'Archive/a.md',
    );
    await expect(tool.authorize(input(move(readOnly)))).rejects.toThrow('may only read');
    await expect(tool.authorize(input(move(elsewhere)))).rejects.toThrow('same network share');
    await expect(tool.authorize(input(move(foreign)))).rejects.toThrow(
      'not shared with the project',
    );

    // A destination downgraded after the card was shown stops the move.
    const call = input(move(archive));
    const snapshot = (await tool.snapshot(call))!;
    await store.networkShares.setFolderAccess('p1', archive, 'read-only');
    await expect(
      tool.invoke({ ...call, approvedByCard: true, authorizationSnapshot: snapshot }),
    ).rejects.toThrow('may only read');
    expect(client.rename).toHaveBeenCalledTimes(1);
  });

  // Grants are paths: renaming, moving or deleting a folder that is or holds
  // one would leave a project without its folder, or point it at other files.
  it('leaves folders granted to any project alone', async () => {
    const client = fakeClient();
    const tool = createNetworkShareTool({ store, client });
    const folderId = await grant('Projects');
    await grant('Projects/Briefs/Client A', 'read-only', 'p2');
    const refused = [
      { action: 'rename', folderId, path: 'Briefs', kind: 'folder', newName: 'Old briefs' },
      { action: 'move', folderId, path: 'Briefs', kind: 'folder', toPath: 'Archive/Briefs' },
      { action: 'delete', folderId, path: 'briefs', kind: 'folder' },
      // Nor may something take a granted path that is missing for now.
      { action: 'move', folderId, path: 'Other', kind: 'folder', toPath: 'Briefs/Client A' },
    ];
    for (const request of refused)
      await expect(tool.authorize(input(request))).rejects.toThrow('shared with a project');
    await expect(
      tool.authorize(
        input({ action: 'rename', folderId, path: '/', kind: 'folder', newName: 'X' }),
      ),
    ).rejects.toThrow('granted folder itself');
    await expect(
      tool.authorize(
        input({ action: 'rename', folderId, path: 'Briefs/Notes', kind: 'folder', newName: 'N' }),
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses moves into the item itself and names that leave the folder', async () => {
    const tool = createNetworkShareTool({ store, client: fakeClient() });
    const folderId = await grant('Projects/Briefs');
    for (const request of [
      { action: 'move', folderId, path: 'Reviews', kind: 'folder', toPath: 'Reviews/Inner' },
      { action: 'move', folderId, path: 'Reviews', kind: 'folder', toPath: 'reviews' },
      { action: 'move', folderId, path: 'a.md', kind: 'file', toPath: '../a.md' },
      { action: 'rename', folderId, path: 'a.md', kind: 'file', newName: 'sub/b.md' },
      { action: 'rename', folderId, path: 'a.md', kind: 'file', newName: '..' },
    ])
      await expect(tool.authorize(input(request))).rejects.toThrow();
  });

  it('deletes a file only at the version read, and folders without a version', async () => {
    const client = fakeClient();
    const tool = createNetworkShareTool({ store, client });
    const folderId = await grant('Projects/Briefs');
    await expect(
      tool.authorize(input({ action: 'delete', folderId, path: 'a.md', kind: 'file' })),
    ).rejects.toThrow('expectedVersion');
    await expect(
      tool.authorize(
        input({ action: 'delete', folderId, path: 'Empty', kind: 'folder', expectedVersion: 'v1' }),
      ),
    ).rejects.toThrow('expectedVersion');
    const remove = {
      action: 'delete',
      folderId,
      path: 'a.md',
      kind: 'file',
      expectedVersion: 'v1',
    };
    expect(await approved(tool, remove)).toEqual({ path: 'a.md', kind: 'file', deleted: true });
    expect(client.deleteFile).toHaveBeenCalledWith(expect.anything(), 'Projects/Briefs/a.md', 'v1');
    await expect(approved(tool, { ...remove, expectedVersion: 'old' })).rejects.toThrow(
      'changed on the share',
    );
    expect(
      await approved(tool, { action: 'delete', folderId, path: 'Empty', kind: 'folder' }),
    ).toEqual({ path: 'Empty', kind: 'folder', deleted: true });
    expect(client.deleteFolder).toHaveBeenCalledWith(expect.anything(), 'Projects/Briefs/Empty');
  });

  // The card is what the user decides on; it must name folders as the user
  // knows them, never just the IDs the agent passed.
  it('describes each approval by share and folder names', async () => {
    const tool = createNetworkShareTool({ store, client: fakeClient() });
    const folderId = await grant('Projects/Briefs');
    const archive = await grant('Archive');
    const present = (request: object) => tool.presentation(input(request));
    expect(
      await present({
        action: 'delete',
        folderId,
        path: 'old/kickoff.md',
        kind: 'file',
        expectedVersion: 'v1',
      }),
    ).toEqual({
      networkShare: {
        action: 'delete',
        kind: 'file',
        share: 'Studio NAS',
        location: 'Studio NAS › Projects › Briefs › old › kickoff.md',
      },
    });
    expect(
      await present({
        action: 'move',
        folderId,
        path: 'Reviews',
        kind: 'folder',
        toFolderId: archive,
        toPath: 'Reviews 2025',
      }),
    ).toMatchObject({
      networkShare: {
        location: 'Studio NAS › Projects › Briefs › Reviews',
        destination: 'Studio NAS › Archive › Reviews 2025',
      },
    });
    const long = `# Kickoff\n${'x'.repeat(2000)}`;
    const update = (await present({
      action: 'update',
      folderId,
      path: 'kickoff.md',
      expectedVersion: 'v1',
      content: long,
    }))!.networkShare;
    expect(update.content?.bytes).toBe(Buffer.byteLength(long));
    expect(update.content?.preview).toBe(long.slice(0, 600));
    const binary = (await present({
      action: 'update',
      folderId,
      path: 'logo.png',
      expectedVersion: 'v1',
      content: Buffer.from([0xff, 0xfe, 0x00]).toString('base64'),
      encoding: 'base64',
    }))!.networkShare;
    expect(binary.content).toEqual({ bytes: 3 });
    // Nothing to show for calls that run without a card.
    expect(await present({ action: 'create_folder', folderId, path: 'New' })).toBeUndefined();
  });

  it('accepts only the documented request shapes', () => {
    const folderId = 'f';
    expect(
      networkShareRequestSchema.safeParse({ action: 'move', folderId, path: 'a', kind: 'file' })
        .success,
    ).toBe(false);
    expect(
      networkShareRequestSchema.safeParse({
        action: 'delete',
        folderId,
        path: 'a',
        kind: 'everything',
      }).success,
    ).toBe(false);
  });
});
