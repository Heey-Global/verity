import { Alert, AppState } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
const mockAttempt = jest.fn();
const mockVerify = jest.fn();
const mockExport = jest.fn();
const mockCopy = jest.fn();
const mockContext = jest.fn();
const mockInactive = jest.fn();
let mockProfile = { serverId: 'paired' };
let mockRunId = '11111111-1111-4111-8111-111111111111';
let mockBlur: (() => void) | undefined;
let mockAppState: ((state: string) => void) | undefined;
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => () => void) => {
    require('react').useEffect(() => {
      mockBlur = callback();
      return mockBlur;
    }, [callback]);
  },
}));
jest.mock('../premium/PremiumChrome', () => ({
  Eyebrow: ({ children }: any) =>
    require('react').createElement(require('react-native').Text, null, children),
  RowCard: ({ children }: any) =>
    require('react').createElement(require('react-native').View, null, children),
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
jest.mock('expo-crypto', () => ({ randomUUID: () => mockRunId }));
jest.mock('expo-clipboard', () => ({ setStringAsync: (...args: unknown[]) => mockCopy(...args) }));
jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
jest.mock('../../lib/serverProfile', () => ({ getServerProfile: () => mockProfile }));
jest.mock('../../lib/selectedRecordingAttempt', () => ({
  selectedRecordingAttempt: (...args: unknown[]) => mockAttempt(...args),
}));
jest.mock('../../lib/selectedRecordingContext', () => ({
  selectedRecordingContext: () => mockContext(),
  assertNativeTunnelInactive: () => mockInactive(),
}));
jest.mock('../../lib/remoteControlTransport', () => ({
  remoteDataRecordingRemainingMs: async () => 0,
  startRemoteDataRecording: jest.fn(),
  stopRemoteDataRecording: async () => true,
}));
import { SelectedConnectionTest } from './SelectedConnectionTest';
import { ConnectionRecording } from './ConnectionRecording';
import { loadConnectionDiagnosticReports } from '../../lib/connectionDiagnosticReport';
const runId = '11111111-1111-4111-8111-111111111111';
const key = 'verity.selectedConnectionTest.v1.paired';
const sessionHash = 'c1448f52fd7bef90';
const fingerprint = '0123456789abcdef';
const storageSetItem = jest.mocked(AsyncStorage.setItem).getMockImplementation()!;
const storageRemoveItem = jest.mocked(AsyncStorage.removeItem).getMockImplementation()!;
function nativeRecording() {
  return JSON.stringify([
    {
      version: 1,
      channel: 'DATA',
      generation: '01234567-0123-4123-8123-0123456789ab',
      sessionHash,
      clockOffsetKnown: false,
      startedLate: false,
      delegateAvailable: true,
      captureLimitMs: 30000,
      expired: false,
      dropped: 0,
      events: [
        { sequence: 1, utc: new Date().toISOString(), elapsedMs: 0, event: 'capture_started' },
        { sequence: 2, utc: new Date().toISOString(), elapsedMs: 1, event: 'task_completed' },
      ],
    },
  ]);
}
function serverReport() {
  return {
    version: 1,
    status: {
      version: 1,
      runId,
      phase: 'stopped',
      startedAt: '2026-11-04T11:20:00.000Z',
      expiresAt: '2026-11-04T11:20:45.000Z',
      installationFingerprint: fingerprint,
      core: { state: 'stopped', records: 0, dropped: 0 },
      uplink: { state: 'stopped' },
      error: null,
      selection: { sessionHash, confirmed: false, preparationExpiresAt: null, readiness: null },
    },
    core: { records: [], dropped: 0 },
    uplink: {
      available: true,
      data: {
        version: 1,
        runId,
        state: 'stopped',
        expiresAt: '2026-11-04T11:20:45.000Z',
        retainedUntil: '2026-11-04T12:20:00.000Z',
        collectorReady: true,
        recordCount: 0,
        droppedRecords: 0,
        records: [],
      },
      error: null,
    },
  };
}
async function ready() {
  render(<SelectedConnectionTest disabled={false} onBusy={jest.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Start quick test' })).toBeEnabled(),
  );
}
async function completed() {
  await ready();
  fireEvent.press(screen.getByText('Start quick test'));
  await screen.findByText(/Connection works/);
}
async function copyReport() {
  const previous = mockCopy.mock.calls.length;
  fireEvent.press(screen.queryByText('Collect again') ?? screen.getByText('Collect report'));
  await waitFor(() => expect(mockCopy).toHaveBeenCalledTimes(previous + 1));
  return JSON.parse(mockCopy.mock.calls.at(-1)![0]);
}
beforeEach(async () => {
  jest.clearAllMocks();
  mockProfile = { serverId: 'paired' };
  mockRunId = runId;
  jest.mocked(AsyncStorage.removeItem).mockReset().mockImplementation(storageRemoveItem);
  jest.mocked(AsyncStorage.setItem).mockReset().mockImplementation(storageSetItem);
  mockContext.mockReset();
  mockAttempt.mockReset();
  mockVerify.mockReset();
  mockExport.mockReset();
  mockCopy.mockReset();
  mockInactive.mockReset();
  mockBlur = undefined;
  mockAppState = undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener: any) => {
    mockAppState = listener;
    return { remove: jest.fn() };
  });
  await AsyncStorage.clear();
  mockVerify.mockResolvedValue(fingerprint);
  mockInactive.mockResolvedValue(undefined);
  mockCopy.mockResolvedValue(undefined);
  mockExport.mockImplementation(async () => serverReport());
  mockAttempt.mockImplementation(async (options) => {
    options.onPhase?.('running');
    options.onResponse?.(200);
    options.onPhase?.('stopping');
    await options.onLocalRecording?.({
      status: 'ready',
      recording: nativeRecording(),
      sessionHash,
      stopped: true,
    });
    return { status: 200 };
  });
  mockContext.mockReturnValue({
    assertInactive: mockInactive,
    profile: mockProfile,
    options: {},
    verify: mockVerify,
    client: { exportConnectionRecording: mockExport },
  });
});
afterEach(() => jest.restoreAllMocks());
it('does not start on mount and explains the quick test automatic end', async () => {
  await ready();
  expect(mockAttempt).not.toHaveBeenCalled();
  expect(screen.getByText(/Checks once whether the connection works/)).toBeTruthy();
  expect(screen.queryByText('Stop test')).toBeNull();
});
it('retains the completed run and copies a combined version2 report only on request', async () => {
  await completed();
  expect(mockAttempt).toHaveBeenCalledTimes(1);
  expect(mockCopy).not.toHaveBeenCalled();
  expect(screen.queryByText('Stop test')).toBeNull();
  const report = await copyReport();
  expect(report).toMatchObject({
    version: 2,
    runId,
    testType: 'quick_test',
    outcome: 'completed',
    expectedAutomaticStop: true,
    complete: true,
    sources: { app: true, core: true, uplink: true },
  });
  expect(report.app.recording[0].sessionHash).toBe(sessionHash);
  expect(report.remote.recording).toEqual(serverReport());
  expect(mockExport).toHaveBeenCalledWith(runId, 3);
  expect(JSON.parse((await AsyncStorage.getItem(key))!)).toMatchObject({
    runId,
    localStatus: 'ready',
    localStopped: true,
    outcome: 'completed',
  });
  expect(await loadConnectionDiagnosticReports('paired')).toEqual([report]);
});
it('blocks attachment when paired direct prerequisites fail', async () => {
  mockContext.mockImplementation(() => {
    throw new Error('Unlock the paired direct connection before testing.');
  });
  await ready();
  fireEvent.press(screen.getByText('Start quick test'));
  await screen.findByText('Unlock the direct connection to your Core, then try again.');
  expect(mockAttempt).not.toHaveBeenCalled();
  expect(await AsyncStorage.getItem(key)).toBeNull();
});
it.each(['stop', 'blur', 'background'])('aborts without double starting on %s', async (action) => {
  mockAttempt.mockImplementation(
    ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Stopped'))),
      ),
  );
  await ready();
  fireEvent.press(screen.getByText('Start quick test'));
  await waitFor(() => expect(mockAttempt).toHaveBeenCalledTimes(1));
  await act(async () => {
    if (action === 'stop') fireEvent.press(screen.getByText('Stop test'));
    if (action === 'blur') mockBlur?.();
    if (action === 'background') mockAppState?.('background');
  });
  expect(mockAttempt.mock.calls[0][0].signal.aborted).toBe(true);
  await waitFor(async () =>
    expect(JSON.parse((await AsyncStorage.getItem(key))!).outcome).toBe('cancelled'),
  );
  expect(mockAttempt).toHaveBeenCalledTimes(1);
});
it('restores an older UUID run as unknown and never restarts it during collection', async () => {
  await AsyncStorage.setItem(key, runId);
  render(<SelectedConnectionTest disabled={false} onBusy={jest.fn()} />);
  await screen.findByText(/Earlier test\. Collect its report/);
  expect(screen.queryByText('Start quick test')).toBeNull();
  const report = await copyReport();
  expect(report).toMatchObject({
    version: 2,
    runId,
    startedAt: null,
    outcome: 'unknown',
    complete: false,
    app: { available: false, unavailableReason: 'legacy' },
  });
  expect(mockAttempt).not.toHaveBeenCalled();
  expect(await AsyncStorage.getItem(key)).toBe(runId);
});
it('retains local evidence and the run when remote recollection fails', async () => {
  await completed();
  const first = await copyReport();
  await screen.findByText('Report copied to the clipboard.');
  mockExport.mockRejectedValue(new Error('private token payload'));
  const next = await copyReport();
  expect(next).toMatchObject({
    runId,
    complete: true,
    sources: { app: true, core: true, uplink: true },
  });
  expect(JSON.stringify(next)).not.toContain('private');
  expect(await AsyncStorage.getItem(key)).not.toBeNull();
  expect(await loadConnectionDiagnosticReports('paired')).toEqual([first]);
  expect(mockAttempt).toHaveBeenCalledTimes(1);
});
it('excludes a server response from another installation', async () => {
  await completed();
  const candidate = serverReport();
  candidate.status.installationFingerprint = 'ffffffffffffffff';
  mockExport.mockResolvedValue(candidate);
  const report = await copyReport();
  expect(report).toMatchObject({ complete: false, remote: { available: false, recording: null } });
});
it('does not announce copying when the clipboard rejects and keeps evidence available', async () => {
  await completed();
  mockCopy.mockRejectedValue(new Error('clipboard unavailable'));
  fireEvent.press(screen.getByText('Collect report'));
  await screen.findByText('Could not copy the report. The test is kept – try again.');
  expect(screen.queryByText('Report copied to the clipboard.')).toBeNull();
  expect(await AsyncStorage.getItem(key)).not.toBeNull();
  expect(await loadConnectionDiagnosticReports('paired')).toHaveLength(1);
});
it('does not start the test when saving its initial identity fails', async () => {
  await ready();
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage full'));
  fireEvent.press(screen.getByText('Start quick test'));
  await screen.findByText('Connection failed');
  expect(mockAttempt).not.toHaveBeenCalled();
  expect(screen.queryByText(/Connection works/)).toBeNull();
});
it('reports history storage failure separately from clipboard success', async () => {
  await completed();
  const setItem = storageSetItem;
  jest
    .spyOn(AsyncStorage, 'setItem')
    .mockImplementation((name, value) =>
      name.startsWith('verity.connectionDiagnosticReports.')
        ? Promise.reject(new Error('storage full'))
        : setItem(name, value),
    );
  const report = await copyReport();
  await screen.findByText(/could not be saved on this device/);
  expect(report.runId).toBe(runId);
  expect(screen.queryByText('Start new quick test')).toBeNull();
});
it('persists native evidence arriving after navigation without updating the unfocused UI', async () => {
  let finish!: () => void;
  mockAttempt.mockImplementation(
    (options) =>
      new Promise((resolve) => {
        finish = () => {
          void options
            .onLocalRecording({
              status: 'ready',
              recording: nativeRecording(),
              sessionHash,
              stopped: true,
            })
            .then(() => resolve({ status: 200 }));
        };
      }),
  );
  await ready();
  fireEvent.press(screen.getByText('Start quick test'));
  await waitFor(() => expect(finish).toBeDefined());
  await act(async () => {
    mockBlur?.();
    finish();
  });
  await waitFor(async () =>
    expect(JSON.parse((await AsyncStorage.getItem(key))!)).toMatchObject({
      localStatus: 'ready',
      localStopped: true,
    }),
  );
  expect(mockAttempt.mock.calls[0][0].signal.aborted).toBe(true);
  expect(screen.queryByText(/Connection works/)).toBeNull();
});
it('does not start another run while native Stop remains unknown', async () => {
  await completed();
  await copyReport();
  await screen.findByText('Start new quick test');
  mockInactive.mockRejectedValue(new Error('native Stop unknown'));
  fireEvent.press(screen.getByText('Start new quick test'));
  await screen.findByText(
    'The app could not confirm that the last test stopped on this device. Try again.',
  );
  expect(await AsyncStorage.getItem(key)).not.toBeNull();
  expect(screen.queryByText('Start quick test')).toBeNull();
  expect(mockAttempt).toHaveBeenCalledTimes(1);
});
it('does not authorize a fresh run merely because a partial report was saved', async () => {
  await completed();
  mockExport.mockRejectedValue(new Error('remote unavailable'));
  await copyReport();
  // A partial report alone never offers a fresh run; the user must finish or discard.
  await screen.findByText('Not confirmed as stopped');
  expect(screen.queryByText('Start new quick test')).toBeNull();
  expect(screen.getByText('Discard and start over')).toBeTruthy();
  expect(await AsyncStorage.getItem(key)).not.toBeNull();
  expect(screen.queryByText('Start quick test')).toBeNull();
  expect(mockAttempt).toHaveBeenCalledTimes(1);
});

it('serializes repeated new-test taps so a delayed removal cannot erase the next run', async () => {
  await completed();
  await copyReport();
  const button = await screen.findByRole('button', { name: 'Start new quick test' });
  let release!: () => void;
  jest.mocked(AsyncStorage.removeItem).mockImplementationOnce(
    (name) =>
      new Promise<void>((resolve, reject) => {
        release = () => {
          void storageRemoveItem(name).then(resolve, reject);
        };
      }),
  );
  let control: typeof button | null = button;
  while (control && typeof control.props.onPress !== 'function') control = control.parent;
  expect(control).not.toBeNull();
  const press = control!.props.onPress as () => void;
  act(() => {
    press();
    press();
  });
  await waitFor(() => expect(AsyncStorage.removeItem).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('Start quick test')).toBeNull();
  await act(async () => release());
  await screen.findByText('Start quick test');
  mockRunId = '22222222-2222-4222-8222-222222222222';
  fireEvent.press(screen.getByText('Start quick test'));
  await waitFor(async () =>
    expect(JSON.parse((await AsyncStorage.getItem(key))!)).toMatchObject({
      runId: mockRunId,
      outcome: 'completed',
    }),
  );
  expect(mockAttempt).toHaveBeenCalledTimes(2);
  expect(AsyncStorage.removeItem).toHaveBeenCalledTimes(1);
});
it('retains old-profile completion only under its original storage key', async () => {
  let finish!: () => void;
  mockAttempt.mockImplementation(
    (options) =>
      new Promise((resolve) => {
        finish = () => {
          options.onPhase('stopping');
          void options
            .onLocalRecording({
              status: 'ready',
              recording: nativeRecording(),
              sessionHash,
              stopped: true,
            })
            .then(() => resolve({ status: 200 }));
        };
      }),
  );
  const view = render(<SelectedConnectionTest disabled={false} onBusy={jest.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Start quick test' })).toBeEnabled(),
  );
  fireEvent.press(screen.getByText('Start quick test'));
  await waitFor(() => expect(finish).toBeDefined());
  mockProfile = { serverId: 'other-profile' };
  view.rerender(<SelectedConnectionTest disabled={false} onBusy={jest.fn()} />);
  await act(async () => finish());
  await waitFor(async () =>
    expect(JSON.parse((await AsyncStorage.getItem(key))!)).toMatchObject({
      runId,
      localStatus: 'ready',
    }),
  );
  expect(await AsyncStorage.getItem('verity.selectedConnectionTest.v1.other-profile')).toBeNull();
  expect(screen.queryByText(/Quick test · 11111111/)).toBeNull();
  expect(screen.queryByText(/Connection works/)).toBeNull();
});

it('keeps a partial report for a missing server run and allows a new test only after verified inactivity', async () => {
  await completed();
  mockExport.mockRejectedValue(Object.assign(new Error('not retained'), { status: 404 }));
  const report = await copyReport();
  expect(report.remote).toMatchObject({ available: false, stopped: false, recording: null });
  expect(screen.getByText(/Your Core no longer has data for this test/)).toBeTruthy();
  fireEvent.press(screen.getByText('Start new quick test'));
  await screen.findByText('Start quick test');
  expect(await AsyncStorage.getItem(key)).toBeNull();
  expect(await loadConnectionDiagnosticReports('paired')).toHaveLength(1);
});

it('resets the previous profile report and failure status when selecting another profile', async () => {
  const view = render(<SelectedConnectionTest disabled={false} onBusy={jest.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Start quick test' })).toBeEnabled(),
  );
  fireEvent.press(screen.getByText('Start quick test'));
  await screen.findByText(/Connection works/);
  mockExport.mockRejectedValue(new Error('offline'));
  await copyReport();
  expect(screen.getByText('Copy technical failure details')).toBeTruthy();
  mockProfile = { serverId: 'other-profile' };
  view.rerender(<SelectedConnectionTest disabled={false} onBusy={jest.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Start quick test' })).toBeEnabled(),
  );
  expect(screen.queryByText('Copy technical failure details')).toBeNull();
  expect(screen.queryByText(/Incomplete –/)).toBeNull();
  expect(screen.getByText(/Checks once whether the connection works/)).toBeTruthy();
});

it('preserves native evidence in memory when persistence fails after capture', async () => {
  jest.mocked(AsyncStorage.setItem).mockImplementation(async (storageKey, value) => {
    if (storageKey === key && JSON.parse(value).local !== null) throw new Error('storage full');
    return storageSetItem(storageKey, value);
  });
  mockAttempt.mockImplementation(async (options) => {
    options.onResponse?.(200);
    try {
      await options.onLocalRecording({
        status: 'ready',
        recording: nativeRecording(),
        sessionHash,
        stopped: true,
      });
    } catch {
      await options
        .onLocalRecording({ status: 'failed', recording: null, sessionHash, stopped: true })
        .catch(() => undefined);
    }
    return { status: 200 };
  });
  await ready();
  fireEvent.press(screen.getByText('Start quick test'));
  await screen.findByText('Collect report');
  const report = await copyReport();
  expect(report.app.available).toBe(true);
  expect(report.app.recording[0].sessionHash).toBe(sessionHash);
  expect(report.app.stopped).toBe(true);
});

it('keeps cross-mode capture blocked after a failed attempt until confirmed collection', async () => {
  mockAttempt.mockRejectedValue(new Error('Selected native capture cleanup failed'));
  const blocked = jest.fn();
  render(<SelectedConnectionTest disabled={false} onBusy={() => {}} onCaptureBlocked={blocked} />);
  await waitFor(() => expect(blocked).toHaveBeenLastCalledWith(false));
  fireEvent.press(screen.getByText('Start quick test'));
  await screen.findByText('Connection failed');
  expect(blocked).toHaveBeenLastCalledWith(true);
});

it('integrates the quick collection/Stop gate with problem-start admission', async () => {
  const client = { startConnectionRecording: jest.fn() } as never;
  mockAttempt.mockRejectedValue(new Error('Selected native capture cleanup failed'));
  render(<ConnectionRecording client={client} />);
  await waitFor(() => expect(screen.getByText('Start quick test')).toBeEnabled());
  fireEvent.press(screen.getByText('Start quick test'));
  await screen.findByText('Connection failed');
  expect(screen.getByText('Start long test')).toBeDisabled();
  mockExport.mockRejectedValueOnce(new Error('unavailable'));
  await copyReport();
  expect(screen.getByText('Start long test')).toBeDisabled();
  await copyReport();
  await waitFor(() => expect(screen.getByText('Start long test')).toBeEnabled());
});

it('does not release cross-mode capture from retained Stop when current inactivity fails', async () => {
  const blocked = jest.fn();
  render(<SelectedConnectionTest disabled={false} onBusy={() => {}} onCaptureBlocked={blocked} />);
  await waitFor(() => expect(screen.getByText('Start quick test')).toBeEnabled());
  fireEvent.press(screen.getByText('Start quick test'));
  await screen.findByText(/Connection works/);
  await copyReport();
  expect(blocked).toHaveBeenLastCalledWith(false);
  mockInactive.mockRejectedValue(new Error('active tunnel'));
  await copyReport();
  expect(blocked).toHaveBeenLastCalledWith(true);
});

async function confirmDiscard() {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    fireEvent.press(screen.getByText('Discard and start over'));
    await act(async () =>
      alert.mock.calls[0]![2]!.find((button) => button.text === 'Discard')!.onPress!(),
    );
  } finally {
    alert.mockRestore();
  }
}
it('discards an unfinished quick test only after this device confirms it is inactive', async () => {
  await AsyncStorage.setItem(key, runId);
  render(<SelectedConnectionTest disabled={false} onBusy={jest.fn()} />);
  await screen.findByText(/Earlier test\. Collect its report/);
  // A still-running native tunnel must keep the unfinished test and its data.
  mockInactive.mockRejectedValueOnce(new Error('active tunnel'));
  await confirmDiscard();
  await screen.findByText(/could not confirm that the test stopped on this device/);
  expect(await AsyncStorage.getItem(key)).toBe(runId);
  await confirmDiscard();
  await waitFor(() => expect(screen.getByText('Start quick test')).toBeEnabled());
  expect(await AsyncStorage.getItem(key)).toBeNull();
  expect(mockAttempt).not.toHaveBeenCalled();
});
it('keeps saved reports when discarding an unfinished quick test', async () => {
  await completed();
  mockExport.mockRejectedValue(new Error('remote unavailable'));
  await copyReport();
  await screen.findByText('Not confirmed as stopped');
  await confirmDiscard();
  await screen.findByText('Start quick test');
  expect((await loadConnectionDiagnosticReports('paired')).map((entry) => entry.runId)).toEqual([
    runId,
  ]);
  // Stop was never confirmed, so the server may still record this run.
  await screen.findByText(/still finishing the previous test · ready in \d+ s/);
  expect(screen.getByRole('button', { name: 'Start quick test' })).toBeDisabled();
});
it('explains why the quick test is unavailable instead of only greying it out', async () => {
  render(
    <SelectedConnectionTest
      disabled
      blockedReason="Finish the long test first."
      onBusy={jest.fn()}
    />,
  );
  await screen.findByText('Finish the long test first.');
  expect(screen.getByRole('button', { name: 'Start quick test' })).toBeDisabled();
});

it('keeps the other test blocked after reopening until the stored wait is read', async () => {
  await AsyncStorage.setItem(
    'verity.selectedConnectionTest.hold.v1.paired',
    String(Date.now() + 40_000),
  );
  // Read the stored wait only after the saved test has loaded: the window the guard covers.
  const getItem = jest.mocked(AsyncStorage.getItem).getMockImplementation()!;
  let releaseHold!: () => void;
  const holdRead = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const read = jest
    .spyOn(AsyncStorage, 'getItem')
    .mockImplementation(async (name: string) =>
      name.includes('.hold.') ? holdRead.then(() => getItem(name)) : getItem(name),
    );
  const blocked = jest.fn();
  try {
    render(
      <SelectedConnectionTest disabled={false} onBusy={jest.fn()} onCaptureBlocked={blocked} />,
    );
    await waitFor(() => expect(read).toHaveBeenCalledWith(key));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(blocked).not.toHaveBeenCalledWith(false);
    releaseHold();
    await screen.findByText(/still finishing the previous test · ready in \d+ s/);
  } finally {
    read.mockRestore();
  }
  // The run itself is gone, but the long test must never have been released.
  expect(blocked).not.toHaveBeenCalledWith(false);
  expect(screen.getByRole('button', { name: 'Start quick test' })).toBeDisabled();
});
