import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '@verity/store/testing';
import { registerGoogleDriveRoutes } from './google-drive-routes.js';

/** Routes without a signed-in person act for the installation's administrator. */
const ADMIN = '00000000-0000-4000-8000-000000000001';
const BOB = 'drive-bob';
const CAROL = 'drive-carol';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.db
    .insertInto('users')
    .values([
      { id: BOB, role: 'member', status: 'active' },
      { id: CAROL, role: 'member', status: 'active' },
    ])
    .execute();
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

/** Make `turnId` the running turn of `sessionId`, sent by `userId`. */
async function runTurnFor(userId: string, sessionId: string, turnId: string) {
  const prompt = await ctx.store.appendEvent(sessionId, {
    t: 'prompt',
    text: 'Drive',
    initiatedBy: { userId },
  });
  await ctx.store.markTurnRunning({ sessionId, promptSeq: prompt.seq });
  await ctx.store.bindTurnIdentity(sessionId, { turnId, startCommandId: turnId });
}

/** Drive routes acting for whoever `x-test-user` names; the administrator otherwise. */
async function driveApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('localUserId', null);
  app.addHook('onRequest', async (request) => {
    const user = request.headers['x-test-user'];
    if (typeof user === 'string') request.localUserId = user;
  });
  registerGoogleDriveRoutes(app, { eventStore: ctx.store });
  await app.ready();
  return app;
}

function googleFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(target);
    if (url.origin === 'https://oauth2.googleapis.com')
      return new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }));
    if (url.pathname.startsWith('/drive/v3/files/'))
      return new Response(
        JSON.stringify({
          id: url.pathname.split('/').pop(),
          name: 'Folder',
          mimeType: 'application/vnd.google-apps.folder',
        }),
      );
    return new Response(JSON.stringify({ files: [] }));
  });
}

it.each(['/sessions/s/google-workspace/file', '/sessions/s/google-slides/deck'])(
  'keeps %s bound to its selected account and linked folder during network requests',
  async (url) => {
    const account = await ctx.store.googleAccounts.save({
      ownerUserId: ADMIN,
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
      const url = new URL(target);
      if (url.origin === 'https://oauth2.googleapis.com')
        return new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }));
      if (url.origin === 'https://slides.googleapis.com') {
        if (revoke) await ctx.store.googleAccounts.unlinkFolder('p', link.id);
        return new Response(
          JSON.stringify({ presentationId: 'deck', title: 'Deck', revisionId: 'revision' }),
        );
      }
      if (url.origin !== 'https://www.googleapis.com') throw new Error('Unexpected API origin');
      return new Response(
        JSON.stringify({
          id: url.pathname === '/drive/v3/files/root' ? 'root' : 'deck',
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
    ownerUserId: ADMIN,
    email: 'personal-folders@example.test',
    clientId: 'client',
    refreshToken: 'personal',
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const work = await ctx.store.googleAccounts.save({
    ownerUserId: ADMIN,
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
  const { assertWorkspaceWritePermission } = await import('./google-workspace-tool-types.js');
  await expect(
    assertWorkspaceWritePermission(ctx.store, 'p', {
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
  await runTurnFor(ADMIN, 's', 'turn');
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
  await ctx.store.clearRunningTurn('s');
});

it('refuses to edit an assigned document that moved outside its linked folder', async () => {
  const { createGoogleDocsTool } = await import('./google-docs-tool.js');
  const account = await ctx.store.googleAccounts.save({
    ownerUserId: ADMIN,
    email: 'moved@example.test',
    clientId: 'client',
    refreshToken: 'refresh',
    scopes: [],
  });
  const link = await ctx.store.googleAccounts.linkFolder({
    projectId: 'p',
    accountId: account.id,
    folderId: 'root',
    name: 'Root',
    accessMode: 'read-write',
  });
  await ctx.store.setSessionWorkspaceFile({
    sessionId: 's',
    accountId: account.id,
    folderLinkId: link.id,
    fileId: 'moved',
    name: 'Moved',
    kind: 'docs',
    revisionId: 'r1',
    webViewLink: 'https://docs.google.com/document/d/moved/edit',
  });
  const docs = {
    inspect: vi.fn(),
    read: vi.fn(),
    update: vi.fn().mockResolvedValue({ revisionId: 'r2', result: {} }),
  };
  const tool = createGoogleDocsTool({
    eventStore: ctx.store,
    googleAccessToken: async () => 'token',
    docs,
  });
  let outside = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify({
            id: url.includes('/files/root?') ? 'root' : 'moved',
            name: 'Moved',
            mimeType: 'application/vnd.google-apps.document',
            parents: outside ? [] : ['root'],
          }),
        ),
    ),
  );
  try {
    await expect(
      tool.invoke({
        projectId: 'p',
        sessionId: 's',
        turnId: 't',
        invocationId: 'moved',
        request: {
          action: 'edit',
          revisionId: 'r1',
          requests: [{ insertText: { text: 'x', location: { index: 1 } } }],
        },
      }),
    ).rejects.toThrow('outside');
    expect(docs.update).not.toHaveBeenCalled();
    outside = false;
    await tool.invoke({
      projectId: 'p',
      sessionId: 's',
      turnId: 't',
      invocationId: 'returned',
      request: {
        action: 'edit',
        revisionId: 'r1',
        requests: [{ insertText: { text: 'x', location: { index: 1 } } }],
      },
    });
    expect(docs.update).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("another person's Google Drive account (ADR 0023 §3)", () => {
  it("never mints a token for someone else's account id", async () => {
    const bobs = await ctx.store.googleAccounts.save({
      ownerUserId: BOB,
      email: 'bob-files@example.test',
      clientId: 'client',
      refreshToken: 'bob-refresh',
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const fetch = googleFetch();
    vi.stubGlobal('fetch', fetch);
    const app = await driveApp();
    try {
      const url = `/google-drive/files?accountId=${bobs.id}`;
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(409);
      expect(fetch).not.toHaveBeenCalled();
      const own = await app.inject({ method: 'GET', url, headers: { 'x-test-user': BOB } });
      expect(own.statusCode, own.body).toBe(200);
    } finally {
      await app.close();
      vi.unstubAllGlobals();
      await ctx.store.googleAccounts.remove(bobs.id);
    }
  });

  it("keeps a folder linked with Bob's account out of another person's browsing", async () => {
    const bobs = await ctx.store.googleAccounts.save({
      ownerUserId: BOB,
      email: 'bob-folder@example.test',
      clientId: 'client',
      refreshToken: 'bob-refresh',
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const link = await ctx.store.googleAccounts.linkFolder({
      projectId: 'p',
      accountId: bobs.id,
      folderId: 'bob-root',
      name: 'Bob',
      accessMode: 'read-write',
    });
    const fetch = googleFetch();
    vi.stubGlobal('fetch', fetch);
    const app = await driveApp();
    try {
      // Both the link id and the bare folder id must miss for the administrator.
      for (const folder of [link.id, 'bob-root']) {
        const url = `/projects/p/google-drive/folders/${folder}/files`;
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
      }
      expect(fetch).not.toHaveBeenCalled();
      const own = await app.inject({
        method: 'GET',
        url: `/projects/p/google-drive/folders/${link.id}/files`,
        headers: { 'x-test-user': BOB },
      });
      expect(own.statusCode, own.body).toBe(200);
    } finally {
      await app.close();
      vi.unstubAllGlobals();
      await ctx.store.googleAccounts.unlinkFolder('p', link.id);
      await ctx.store.googleAccounts.remove(bobs.id);
    }
  });

  it("disconnecting one person's account leaves other people's Google choices in place", async () => {
    const scopes = ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic', 'drive'].map(
      (scope) => `https://www.googleapis.com/auth/${scope}`,
    );
    const bobs = await ctx.store.googleAccounts.save({
      ownerUserId: BOB,
      email: 'bob-disconnect@example.test',
      clientId: 'client',
      refreshToken: 'bob-refresh',
      scopes,
    });
    const carols = await ctx.store.googleAccounts.save({
      ownerUserId: CAROL,
      email: 'carol@example.test',
      clientId: 'client',
      refreshToken: 'carol-refresh',
      scopes,
    });
    await ctx.store.googleAccounts.setProjectAccess('p', 'gmail', BOB, bobs.id);
    await ctx.store.googleAccounts.setSessionAccess('s', 'gmail', {
      mode: 'account',
      accountId: bobs.id,
    });
    const app = await driveApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/google-drive/disconnect',
        headers: { 'x-test-user': CAROL },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(await ctx.store.googleAccounts.get(carols.id)).toBeUndefined();
      // The instance-wide legacy cleanup would silently drop Bob's project choice.
      expect((await ctx.store.googleAccounts.projectAccess('p', 'gmail', BOB))?.id).toBe(bobs.id);
      expect(await ctx.store.googleAccounts.sessionAccess('s', 'gmail')).toEqual({
        mode: 'account',
        accountId: bobs.id,
      });
      expect(await ctx.store.googleAccounts.get(bobs.id)).toBeDefined();
    } finally {
      await app.close();
      await ctx.store.googleAccounts.setSessionAccess('s', 'gmail', { mode: 'inherit' });
      await ctx.store.googleAccounts.remove(bobs.id);
    }
  });
  // The administrator's account is mirrored into the instance settings, which
  // the mail, calendar and contacts tools fall back to. Disconnecting it while
  // others keep theirs must end that copy, not leave it serving them.
  it("disconnecting the mirrored account ends the instance copy, others' accounts stay", async () => {
    const scopes = ['gmail.readonly', 'drive'].map(
      (scope) => `https://www.googleapis.com/auth/${scope}`,
    );
    const bobs = await ctx.store.googleAccounts.save({
      ownerUserId: BOB,
      email: 'bob-keeps@example.test',
      clientId: 'client',
      refreshToken: 'bob-keeps-refresh',
      scopes,
    });
    const carols = await ctx.store.googleAccounts.save({
      ownerUserId: CAROL,
      email: 'carol-mirrored@example.test',
      clientId: 'client',
      refreshToken: 'carol-mirrored-refresh',
      scopes,
    });
    await ctx.store.updateVeritySettings({
      googleDriveClientId: 'client',
      googleDriveRefreshToken: 'carol-mirrored-refresh',
      googleDriveAccountEmail: 'carol-mirrored@example.test',
    });
    // The mirror must be in place, or the assertion below proves nothing.
    expect((await ctx.store.getVeritySettings())?.googleDriveRefreshToken).toBe(
      'carol-mirrored-refresh',
    );
    const app = await driveApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/google-drive/disconnect',
        headers: { 'x-test-user': CAROL },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(await ctx.store.googleAccounts.get(carols.id)).toBeUndefined();
      expect((await ctx.store.getVeritySettings())?.googleDriveRefreshToken ?? null).toBeNull();
      expect(await ctx.store.googleAccounts.get(bobs.id)).toBeDefined();
    } finally {
      await app.close();
      await ctx.store.googleAccounts.remove(bobs.id);
    }
  });
});
