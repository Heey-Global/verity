import { describe, expect, it, vi } from 'vitest';

import { createGmailTool, type GmailToolStore } from './gmail-tool.js';

function setup(overrides: Partial<GmailToolStore> = {}) {
  const eventStore: GmailToolStore = {
    getSession: vi.fn().mockResolvedValue({ projectId: 'p1' }),
    getSessionGmailConnection: vi
      .fn()
      .mockResolvedValue({ accountEmail: 'me@example.test', enabledAt: new Date() }),
    getVeritySettings: vi.fn().mockResolvedValue({
      gmailAuthorized: true,
      googleDriveRefreshToken: 'refresh',
      googleDriveAccountEmail: 'me@example.test',
    }),
    claimGoogleWorkspaceInvocation: vi.fn().mockResolvedValue({ status: 'claimed' }),
    completeGoogleWorkspaceInvocation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const gmail = {
    search: vi.fn().mockResolvedValue({ messages: [] }),
    readThread: vi.fn().mockResolvedValue({ id: 't1', messages: [] }),
    createDraft: vi.fn().mockResolvedValue({ id: 'd1' }),
    createReplyDraft: vi.fn().mockResolvedValue({ id: 'd2' }),
  };
  return {
    eventStore,
    gmail,
    tool: createGmailTool({ eventStore, gmail, googleAccessToken: async () => 'token' }),
  };
}

const input = (request: unknown) => ({
  projectId: 'p1',
  sessionId: 's1',
  turnId: 'turn1',
  invocationId: 'inv1',
  request,
});

describe('Gmail session tool', () => {
  it('has no send action', async () => {
    const { tool, gmail } = setup();
    await expect(
      tool.invoke(input({ action: 'send', to: ['a@example.test'], body: 'Body' })),
    ).rejects.toThrow('Unsupported Gmail action');
    expect(gmail.createDraft).not.toHaveBeenCalled();
  });

  it('refuses a session without its own Gmail access row', async () => {
    const { tool } = setup({ getSessionGmailConnection: vi.fn().mockResolvedValue(undefined) });
    await expect(tool.invoke(input({ action: 'search', query: 'is:unread' }))).rejects.toThrow(
      'Gmail is not enabled for the calling session',
    );
  });

  it('refuses a grant that belongs to a previously connected account', async () => {
    const { tool } = setup({
      getSessionGmailConnection: vi
        .fn()
        .mockResolvedValue({ accountEmail: 'old@example.test', enabledAt: new Date() }),
    });
    await expect(tool.invoke(input({ action: 'search', query: 'is:unread' }))).rejects.toThrow(
      'Gmail is not enabled for the calling session',
    );
  });

  it('aborts when the connected account changes while acquiring an access token', async () => {
    const getSessionGmailConnection = vi
      .fn()
      .mockResolvedValueOnce({ accountEmail: 'old@example.test', enabledAt: new Date() })
      .mockResolvedValueOnce({ accountEmail: 'new@example.test', enabledAt: new Date() });
    const getVeritySettings = vi
      .fn()
      .mockResolvedValueOnce({
        gmailAuthorized: true,
        googleDriveRefreshToken: 'old-refresh',
        googleDriveAccountEmail: 'old@example.test',
      })
      .mockResolvedValueOnce({
        gmailAuthorized: true,
        googleDriveRefreshToken: 'new-refresh',
        googleDriveAccountEmail: 'new@example.test',
      });
    const { eventStore, gmail } = setup({ getSessionGmailConnection, getVeritySettings });
    const tool = createGmailTool({
      eventStore,
      gmail,
      googleAccessToken: async () => 'old-account-token',
    });

    await expect(tool.invoke(input({ action: 'search', query: 'is:unread' }))).rejects.toThrow(
      'The connected Gmail account changed during this operation',
    );
    expect(gmail.search).not.toHaveBeenCalled();
  });

  it('rechecks session access immediately before creating a draft', async () => {
    const getSessionGmailConnection = vi
      .fn()
      .mockResolvedValueOnce({ accountEmail: 'me@example.test', enabledAt: new Date() })
      .mockResolvedValueOnce(undefined);
    const { tool, gmail } = setup({ getSessionGmailConnection });
    await expect(
      tool.invoke(
        input({ action: 'create_draft', to: ['a@example.test'], subject: 'Hello', body: 'Body' }),
      ),
    ).rejects.toThrow('Gmail is not enabled for the calling session');
    expect(gmail.createDraft).not.toHaveBeenCalled();
  });

  it('returns a completed draft invocation without creating it twice', async () => {
    const { tool, gmail } = setup({
      claimGoogleWorkspaceInvocation: vi
        .fn()
        .mockResolvedValue({ status: 'completed', result: { id: 'existing' } }),
    });
    await expect(
      tool.invoke(
        input({ action: 'create_draft', to: ['a@example.test'], subject: 'Hello', body: 'Body' }),
      ),
    ).resolves.toEqual({ id: 'existing' });
    expect(gmail.createDraft).not.toHaveBeenCalled();
  });
});
