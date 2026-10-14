import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
const runId = '11111111-1111-4111-8111-111111111111';
const mockStart = jest.fn();
const mockStop = jest.fn();
const mockRemaining = jest.fn();
const mockExport = jest.fn();
const mockCopy = jest.fn();
let mockServerId = 'paired-core';
jest.mock('expo-crypto', () => ({ randomUUID: () => '11111111-1111-4111-8111-111111111111' }));
jest.mock('expo-clipboard', () => ({ setStringAsync: (...args: unknown[]) => mockCopy(...args) }));
jest.mock('../../lib/serverProfile', () => ({
  getServerProfile: () => ({ serverId: mockServerId }),
}));
jest.mock('../../lib/remoteControlTransport', () => ({
  startRemoteDataRecording: () => mockStart(),
  stopRemoteDataRecording: () => mockStop(),
  remoteDataRecordingRemainingMs: () => mockRemaining(),
}));
jest.mock('../../lib/remoteDataDiagnostics', () => ({
  exportRemoteDataDiagnostics: () => mockExport(),
  validateStoredRemoteRecording: (value: string) => value,
  selectRemoteRecording: (value: string) => value,
}));
import { ConnectionRecording } from './ConnectionRecording';
function status() {
  return {
    version: 1,
    runId,
    phase: 'recording',
    core: { state: 'recording' },
    uplink: { state: 'recording' },
    error: null,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
}
function client() {
  return {
    startConnectionRecording: jest.fn().mockResolvedValue(status()),
    stopConnectionRecording: jest
      .fn()
      .mockResolvedValue({ ...status(), core: { state: 'stopped' }, uplink: { state: 'stopped' } }),
    exportConnectionRecording: jest.fn().mockResolvedValue({
      version: 1,
      status: status(),
      core: { records: [] },
      uplink: { available: true },
    }),
  };
}
beforeEach(async () => {
  mockServerId = 'paired-core';
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockStart.mockResolvedValue(120_000);
  mockStop.mockResolvedValue(true);
  mockRemaining.mockResolvedValue(0);
  mockExport.mockResolvedValue({ status: 'ready', recording: '[]' });
  mockCopy.mockResolvedValue(undefined);
});
async function pressStart() {
  await waitFor(() => expect(screen.getByText('Record connection').parent?.parent).toBeTruthy());
  // Wait for the saved run read to settle before pressing its enabled action.
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.press(screen.getByText('Record connection'));
}
it('does not start on opening, then arms local before Core and declares ready only with every source', async () => {
  const api = client();
  render(<ConnectionRecording client={api as never} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(mockStart).not.toHaveBeenCalled();
  expect(api.startConnectionRecording).not.toHaveBeenCalled();
  mockRemaining.mockResolvedValue(110_000);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  expect(mockStart.mock.invocationCallOrder[0]).toBeLessThan(
    api.startConnectionRecording.mock.invocationCallOrder[0]!,
  );
  expect(api.startConnectionRecording).toHaveBeenCalledWith(runId, expect.any(Number), 2);
});
it.each(['local', 'core', 'uplink', 'expired'])(
  'does not declare ready after %s failure',
  async (source) => {
    const api = client();
    if (source === 'local') mockStart.mockRejectedValue(new Error('unsupported'));
    if (source === 'core') api.startConnectionRecording.mockRejectedValue(new Error('offline'));
    if (source === 'uplink')
      api.startConnectionRecording.mockResolvedValue({
        ...status(),
        phase: 'failed',
        uplink: { state: 'unavailable' },
      });
    render(<ConnectionRecording client={api as never} />);
    await pressStart();
    await screen.findByText(/Preparation failed/);
    expect(screen.queryByText(/Ready — turn off VPN/)).toBeNull();
    expect(mockStop).toHaveBeenCalled();
  },
);
it('stops locally offline, retains run across reopening and retries collection with VPN', async () => {
  const api = client();
  const first = render(<ConnectionRecording client={api as never} />);
  await act(async () => {
    await Promise.resolve();
  });
  mockRemaining.mockResolvedValue(110_000);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  api.stopConnectionRecording.mockRejectedValue(new Error('offline'));
  fireEvent.press(screen.getByText('Stop and collect'));
  await screen.findByText(/Partial recording copied/);
  expect(mockStop.mock.invocationCallOrder[0]).toBeLessThan(
    api.stopConnectionRecording.mock.invocationCallOrder[0]!,
  );
  expect(JSON.parse(mockCopy.mock.calls[0]![0] as string).remote.available).toBe(false);
  first.unmount();
  const next = client();
  render(<ConnectionRecording client={next as never} />);
  await screen.findByText(/Saved run available/);
  fireEvent.press(screen.getByText('Stop and collect'));
  await screen.findByText('App, Core and Uplink recording copied.');
  expect(next.stopConnectionRecording).toHaveBeenCalledWith(runId);
  expect(next.exportConnectionRecording).toHaveBeenCalledWith(runId, 2);
  expect(mockStart).toHaveBeenCalledTimes(1);
});
it('a late Core start cannot restore ready after Stop', async () => {
  const api = client();
  let resolve!: (value: ReturnType<typeof status>) => void;
  api.startConnectionRecording.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await waitFor(() => expect(api.startConnectionRecording).toHaveBeenCalled());
  fireEvent.press(screen.getByText('Stop and collect'));
  await waitFor(() => expect(mockStop).toHaveBeenCalled());
  await act(async () => {
    resolve(status());
  });
  expect(screen.queryByText(/Ready — turn off VPN/)).toBeNull();
  expect(api.stopConnectionRecording).toHaveBeenCalledWith(runId);
});

it('discards a collection result after switching paired servers', async () => {
  const api = client();
  const view = render(<ConnectionRecording client={api as never} />);
  await act(async () => {
    await Promise.resolve();
  });
  mockRemaining.mockResolvedValue(110_000);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  let resolve!: (value: ReturnType<typeof status>) => void;
  api.stopConnectionRecording.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  fireEvent.press(screen.getByText('Stop and collect'));
  await waitFor(() => expect(api.stopConnectionRecording).toHaveBeenCalled());
  mockServerId = 'other-core';
  view.rerender(<ConnectionRecording client={client() as never} />);
  await act(async () => {
    resolve(status());
  });
  expect(mockCopy).not.toHaveBeenCalled();
  expect(screen.queryByText(/Ready — turn off VPN/)).toBeNull();
  expect(screen.queryByText(`Run ${runId}`)).toBeNull();
});
it('removes Ready when the local capture expires', async () => {
  jest.useFakeTimers();
  try {
    render(<ConnectionRecording client={client() as never} />);
    await act(async () => {
      await Promise.resolve();
    });
    mockRemaining.mockResolvedValue(110_000);
    await pressStart();
    await screen.findByText(/Ready — turn off VPN/);
    mockRemaining.mockResolvedValue(0);
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    expect(screen.queryByText(/Ready — turn off VPN/)).toBeNull();
    expect(
      screen.getByText('Local recording ended. Stop and collect the saved evidence.'),
    ).toBeOnTheScreen();
  } finally {
    jest.useRealTimers();
  }
});

it('explains missing version support before another recording attempt', async () => {
  const api = client();
  api.startConnectionRecording.mockRejectedValue(new Error('diagnostics_version_unavailable'));
  render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await waitFor(() =>
    expect(screen.getByText(/Uplink does not support this recording version/)).toBeTruthy(),
  );
  expect(mockStop).toHaveBeenCalled();
});

it('collects legacy saved runs using version 1', async () => {
  await AsyncStorage.setItem(
    'verity.connectionRecording.v1.paired-core',
    JSON.stringify({ runId, startedAt: Date.now(), expiresAt: Date.now() + 120000, local: null }),
  );
  const api = client();
  render(<ConnectionRecording client={api as never} />);
  await screen.findByText(/Saved run available/);
  fireEvent.press(screen.getByText('Stop and collect'));
  await waitFor(() => expect(api.exportConnectionRecording).toHaveBeenCalledWith(runId, 1));
});
