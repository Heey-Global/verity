import AsyncStorage from '@react-native-async-storage/async-storage';
import { VerityApiError } from '@verity/mobile';

import {
  answerVerity,
  deliveryOutcome,
  discardOutgoing,
  flushVerity,
  followVerity,
  refreshVerity,
  resetVerityForTests,
  retryOutgoing,
  sendToVerity,
  useVerity,
} from './verityConversation';

const mockClient = {
  sendAssistantMessage: jest.fn(),
  answerAssistantQuestion: jest.fn(),
  assistantConversation: jest.fn(),
};
let mockScope: string | null = 'account-a';
jest.mock('./client', () => ({ createVerityClient: () => mockClient }));
jest.mock('./tasksStore', () => ({ taskAccountScope: () => mockScope }));
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `request-${String(++mockUuid)}` }));

const conversation = {
  availability: 'ready',
  sessionId: 'assistant',
  revision: 1,
  state: 'idle',
  items: [],
  question: null,
  approvals: [],
};

/** The outbox as persisted, which is what survives an app restart. */
async function saved(): Promise<{ requestId: string; held?: boolean; error?: string }[]> {
  return JSON.parse((await AsyncStorage.getItem('verity.assistant.outbox')) ?? '[]') as never;
}

/** The store's state, read through the hook's snapshot source. */
let current: ReturnType<typeof useVerity> | undefined;
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: () => undefined,
}));
function state() {
  current = useVerity(false);
  return current;
}

beforeEach(async () => {
  resetVerityForTests();
  await AsyncStorage.clear();
  mockScope = 'account-a';
  mockUuid = 0;
  for (const fn of Object.values(mockClient)) fn.mockReset();
  mockClient.assistantConversation.mockResolvedValue(conversation);
});

it('removes words from the outbox only after the server confirmed them', async () => {
  mockClient.sendAssistantMessage.mockRejectedValueOnce(new TypeError('Network request failed'));
  await sendToVerity({ text: ' Remember the offer ', input: 'voice', projectId: 'site' });
  // Offline: kept, with a reason, to retry under the same id.
  expect(await saved()).toMatchObject([{ requestId: 'request-1', held: false }]);
  expect(state().outbox[0]).toMatchObject({ text: 'Remember the offer', input: 'voice' });

  mockClient.sendAssistantMessage.mockResolvedValueOnce({
    requestId: 'request-1',
    delivered: true,
  });
  await flushVerity();
  expect(mockClient.sendAssistantMessage.mock.calls.map(([body]) => body)).toEqual([
    expect.objectContaining({ requestId: 'request-1', device: 'phone', projectId: 'site' }),
    expect.objectContaining({ requestId: 'request-1' }),
  ]);
  expect(await saved()).toEqual([]);
});

it('holds what the server refused until the user retries or discards it', async () => {
  mockClient.sendAssistantMessage.mockRejectedValue(
    new VerityApiError(409, 'off', { code: 'disabled' }),
  );
  await sendToVerity({ text: 'one', input: 'text' });
  await sendToVerity({ text: 'two', input: 'text' });
  expect(await saved()).toMatchObject([
    { requestId: 'request-1', held: true, error: 'Verity is switched off in settings.' },
    { requestId: 'request-2', held: true },
  ]);
  // Held entries are not resent on every poll.
  mockClient.sendAssistantMessage.mockClear();
  await flushVerity();
  expect(mockClient.sendAssistantMessage).not.toHaveBeenCalled();

  mockClient.sendAssistantMessage.mockResolvedValue({ requestId: 'request-1', delivered: true });
  await retryOutgoing('request-1');
  expect(mockClient.sendAssistantMessage).toHaveBeenCalledWith(
    expect.objectContaining({ requestId: 'request-1', text: 'one' }),
  );
  await discardOutgoing('request-2');
  expect(await saved()).toEqual([]);
});

it('drops an answer another device gave first and says so', async () => {
  mockClient.answerAssistantQuestion.mockRejectedValue(
    new VerityApiError(409, 'answered', { code: 'answered' }),
  );
  await answerVerity('q-3', ['Hansen']);
  expect(await saved()).toEqual([]);
  expect(state().notice).toMatch(/another device/);
});

it('never sends one account’s words to another account', async () => {
  mockClient.sendAssistantMessage.mockRejectedValueOnce(new TypeError('offline'));
  await sendToVerity({ text: 'for account a', input: 'text' });
  mockScope = 'account-b';
  mockClient.sendAssistantMessage.mockClear();
  await flushVerity();
  expect(mockClient.sendAssistantMessage).not.toHaveBeenCalled();
  expect(await saved()).toHaveLength(1);
});

it('keeps a retryable failure in order rather than letting later words overtake it', () => {
  expect(deliveryOutcome(new VerityApiError(409, 'x', { code: 'pending' })).action).toBe('retry');
  expect(deliveryOutcome(new VerityApiError(503, 'x')).action).toBe('retry');
  expect(deliveryOutcome(new VerityApiError(403, 'x')).action).toBe('hold');
  expect(deliveryOutcome(new VerityApiError(409, 'x', { code: 'stale_question' })).action).toBe(
    'drop',
  );
});

describe('following the conversation', () => {
  it('holds each read open from the revision it already shows', async () => {
    const controller = new AbortController();
    const sleep = jest.fn(async () => undefined);
    mockClient.assistantConversation
      .mockResolvedValueOnce(conversation)
      .mockResolvedValueOnce({ ...conversation, revision: 2, state: 'working' })
      .mockImplementationOnce(async () => {
        controller.abort();
        return { ...conversation, revision: 3 };
      });
    await followVerity(controller.signal, () => true, sleep);
    expect(mockClient.assistantConversation.mock.calls.map(([options]) => options)).toEqual([
      { signal: controller.signal },
      { after: 1, waitMs: 20_000, signal: controller.signal },
      { after: 2, waitMs: 20_000, signal: controller.signal },
    ]);
    // Every answer was a change, so no read waited on the phone's side.
    expect(sleep).not.toHaveBeenCalled();
    expect(state().conversation?.revision).toBe(2);
  });

  it('falls back to polling when the server answers unchanged at once', async () => {
    const controller = new AbortController();
    const sleep = jest.fn(async () => {
      controller.abort();
    });
    await followVerity(controller.signal, () => false, sleep);
    // The first read had nothing to wait from; the second came back unchanged at once.
    expect(mockClient.assistantConversation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(30_000, controller.signal);
  });

  it('backs off while the server cannot be reached', async () => {
    const controller = new AbortController();
    mockClient.assistantConversation.mockRejectedValue(new TypeError('Network request failed'));
    const waits: number[] = [];
    await followVerity(
      controller.signal,
      () => true,
      async (ms) => {
        waits.push(ms);
        if (waits.length === 3) controller.abort();
      },
    );
    expect(waits).toEqual([2_000, 4_000, 8_000]);
    expect(state().access).toBe('offline');
  });

  it('asks again soon while words wait to be resent', async () => {
    const controller = new AbortController();
    mockClient.sendAssistantMessage.mockRejectedValue(new TypeError('Network request failed'));
    mockClient.assistantConversation.mockResolvedValueOnce(conversation);
    await sendToVerity({ text: 'Hi', input: 'text' }).catch(() => undefined);
    mockClient.assistantConversation.mockImplementationOnce(async () => {
      controller.abort();
      return { ...conversation, revision: 2 };
    });
    await followVerity(
      controller.signal,
      () => true,
      async () => undefined,
    );
    expect(mockClient.assistantConversation.mock.calls.at(-1)?.[0]).toMatchObject({
      after: 1,
      waitMs: 2_000,
    });
  });
});

it('never lets an older read replace a newer one', async () => {
  mockClient.assistantConversation.mockResolvedValueOnce({ ...conversation, revision: 5 });
  await refreshVerity();
  mockClient.assistantConversation.mockResolvedValueOnce({ ...conversation, revision: 3 });
  await refreshVerity();
  expect(state().conversation?.revision).toBe(5);
});

it('sends words added while a delivery is under way in the same flush', async () => {
  let release: () => void = () => undefined;
  mockClient.sendAssistantMessage.mockImplementationOnce(
    () => new Promise((resolve) => (release = () => resolve({ delivered: true }))),
  );
  mockClient.sendAssistantMessage.mockResolvedValue({ delivered: true });
  const first = sendToVerity({ text: 'one', input: 'text' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = sendToVerity({ text: 'two', input: 'text' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await Promise.all([first, second]);
  expect(mockClient.sendAssistantMessage.mock.calls.map(([body]) => body.text)).toEqual([
    'one',
    'two',
  ]);
  expect(await saved()).toEqual([]);
});
