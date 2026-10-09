import { createTestDb, type TestDb } from '@verity/store/testing';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createGmailTool } from './gmail-tool.js';
let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'local',
    repo: 'repo',
    containerName: 'test',
    state: 'active',
  });
  await ctx.store.createSession({
    sessionId: 's1',
    projectId: 'p1',
    worktree: '/wt',
    model: 'default',
  });
  await ctx.store.updateVeritySettings({
    gmailAuthorized: true,
    googleDriveRefreshToken: 'refresh',
    googleDriveAccountEmail: 'me@example.test',
  });
});
afterAll(async () => {
  await ctx.close();
});
const input = {
  projectId: 'p1',
  sessionId: 's1',
  turnId: 't1',
  invocationId: 'i1',
  request: { action: 'send_draft', draftId: 'd1' },
};
function setup(beforeSend: () => Promise<void>) {
  const sendDraft = vi.fn().mockResolvedValue({ messageId: 'sent' });
  const tool = createGmailTool({
    eventStore: {
      getSession: ctx.store.getSession.bind(ctx.store),
      getSessionGmailConnection: ctx.store.getSessionGmailConnection.bind(ctx.store),
      getVeritySettings: ctx.store.getVeritySettings.bind(ctx.store),
      claimGoogleWorkspaceInvocation: async () => {
        await beforeSend();
        return { status: 'claimed' };
      },
      completeGoogleWorkspaceInvocation: vi.fn().mockResolvedValue(undefined),
    },
    gmail: {
      search: vi.fn(),
      readThread: vi.fn(),
      createDraft: vi.fn(),
      createReplyDraft: vi.fn(),
      prepareDraftSend: vi.fn(),
      readSignature: vi.fn(),
      sendDraft,
    },
    googleAccessToken: async () => 'token',
  });
  return { tool, sendDraft };
}
it('accepts an explicit project grant without a legacy session grant', async () => {
  await ctx.store.enableProjectGoogleConnection('p1', 'gmail', 'me@example.test');
  const { tool, sendDraft } = setup(async () => {});
  await expect(tool.invoke(input)).resolves.toEqual({ messageId: 'sent' });
  expect(sendDraft).toHaveBeenCalled();
});
it('blocks an approved action if project access is revoked before execution', async () => {
  await ctx.store.enableProjectGoogleConnection('p1', 'gmail', 'me@example.test');
  const { tool, sendDraft } = setup(() => ctx.store.disableProjectGoogleConnection('p1', 'gmail'));
  await expect(tool.invoke(input)).rejects.toThrow('not enabled');
  expect(sendDraft).not.toHaveBeenCalled();
});
it('blocks an approved action if the connected account changes before execution', async () => {
  await ctx.store.enableProjectGoogleConnection('p1', 'gmail', 'me@example.test');
  const { tool, sendDraft } = setup(async () => {
    await ctx.store.updateVeritySettings({ googleDriveAccountEmail: 'other@example.test' });
  });
  await expect(tool.invoke(input)).rejects.toThrow('not enabled');
  expect(sendDraft).not.toHaveBeenCalled();
});
