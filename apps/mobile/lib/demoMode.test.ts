import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';

import {
  enterDemoMode,
  exitDemoMode,
  hydrateDemoMode,
  isDemoMode,
  restartDemoMode,
  useDemoRevision,
} from './demoMode';
import {
  createVerityClient,
  getActiveMeetingServerId,
  getVerityBaseUrl,
  hasConfiguredVerityBaseUrl,
  hydrateVerityBaseUrl,
  setVerityBaseUrl,
} from './client';
import { DEMO_BASE_URL } from './demoTransport';
import { createWebSocket } from './socket';
import { resetVeritySettingsStore } from './settingsStore';
import { getAuthToken } from './authToken';
import { restoreUnprotectedAuthToken } from './authToken';
import { hasActiveMeetingCapture } from './meetingCaptureStatus';

jest.mock('./settingsStore', () => ({ resetVeritySettingsStore: jest.fn() }));
jest.mock('./serverProfile', () => ({
  getServerProfile: () => null,
  hydrateServerProfile: jest.fn().mockResolvedValue(null),
}));
jest.mock('./authToken', () => ({
  clearAuthToken: jest.fn(),
  getAuthToken: jest.fn().mockReturnValue(null),
  restoreUnprotectedAuthToken: jest.fn().mockResolvedValue(true),
}));
jest.mock('./meetingCaptureStatus', () => ({
  hasActiveMeetingCapture: jest.fn().mockReturnValue(false),
}));
jest.mock('./pinnedTransport', () => ({
  createPinnedFetch: jest.fn(),
  createPinnedWebSocket: jest.fn(),
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(hasActiveMeetingCapture).mockReturnValue(false);
  await AsyncStorage.clear();
  await hydrateVerityBaseUrl();
});

afterEach(async () => {
  await exitDemoMode();
});

it('serves projects offline without reading real authentication or opening a native socket', async () => {
  const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network disabled'));
  const socketSpy = jest.spyOn(global, 'WebSocket');
  try {
    await enterDemoMode();
    expect(getVerityBaseUrl()).toBe(DEMO_BASE_URL);
    expect(hasConfiguredVerityBaseUrl()).toBe(true);
    expect(getActiveMeetingServerId()).toBeNull();
    const client = createVerityClient()!;
    const projects = await client.listProjects();
    expect(projects.length).toBeGreaterThan(0);
    const sessions = await client.listSessions();
    const socket = createWebSocket(
      `${DEMO_BASE_URL.replace('https:', 'wss:')}/sessions/${sessions[0]!.sessionId}/stream`,
    );
    socket.close();
    expect(getAuthToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(socketSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    socketSpy.mockRestore();
  }
});

it('preserves the saved server across entry, relaunch and exit', async () => {
  await setVerityBaseUrl('https://my-server.test');
  await enterDemoMode();
  await hydrateVerityBaseUrl();
  expect(isDemoMode()).toBe(true);
  expect(getVerityBaseUrl()).toBe(DEMO_BASE_URL);
  expect(await AsyncStorage.getItem('verity.serverUrl')).toBe('https://my-server.test');
  await exitDemoMode();
  expect(getVerityBaseUrl()).toBe('https://my-server.test');
  expect(restoreUnprotectedAuthToken).toHaveBeenLastCalledWith('https://my-server.test');
  expect(hasConfiguredVerityBaseUrl()).toBe(true);
});

it('retains the real connection and recording controls while meeting capture is active or starting', async () => {
  await setVerityBaseUrl('https://my-server.test');
  jest.mocked(hasActiveMeetingCapture).mockReturnValue(true);
  await expect(enterDemoMode()).rejects.toThrow('End the current meeting');
  expect(isDemoMode()).toBe(false);
  expect(getVerityBaseUrl()).toBe('https://my-server.test');
  expect(await AsyncStorage.getItem('verity.demoMode.v1')).toBeNull();
});

it('returns an unconfigured installation to onboarding after exit', async () => {
  await enterDemoMode();
  await exitDemoMode();
  expect(createVerityClient()).toBeNull();
  expect(hasConfiguredVerityBaseUrl()).toBe(false);
});

it('invalidates memoized screens and cached settings on entry, reset and exit', async () => {
  const { result } = renderHook(() => useDemoRevision());
  const revisions = [result.current];
  await act(() => enterDemoMode());
  revisions.push(result.current);
  act(() => restartDemoMode());
  revisions.push(result.current);
  await act(() => exitDemoMode());
  revisions.push(result.current);
  expect(new Set(revisions).size).toBe(4);
  expect(resetVeritySettingsStore).toHaveBeenCalledTimes(4);
});

it('keeps the current mode when persisting a transition fails', async () => {
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('Storage full'));
  await expect(enterDemoMode()).rejects.toThrow('Storage full');
  expect(isDemoMode()).toBe(false);
  await enterDemoMode();
  jest.mocked(AsyncStorage.removeItem).mockRejectedValueOnce(new Error('Storage unavailable'));
  await expect(exitDemoMode()).rejects.toThrow('Storage unavailable');
  expect(isDemoMode()).toBe(true);
});

it('tolerates a failed preference read', async () => {
  await enterDemoMode();
  jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('Storage unavailable'));
  await hydrateDemoMode();
  expect(isDemoMode()).toBe(false);
});
