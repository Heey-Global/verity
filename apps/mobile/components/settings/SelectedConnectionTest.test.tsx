import { AppState } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
const mockAttempt = jest.fn();
const mockVerify = jest.fn();
const mockExport = jest.fn();
const mockCopy = jest.fn();
const mockContext = jest.fn();
const mockProfile = { serverId: 'paired' };
let mockBlur: (() => void) | undefined;
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => () => void) => {
    require('react').useEffect(() => {
      mockBlur = callback();
      return mockBlur;
    }, [callback]);
  },
}));
jest.mock('../premium/PremiumChrome', () => ({
  CardRow: ({ title, subtitle, disabled, onPress }: any) => {
    const { Pressable, Text } = require('react-native');
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        disabled={disabled}
        onPress={onPress}
      >
        <Text>{title}</Text>
        <Text>{subtitle}</Text>
      </Pressable>
    );
  },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => '11111111-1111-4111-8111-111111111111' }));
jest.mock('expo-clipboard', () => ({ setStringAsync: (...args: unknown[]) => mockCopy(...args) }));
jest.mock('../../lib/serverProfile', () => ({ getServerProfile: () => mockProfile }));
jest.mock('../../lib/selectedRecordingAttempt', () => ({
  selectedRecordingAttempt: (...args: unknown[]) => mockAttempt(...args),
}));
jest.mock('../../lib/selectedRecordingContext', () => ({
  selectedRecordingContext: () => mockContext(),
}));
import { SelectedConnectionTest } from './SelectedConnectionTest';
const runId = '11111111-1111-4111-8111-111111111111';
async function ready() {
  render(<SelectedConnectionTest disabled={false} onBusy={jest.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Run bounded connection test' })).toBeEnabled(),
  );
}
beforeEach(async () => {
  jest.clearAllMocks();
  mockContext.mockReset();
  mockAttempt.mockReset();
  mockVerify.mockReset();
  mockExport.mockReset();
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  await AsyncStorage.clear();
  mockVerify.mockResolvedValue('a'.repeat(16));
  mockAttempt.mockResolvedValue({ status: 200 });
  mockCopy.mockResolvedValue(undefined);
  mockExport.mockResolvedValue({
    status: {
      runId,
      installationFingerprint: 'a'.repeat(16),
      phase: 'stopped',
      core: { state: 'stopped' },
      uplink: { state: 'stopped' },
      error: null,
    },
  });
  mockContext.mockReturnValue({
    assertInactive: async () => undefined,
    profile: mockProfile,
    options: {},
    verify: mockVerify,
    client: { exportConnectionRecording: mockExport },
  });
});
it('runs once, confirms cleanup separately from export and copies only on request', async () => {
  await ready();
  fireEvent.press(screen.getByText('Run bounded connection test'));
  await screen.findByText(
    'HTTP 200. Connection and recording Stop confirmed. Export remains separate.',
  );
  expect(mockAttempt).toHaveBeenCalledTimes(1);
  expect(mockCopy).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Copy bounded test report'));
  await waitFor(() => expect(mockCopy).toHaveBeenCalledTimes(1));
  expect(mockExport).toHaveBeenCalledWith(runId, 3);
});
it('blocks double start and aborts promptly on Stop', async () => {
  mockAttempt.mockImplementation(
    ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Stopped'))),
      ),
  );
  await ready();
  fireEvent.press(screen.getByText('Run bounded connection test'));
  await waitFor(() => expect(mockAttempt).toHaveBeenCalledTimes(1));
  fireEvent.press(screen.getByText('Run bounded connection test'));
  fireEvent.press(screen.getByText('Stop bounded test'));
  await waitFor(() => expect(mockAttempt.mock.calls[0][0].signal.aborted).toBe(true));
  expect(mockAttempt).toHaveBeenCalledTimes(1);
});
it('aborts on navigation', async () => {
  mockAttempt.mockImplementation(
    ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Stopped'))),
      ),
  );
  await ready();
  fireEvent.press(screen.getByText('Run bounded connection test'));
  await waitFor(() => expect(mockAttempt).toHaveBeenCalled());
  await act(async () => mockBlur?.());
  expect(mockAttempt.mock.calls[0][0].signal.aborted).toBe(true);
});
it('does not attach without direct administrator prerequisites', async () => {
  mockContext.mockImplementation(() => {
    throw new Error('Unlock the paired direct connection before testing.');
  });
  await ready();
  fireEvent.press(screen.getByText('Run bounded connection test'));
  await screen.findByText('Unlock the paired direct connection before testing.');
  expect(mockAttempt).not.toHaveBeenCalled();
});
it('keeps failed cleanup distinct and blocks the next start', async () => {
  mockAttempt.mockRejectedValue(new Error('Selected cleanup failed'));
  await ready();
  fireEvent.press(screen.getByText('Run bounded connection test'));
  await screen.findByText(
    'No HTTP result confirmed. Stop could not be confirmed. Do not start another test; collect the report after expiry.',
  );
  expect(screen.getByRole('button', { name: 'Run bounded connection test' })).toBeDisabled();
});
it('restores the saved run and retains it after export failure', async () => {
  await AsyncStorage.setItem('verity.selectedConnectionTest.v1.paired', runId);
  mockExport.mockRejectedValue(new Error('secret error'));
  render(<SelectedConnectionTest disabled={false} onBusy={jest.fn()} />);
  await screen.findByText(
    'Saved bounded test available. Copy its report before starting another test.',
  );
  fireEvent.press(screen.getByText('Copy bounded test report'));
  await screen.findByText(
    'Export unavailable. The run is retained here for another collection attempt.',
  );
  expect(mockCopy).not.toHaveBeenCalled();
  expect(await AsyncStorage.getItem('verity.selectedConnectionTest.v1.paired')).toBe(runId);
});
it('rejects an export from another installation', async () => {
  mockExport.mockResolvedValue({ status: { runId, installationFingerprint: 'b'.repeat(16) } });
  await ready();
  fireEvent.press(screen.getByText('Run bounded connection test'));
  await screen.findByText(
    'HTTP 200. Connection and recording Stop confirmed. Export remains separate.',
  );
  fireEvent.press(screen.getByText('Copy bounded test report'));
  await screen.findByText(
    'Export unavailable. The run is retained here for another collection attempt.',
  );
  expect(mockCopy).not.toHaveBeenCalled();
});
it('clears an orphan reference only after an export 404 and inactive native status', async () => {
  await AsyncStorage.setItem('verity.selectedConnectionTest.v1.paired', runId);
  mockExport.mockRejectedValue(Object.assign(new Error('missing'), { status: 404 }));
  render(<SelectedConnectionTest disabled={false} onBusy={jest.fn()} />);
  await screen.findByText(
    'Saved bounded test available. Copy its report before starting another test.',
  );
  fireEvent.press(screen.getByText('Copy bounded test report'));
  await screen.findByText(
    'Core has no report for this run. Local reference cleared; no report copied.',
  );
  expect(await AsyncStorage.getItem('verity.selectedConnectionTest.v1.paired')).toBeNull();
  expect(mockCopy).not.toHaveBeenCalled();
});
it('does not copy or clear when descriptor verification returns 404', async () => {
  await AsyncStorage.setItem('verity.selectedConnectionTest.v1.paired', runId);
  mockVerify.mockRejectedValue(Object.assign(new Error('missing'), { status: 404 }));
  render(<SelectedConnectionTest disabled={false} onBusy={jest.fn()} />);
  await screen.findByText(
    'Saved bounded test available. Copy its report before starting another test.',
  );
  fireEvent.press(screen.getByText('Copy bounded test report'));
  await screen.findByText(
    'Export unavailable. The run is retained here for another collection attempt.',
  );
  expect(await AsyncStorage.getItem('verity.selectedConnectionTest.v1.paired')).toBe(runId);
  expect(mockExport).not.toHaveBeenCalled();
});
it('copies an allowlisted local receipt when server export fails, without clearing the run', async () => {
  await AsyncStorage.setItem('verity.selectedConnectionTest.v1.paired', runId);
  mockExport.mockRejectedValue(Object.assign(new Error('secret token payload'), { status: 503 }));
  render(<SelectedConnectionTest disabled={false} onBusy={jest.fn()} />);
  await screen.findByText(
    'Saved bounded test available. Copy its report before starting another test.',
  );
  fireEvent.press(screen.getByText('Copy bounded test report'));
  await screen.findByText('Copy local test failure');
  fireEvent.press(screen.getByText('Copy local test failure'));
  await screen.findByText('Local failure copied. This does not confirm server recording or Stop.');
  expect(JSON.parse(mockCopy.mock.calls[0][0])).toEqual({
    kind: 'selected-test-local-failure',
    stage: 'server-export',
    httpStatus: 503,
    runId,
  });
  expect(mockCopy.mock.calls[0][0]).not.toContain('secret');
  expect(await AsyncStorage.getItem('verity.selectedConnectionTest.v1.paired')).toBe(runId);
  expect(screen.getByRole('button', { name: 'Run bounded connection test' })).toBeDisabled();
});
it('reports direct verification failure locally without trying server export', async () => {
  await AsyncStorage.setItem('verity.selectedConnectionTest.v1.paired', runId);
  mockVerify.mockRejectedValue(new Error('private URL and token'));
  render(<SelectedConnectionTest disabled={false} onBusy={jest.fn()} />);
  await screen.findByText(
    'Saved bounded test available. Copy its report before starting another test.',
  );
  fireEvent.press(screen.getByText('Copy bounded test report'));
  await screen.findByText('Copy local test failure');
  mockCopy.mockRejectedValueOnce(new Error('clipboard failed'));
  fireEvent.press(screen.getByText('Copy local test failure'));
  await screen.findByText('Clipboard unavailable. Failed step: export-direct-descriptor.');
  expect(mockExport).not.toHaveBeenCalled();
  expect(JSON.parse(mockCopy.mock.calls[0][0])).toEqual({
    kind: 'selected-test-local-failure',
    stage: 'export-direct-descriptor',
    httpStatus: null,
    runId,
  });
});
it('copies only local evidence after the bounded attempt fails and retains the run', async () => {
  mockAttempt.mockRejectedValue(
    Object.assign(new Error('secret admission ticket'), { status: 502 }),
  );
  await ready();
  fireEvent.press(screen.getByText('Run bounded connection test'));
  await screen.findByText('Copy local test failure');
  fireEvent.press(screen.getByText('Copy local test failure'));
  await screen.findByText('Local failure copied. This does not confirm server recording or Stop.');
  expect(JSON.parse(mockCopy.mock.calls[0][0])).toEqual({
    kind: 'selected-test-local-failure',
    stage: 'bounded-attempt',
    httpStatus: 502,
    runId,
  });
  expect(await AsyncStorage.getItem('verity.selectedConnectionTest.v1.paired')).toBe(runId);
  expect(mockExport).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Run bounded connection test' })).toBeDisabled();
});
