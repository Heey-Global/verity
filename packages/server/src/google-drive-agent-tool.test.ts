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
  };
  const eventStore = {
    getSession: vi.fn(async () => ({ projectId: 'p1' })),
    getProjectSettings: vi.fn(async () => ({ googleDriveFolderId: 'root' }) as never),
    setSessionWorkspaceFile: vi.fn(async () => undefined),
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
