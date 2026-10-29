import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import SystemLogsScreen from '../app/settings/system-logs';
import {
  makeClient,
  mockCreateVerityClient,
  resetSettingsHarness,
  setSearchParams,
} from './support/settingsHarness';

afterEach(() => resetSettingsHarness());

function logs(text: string) {
  return {
    source: 'server',
    state: 'available',
    window: { since: '2026-10-28T12:00:00Z', until: '2026-10-28T13:00:00Z' },
    stale: false,
    truncated: false,
    entries: [{ at: null, level: 'error', text }],
  };
}

it('ignores a stale source response after switching sources', async () => {
  let resolveOld!: (value: ReturnType<typeof logs>) => void;
  const old = new Promise<ReturnType<typeof logs>>((resolve) => {
    resolveOld = resolve;
  });
  const systemLogs = jest
    .fn()
    .mockReturnValueOnce(old)
    .mockResolvedValue({ ...logs('host fault'), source: 'host', stale: true });
  mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { systemLogs }));
  render(<SystemLogsScreen />);
  fireEvent.press(screen.getByText('Host events'));
  expect(await screen.findByText('host fault')).toBeOnTheScreen();
  expect(screen.getByText('Stale snapshot')).toBeOnTheScreen();
  await act(async () => resolveOld(logs('obsolete server output')));
  expect(screen.queryByText('obsolete server output')).toBeNull();
  expect(screen.getByText('host fault')).toBeOnTheScreen();
});

it('explains missing build output and scopes the read to its operation', async () => {
  setSearchParams({ operationId: 'build-1' });
  const buildDiagnostic = jest.fn().mockResolvedValue({ state: 'expired', diagnostic: null });
  const systemLogs = jest.fn();
  mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { systemLogs, buildDiagnostic }));
  render(<SystemLogsScreen />);
  expect(
    await screen.findByText('The seven-day build diagnostic retention period has ended.'),
  ).toBeOnTheScreen();
  expect(buildDiagnostic).toHaveBeenCalledWith('build-1');
  expect(systemLogs).not.toHaveBeenCalled();
});

it('shows a shortened build output without presenting it as complete', async () => {
  setSearchParams({ operationId: 'build-2' });
  const buildDiagnostic = jest.fn().mockResolvedValue({
    state: 'available',
    diagnostic: { recordedAt: '2026-10-28T12:00:00Z', text: 'compiler failed', truncated: true },
  });
  mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { buildDiagnostic }));
  render(<SystemLogsScreen />);
  expect(await screen.findByText('compiler failed')).toBeOnTheScreen();
  expect(screen.getByText('Output shortened')).toBeOnTheScreen();
});
