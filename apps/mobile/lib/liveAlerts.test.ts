import * as Notifications from 'expo-notifications';
import { presentLiveAlert, nativeCanPresentAlerts } from './liveAlerts';

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, value: string) => {
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    return createHash('sha256').update(value).digest('hex');
  },
}));
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  setNotificationCategoryAsync: jest.fn().mockResolvedValue(undefined),
  scheduleNotificationAsync: jest.fn().mockResolvedValue('id'),
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const schedule = Notifications.scheduleNotificationAsync as jest.Mock;
const setCategory = Notifications.setNotificationCategoryAsync as jest.Mock;

beforeEach(() => jest.clearAllMocks());

it('shows a permission request with the quick actions of its push', async () => {
  await presentLiveAlert({
    sessionId: 's1',
    kind: 'permission',
    categoryId: 'PERMISSION_PROMPT',
    toolUseId: 't1',
    title: 'Permission needed',
    body: 'A session requests permission to continue.',
  });
  expect(setCategory).not.toHaveBeenCalled();
  expect(schedule).toHaveBeenCalledWith({
    content: {
      title: 'Permission needed',
      body: 'A session requests permission to continue.',
      sound: 'default',
      categoryIdentifier: 'PERMISSION_PROMPT',
      data: { sessionId: 's1', kind: 'permission', toolUseId: 't1' },
    },
    trigger: null,
  });
});

it("labels a question's buttons with its options and carries them for the answer", async () => {
  await presentLiveAlert({
    sessionId: 's1',
    kind: 'question',
    categoryId: 'AGENT_QUESTION',
    choices: ['Push + PR', 'Wait'],
    title: 'Reply needed',
    body: 'A session is waiting for your answer.',
  });
  expect(setCategory).toHaveBeenCalledWith(expect.stringMatching(/^AGENT_QUESTION_CHOICES_/), [
    expect.objectContaining({ identifier: 'VERITY_CHOICE_0', buttonTitle: 'Push + PR' }),
    expect.objectContaining({ identifier: 'VERITY_CHOICE_1', buttonTitle: 'Wait' }),
    expect.objectContaining({ identifier: 'VERITY_REPLY', buttonTitle: 'Reply' }),
  ]);
  // The category must exist before the notification that names it.
  expect(setCategory.mock.invocationCallOrder[0]).toBeLessThan(
    schedule.mock.invocationCallOrder[0]!,
  );
  expect(schedule).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.objectContaining({
        categoryIdentifier: setCategory.mock.calls[0]?.[0],
        data: { sessionId: 's1', kind: 'question', choices: ['Push + PR', 'Wait'] },
      }),
    }),
  );
});

it('keeps outstanding questions on categories with their own labels', async () => {
  const question = {
    sessionId: 's1',
    kind: 'question' as const,
    categoryId: 'AGENT_QUESTION' as const,
    title: 'Reply',
    body: 'Choose',
  };
  await presentLiveAlert({ ...question, choices: ['Push', 'Wait'] });
  await presentLiveAlert({ ...question, sessionId: 's2', choices: ['Implement', 'Plan'] });
  expect(setCategory.mock.calls[0]?.[0]).not.toBe(setCategory.mock.calls[1]?.[0]);
  for (let i = 0; i < 2; i += 1) {
    expect(schedule.mock.calls[i]?.[0].content.categoryIdentifier).toBe(
      setCategory.mock.calls[i]?.[0],
    );
  }
});

it('reports whether local notifications can present native live alerts', async () => {
  const permissions = Notifications.getPermissionsAsync as jest.Mock;
  permissions.mockResolvedValueOnce({ granted: false }).mockResolvedValueOnce({ granted: true });
  expect(await nativeCanPresentAlerts()).toBe(false);
  expect(await nativeCanPresentAlerts()).toBe(true);
});
