import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerSessionFileRoutes, type SessionFileRouteDeps } from './session-file-routes.js';

it('normalizes Wiki and Raw Sources aliases without changing write protection', async () => {
  const app = Fastify();
  const write = vi.fn(async () => ({ ok: true }));
  const deps: SessionFileRouteDeps = {
    resolveRoot: async (_session, root) => `/knowledge/${root}`,
    list: async (_reply, target) => ({ root: target.root }),
    upload: async () => undefined,
    history: async () => undefined,
    content: async () => undefined,
    download: async () => undefined,
    remove: async () => undefined,
    move: async () => undefined,
    write,
  };
  registerSessionFileRoutes(app, deps);
  try {
    for (const [alias, expected] of [
      ['wiki', 'documents'],
      ['documents', 'documents'],
      ['raw-sources', 'sources'],
      ['sources', 'sources'],
    ]) {
      const result = await app.inject(`/sessions/s/files?root=${alias}`);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ root: expected });
    }
    const result = await app.inject({
      method: 'PUT',
      url: '/sessions/s/files/content',
      payload: {
        root: 'raw-sources',
        path: 'original.md',
        content: 'overwrite',
        expectedVersion: null,
      },
    });
    expect(result.statusCode).toBe(403);
    expect(write).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

// Changing the code working copy by hand is part of the Code permission; a
// member without it still edits Documents and still reads the worktree, where
// the agent's generated files are linked from the conversation.
it('needs Code to change worktree files, and only those', async () => {
  const app = Fastify();
  const write = vi.fn(async () => ({ ok: true }));
  const remove = vi.fn(async () => undefined);
  const move = vi.fn(async () => undefined);
  const upload = vi.fn(async () => undefined);
  const content = vi.fn(async () => ({ text: 'readable' }));
  const createFolder = vi.fn(async () => ({ path: 'new' }));
  const mayChangeCode = vi.fn(async () => false);
  let workspaceKind: 'documents' | 'code' = 'code';
  registerSessionFileRoutes(app, {
    workspaceKind: async () => workspaceKind,
    resolveRoot: async (_session, root) => `/files/${root}`,
    list: async () => [],
    upload,
    history: async () => undefined,
    content,
    download: async () => undefined,
    remove,
    move,
    write,
    createFolder,
    mayChangeCode,
  });
  const put = (root: string) =>
    app.inject({
      method: 'PUT',
      url: '/sessions/s/files/content',
      payload: { root, path: 'a.md', content: 'x', expectedVersion: null },
    });
  try {
    expect((await put('worktree')).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'DELETE', url: '/sessions/s/files?path=a.md' })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/sessions/s/files/move',
          payload: { root: 'worktree', path: 'a.md', toRoot: 'worktree', toPath: 'b' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/sessions/s/files?fileName=a.png', payload: '' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/sessions/s/files/folders',
          payload: { root: 'worktree', name: 'new' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'DELETE', url: '/sessions/s/files?root=worktree&path=a.md' }))
        .statusCode,
    ).toBe(403);
    expect(createFolder).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();

    expect((await app.inject('/sessions/s/files/content?path=a.md')).statusCode).toBe(200);
    expect((await put('documents')).statusCode).toBe(200);
    expect(write).toHaveBeenCalledTimes(1);

    // A Documents session keeps its documents in the worktree; they stay editable.
    workspaceKind = 'documents';
    expect((await put('worktree')).statusCode).toBe(200);
    expect(write).toHaveBeenCalledTimes(2);
    workspaceKind = 'code';

    mayChangeCode.mockResolvedValue(true);
    expect((await put('worktree')).statusCode).toBe(200);
    expect(write).toHaveBeenCalledTimes(3);
  } finally {
    await app.close();
  }
});
