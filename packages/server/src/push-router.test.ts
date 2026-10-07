import type { LiveAlert } from '@verity/events';
import type { DevicePushTokenRecord } from '@verity/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPushRouter,
  type PushPresence,
  type PushRouterStore,
  type SessionNotification,
} from './push-router.js';
import type { PushSendResult, PushSender } from './push-sender.js';

const SENT: PushSendResult = {
  targets: 1,
  ticketsAccepted: 1,
  ticketErrors: 0,
  receiptsQueued: 1,
  pruned: 0,
  transportErrors: 0,
};

type Token = DevicePushTokenRecord & { userId: string };

function token(authTokenId: string, userId: string): Token {
  return {
    authTokenId,
    userId,
    expoToken: `ExpoPushToken[${authTokenId}]`,
    platform: 'ios',
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Alice owns a phone and a tablet; Bob a phone. */
const TOKENS = [
  token('alice-phone', 'alice'),
  token('alice-tablet', 'alice'),
  token('bob-phone', 'bob'),
];

function fakeStore(overrides: Partial<PushRouterStore> = {}): PushRouterStore {
  return {
    getSession: async () => ({ projectId: 'p1' }),
    listProjectUserIds: async () => ['alice', 'bob'],
    listActiveAdministratorIds: async () => ['alice'],
    listDevicePushTokensForUsers: async (userIds) =>
      TOKENS.filter((entry) => userIds.includes(entry.userId)),
    ...overrides,
  };
}

/** Presence as the live hub reports it: per user, the session they view and
 * the devices in the foreground. */
function fakePresence(state: {
  viewing?: Record<string, string[]>;
  foreground?: Record<string, string[]>;
}): Omit<PushPresence, 'deliverAlert'> & {
  deliverAlert: ReturnType<typeof vi.fn<PushPresence['deliverAlert']>>;
} {
  return {
    isViewing: (userId, sessionId) => state.viewing?.[userId]?.includes(sessionId) ?? false,
    foregroundDevices: (userId) => new Set(state.foreground?.[userId] ?? []),
    deliverAlert: vi.fn<PushPresence['deliverAlert']>(
      (userId) => new Set(state.foreground?.[userId] ?? []),
    ),
  };
}

function fakeSender(): Pick<PushSender, 'send'> & {
  send: ReturnType<typeof vi.fn<PushSender['send']>>;
} {
  return { send: vi.fn<PushSender['send']>().mockResolvedValue(SENT) };
}

const ALERT: LiveAlert = {
  sessionId: 's1',
  kind: 'permission',
  categoryId: 'PERMISSION_PROMPT',
  toolUseId: 'p1',
  title: 'Permission needed',
  body: 'A session requests permission to continue.',
};

function permission(overrides: Partial<SessionNotification> = {}): SessionNotification {
  return {
    key: 'permission:s1:p1',
    sessionId: 's1',
    initiatorUserId: 'alice',
    notification: {
      title: ALERT.title,
      body: ALERT.body,
      categoryId: 'PERMISSION_PROMPT',
      data: { sessionId: 's1', kind: 'permission', toolUseId: 'p1' },
    },
    alert: ALERT,
    ...overrides,
  };
}

/** The devices a send call targeted. */
function targets(sender: ReturnType<typeof fakeSender>, call = 0): string[] {
  return (sender.send.mock.calls[call]?.[1] ?? []).map((entry) => entry.authTokenId);
}

function senderOf(sender: ReturnType<typeof fakeSender>): PushSender {
  return {
    ...sender,
    processDueReceipts: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
  };
}

describe('push router', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pushes to every device of the initiator, and to nobody else', async () => {
    const sender = fakeSender();
    const router = createPushRouter({
      sender: senderOf(sender),
      presence: fakePresence({}),
      store: fakeStore(),
    });

    await expect(router.notify(permission())).resolves.toBe('delivered');
    expect(targets(sender)).toEqual(['alice-phone', 'alice-tablet']);
    router.close();
  });

  it('sends nothing to a user who is looking at the session', async () => {
    const sender = fakeSender();
    const presence = fakePresence({
      viewing: { alice: ['s1'] },
      foreground: { alice: ['alice-phone'] },
    });
    const router = createPushRouter({ sender: senderOf(sender), presence, store: fakeStore() });

    await expect(router.notify(permission())).resolves.toBe('suppressed');
    expect(sender.send).not.toHaveBeenCalled();
    expect(presence.deliverAlert).not.toHaveBeenCalled();
    router.close();
  });

  it("is not silenced by another user's activity", async () => {
    const sender = fakeSender();
    // Bob watches the session; the turn is Alice's.
    const presence = fakePresence({ viewing: { bob: ['s1'] }, foreground: { bob: ['bob-phone'] } });
    const router = createPushRouter({ sender: senderOf(sender), presence, store: fakeStore() });

    await router.notify(permission());
    expect(targets(sender)).toEqual(['alice-phone', 'alice-tablet']);
    router.close();
  });

  it('alerts the foreground device in-app and escalates to the others when unanswered', async () => {
    const sender = fakeSender();
    const presence = fakePresence({ foreground: { alice: ['alice-phone'] } });
    const router = createPushRouter({
      sender: senderOf(sender),
      presence,
      store: fakeStore(),
      escalationMs: 60_000,
    });

    await expect(router.notify(permission())).resolves.toBe('delivered');
    expect(presence.deliverAlert).toHaveBeenCalledWith('alice', ALERT);
    expect(sender.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(sender.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // The tablet learns of it now; the phone already shows it.
    expect(targets(sender)).toEqual(['alice-tablet']);
    router.close();
  });

  it('withdraws the escalation once the request is answered', async () => {
    const sender = fakeSender();
    const router = createPushRouter({
      sender: senderOf(sender),
      presence: fakePresence({ foreground: { alice: ['alice-phone'] } }),
      store: fakeStore(),
      escalationMs: 60_000,
    });

    await router.notify(permission());
    router.cancel('permission:s1:p1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sender.send).not.toHaveBeenCalled();
    router.close();
  });

  it('does not escalate once the user opened the session', async () => {
    const sender = fakeSender();
    const state = {
      foreground: { alice: ['alice-phone'] },
      viewing: {} as Record<string, string[]>,
    };
    const router = createPushRouter({
      sender: senderOf(sender),
      presence: fakePresence(state),
      store: fakeStore(),
      escalationMs: 60_000,
    });

    await router.notify(permission());
    state.viewing.alice = ['s1'];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sender.send).not.toHaveBeenCalled();
    router.close();
  });

  it('keeps an informational notification off a user who is in the app', async () => {
    const sender = fakeSender();
    const presence = fakePresence({ foreground: { alice: ['alice-phone'] } });
    const router = createPushRouter({ sender: senderOf(sender), presence, store: fakeStore() });

    await expect(
      router.notify(
        permission({
          key: 'terminal:s1',
          notification: {
            title: 'Turn complete',
            body: 'A session finished its turn.',
            categoryId: 'SESSION_STATUS',
            data: { sessionId: 's1', kind: 'completed' },
          },
          alert: undefined,
        }),
      ),
    ).resolves.toBe('suppressed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sender.send).not.toHaveBeenCalled();
    expect(presence.deliverAlert).not.toHaveBeenCalled();
    router.close();
  });

  it('falls back to the members who could have run the turn', async () => {
    const sender = fakeSender();
    const listProjectUserIds = vi.fn(async () => ['alice', 'bob']);
    const router = createPushRouter({
      sender: senderOf(sender),
      presence: fakePresence({}),
      store: fakeStore({ listProjectUserIds }),
    });

    await router.notify(permission({ initiatorUserId: undefined }));
    expect(listProjectUserIds).toHaveBeenCalledWith('p1', 'execute');
    expect(
      sender.send.mock.calls
        .flatMap((call) => call[1] ?? [])
        .map((entry) => entry.authTokenId)
        .sort(),
    ).toEqual(['alice-phone', 'alice-tablet', 'bob-phone']);
    router.close();
  });

  it('reports undelivered when the user has no registered device', async () => {
    const sender = fakeSender();
    const router = createPushRouter({
      sender: senderOf(sender),
      presence: fakePresence({}),
      store: fakeStore(),
    });

    await expect(router.notify(permission({ initiatorUserId: 'carol' }))).resolves.toBe(
      'undelivered',
    );
    expect(sender.send).not.toHaveBeenCalled();
    router.close();
  });
});

it('does not notify a recorded initiator after project access is revoked', async () => {
  const sender = fakeSender();
  const presence = fakePresence({ foreground: { alice: ['alice-phone'] } });
  const router = createPushRouter({
    sender: senderOf(sender),
    presence,
    store: fakeStore({ listProjectUserIds: async () => ['bob'] }),
  });
  expect(await router.notify(permission())).toBe('undelivered');
  expect(sender.send).not.toHaveBeenCalled();
  expect(presence.deliverAlert).not.toHaveBeenCalled();
  router.close();
});

it('rechecks project access before escalating a foreground alert', async () => {
  vi.useFakeTimers();
  let members = ['alice'];
  const sender = fakeSender();
  const router = createPushRouter({
    sender: senderOf(sender),
    presence: fakePresence({ foreground: { alice: ['alice-phone'] } }),
    store: fakeStore({ listProjectUserIds: async () => members }),
    escalationMs: 100,
  });
  try {
    expect(await router.notify(permission())).toBe('delivered');
    members = [];
    await vi.advanceTimersByTimeAsync(100);
    expect(sender.send).not.toHaveBeenCalled();
  } finally {
    router.close();
    vi.useRealTimers();
  }
});

it('cancels an alert while its recipient lookup is still outstanding', async () => {
  let resolve!: (members: string[]) => void;
  const sender = fakeSender();
  const presence = fakePresence({ foreground: { alice: ['alice-phone'] } });
  const router = createPushRouter({
    sender: senderOf(sender),
    presence,
    store: fakeStore({
      listProjectUserIds: () =>
        new Promise((done) => {
          resolve = done;
        }),
    }),
  });
  const pending = router.notify(permission());
  await vi.waitFor(() => expect(resolve).toBeDefined());
  router.cancel(permission().key);
  resolve(['alice']);
  expect(await pending).toBe('suppressed');
  expect(presence.deliverAlert).not.toHaveBeenCalled();
  expect(sender.send).not.toHaveBeenCalled();
  router.close();
});
