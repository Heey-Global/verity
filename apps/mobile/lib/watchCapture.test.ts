import type { AssistantConversation, InboxItem, VerityClient } from '@verity/mobile';

import { getAuthToken, isBiometricUnlockEnabled } from './authToken';
import { getVerityBaseUrl } from './client';
import { getServerProfile } from './serverProfile';

import {
  performWatchInboxAction,
  createWatchInboxDrainer,
  createWatchInboxSync,
  showWatchSettings,
  watchLink,
  watchScopeAllowed,
  watchInbox,
  watchSnapshot,
  WATCH_INBOX_LIMIT,
  type WatchCapture,
} from './watchCapture';

jest.mock('./tasksStore', () => ({ taskAccountScope: jest.fn(() => 'account-1') }));
jest.mock('./client', () => ({
  getVerityBaseUrl: jest.fn(() => null),
  subscribeVerityBaseUrl: jest.fn(() => () => undefined),
}));
jest.mock('./authToken', () => ({
  getAuthToken: jest.fn(() => null),
  isBiometricUnlockEnabled: jest.fn(async () => false),
  subscribeAuthToken: jest.fn(() => () => undefined),
  subscribeBiometricUnlock: jest.fn(() => () => undefined),
}));
jest.mock('./serverProfile', () => ({ getServerProfile: jest.fn(() => null) }));
jest.mock('./verityConversation', () => ({
  answerVerity: jest.fn(),
  sendToVerity: jest.fn(),
  subscribeVerity: jest.fn(() => () => undefined),
}));

const capture = (id: string): WatchCapture => ({
  id,
  text: `note ${id}`,
  createdAt: '2026-10-08T10:00:00Z',
  durationMs: 1200,
});

function inbox(initial: WatchCapture[]) {
  const entries = [...initial];
  return {
    entries,
    pending: jest.fn(async () => [...entries]),
    acknowledge: jest.fn(async (id: string) => {
      entries.splice(
        entries.findIndex((entry) => entry.id === id),
        1,
      );
    }),
  };
}

describe('watch inbox drain', () => {
  it('saves each capture before releasing it from the inbox', async () => {
    const box = inbox([capture('a'), capture('b')]);
    const order: string[] = [];
    const save = jest.fn(async (c: WatchCapture) => void order.push(`save ${c.id}`));
    box.acknowledge.mockImplementation(async (id: string) => {
      order.push(`ack ${id}`);
      box.entries.splice(
        box.entries.findIndex((entry) => entry.id === id),
        1,
      );
    });
    await createWatchInboxDrainer(box, save)();
    expect(order).toEqual(['save a', 'ack a', 'save b', 'ack b']);
    expect(box.entries).toHaveLength(0);
  });

  // The silent failure: acknowledging a capture the outbox never stored deletes
  // the only copy of the recording on the iPhone.
  it('keeps a capture in the inbox when saving fails', async () => {
    const box = inbox([capture('a')]);
    const save = jest.fn(async () => {
      throw new Error('Sign in to talk to Verity.');
    });
    await expect(createWatchInboxDrainer(box, save)()).rejects.toThrow('Sign in');
    expect(box.acknowledge).not.toHaveBeenCalled();
    expect(box.entries).toHaveLength(1);
  });

  it('saves later captures when an earlier one keeps failing', async () => {
    const box = inbox([capture('a'), capture('b')]);
    const save = jest.fn(async (c: WatchCapture) => {
      if (c.id === 'a') throw new Error('rejected');
    });
    await expect(createWatchInboxDrainer(box, save)()).rejects.toThrow('rejected');
    expect(box.entries.map((entry) => entry.id)).toEqual(['a']);
  });

  it('runs another pass for a capture that lands mid-drain', async () => {
    const box = inbox([capture('a')]);
    let drain: () => Promise<void> = async () => undefined;
    const save = jest.fn(async (c: WatchCapture) => {
      if (c.id === 'a') {
        box.entries.push(capture('b'));
        void drain();
      }
    });
    drain = createWatchInboxDrainer(box, save);
    await drain();
    expect(save.mock.calls.map(([c]) => c.id)).toEqual(['a', 'b']);
    expect(box.entries).toHaveLength(0);
  });
});

describe('watch account', () => {
  it('hands words only to the account they were said in', () => {
    expect(watchScopeAllowed('account-1', 'account-1')).toBe(true);
    expect(watchScopeAllowed('account-1', 'account-2')).toBe(false);
    expect(watchScopeAllowed('account-1', null)).toBe(false);
    // An interrupted recording has no account: it goes to the one signed in.
    expect(watchScopeAllowed(undefined, 'account-2')).toBe(true);
  });
});

describe('watch snapshot', () => {
  const conversation: AssistantConversation = {
    availability: 'ready',
    sessionId: 'assistant',
    revision: 9,
    state: 'needs_you',
    items: [
      { kind: 'message', id: 'm-1', at: 1, text: 'Set up Hansen' },
      { kind: 'reply', id: 'r-2', at: 2, text: 'Which client?' },
      { kind: 'task', id: 't-3', at: 3, title: 'x', projectId: 'p', state: 'saved' },
    ],
    question: {
      id: 'q-4',
      question: 'Which client?',
      options: [{ label: 'Hansen', recommended: true }, { label: 'Müller' }],
      multiSelect: false,
    },
    approvals: [{ id: 'perm-1', tool: 'verity_gmail' }],
  };

  it('keeps what the wrist needs: state, latest reply, question and approvals', () => {
    expect(watchSnapshot(conversation, 'ready', 'account-1')).toEqual({
      availability: 'ready',
      state: 'needs_you',
      revision: 9,
      approvals: 1,
      scope: 'account-1',
      reply: 'Which client?',
      replyId: 'r-2',
      replyMessageId: 'm-1',
      question: {
        id: 'q-4',
        text: 'Which client?',
        options: ['Hansen', 'Müller'],
        multiSelect: false,
      },
    });
  });

  it('does not associate an earlier reply with a newer unanswered message', () => {
    const snapshot = watchSnapshot(
      {
        ...conversation,
        items: [
          ...conversation.items,
          { kind: 'message', id: 'm-10', at: 10, text: 'Another question' },
        ],
      },
      'ready',
      'account-1',
    );
    expect(snapshot).toMatchObject({ replyId: 'r-2', replyMessageId: 'm-1' });
    expect(watchSnapshot({ ...conversation, items: [] }, 'ready', 'account-1')).not.toHaveProperty(
      'replyId',
    );
  });

  it('tells the watch when Verity is not this account’s, and nothing when signed out', () => {
    expect(watchSnapshot(null, 'denied', 'account-1')).toMatchObject({ availability: 'denied' });
    expect(watchSnapshot(conversation, 'ready', null)).toBeNull();
  });
});

describe('watch link', () => {
  const direct = { url: 'https://verity.example', transport: 'direct', tlsPin: 'sha256-pin' };
  beforeEach(() => {
    jest.mocked(getVerityBaseUrl).mockReturnValue('https://verity.example');
    jest.mocked(getAuthToken).mockReturnValue('token');
    jest.mocked(isBiometricUnlockEnabled).mockResolvedValue(false);
    jest.mocked(getServerProfile).mockReturnValue({ endpoints: [direct] } as never);
  });

  it('hands native code the pinned direct connection of the signed-in account', async () => {
    expect(await watchLink()).toEqual({
      baseUrl: 'https://verity.example',
      token: 'token',
      tlsPin: 'sha256-pin',
      scope: 'account-1',
    });
  });

  it('keeps a sign-in behind Face ID, and every connection but a pinned direct one, in the app', async () => {
    jest.mocked(isBiometricUnlockEnabled).mockResolvedValue(true);
    expect(await watchLink()).toBeNull();
    jest.mocked(isBiometricUnlockEnabled).mockResolvedValue(false);
    jest
      .mocked(getServerProfile)
      .mockReturnValue({ endpoints: [{ ...direct, transport: 'uplink' }] } as never);
    expect(await watchLink()).toBeNull();
    jest.mocked(getServerProfile).mockReturnValue({ endpoints: [direct] } as never);
    jest.mocked(getAuthToken).mockReturnValue(null);
    expect(await watchLink()).toBeNull();
  });
});

describe('watch settings visibility', () => {
  it('hides the section without a paired watch, unless captures are still waiting', () => {
    expect(showWatchSettings(null)).toBe(false);
    expect(showWatchSettings({ supported: false })).toBe(false);
    expect(showWatchSettings({ supported: true, activated: true, paired: false, waiting: 0 })).toBe(
      false,
    );
    expect(showWatchSettings({ supported: true, activated: true, paired: true })).toBe(true);
    expect(showWatchSettings({ supported: true, activated: true, paired: false, waiting: 2 })).toBe(
      true,
    );
  });
});

const item = (index: number, extra: Partial<InboxItem> = {}): InboxItem => ({
  key: `item-${String(index)}`,
  kind: 'question',
  tag: 'Question',
  tone: 'action',
  title: `Which environment ${String(index)}?`,
  context: 'Website',
  actions: [{ kind: 'answer', label: 'Staging', answer: 'Staging', sessionId: 's' }],
  at: 0,
  ...extra,
});

describe('watch "Needs you" list', () => {
  it('sends Home’s items in Home’s order, cut to what the wrist lists', () => {
    const items = Array.from({ length: WATCH_INBOX_LIMIT + 3 }, (_, index) => item(index));
    items[0] = item(0, { message: 'x'.repeat(1000) });
    const payload = watchInbox(items, 'account-1', 1234);
    expect(payload?.scope).toBe('account-1');
    expect(payload?.at).toBe(1234);
    // The wrist lists twelve but counts them all, as Home does.
    expect(payload?.total).toBe(WATCH_INBOX_LIMIT + 3);
    expect(payload?.items.map((entry) => entry.key)).toEqual(
      items.slice(0, WATCH_INBOX_LIMIT).map((entry) => entry.key),
    );
    expect(payload?.items[0]).toMatchObject({
      tag: 'Question',
      tone: 'action',
      context: 'Website',
    });
    expect(payload?.items[0]?.message).toHaveLength(400);
    // A property list has no undefined: an item without a message carries no key.
    expect(payload?.items[1]).not.toHaveProperty('message');
  });

  it('only sends supported current Home action routes to the Watch', () => {
    const payload = watchInbox(
      [
        item(0, {
          actions: [
            { kind: 'resume', label: 'Resume', sessionId: 'session-1' },
            { kind: 'merge', label: 'Merge', sessionId: 'session-2', number: 42 },
            { kind: 'open_session', label: 'Open', sessionId: 'session-3' },
          ],
        }),
      ],
      'account-1',
      1234,
    );
    expect(payload?.items[0]?.actions).toEqual([
      { kind: 'resume', label: 'Resume', sessionId: 'session-1' },
      { kind: 'merge', label: 'Merge', sessionId: 'session-2', number: 42 },
    ]);
    expect(watchInbox([item(0)], 'account-1', 1234)?.items[0]?.actions).toEqual([]);
  });

  it('sends nothing for a signed-out iPhone, so the watch clears its list', () => {
    expect(watchInbox([item(0)], null, 1)).toBeNull();
  });

  it('sends a changed list at once and an unchanged one only to refresh its time', () => {
    const send = jest.fn(async () => undefined);
    const sync = createWatchInboxSync(send);
    sync([item(0)], 'account-1', 0);
    sync([item(0)], 'account-1', 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    sync([item(0), item(1)], 'account-1', 61_000);
    expect(send).toHaveBeenCalledTimes(2);
    // Without a resend the watch would call a correct list outdated.
    sync([item(0), item(1)], 'account-1', 61_000 + 5 * 60_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ at: 61_000 + 5 * 60_000 }));
  });

  it('tries a list again on the next change after a failed send', async () => {
    const send = jest
      .fn<Promise<void>, [unknown]>()
      .mockRejectedValueOnce(new Error('not activated'))
      .mockResolvedValue(undefined);
    const sync = createWatchInboxSync(send);
    sync([item(0)], 'account-1', 0);
    await Promise.resolve();
    await Promise.resolve();
    // Kept as sent, the list would wait out the refresh interval on the iPhone.
    sync([item(0)], 'account-1', 1_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends the same list again after a sign-out cleared it', () => {
    const send = jest.fn(async () => undefined);
    const sync = createWatchInboxSync(send);
    sync([item(0)], 'account-1', 0);
    sync([], null, 1_000);
    expect(send).toHaveBeenLastCalledWith(null);
    // Signing back in shows the same items; skipping them left the watch empty.
    sync([item(0)], 'account-1', 2_000);
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe('immediate Watch Home actions', () => {
  const request = {
    id: 'reply-1',
    scope: 'account-1',
    key: 'crashed:s:4',
    expiresAt: 100,
    action: { kind: 'resume' as const, sessionId: 's' },
  };
  const client = (session: Record<string, unknown> = { status: 'crashed' }) => ({
    getSession: jest.fn(async () => session),
    sendTurn: jest.fn(async () => ({})),
    mergePullRequest: jest.fn(async () => ({})),
  });
  it('resumes through the existing performer with the stable reply id', async () => {
    const api = client();
    expect(
      await performWatchInboxAction(
        request,
        api as unknown as VerityClient,
        () => 'account-1',
        () => 1,
      ),
    ).toEqual({ status: 'done' });
    expect(api.sendTurn).toHaveBeenCalledWith('s', {
      prompt: 'Continue where you stopped.',
      clientReplyId: 'reply-1',
    });
  });
  it('rejects another account or an expired request before any API call', async () => {
    const api = client();
    expect(
      (
        await performWatchInboxAction(
          request,
          api as unknown as VerityClient,
          () => 'account-2',
          () => 1,
        )
      ).status,
    ).toBe('error');
    expect(
      (
        await performWatchInboxAction(
          request,
          api as unknown as VerityClient,
          () => 'account-1',
          () => 101,
        )
      ).status,
    ).toBe('error');
    expect(api.getSession).not.toHaveBeenCalled();
  });
  it('rejects an account switch while checking session state', async () => {
    const api = client();
    const scope = jest.fn().mockReturnValueOnce('account-1').mockReturnValue('account-2');
    expect(
      (await performWatchInboxAction(request, api as unknown as VerityClient, scope, () => 1))
        .status,
    ).toBe('error');
    expect(api.sendTurn).not.toHaveBeenCalled();
  });
  it('rejects a resumed session that crashed again after the item was shown', async () => {
    const api = client({ status: 'crashed', eventCount: 5 });
    const result = await performWatchInboxAction(
      request,
      api as unknown as VerityClient,
      () => 'account-1',
      () => 1,
    );
    expect(result.status).toBe('error');
    expect(api.sendTurn).not.toHaveBeenCalled();
  });
  it('does not resume an already running session', async () => {
    const api = client({ status: 'running' });
    expect(
      (
        await performWatchInboxAction(
          request,
          api as unknown as VerityClient,
          () => 'account-1',
          () => 1,
        )
      ).status,
    ).toBe('error');
    expect(api.sendTurn).not.toHaveBeenCalled();
  });
  it('merges only a freshly eligible matching PR', async () => {
    const api = client({ pullRequest: { number: 42, phase: 'open', mergeable: true } });
    const merge = {
      ...request,
      key: 'merge:s:42:',
      action: { kind: 'merge' as const, sessionId: 's', number: 42 },
    };
    expect(
      await performWatchInboxAction(
        merge,
        api as unknown as VerityClient,
        () => 'account-1',
        () => 1,
      ),
    ).toEqual({ status: 'done' });
    expect(api.mergePullRequest).toHaveBeenCalledWith('s', 42);
    api.getSession.mockResolvedValue({
      pullRequest: { number: 43, phase: 'open', mergeable: true },
    });
    expect(
      (
        await performWatchInboxAction(
          merge,
          api as unknown as VerityClient,
          () => 'account-1',
          () => 1,
        )
      ).status,
    ).toBe('error');
    api.getSession.mockResolvedValue({
      pullRequest: { number: 42, phase: 'open', mergeable: true, headSha: 'new-head' },
    });
    expect(
      (
        await performWatchInboxAction(
          merge,
          api as unknown as VerityClient,
          () => 'account-1',
          () => 1,
        )
      ).status,
    ).toBe('error');
    expect(api.mergePullRequest).toHaveBeenCalledTimes(1);
  });
  it('reports errors rather than claiming success after a network failure', async () => {
    const api = client();
    api.sendTurn.mockRejectedValue(new Error('offline'));
    expect(
      (
        await performWatchInboxAction(
          request,
          api as unknown as VerityClient,
          () => 'account-1',
          () => 1,
        )
      ).status,
    ).toBe('error');
  });
});
