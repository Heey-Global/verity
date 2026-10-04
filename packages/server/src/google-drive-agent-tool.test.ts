import { describe, expect, it, vi } from 'vitest';

import { createGoogleDriveAgentTool, type GoogleDriveAgentApi } from './google-drive-agent-tool.js';
import { GoogleDriveError, type DriveFile } from './google-drive.js';

const input = { projectId: 'p1', sessionId: 's1', turnId: 't1', invocationId: 'i1' };
const root = { id: 'root', name: 'Project', mimeType: 'application/vnd.google-apps.folder' };

function setup(files: Record<string, DriveFile> = {}) {
  const all: Record<string, DriveFile> = { root, ...files };
  const download = vi.fn(async () => new TextEncoder().encode('hello'));
  const exportFile = vi.fn(async () => new TextEncoder().encode('# doc'));
  const create = vi.fn(
    async (_token: string, value: Parameters<GoogleDriveAgentApi['create']>[1]) => ({
      id: 'new',
      name: value.name,
      mimeType: value.mimeType,
      parents: [value.parentId],
    }),
  );
  const drive: GoogleDriveAgentApi = {
    get: vi.fn(async (_token: string, id: string) => {
      const file = all[id];
      if (!file) throw new Error('missing');
      return file;
    }),
    list: vi.fn(async (request: Parameters<GoogleDriveAgentApi['list']>[0]) => ({
      files: Object.values(all).filter((file) =>
        request.query
          ? file.name.includes(request.query)
          : request.parentId !== undefined && file.parents?.includes(request.parentId),
      ),
    })),
    download,
    export: exportFile,
    create,
    mutate: vi.fn(async (_token, id, value) => ({
      ...all[id]!,
      name: value.name ?? all[id]!.name,
      version: 'next',
    })),
  };
  const eventStore = {
    getCompletedGoogleWorkspaceInvocation: vi.fn(
      async (): Promise<{ result: unknown } | undefined> => undefined,
    ),
    getSession: vi.fn(async () => ({ projectId: 'p1' })),
    getProjectSettings: vi.fn(async () => ({ googleDriveFolderId: 'root' }) as never),
    setSessionWorkspaceFile: vi.fn(async () => undefined),
    claimGoogleWorkspaceInvocation: vi.fn(async () => ({ status: 'claimed' as const })),
    completeGoogleWorkspaceInvocation: vi.fn(async () => undefined),
  };
  const tool = createGoogleDriveAgentTool({
    eventStore,
    googleAccessToken: async () => 'token',
    drive,
  });
  return { tool, drive, eventStore, download, exportFile, create };
}

describe('project Google Drive agent tool', () => {
  it('lists the linked folder and enforces session project authority', async () => {
    const { tool } = setup({
      a: { id: 'a', name: 'A', mimeType: 'text/plain', parents: ['root'] },
    });
    await expect(tool.invoke({ ...input, request: { action: 'list' } })).resolves.toMatchObject({
      files: [{ id: 'a' }],
    });
    await expect(
      tool.invoke({ ...input, projectId: 'other', request: { action: 'list' } }),
    ).rejects.toThrow('calling session');
  });

  it('filters global search results and rejects reads outside the linked ancestry', async () => {
    const { tool, download } = setup({
      inside: { id: 'inside', name: 'Plan', mimeType: 'text/plain', parents: ['root'] },
      outside: { id: 'outside', name: 'Plan', mimeType: 'text/plain', parents: ['elsewhere'] },
      elsewhere: {
        id: 'elsewhere',
        name: 'Elsewhere',
        mimeType: 'application/vnd.google-apps.folder',
      },
    });
    await expect(
      tool.invoke({ ...input, request: { action: 'search', query: 'Plan' } }),
    ).resolves.toMatchObject({ files: [{ id: 'inside' }] });
    await expect(
      tool.invoke({ ...input, request: { action: 'read', fileId: 'outside' } }),
    ).rejects.toThrow('outside the linked');
    expect(download).not.toHaveBeenCalled();
  });

  it('reads native Docs by export and uploads into an authorized nested folder', async () => {
    const { tool, exportFile, create } = setup({
      docs: {
        id: 'docs',
        name: 'Brief',
        mimeType: 'application/vnd.google-apps.document',
        parents: ['root'],
      },
      nested: {
        id: 'nested',
        name: 'Nested',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
      },
    });
    await expect(
      tool.invoke({ ...input, request: { action: 'read', name: 'Brief' } }),
    ).resolves.toMatchObject({ encoding: 'utf8', content: '# doc' });
    await tool.invoke({
      ...input,
      request: {
        action: 'upload',
        name: 'note.txt',
        mimeType: 'text/plain',
        content: 'hi',
        folderId: 'nested',
      },
    });
    expect(exportFile).toHaveBeenCalledWith('token', 'docs', 'text/markdown');
    expect(create).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({ parentId: 'nested', bytes: Buffer.from('hi') }),
    );
  });

  it('selects an authorized native file for the existing Workspace editor', async () => {
    const { tool, eventStore } = setup({
      deck: {
        id: 'deck',
        name: 'Roadmap',
        mimeType: 'application/vnd.google-apps.presentation',
        parents: ['root'],
      },
    });
    await expect(
      tool.invoke({ ...input, request: { action: 'select_workspace_file', name: 'Roadmap' } }),
    ).resolves.toMatchObject({ selected: true, kind: 'slides' });
    expect(eventStore.setSessionWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', fileId: 'deck', kind: 'slides' }),
    );
  });

  it('checks every search page before resolving a file name', async () => {
    const { tool, drive } = setup({
      late: { id: 'late', name: 'Plan', mimeType: 'text/plain', parents: ['root'] },
    });
    const list = vi
      .fn<GoogleDriveAgentApi['list']>()
      .mockResolvedValueOnce({ files: [], nextPageToken: 'page-2' })
      .mockResolvedValueOnce({
        files: [{ id: 'late', name: 'Plan', mimeType: 'text/plain', parents: ['root'] }],
      });
    drive.list = list;

    await expect(
      tool.invoke({ ...input, request: { action: 'read', name: 'Plan' } }),
    ).resolves.toMatchObject({ content: 'hello' });
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageToken: 'page-2' }));
  });

  it('skips search results whose ancestry is not readable', async () => {
    const { tool, drive } = setup({
      blocked: { id: 'blocked', name: 'Plan', mimeType: 'text/plain', parents: ['hidden'] },
      allowed: { id: 'allowed', name: 'Plan', mimeType: 'text/plain', parents: ['root'] },
    });
    const originalGet = drive.get.bind(drive);
    drive.get = vi.fn(async (token: string, fileId: string) => {
      if (fileId === 'hidden') throw new GoogleDriveError('forbidden', 'http_403');
      return originalGet(token, fileId);
    });

    await expect(
      tool.invoke({ ...input, request: { action: 'read', name: 'Plan' } }),
    ).resolves.toMatchObject({ file: { id: 'allowed' } });
  });
});

describe('Drive file mutations', () => {
  const file = {
    id: 'file',
    name: 'Note',
    mimeType: 'text/plain',
    parents: ['root'],
    version: 'v1',
  };
  const request = {
    action: 'overwrite',
    fileId: 'file',
    name: 'Note',
    expectedVersion: 'v1',
    content: 'updated',
  };
  it('requires a separate approval and a current version before overwriting', async () => {
    const { tool, drive } = setup({ file });
    await expect(tool.invoke({ ...input, request })).rejects.toThrow('explicit approval');
    await expect(
      tool.invoke({
        ...input,
        approvedByCard: true,
        request: { ...request, expectedVersion: 'old' },
      }),
    ).rejects.toThrow('changed');
    expect(drive.mutate).not.toHaveBeenCalled();
    await tool.invoke({ ...input, approvedByCard: true, request });
    expect(drive.mutate).toHaveBeenCalledWith('token', 'file', {
      expectedVersion: 'v1',
      bytes: Buffer.from('updated'),
      mimeType: 'text/plain',
    });
  });
  it.each([
    { action: 'upload', name: 'New', mimeType: 'text/plain', content: '' },
    { action: 'create_folder', name: 'New' },
    request,
    { action: 'rename', fileId: 'file', name: 'Note', newName: 'Next', expectedVersion: 'v1' },
    { action: 'move', fileId: 'file', name: 'Note', folderId: 'root', expectedVersion: 'v1' },
    { action: 'trash', fileId: 'file', name: 'Note', expectedVersion: 'v1' },
  ])('rejects $action in a read-only project', async (request) => {
    const { tool, drive, eventStore } = setup({ file });
    eventStore.getProjectSettings.mockResolvedValue({
      googleDriveFolderId: 'root',
      googleDriveAccessMode: 'read-only',
    } as never);
    await expect(tool.invoke({ ...input, approvedByCard: true, request })).rejects.toThrow(
      'read-only',
    );
    expect(drive.mutate).not.toHaveBeenCalled();
    expect(drive.create).not.toHaveBeenCalled();
  });
  it('checks both move endpoints and prevents moving a folder into its own descendants', async () => {
    const nested = {
      id: 'nested',
      name: 'Nested',
      mimeType: root.mimeType,
      parents: ['root'],
      version: 'v1',
    };
    const { tool, drive } = setup({
      nested,
      child: { id: 'child', name: 'Child', mimeType: root.mimeType, parents: ['nested'] },
      outside: { id: 'outside', name: 'Outside', mimeType: root.mimeType, parents: [] },
    });
    for (const folderId of ['outside', 'child', 'nested'])
      await expect(
        tool.invoke({
          ...input,
          approvedByCard: true,
          request: {
            action: 'move',
            name: 'Nested',
            fileId: 'nested',
            folderId,
            expectedVersion: 'v1',
          },
        }),
      ).rejects.toThrow();
    expect(drive.mutate).not.toHaveBeenCalled();
  });
  it('trashes an entire folder after approval without permanently deleting it', async () => {
    const folder = {
      id: 'nested',
      name: 'Nested',
      mimeType: root.mimeType,
      parents: ['root'],
      version: 'v1',
    };
    const { tool, drive } = setup({ nested: folder, child: { ...file, parents: ['nested'] } });
    await tool.invoke({
      ...input,
      approvedByCard: true,
      request: { action: 'trash', name: 'Nested', fileId: 'nested', expectedVersion: 'v1' },
    });
    expect(drive.mutate).toHaveBeenCalledWith('token', 'nested', {
      expectedVersion: 'v1',
      trashed: true,
    });
  });
  it('does not overwrite native contents or mutate the linked root', async () => {
    const { tool, drive } = setup({
      native: { ...file, id: 'native', mimeType: 'application/vnd.google-apps.document' },
    });
    await expect(
      tool.invoke({ ...input, approvedByCard: true, request: { ...request, fileId: 'native' } }),
    ).rejects.toThrow('Native');
    await expect(
      tool.invoke({
        ...input,
        approvedByCard: true,
        request: { action: 'trash', fileId: 'root', name: 'Project', expectedVersion: 'v1' },
      }),
    ).rejects.toThrow('linked project folder');
    expect(drive.mutate).not.toHaveBeenCalled();
  });
  it('rechecks revoked folder access before sending any mutation', async () => {
    const { tool, drive, eventStore } = setup({ file });
    eventStore.getProjectSettings
      .mockResolvedValueOnce({ googleDriveFolderId: 'root' } as never)
      .mockResolvedValue({ googleDriveFolderId: null } as never);
    await expect(tool.invoke({ ...input, approvedByCard: true, request })).rejects.toThrow(
      'access changed',
    );
    expect(drive.mutate).not.toHaveBeenCalled();
  });
  it('returns completed retries and refuses uncertain pending writes', async () => {
    const { tool, drive, eventStore } = setup();
    eventStore.claimGoogleWorkspaceInvocation
      .mockResolvedValueOnce({ status: 'completed', result: { id: 'saved' } } as never)
      .mockResolvedValueOnce({ status: 'pending' } as never);
    await expect(
      tool.invoke({ ...input, request: { action: 'create_folder', name: 'New' } }),
    ).resolves.toEqual({ id: 'saved' });
    await expect(
      tool.invoke({ ...input, request: { action: 'create_folder', name: 'New' } }),
    ).rejects.toThrow('may already have happened');
    expect(drive.create).not.toHaveBeenCalled();
  });
});

it('invalidates writes if the connected account changes during metadata lookup', async () => {
  const { tool, drive, eventStore } = setup({
    file: { id: 'file', name: 'Note', mimeType: 'text/plain', parents: ['root'], version: 'v1' },
  });
  Object.assign(eventStore, {
    getVeritySettings: vi
      .fn()
      .mockResolvedValueOnce({
        googleDriveAccountEmail: 'old@example.test',
        googleDriveRefreshToken: 'old',
      })
      .mockResolvedValue({
        googleDriveAccountEmail: 'new@example.test',
        googleDriveRefreshToken: 'new',
      }),
  });
  await expect(
    tool.invoke({
      ...input,
      approvedByCard: true,
      request: { action: 'trash', fileId: 'file', name: 'Note', expectedVersion: 'v1' },
    }),
  ).rejects.toThrow('account changed');
  expect(drive.mutate).not.toHaveBeenCalled();
});
it('invalidates a mutation if the calling session is moved to another project', async () => {
  const { tool, drive, eventStore } = setup();
  eventStore.getSession
    .mockResolvedValueOnce({ projectId: 'p1' })
    .mockResolvedValue({ projectId: 'other' });
  await expect(
    tool.invoke({ ...input, request: { action: 'create_folder', name: 'New' } }),
  ).rejects.toThrow('session changed');
  expect(drive.create).not.toHaveBeenCalled();
});

it.each(['application/vnd.google-apps.document', ' application/vnd.google-apps.document '])(
  'rejects native conversion through an upload with MIME type %s',
  async (mimeType) => {
    const { tool, create } = setup();
    await expect(
      tool.invoke({
        ...input,
        request: { action: 'upload', name: 'New', mimeType, content: 'text' },
      }),
    ).rejects.toThrow('dedicated Workspace tools');
    expect(create).not.toHaveBeenCalled();
  },
);

it.each(['overwrite', 'rename', 'move', 'trash'])(
  'returns completed %s without consulting mutated target state',
  async (action) => {
    const { tool, drive, eventStore } = setup();
    eventStore.getCompletedGoogleWorkspaceInvocation.mockResolvedValue({ result: { id: 'saved' } });
    await expect(
      tool.invoke({
        ...input,
        approvedByCard: true,
        request: {
          action,
          fileId: 'missing',
          name: 'Before',
          expectedVersion: 'old',
          ...(action === 'overwrite' ? { content: 'new' } : {}),
          ...(action === 'rename' ? { newName: 'After' } : {}),
          ...(action === 'move' ? { folderId: 'root' } : {}),
        },
      }),
    ).resolves.toEqual({ id: 'saved' });
    expect(drive.get).not.toHaveBeenCalled();
    expect(drive.mutate).not.toHaveBeenCalled();
  },
);
