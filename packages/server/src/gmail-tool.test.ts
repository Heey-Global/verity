import { describe, expect, it, vi } from 'vitest';

import {
  createGmailTool,
  gmailHasStandingAuthorization,
  type GmailToolStore,
} from './gmail-tool.js';

function setup(overrides: Partial<GmailToolStore> = {}) {
  const completeGoogleWorkspaceInvocation = vi.fn().mockResolvedValue(undefined);
  const claimGoogleWorkspaceInvocation = vi.fn().mockResolvedValue({ status: 'claimed' });
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
    claimGoogleWorkspaceInvocation,
    completeGoogleWorkspaceInvocation,
    ...overrides,
  };
  const gmail = {
    downloadAttachment: vi.fn().mockResolvedValue({ encoding: 'base64', content: 'AP8=' }),
    search: vi.fn().mockResolvedValue({ messages: [] }),
    readThread: vi.fn().mockResolvedValue({ id: 't1', messages: [] }),
    createDraft: vi.fn().mockResolvedValue({ id: 'd1' }),
    listSenders: vi
      .fn()
      .mockResolvedValue([{ sendAsEmail: 'me@example.test', isPrimary: true, isDefault: true }]),
    prepareReplyDraft: vi.fn().mockResolvedValue({
      from: 'me@example.test',
      to: ['a@example.test'],
      subject: 'Re: Hello',
      body: 'Reply',
      threadId: 't1',
    }),
    prepareDraftSend: vi.fn().mockResolvedValue({
      draftId: 'd1',
      messageId: 'm1',
      to: ['a@example.test'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      body: 'Body',
      externalUrls: [],
    }),
    sendDraft: vi.fn().mockResolvedValue({ messageId: 'sent' }),
    readSignature: vi.fn().mockResolvedValue({
      text: 'Best regards\nJane',
      html: '<div>Best regards<br>Jane</div>',
      externalUrls: [],
    }),
  };
  return {
    eventStore,
    claimGoogleWorkspaceInvocation,
    completeGoogleWorkspaceInvocation,
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
  it('requires a per-call approval only for sending', () => {
    expect(gmailHasStandingAuthorization({ action: 'search', query: 'is:unread' })).toBe(true);
    expect(gmailHasStandingAuthorization({ action: 'create_draft' })).toBe(true);
    expect(gmailHasStandingAuthorization({ action: 'prepare_draft_send' })).toBe(true);
    expect(gmailHasStandingAuthorization({ action: 'send_draft' })).toBe(false);
  });

  it('downloads attachments only with session access and unchanged credentials', async () => {
    const request = { action: 'download_attachment', messageId: 'm1', partId: '1' };
    const { tool, gmail, claimGoogleWorkspaceInvocation } = setup();
    expect(gmailHasStandingAuthorization(request)).toBe(true);
    await expect(tool.invoke(input(request))).resolves.toMatchObject({ content: 'AP8=' });
    expect(gmail.downloadAttachment).toHaveBeenCalledWith('token', 'm1', '1');
    expect(claimGoogleWorkspaceInvocation).not.toHaveBeenCalled();
    const denied = setup({ getSessionGmailConnection: vi.fn().mockResolvedValue(undefined) });
    await expect(denied.tool.invoke(input(request))).rejects.toThrow('Gmail is not enabled');
    expect(denied.gmail.downloadAttachment).not.toHaveBeenCalled();
    const changed = setup({
      getSessionGmailConnection: vi
        .fn()
        .mockResolvedValueOnce({ accountEmail: 'me@example.test' })
        .mockResolvedValue(undefined),
    });
    await expect(changed.tool.invoke(input(request))).rejects.toThrow('Gmail is not enabled');
    expect(changed.gmail.downloadAttachment).not.toHaveBeenCalled();
  });

  it('rejects an unknown send action', async () => {
    const { tool, gmail } = setup();
    await expect(
      tool.invoke(input({ action: 'send', to: ['a@example.test'], body: 'Body' })),
    ).rejects.toThrow('Unsupported Gmail action');
    expect(gmail.createDraft).not.toHaveBeenCalled();
  });

  it('sends an approved draft snapshot through the idempotent mutation path', async () => {
    const { tool, gmail, completeGoogleWorkspaceInvocation } = setup();
    const snapshot = {
      draftId: 'd1',
      messageId: 'm1',
      to: ['a@example.test'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      body: 'Body',
      externalUrls: [],
    };
    await expect(tool.invoke(input({ action: 'send_draft', ...snapshot }))).resolves.toEqual({
      messageId: 'sent',
    });
    expect(gmail.sendDraft).toHaveBeenCalledWith('token', {
      action: 'send_draft',
      ...snapshot,
    });
    expect(completeGoogleWorkspaceInvocation).toHaveBeenCalledWith('inv1', {
      messageId: 'sent',
    });
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

  it('appends the connected Gmail signature to new and reply drafts', async () => {
    const { tool, gmail } = setup();
    await tool.invoke(
      input({ action: 'create_draft', to: ['a@example.test'], subject: 'Hello', body: 'Body' }),
    );
    expect(gmail.createDraft).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({
        body: 'Body\n\nBest regards\nJane',
        htmlBody: expect.stringContaining('<div>Best regards<br />Jane</div>'),
      }),
    );

    const second = setup();
    await second.tool.invoke(
      input({ action: 'create_reply_draft', threadId: 't1', body: 'Reply' }),
    );
    expect(second.gmail.createDraft).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({
        body: 'Reply\n\nBest regards\nJane',
        htmlBody: expect.stringContaining('<div>Best regards<br />Jane</div>'),
      }),
    );
  });
});

describe('Gmail sender selection in the session tool', () => {
  it('exposes senders without creating a draft', async () => {
    const { tool, gmail } = setup();
    await expect(tool.invoke(input({ action: 'list_senders' }))).resolves.toEqual(
      await gmail.listSenders(),
    );
    expect(gmail.createDraft).not.toHaveBeenCalled();
  });

  it.each(['create_draft', 'create_reply_draft'])(
    'uses the selected identity signature for %s',
    async (action) => {
      const { tool, gmail } = setup();
      gmail.listSenders.mockResolvedValue([
        { sendAsEmail: 'me@example.test', isPrimary: true, isDefault: false },
        { sendAsEmail: 'support@example.test', isPrimary: false, isDefault: true },
      ]);
      gmail.prepareReplyDraft.mockResolvedValue({
        from: 'support@example.test',
        to: ['a@example.test'],
        subject: 'Re: Hello',
        body: 'Reply',
        threadId: 't1',
      });
      await tool.invoke(
        input({
          action,
          from: action === 'create_draft' ? 'support@example.test' : undefined,
          to: ['a@example.test'],
          subject: 'Hello',
          threadId: 't1',
          body: 'Reply',
        }),
      );
      expect(gmail.readSignature).toHaveBeenCalledWith('token', 'support@example.test');
      expect(gmail.createDraft).toHaveBeenCalledWith(
        'token',
        expect.objectContaining({
          from: 'support@example.test',
          body: 'Reply\n\nBest regards\nJane',
        }),
      );
    },
  );

  it('rejects an unknown sender before claiming a mutation', async () => {
    const { tool, gmail, claimGoogleWorkspaceInvocation } = setup();
    await expect(
      tool.invoke(
        input({
          action: 'create_draft',
          from: 'other@example.test',
          to: ['a@example.test'],
          subject: 'Hello',
          body: 'Body',
        }),
      ),
    ).rejects.toThrow('verified');
    expect(gmail.createDraft).not.toHaveBeenCalled();
    expect(claimGoogleWorkspaceInvocation).not.toHaveBeenCalled();
  });
});
