import AsyncStorage from '@react-native-async-storage/async-storage';

import { setVerityBaseUrl } from './client';

const mockResetVeritySettingsStore = jest.fn();

jest.mock('./settingsStore', () => ({
  resetVeritySettingsStore: () => mockResetVeritySettingsStore(),
}));
jest.mock('./serverProfile', () => ({
  getServerProfile: () => null,
  hydrateServerProfile: jest.fn().mockResolvedValue(null),
}));
jest.mock('./authToken', () => ({
  clearAuthToken: jest.fn(),
  getAuthToken: jest.fn(),
}));
jest.mock('./pinnedTransport', () => ({ createPinnedFetch: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
});

it('invalidates cached settings when the selected server changes', async () => {
  await setVerityBaseUrl('https://server-a.test');
  mockResetVeritySettingsStore.mockClear();

  await setVerityBaseUrl('https://server-b.test');

  expect(mockResetVeritySettingsStore).toHaveBeenCalledTimes(1);
});

it('keeps the cache when the selected server is unchanged', async () => {
  await setVerityBaseUrl('https://server.test');
  mockResetVeritySettingsStore.mockClear();

  await setVerityBaseUrl('https://server.test/ignored/path');

  expect(mockResetVeritySettingsStore).not.toHaveBeenCalled();
});
