import { renderHook } from '@testing-library/react-native';
import { VerityApiError } from '@verity/mobile';

import { createVerityClient } from './client';
import { readMeetingExecuteProject, rememberMeetingExecuteGrant } from './meetingExecuteCache';
import { requireMeetingStartAccess, usePendingMeetingStart } from './meetingStartAccess';
import { taskAccountScope } from './tasksStore';

jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
}));
jest.mock('./authToken', () => ({
  getAuthToken: () => 'token',
  subscribeAuthToken: () => () => {},
}));
jest.mock('./browserSession', () => ({
  getBrowserSession: () => null,
  subscribeBrowserSession: () => () => {},
}));
jest.mock('./client', () => ({
  createVerityClient: jest.fn(),
  getVerityBaseUrl: () => 'https://core.test',
  subscribeVerityBaseUrl: () => () => {},
}));
jest.mock('./demoMode', () => ({ isDemoMode: () => false }));
jest.mock('./tasksStore', () => ({ taskAccountScope: jest.fn() }));
jest.mock('./meetingExecuteCache', () => ({
  readMeetingExecuteProject: jest.fn(),
  rememberMeetingExecuteGrant: jest.fn(),
}));

const key = JSON.stringify(['account', 'session']);
const getSession = jest.fn();
const getProject = jest.fn();
const getVeritySettings = jest.fn();
const personalTokens = jest.fn();

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(readMeetingExecuteProject).mockResolvedValue(undefined);
  jest.mocked(taskAccountScope).mockReturnValue('account');
  jest.mocked(createVerityClient).mockReturnValue({
    getSession,
    getProject,
    getVeritySettings,
    doppler: { personalTokens },
  } as never);
  getSession.mockResolvedValue({ projectId: 'project' });
});

it('checks Execute again for each attempt and never falls back on denial', async () => {
  getProject.mockResolvedValueOnce({ viewer: { canExecute: true } });
  await requireMeetingStartAccess('session');
  expect(rememberMeetingExecuteGrant).toHaveBeenLastCalledWith(key, 'project');

  getProject.mockResolvedValueOnce({ viewer: { canExecute: false } });
  await expect(requireMeetingStartAccess('session')).rejects.toThrow('Execute permission');
  expect(rememberMeetingExecuteGrant).toHaveBeenLastCalledWith(key, undefined);
  expect(readMeetingExecuteProject).toHaveBeenCalledWith(key);
});

it('uses a matching previously confirmed grant during an outage', async () => {
  getProject.mockRejectedValue(new TypeError('Network request failed'));
  jest.mocked(readMeetingExecuteProject).mockResolvedValue('project');
  await requireMeetingStartAccess('session');
  expect(readMeetingExecuteProject).toHaveBeenCalledWith(key);

  jest.mocked(readMeetingExecuteProject).mockResolvedValue('different-project');
  await expect(requireMeetingStartAccess('session')).rejects.toThrow('Network request failed');
  expect(rememberMeetingExecuteGrant).toHaveBeenCalledWith(key, undefined);
});

it('does not cache an allow from a canceled check', async () => {
  const attempt = new AbortController();
  getProject.mockImplementation(async () => {
    attempt.abort();
    return { viewer: { canExecute: true } };
  });
  await expect(requireMeetingStartAccess('session', attempt.signal)).rejects.toThrow();
  expect(rememberMeetingExecuteGrant).not.toHaveBeenCalled();
});

it('does not authorize a start after the active account changes', async () => {
  getProject.mockImplementation(async () => {
    jest.mocked(taskAccountScope).mockReturnValue('replacement-account');
    return { viewer: { canExecute: true } };
  });
  await expect(requireMeetingStartAccess('session')).rejects.toThrow('active account changed');
  expect(rememberMeetingExecuteGrant).not.toHaveBeenCalled();
});

it('checks standalone and legacy session permissions through their protected reads', async () => {
  getSession.mockResolvedValueOnce({ projectId: null });
  getVeritySettings.mockResolvedValue(null);
  await requireMeetingStartAccess('session');
  expect(getVeritySettings).toHaveBeenCalledTimes(1);

  getProject.mockResolvedValue({});
  personalTokens.mockRejectedValue(new VerityApiError(403, 'Forbidden'));
  await expect(requireMeetingStartAccess('session')).rejects.toThrow('Execute permission');
  expect(personalTokens).toHaveBeenCalledWith('project');
});

it('does not treat a slow permission check as an outage', async () => {
  jest.useFakeTimers();
  getSession.mockReturnValue(new Promise(() => undefined));
  try {
    const result = expect(requireMeetingStartAccess('session')).rejects.toThrow('timed out');
    await jest.advanceTimersByTimeAsync(10_000);
    await result;
    expect(readMeetingExecuteProject).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it('invalidates the pending start when the meeting screen closes', () => {
  const setBusy = jest.fn();
  const view = renderHook(() => usePendingMeetingStart('session', setBusy));
  const pending = view.result.current.pendingPermission;
  const controller = new AbortController();
  pending.current = controller;
  view.unmount();
  expect(controller.signal.aborted).toBe(true);
  expect(pending.current).toBeNull();
  expect(setBusy).toHaveBeenCalledWith(false);
});

it('forgets a revoked grant even when the check was canceled before the denial', async () => {
  const attempt = new AbortController();
  getProject.mockImplementation(async () => {
    attempt.abort();
    return { viewer: { canExecute: false } };
  });

  await expect(requireMeetingStartAccess('session', attempt.signal)).rejects.toThrow();
  expect(rememberMeetingExecuteGrant).toHaveBeenCalledWith(key, undefined);
});

it('rejects an already checked start if its account changes before the recorder is ready', async () => {
  getProject.mockResolvedValue({ viewer: { canExecute: true } });
  const assertAccess = await requireMeetingStartAccess('session');

  expect(assertAccess).toBeDefined();
  jest.mocked(taskAccountScope).mockReturnValue('replacement-account');
  expect(assertAccess).toThrow('active account changed');
});

it('keeps a confirmed start cancellable until the recorder begins', async () => {
  const attempt = new AbortController();
  getProject.mockResolvedValue({ viewer: { canExecute: true } });
  const assertAccess = await requireMeetingStartAccess('session', attempt.signal);
  attempt.abort();
  expect(assertAccess).toThrow('start was canceled');
});
