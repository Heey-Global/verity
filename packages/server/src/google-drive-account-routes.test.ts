import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '@verity/store/testing';
import { registerGoogleDriveRoutes } from './google-drive-routes.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'local',
    repo: 'project',
    containerName: 'project',
    state: 'active',
  });
  await ctx.store.createSession({
    sessionId: 's',
    projectId: 'p',
    worktree: '/test',
    model: 'test',
  });
});
afterAll(async () => {
  await ctx.close();
});

it.each(['/sessions/s/google-workspace/file', '/sessions/s/google-slides/deck'])(
  'keeps %s bound to its selected account and linked folder during network requests',
  async (url) => {
    const account = await ctx.store.googleAccounts.save({
      email: 'assignment@example.test',
      clientId: 'client',
      refreshToken: 'refresh',
      scopes: ['drive', 'presentations'].map((scope) => 'https://www.googleapis.com/auth/' + scope),
    });
    const link = await ctx.store.googleAccounts.linkFolder({
      projectId: 'p',
      accountId: account.id,
      folderId: 'root',
      name: 'Root',
      accessMode: 'read-write',
    });
    let outside = true;
    let revoke = false;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const target =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (target.includes('oauth2.googleapis.com'))
        return new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }));
      if (target.includes('slides.googleapis.com')) {
        if (revoke) await ctx.store.googleAccounts.unlinkFolder('p', link.id);
        return new Response(
          JSON.stringify({ presentationId: 'deck', title: 'Deck', revisionId: 'revision' }),
        );
      }
      return new Response(
        JSON.stringify({
          id: target.includes('/files/root?') ? 'root' : 'deck',
          name: 'Deck',
          mimeType: 'application/vnd.google-apps.presentation',
          capabilities: { canEdit: true },
          parents: outside ? [] : ['root'],
        }),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const app = Fastify();
    registerGoogleDriveRoutes(app, { eventStore: ctx.store });
    const payload = { fileId: 'deck', accountId: account.id, folderLinkId: link.id };
    try {
      expect((await app.inject({ method: 'PUT', url, payload })).statusCode).not.toBe(200);
      expect(await ctx.store.getSessionWorkspaceFile('s')).toBeUndefined();
      outside = false;
      await ctx.store.googleAccounts.linkFolder({
        projectId: 'p',
        accountId: account.id,
        folderId: 'root',
        name: 'Root',
        accessMode: 'read-only',
      });
      expect(
        (
          await app.inject({
            method: 'PUT',
            url,
            payload: { fileId: 'deck', accountId: account.id },
          })
        ).statusCode,
      ).toBe(409);
      expect(await ctx.store.getSessionWorkspaceFile('s')).toBeUndefined();
      await ctx.store.googleAccounts.linkFolder({
        projectId: 'p',
        accountId: account.id,
        folderId: 'root',
        name: 'Root',
        accessMode: 'read-write',
      });
      expect((await app.inject({ method: 'PUT', url, payload })).statusCode).toBe(200);
      expect(await ctx.store.getSessionWorkspaceFile('s')).toMatchObject({
        accountId: account.id,
        folderLinkId: link.id,
      });
      await ctx.store.clearSessionWorkspaceFile('s');
      revoke = true;
      expect((await app.inject({ method: 'PUT', url, payload })).statusCode).not.toBe(200);
      expect(await ctx.store.getSessionWorkspaceFile('s')).toBeUndefined();
    } finally {
      await app.close();
      vi.unstubAllGlobals();
    }
  },
);

it('keeps mixed-account folder operations on the chosen credentials and permission', async () => {
  const { createGoogleDriveAgentTool } = await import('./google-drive-agent-tool.js');
  const personal = await ctx.store.googleAccounts.save({
    email: 'personal-folders@example.test',
    clientId: 'client',
    refreshToken: 'personal',
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const work = await ctx.store.googleAccounts.save({
    email: 'work-folders@example.test',
    clientId: 'client',
    refreshToken: 'work',
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const one = await ctx.store.googleAccounts.linkFolder({
    projectId: 'p',
    accountId: personal.id,
    folderId: 'root',
    name: 'Personal',
    accessMode: 'read-only',
  });
  const two = await ctx.store.googleAccounts.linkFolder({
    projectId: 'p',
    accountId: work.id,
    folderId: 'root',
    name: 'Work',
    accessMode: 'read-write',
  });
  const { assertWorkspaceWriteAccess } = await import('./google-workspace-tool-types.js');
  await expect(
    assertWorkspaceWriteAccess(ctx.store, 'p', {
      accountId: personal.id,
      assignmentId: 'unbound',
      fileId: 'doc',
      kind: 'docs',
      revisionId: null,
    }),
  ).rejects.toThrow('folder');
  const googleAccessToken = vi.fn(async (id?: string) => id);
  const drive = {
    get: vi.fn(async () => ({
      id: 'root',
      name: 'Root',
      mimeType: 'application/vnd.google-apps.folder',
    })),
    list: vi.fn(async () => ({ files: [] })),
    create: vi.fn(async () => ({
      id: 'new',
      name: 'New',
      mimeType: 'application/vnd.google-apps.folder',
    })),
    mutate: vi.fn(),
    download: vi.fn(),
    export: vi.fn(),
  };
  const tool = createGoogleDriveAgentTool({ eventStore: ctx.store, googleAccessToken, drive });
  const input = { sessionId: 's', projectId: 'p', turnId: 'turn', invocationId: 'mixed-folders' };
  await expect(tool.invoke({ ...input, request: { action: 'list' } })).rejects.toThrow(
    'folderLinkId',
  );
  await tool.invoke({ ...input, request: { action: 'list', folderLinkId: one.id } });
  expect(googleAccessToken).toHaveBeenLastCalledWith(personal.id);
  await expect(
    tool.invoke({
      ...input,
      request: { action: 'create_folder', name: 'New', folderLinkId: one.id },
    }),
  ).rejects.toThrow('read-only');
  expect(drive.create).not.toHaveBeenCalled();
  await tool.invoke({
    ...input,
    request: { action: 'create_folder', name: 'New', folderLinkId: two.id },
  });
  expect(drive.create).toHaveBeenCalledWith(
    work.id,
    expect.objectContaining({ parentId: 'root', name: 'New' }),
  );
  await expect(
    tool.invoke({
      ...input,
      request: { action: 'list', folderLinkId: two.id, accountId: personal.id },
    }),
  ).rejects.toThrow('authorized Google account');
});
