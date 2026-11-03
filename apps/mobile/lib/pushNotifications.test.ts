import type { VerityClient, PushOutbox } from '@verity/mobile';
import AsyncStorage from '@react-native-async-storage/async-storage';

// expo-notifications is a native module; mock the surface the adapter touches so the
// registration/response logic can be exercised in jest. The factory must be
// self-contained (jest hoists it above the imports), so grab the fns after import.
jest.mock('expo-notifications', () => ({
  setNotificationCategoryAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
}));
// The device id (auth-token id) is resolved from the keychain-backed store; the
// auto-mock replaces every export with a jest.fn().
jest.mock('./authToken');

import * as Notifications from 'expo-notifications';
import { getAuthTokenId, getStoredAuthTokenId } from './authToken';
import {
  createPushOutboxForClient,
  ensurePushRegistration,
  foregroundPushBehavior,
  handlePushResponse,
  registerPushCategories,
} from './pushNotifications';

const mockNotifications = {
  setNotificationCategoryAsync: Notifications.setNotificationCategoryAsync as jest.Mock,
  getPermissionsAsync: Notifications.getPermissionsAsync as jest.Mock,
  requestPermissionsAsync: Notifications.requestPermissionsAsync as jest.Mock,
  getExpoPushTokenAsync: Notifications.getExpoPushTokenAsync as jest.Mock,
};
const mockAuth = {
  getAuthTokenId: getAuthTokenId as jest.Mock,
  getStoredAuthTokenId: getStoredAuthTokenId as jest.Mock,
};

function fakeClient(overrides: Partial<VerityClient> = {}): VerityClient {
  return {
    getHealth: jest.fn().mockResolvedValue({ status: 'ok', pushEnabled: true }),
    registerPushToken: jest.fn().mockResolvedValue({ registered: true }),
    decidePermission: jest.fn(),
    sendTurn: jest.fn(),
    mergePullRequest: jest.fn(),
    ...overrides,
  } as unknown as VerityClient;
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockAuth.getAuthTokenId.mockReturnValue('device-1');
  mockAuth.getStoredAuthTokenId.mockResolvedValue('device-1');
  mockNotifications.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
  mockNotifications.requestPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
  mockNotifications.getExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[abc]' });
});

describe('createPushOutboxForClient', () => {
  it('scopes persisted actions by normalized server URL and pairing id', async () => {
    const client = fakeClient();
    const first = createPushOutboxForClient(client, 'https://verity-a.test/');
    await first.queue({ type: 'open-session', sessionId: 's1' });
    const firstKeys = await AsyncStorage.getAllKeys();
    expect(firstKeys).toHaveLength(1);
    expect(firstKeys[0]).toContain(encodeURIComponent('https://verity-a.test'));
    expect(firstKeys[0]).toContain('device-1');

    mockAuth.getAuthTokenId.mockReturnValue('device-2');
    const second = createPushOutboxForClient(client, 'https://verity-b.test');
    await second.queue({ type: 'open-session', sessionId: 's1' });
    expect(await AsyncStorage.getAllKeys()).toHaveLength(2);
    expect(await first.pending()).toHaveLength(1);
    expect(await second.pending()).toHaveLength(1);
  });
});

describe('registerPushCategories', () => {
  it('translates the permission category into gated / destructive expo actions', async () => {
    await registerPushCategories();
    const permissionCall = mockNotifications.setNotificationCategoryAsync.mock.calls.find(
      ([id]) => id === 'PERMISSION_PROMPT',
    );
    expect(permissionCall).toBeDefined();
    const actions = permissionCall?.[1] as Array<{
      identifier: string;
      options: {
        opensAppToForeground: boolean;
        isAuthenticationRequired: boolean;
        isDestructive: boolean;
      };
    }>;
    const allow = actions.find((a) => a.identifier === 'VERITY_ALLOW');
    const deny = actions.find((a) => a.identifier === 'VERITY_DENY');
    // Allow must foreground + force an unlock; deny is a background destructive tap.
    expect(allow?.options).toMatchObject({
      opensAppToForeground: true,
      isAuthenticationRequired: true,
      isDestructive: false,
    });
    expect(deny?.options).toMatchObject({
      opensAppToForeground: false,
      isAuthenticationRequired: false,
      isDestructive: true,
    });
  });

  it('declares the agent-question reply as a text-input action', async () => {
    await registerPushCategories();
    const questionCall = mockNotifications.setNotificationCategoryAsync.mock.calls.find(
      ([id]) => id === 'AGENT_QUESTION',
    );
    const reply = (questionCall?.[1] as Array<{ identifier: string; textInput?: unknown }>).find(
      (a) => a.identifier === 'VERITY_REPLY',
    );
    expect(reply?.textInput).toEqual({
      submitButtonTitle: 'Send',
      placeholder: 'Reply to the agent…',
    });
  });

  it('requires unlock + foreground for the PR merge action', async () => {
    await registerPushCategories();
    const readyCall = mockNotifications.setNotificationCategoryAsync.mock.calls.find(
      ([id]) => id === 'PULL_REQUEST_READY',
    );
    const merge = (
      readyCall?.[1] as Array<{ identifier: string; options: Record<string, boolean> }>
    ).find((action) => action.identifier === 'VERITY_MERGE_PULL_REQUEST');
    expect(merge?.options).toMatchObject({
      opensAppToForeground: true,
      isAuthenticationRequired: true,
      isDestructive: false,
    });
  });
});

describe('ensurePushRegistration', () => {
  it('registers the device token on the happy path', async () => {
    const client = fakeClient();
    expect(await ensurePushRegistration(client, 'http://host')).toBe('registered');
    expect(client.registerPushToken).toHaveBeenCalledWith('device-1', {
      expoToken: 'ExponentPushToken[abc]',
      platform: 'ios',
    });
    expect(mockNotifications.setNotificationCategoryAsync).toHaveBeenCalled();
  });

  it('degrades silently and never prompts when push is disabled server-side', async () => {
    const client = fakeClient({
      getHealth: jest.fn().mockResolvedValue({ status: 'ok', pushEnabled: false }),
    });
    expect(await ensurePushRegistration(client, 'http://host')).toBe('push-disabled');
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(client.registerPushToken).not.toHaveBeenCalled();
  });

  it('treats a 503 from the endpoint as a silent degrade', async () => {
    const { VerityApiError } =
      jest.requireActual<typeof import('@verity/mobile')>('@verity/mobile');
    const client = fakeClient({
      registerPushToken: jest.fn().mockRejectedValue(new VerityApiError(503, 'push off')),
    });
    expect(await ensurePushRegistration(client, 'http://host')).toBe('push-disabled');
  });

  it('treats a 401/403 (bearer not loaded yet) as a benign retry-later skip', async () => {
    const { VerityApiError } =
      jest.requireActual<typeof import('@verity/mobile')>('@verity/mobile');
    const client = fakeClient({
      registerPushToken: jest.fn().mockRejectedValue(new VerityApiError(401, 'unauthorized')),
    });
    expect(await ensurePushRegistration(client, 'http://host')).toBe('no-device');
  });

  it('does nothing until the device is unlocked/paired (no auth-token id)', async () => {
    mockAuth.getAuthTokenId.mockReturnValue(null);
    mockAuth.getStoredAuthTokenId.mockResolvedValue(null);
    const client = fakeClient();
    expect(await ensurePushRegistration(client, 'http://host')).toBe('no-device');
    expect(client.registerPushToken).not.toHaveBeenCalled();
  });

  it('reports permission-denied when the OS refuses and cannot re-ask', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    const client = fakeClient();
    expect(await ensurePushRegistration(client, 'http://host')).toBe('permission-denied');
    expect(client.registerPushToken).not.toHaveBeenCalled();
  });

  it('requests permission when askable, then registers', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    const client = fakeClient();
    expect(await ensurePushRegistration(client, 'http://host')).toBe('registered');
    expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalled();
  });
});

describe('handlePushResponse', () => {
  function fakeOutbox(): PushOutbox & { enqueue: jest.Mock } {
    return {
      queue: jest.fn().mockResolvedValue(undefined),
      enqueue: jest.fn().mockResolvedValue(undefined),
      flush: jest.fn().mockResolvedValue(undefined),
      pending: jest.fn().mockResolvedValue([]),
    } as unknown as PushOutbox & { enqueue: jest.Mock };
  }

  function response(actionIdentifier: string, data: unknown, userText?: string) {
    return {
      actionIdentifier,
      userText,
      notification: { request: { content: { data } } },
    } as unknown as import('expo-notifications').NotificationResponse;
  }

  it('enqueues a permission allow into the outbox', async () => {
    const outbox = fakeOutbox();
    const navigate = jest.fn();
    await handlePushResponse(
      response('VERITY_ALLOW', { sessionId: 's1', kind: 'permission', toolUseId: 't1' }),
      outbox,
      navigate,
    );
    expect(outbox.enqueue).toHaveBeenCalledWith({
      type: 'decide-permission',
      sessionId: 's1',
      toolUseId: 't1',
      decision: { behavior: 'allow' },
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates (no network) on a plain tap', async () => {
    const outbox = fakeOutbox();
    const navigate = jest.fn();
    await handlePushResponse(
      response('expo.modules.notifications.actions.DEFAULT', {
        sessionId: 's1',
        kind: 'completed',
      }),
      outbox,
      navigate,
    );
    expect(navigate).toHaveBeenCalledWith('s1');
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues a PR merge and routes the explicit open action', async () => {
    const outbox = fakeOutbox();
    const navigate = jest.fn();
    const data = {
      sessionId: 's1',
      kind: 'pull_request_ready',
      pullRequestNumber: 831,
      deviceId: 'device-1',
    };
    await handlePushResponse(
      response('VERITY_MERGE_PULL_REQUEST', data),
      outbox,
      navigate,
      'device-1',
    );
    expect(outbox.queue).toHaveBeenCalledWith({
      type: 'merge-pull-request',
      sessionId: 's1',
      pullRequestNumber: 831,
    });
    expect(navigate).toHaveBeenCalledWith('s1');
    expect(outbox.flush).toHaveBeenCalled();

    navigate.mockClear();
    await handlePushResponse(response('VERITY_OPEN_SESSION', data), outbox, navigate, 'device-1');
    expect(navigate).toHaveBeenCalledWith('s1');
  });

  it('rejects a merge action from a different server pairing', async () => {
    const outbox = fakeOutbox();
    const navigate = jest.fn();
    await handlePushResponse(
      response('VERITY_MERGE_PULL_REQUEST', {
        sessionId: 's1',
        kind: 'pull_request_ready',
        pullRequestNumber: 831,
        deviceId: 'old-server-device',
      }),
      outbox,
      navigate,
      'current-server-device',
    );
    expect(outbox.queue).not.toHaveBeenCalled();
    expect(outbox.flush).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  /**
   * The server-update announcement carries no `sessionId`, so the session parser
   * rejects it by design. Routed before that parser, a tap reaches settings; routed
   * through it, the notification names an action and then leads nowhere.
   */
  it('opens settings on a server-update announcement', async () => {
    const outbox = fakeOutbox();
    const navigate = jest.fn();
    const navigateToSettings = jest.fn();
    await handlePushResponse(
      response('expo.modules.notifications.actions.DEFAULT', {
        kind: 'server-update',
        version: 'v11.1.0',
        deviceId: 'device-1',
      }),
      outbox,
      navigate,
      'device-1',
      navigateToSettings,
    );
    expect(navigateToSettings).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('ignores a server-update announcement from a different server pairing', async () => {
    const outbox = fakeOutbox();
    const navigate = jest.fn();
    const navigateToSettings = jest.fn();
    await handlePushResponse(
      response('expo.modules.notifications.actions.DEFAULT', {
        kind: 'server-update',
        version: 'v11.1.0',
        deviceId: 'old-server-device',
      }),
      outbox,
      navigate,
      'current-server-device',
      navigateToSettings,
    );
    expect(navigateToSettings).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('routes scan taps only within the current pairing and never queues an agent action', async () => {
    const outbox = fakeOutbox(),
      session = jest.fn(),
      project = jest.fn();
    const tap = (projectId: string | null, sessionId: string | null, deviceId = 'current') =>
      response('expo.modules.notifications.actions.DEFAULT', {
        kind: 'vulnerability',
        projectId,
        sessionId,
        deviceId,
      });
    await handlePushResponse(tap('p', 's'), outbox, session, 'current', undefined, project);
    expect(session).toHaveBeenCalledWith('s');
    await handlePushResponse(tap('p', null), outbox, session, 'current', undefined, project);
    expect(project).toHaveBeenLastCalledWith('p');
    await handlePushResponse(tap(null, null), outbox, session, 'current', undefined, project);
    expect(project).toHaveBeenLastCalledWith(null);
    await handlePushResponse(
      tap('old', null, 'old'),
      outbox,
      session,
      'current',
      undefined,
      project,
    );
    expect(project).toHaveBeenCalledTimes(2);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('drops a malformed payload', async () => {
    const outbox = fakeOutbox();
    const navigate = jest.fn();
    await handlePushResponse(response('VERITY_ALLOW', { nope: true }), outbox, navigate);
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('foregroundPushBehavior', () => {
  const surfaced = (data: unknown): boolean => {
    const behavior = foregroundPushBehavior(data);
    // Banner, list and sound move together: a banner without the sound is exactly
    // the silent delivery that let a waiting agent go unnoticed.
    expect(behavior.shouldShowList).toBe(behavior.shouldShowBanner);
    expect(behavior.shouldPlaySound).toBe(behavior.shouldShowBanner);
    return behavior.shouldShowBanner;
  };

  it('surfaces the pushes the agent is blocked on', () => {
    expect(surfaced({ sessionId: 's1', kind: 'permission', toolUseId: 't1' })).toBe(true);
    expect(surfaced({ sessionId: 's1', kind: 'question' })).toBe(true);
  });

  it('keeps informational and unrecognised pushes quiet in the foreground', () => {
    expect(surfaced({ sessionId: 's1', kind: 'completed' })).toBe(false);
    expect(surfaced({ sessionId: 's1', kind: 'crashed' })).toBe(false);
    expect(
      surfaced({
        sessionId: 's1',
        kind: 'pull_request_ready',
        pullRequestNumber: 1,
        deviceId: 'd',
      }),
    ).toBe(false);
    expect(surfaced({ kind: 'server-update', version: '1.2.3' })).toBe(false);
    // A permission payload without its toolUseId is malformed, not a prompt.
    expect(surfaced({ sessionId: 's1', kind: 'permission' })).toBe(false);
  });
});

describe('calendar meeting pushes', () => {
  const outbox = () =>
    ({
      queue: jest.fn().mockResolvedValue(undefined),
      enqueue: jest.fn().mockResolvedValue(undefined),
      flush: jest.fn().mockResolvedValue(undefined),
      pending: jest.fn().mockResolvedValue([]),
    }) as unknown as PushOutbox & { enqueue: jest.Mock };
  const respond = (actionIdentifier: string, data: unknown) =>
    ({
      actionIdentifier,
      notification: { request: { content: { data } } },
    }) as unknown as import('expo-notifications').NotificationResponse;
  const upcoming = { kind: 'meeting-upcoming', eventKey: 'k1', deviceId: 'current' };
  const started = { kind: 'meeting-started', meetingId: 'm1', deviceId: 'current' };
  const handle = async (actionIdentifier: string, data: unknown) => {
    const box = outbox();
    const prompt = jest.fn();
    const session = jest.fn();
    await handlePushResponse(
      respond(actionIdentifier, data),
      box,
      session,
      'current',
      undefined,
      undefined,
      prompt,
    );
    return { box, prompt, session };
  };

  it('queues Join, Skip and Discard as outbox replies', async () => {
    expect((await handle('VERITY_MEETING_JOIN', upcoming)).box.enqueue).toHaveBeenCalledWith({
      type: 'join-calendar-meeting',
      eventKey: 'k1',
    });
    expect((await handle('VERITY_MEETING_SKIP', upcoming)).box.enqueue).toHaveBeenCalledWith({
      type: 'skip-calendar-meeting',
      eventKey: 'k1',
    });
    expect((await handle('VERITY_MEETING_DISCARD', started)).box.enqueue).toHaveBeenCalledWith({
      type: 'discard-live-meeting',
      meetingId: 'm1',
    });
  });

  it('hands a tap to the meeting card instead of opening a session', async () => {
    const tapUpcoming = await handle('expo.modules.notifications.actions.DEFAULT', upcoming);
    expect(tapUpcoming.prompt).toHaveBeenCalledWith({ kind: 'upcoming', eventKey: 'k1' });
    const openStarted = await handle('VERITY_MEETING_OPEN', started);
    expect(openStarted.prompt).toHaveBeenCalledWith({ kind: 'started', meetingId: 'm1' });
    expect(openStarted.session).not.toHaveBeenCalled();
    expect(openStarted.box.enqueue).not.toHaveBeenCalled();
  });

  // A Join left in the tray by a former server must not send a bot through the current one.
  it('ignores meeting pushes from another pairing', async () => {
    const { box } = await handle('VERITY_MEETING_JOIN', { ...upcoming, deviceId: 'old' });
    expect(box.enqueue).not.toHaveBeenCalled();
  });

  it('ignores a meeting push when the pairing cannot be checked', async () => {
    const box = outbox();
    const { deviceId: _omitted, ...unstamped } = upcoming;
    await handlePushResponse(respond('VERITY_MEETING_JOIN', unstamped), box, jest.fn(), undefined);
    expect(box.enqueue).not.toHaveBeenCalled();
  });

  // Join from a killed app is the main path; the device id may not be loaded yet.
  it('asks in the sheet when Join arrives before the device id is known', async () => {
    const box = outbox();
    const prompt = jest.fn();
    await handlePushResponse(
      respond('VERITY_MEETING_JOIN', upcoming),
      box,
      jest.fn(),
      undefined,
      undefined,
      undefined,
      prompt,
    );
    expect(box.enqueue).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledWith({ kind: 'upcoming', eventKey: upcoming.eventKey });
  });

  // On a cold start the device id may not be loaded yet; a tap must still lead somewhere.
  it('opens the sheet for a plain tap before the pairing is known', async () => {
    const prompt = jest.fn();
    await handlePushResponse(
      respond('expo.modules.notifications.actions.DEFAULT', upcoming),
      outbox(),
      jest.fn(),
      undefined,
      undefined,
      undefined,
      prompt,
    );
    expect(prompt).toHaveBeenCalledWith({ kind: 'upcoming', eventKey: upcoming.eventKey });
  });

  it('shows a meeting about to start while the app is open', () => {
    expect(foregroundPushBehavior(upcoming).shouldShowBanner).toBe(true);
  });
});
