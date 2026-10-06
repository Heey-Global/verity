import * as Notifications from 'expo-notifications';
import { presentLiveAlert } from './liveAlerts';

jest.mock('expo-notifications', () => ({
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
  expect(setCategory).toHaveBeenCalledWith('AGENT_QUESTION_CHOICES', [
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
        categoryIdentifier: 'AGENT_QUESTION_CHOICES',
        data: { sessionId: 's1', kind: 'question', choices: ['Push + PR', 'Wait'] },
      }),
    }),
  );
});
