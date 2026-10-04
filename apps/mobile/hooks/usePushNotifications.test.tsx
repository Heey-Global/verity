import { renderHook, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
import * as Notifications from 'expo-notifications';
import { isDemoMode } from '../lib/demoMode';
import { createPushOutboxForClient, ensurePushRegistration } from '../lib/pushNotifications';
import { usePushNotifications } from './usePushNotifications';

jest.mock('../lib/demoMode', () => ({ isDemoMode: jest.fn().mockReturnValue(false) }));
jest.mock('../lib/authToken', () => ({
  getAuthTokenId: jest.fn(),
  getStoredAuthTokenId: jest.fn(),
}));
jest.mock('../lib/pushNotifications', () => ({
  createPushOutboxForClient: jest.fn(() => ({ flush: jest.fn().mockResolvedValue(undefined) })),
  ensurePushRegistration: jest.fn().mockResolvedValue(undefined),
  handlePushResponse: jest.fn(),
}));
jest.mock('expo-notifications', () => ({
  getLastNotificationResponseAsync: jest.fn().mockResolvedValue(null),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isDemoMode).mockReturnValue(false);
});

it('does not register push, flush real outboxes, or consume notifications in demo mode', () => {
  jest.mocked(isDemoMode).mockReturnValue(true);
  renderHook(() => usePushNotifications({} as VerityClient, 'https://demo.invalid'));
  expect(ensurePushRegistration).not.toHaveBeenCalled();
  expect(createPushOutboxForClient).not.toHaveBeenCalled();
  expect(Notifications.getLastNotificationResponseAsync).not.toHaveBeenCalled();
  expect(Notifications.addNotificationResponseReceivedListener).not.toHaveBeenCalled();
});

it('retains push registration and notification handling for a connected server', async () => {
  const client = {} as VerityClient;
  renderHook(() => usePushNotifications(client, 'https://server.example'));
  await waitFor(() =>
    expect(ensurePushRegistration).toHaveBeenCalledWith(client, 'https://server.example'),
  );
  expect(createPushOutboxForClient).toHaveBeenCalledWith(client, 'https://server.example');
  expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalled();
});
