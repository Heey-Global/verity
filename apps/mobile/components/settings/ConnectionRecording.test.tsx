jest.mock('./SelectedConnectionTest', () => ({
  SelectedConnectionTest: ({
    disabled,
    onBusy,
    visible,
    onCaptureBlocked,
  }: {
    disabled: boolean;
    onCaptureBlocked?: (blocked: boolean) => void;
    visible?: boolean;
    onBusy: (busy: boolean) => void;
  }) => {
    require('react').useEffect(() => onCaptureBlocked?.(false), [onCaptureBlocked]);
    const { Pressable, Text } = require('react-native');
    if (visible === false) return null;
    return (
      <Pressable disabled={disabled} onPress={() => onBusy(true)}>
        <Text>Mock selected start</Text>
      </Pressable>
    );
  },
}));
import {
  act,
  fireEvent,
  render as testingRender,
  screen,
  waitFor,
} from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
const runId = '11111111-1111-4111-8111-111111111111';
const mockStart = jest.fn();
const mockStop = jest.fn();
const mockRemaining = jest.fn();
const mockExport = jest.fn();
const mockCopy = jest.fn();
const mockDigest = jest.fn(async () => 'abcdef0123456789');
let mockServerId = 'paired-core';
let mockAdministration: ReturnType<typeof client>;
const mockVerifyAdministration = jest.fn();
const mockNativeInactive = jest.fn(async () => undefined);
jest.mock('../../lib/selectedRecordingContext', () => ({
  selectedRecordingContext: () => ({
    verify: () => mockVerifyAdministration(),
    client: mockAdministration,
  }),
  assertNativeTunnelInactive: () => mockNativeInactive(),
}));
jest.mock('expo-crypto', () => ({
  randomUUID: () => '11111111-1111-4111-8111-111111111111',
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  digestStringAsync: () => mockDigest(),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: (...args: unknown[]) => mockCopy(...args) }));
jest.mock('../../lib/serverProfile', () => ({
  getServerProfile: () => ({ serverId: mockServerId }),
}));
jest.mock('../../lib/remoteControlTransport', () => ({
  startRemoteDataRecording: async (hook?: (session: string) => Promise<void>) => {
    const duration = await mockStart();
    if (hook) await hook('selected-session');
    if (mockStop.mock.calls.length) throw new Error('Recording stopped');
    return duration;
  },
  stopRemoteDataRecording: () => mockStop(),
  remoteDataRecordingRemainingMs: () => mockRemaining(),
}));
jest.mock('../../lib/remoteDataDiagnostics', () => ({
  exportRemoteDataDiagnostics: () => mockExport(),
  validateStoredRemoteRecording: (value: string) => value,
  selectRemoteRecording: (value: string) => value,
}));
import { ConnectionRecording } from './ConnectionRecording';
import { Alert } from 'react-native';
import {
  createConnectionDiagnosticReport,
  saveConnectionDiagnosticReport,
} from '../../lib/connectionDiagnosticReport';
function render(element: React.ReactElement) {
  return testingRender(element);
}
function pressCollect() {
  fireEvent.press(
    screen.queryByText('Stop recording') ??
      screen.queryByText('Cancel') ??
      screen.queryByText('Collect again') ??
      screen.getByText('Collect report'),
  );
}
function status() {
  return {
    version: 1,
    evidence: {
      targetSession: 'abcdef0123456789',
      readiness: {
        ready: true,
        installation: { bound: true, active: true },
        app: { bound: true, active: true },
      },
    },
    runId,
    phase: 'recording',
    core: { state: 'recording' },
    uplink: { state: 'recording' },
    error: null,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
}
function client() {
  const api = {
    getConnectionRecording: jest.fn().mockResolvedValue(status()),
    startConnectionRecording: jest.fn().mockResolvedValue(status()),
    stopConnectionRecording: jest
      .fn()
      .mockResolvedValue({ ...status(), core: { state: 'stopped' }, uplink: { state: 'stopped' } }),
    exportConnectionRecording: jest.fn().mockResolvedValue({
      version: 1,
      status: {
        version: 1,
        runId,
        phase: 'stopped',
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 45000).toISOString(),
        installationFingerprint: 'abcdef0123456789',
        core: { state: 'stopped', records: 0, dropped: 0 },
        uplink: { state: 'stopped' },
        error: null,
      },
      core: { records: [], dropped: 0 },
      uplink: {
        available: true,
        data: {
          version: 1,
          runId,
          state: 'stopped',
          expiresAt: new Date(Date.now() + 45000).toISOString(),
          retainedUntil: new Date(Date.now() + 3600000).toISOString(),
          collectorReady: true,
          recordCount: 0,
          droppedRecords: 0,
          records: [],
        },
        error: null,
      },
    }),
  };
  mockAdministration = api;
  return api;
}
beforeEach(async () => {
  mockServerId = 'paired-core';
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockVerifyAdministration.mockReset();
  mockVerifyAdministration.mockResolvedValue('abcdef0123456789');
  mockDigest.mockReset();
  mockDigest.mockResolvedValue('abcdef0123456789');
  mockStart.mockImplementation(async () => {
    mockRemaining.mockResolvedValue(110_000);
    return 120_000;
  });
  mockStop.mockResolvedValue(true);
  mockRemaining.mockResolvedValue(0);
  mockExport.mockResolvedValue({ status: 'ready', recording: '[]' });
  mockCopy.mockResolvedValue(undefined);
});
async function pressStart() {
  await waitFor(() => expect(screen.getByText('Start long test').parent?.parent).toBeTruthy());
  // Wait for the saved run read to settle before pressing its enabled action.
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.press(screen.getByText('Start long test'));
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
  expect(api.startConnectionRecording).toHaveBeenCalledWith(runId, 30000, 3, 'selected-session');
});
it.each(['local', 'core', 'uplink', 'expired'])(
  'does not declare ready after %s failure',
  async (source) => {
    const api = client();
    if (source === 'expired')
      mockStart.mockImplementation(async () => {
        mockRemaining.mockResolvedValue(0);
        return 120000;
      });
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
  api.exportConnectionRecording.mockRejectedValue(new Error('offline'));
  pressCollect();
  await screen.findByText(/Incomplete –/);
  expect(mockStop.mock.invocationCallOrder[0]).toBeLessThan(
    api.stopConnectionRecording.mock.invocationCallOrder[0]!,
  );
  expect(JSON.parse(mockCopy.mock.calls[0]![0] as string).remote.available).toBe(false);
  first.unmount();
  const next = client();
  render(<ConnectionRecording client={next as never} />);
  await screen.findByText(/Recording finished ·/);
  pressCollect();
  await screen.findByText(/Incomplete –/);
  expect(next.stopConnectionRecording).toHaveBeenCalledWith(runId);
  expect(next.exportConnectionRecording).toHaveBeenCalledWith(runId, 3);
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
  pressCollect();
  await screen.findByText(/Incomplete –/);
  expect(api.stopConnectionRecording).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve(status());
  });
  expect(screen.queryByText(/Ready — turn off VPN/)).toBeNull();
  expect(api.stopConnectionRecording).toHaveBeenCalledTimes(2);
  expect(api.stopConnectionRecording).toHaveBeenLastCalledWith(runId);
});

it.each(['stop', 'switch', 'expiry'] as const)(
  'does not restore Ready after %s during final persistence',
  async (action) => {
    if (action === 'expiry') jest.useFakeTimers();
    const api = client();
    const view = render(<ConnectionRecording client={api as never} />);
    let release!: () => void;
    let pending = false;
    let writes = 0;
    const write = jest.mocked(AsyncStorage.setItem).getMockImplementation()!;
    const spy = jest.spyOn(AsyncStorage, 'setItem').mockImplementation(async (key, value) => {
      if (++writes === 3) {
        pending = true;
        await new Promise<void>((done) => {
          release = done;
        });
      }
      return write(key, value);
    });
    try {
      await pressStart();
      await waitFor(() => expect(pending).toBe(true));
      if (action === 'stop') {
        pressCollect();
        await waitFor(() => expect(mockStop).toHaveBeenCalled());
      } else if (action === 'switch') {
        mockServerId = 'other-core';
        view.rerender(<ConnectionRecording client={client() as never} />);
        await act(async () => {
          await Promise.resolve();
        });
      }
      if (action === 'expiry') {
        await act(async () => {
          jest.advanceTimersByTime(31_000);
        });
      }
      await act(async () => {
        release();
      });
      expect(screen.queryByText(/Ready — turn off VPN/)).toBeNull();
    } finally {
      spy.mockImplementation(write);
      if (action === 'expiry') jest.useRealTimers();
    }
  },
);

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
  pressCollect();
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
      screen.getByText('Recording time is up. Turn VPN back on, then collect the report.'),
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
    expect(screen.getByText(/Your Uplink does not support this test yet/)).toBeTruthy(),
  );
  expect(mockStop).toHaveBeenCalled();
});

it.each([1, 2])('collects saved runs using version %s', async (version) => {
  await AsyncStorage.setItem(
    'verity.connectionRecording.v1.paired-core',
    JSON.stringify({
      runId,
      startedAt: Date.now(),
      expiresAt: Date.now() + 120000,
      local: null,
      ...(version === 2 ? { diagnosticsVersion: 2 } : {}),
    }),
  );
  const api = client();
  render(<ConnectionRecording client={api as never} />);
  await screen.findByText(/Recording finished ·/);
  pressCollect();
  await waitFor(() => expect(api.exportConnectionRecording).toHaveBeenCalledWith(runId, version));
});

it.each(['capacity', 'missing binding', 'wrong session', 'offline'])(
  'rejects stale start readiness when fresh status reports %s',
  async (reason) => {
    const api = client();
    const fresh = status();
    if (reason === 'capacity') fresh.phase = 'stopped';
    if (reason === 'missing binding') fresh.evidence.readiness.app.bound = false;
    if (reason === 'wrong session') fresh.evidence.targetSession = '0000000000000000';
    api.getConnectionRecording.mockResolvedValue(fresh);
    if (reason === 'offline') api.getConnectionRecording.mockRejectedValue(new Error('offline'));
    render(<ConnectionRecording client={api as never} />);
    await act(async () => {
      await Promise.resolve();
    });
    mockRemaining.mockResolvedValue(110000);
    await pressStart();
    await screen.findByText(/Preparation failed/);
    expect(screen.queryByText(/Ready — turn off VPN/)).toBeNull();
  },
);
it('withdraws readiness on unreachable polling while preserving local recording', async () => {
  jest.useFakeTimers();
  try {
    const api = client();
    render(<ConnectionRecording client={api as never} />);
    await act(async () => {
      await Promise.resolve();
    });
    mockRemaining.mockResolvedValue(110000);
    await pressStart();
    await screen.findByText(/Ready — turn off VPN/);
    api.getConnectionRecording.mockRejectedValue(new Error('offline'));
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/cannot be reached right now/)).toBeTruthy();
    expect(mockStop).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it('bounds unreachable readiness requests without overlapping polls', async () => {
  jest.useFakeTimers();
  try {
    const api = client();
    render(<ConnectionRecording client={api as never} />);
    await act(async () => {
      await Promise.resolve();
    });
    await pressStart();
    await screen.findByText(/Ready — turn off VPN/);
    api.getConnectionRecording.mockImplementation(
      (_id: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const before = api.getConnectionRecording.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(api.getConnectionRecording.mock.calls.length).toBe(before + 1);
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/cannot be reached right now/)).toBeTruthy();
    expect(mockStop).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it('does not restore Ready when a polling response crosses the local deadline', async () => {
  jest.useFakeTimers();
  try {
    const api = client();
    render(<ConnectionRecording client={api as never} />);
    await act(async () => {
      await Promise.resolve();
    });
    await pressStart();
    await screen.findByText(/Ready — turn off VPN/);
    let resolve!: (value: ReturnType<typeof status>) => void;
    api.getConnectionRecording.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      jest.advanceTimersByTime(29_000);
    });
    expect(resolve).toBeDefined();
    await act(async () => {
      jest.advanceTimersByTime(2_000);
      resolve(status());
    });
    expect(screen.queryByText(/Ready — turn off VPN/)).toBeNull();
    expect(mockStop).toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it('does not overwrite a saved problem recording with another start', async () => {
  const api = client();
  render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  expect(screen.queryByText('Start long test')).toBeNull();
  const stored = await AsyncStorage.getItem('verity.connectionRecording.v1.paired-core');
  expect(JSON.parse(stored!).runId).toBe(runId);
  expect(mockStart).toHaveBeenCalledTimes(1);
});

it('preserves the failed preparation stage across reopening without exporting raw errors', async () => {
  const api = client();
  api.startConnectionRecording.mockRejectedValue(new Error('private token and URL'));
  const view = render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await screen.findByText(/Preparation failed/);
  view.unmount();
  render(<ConnectionRecording client={api as never} />);
  await screen.findByText('Preparation failed');
  pressCollect();
  await waitFor(() => expect(mockCopy).toHaveBeenCalled());
  const report = JSON.parse(mockCopy.mock.calls[0]![0] as string);
  expect(report.preparation).toEqual({ stage: 'remote-start', failed: true });
  expect(JSON.stringify(report)).not.toContain('private token');
});

it('confirms Stop from retained terminal evidence when stop acknowledgement fails', async () => {
  const api = client();
  render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  api.stopConnectionRecording.mockRejectedValue(new Error('response lost'));
  pressCollect();
  await waitFor(() => expect(mockCopy).toHaveBeenCalled());
  const report = JSON.parse(mockCopy.mock.calls[0]![0] as string);
  expect(api.exportConnectionRecording).toHaveBeenCalledWith(runId, 3);
  expect(report.remote.available).toBe(true);
  expect(report.remote.stopped).toBe(true);
  mockRemaining.mockResolvedValue(0);
  fireEvent.press(screen.getByText('Start new long test'));
  await screen.findByText('Start long test');
});

it('exports only the HTTP status from a failed preparation response', async () => {
  const api = client();
  api.startConnectionRecording.mockRejectedValue(
    Object.assign(new Error('secret response'), { status: 403 }),
  );
  render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await screen.findByText(/HTTP 403/);
  pressCollect();
  await waitFor(() => expect(mockCopy).toHaveBeenCalled());
  const report = JSON.parse(mockCopy.mock.calls[0]![0] as string);
  expect(report.preparation).toEqual({ stage: 'remote-start', failed: true, httpStatus: 403 });
  expect(mockCopy.mock.calls[0]![0]).not.toContain('secret response');
});

it('retains completed preparation after reopening', async () => {
  const api = client();
  const view = render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  view.unmount();
  render(<ConnectionRecording client={api as never} />);
  await screen.findByText(/Recording finished ·/);
  pressCollect();
  await waitFor(() => expect(mockCopy).toHaveBeenCalled());
  expect(JSON.parse(mockCopy.mock.calls[0]![0] as string).preparation).toEqual({
    stage: 'ready',
    failed: false,
  });
});

it('prevents legacy recording while the selected test owns the controls', async () => {
  render(<ConnectionRecording client={client() as never} />);
  await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
  await screen.findByText('Mock selected start');
  await waitFor(() => expect(screen.getByText('Start long test')).toBeEnabled());
  act(() => {
    fireEvent.press(screen.getByText('Mock selected start'));
  });
  // While the quick test owns the native capture, the long test cannot start.
  expect(screen.getByText('Finish the quick test first.')).toBeTruthy();
  expect(screen.getByText('Start long test')).toBeDisabled();
  fireEvent.press(screen.getByText('Start long test'));
  await act(async () => {
    await Promise.resolve();
  });
  expect(mockStart).not.toHaveBeenCalled();
});

it('lists both tests with their own start action and starts neither on opening', async () => {
  testingRender(<ConnectionRecording client={client() as never} />);
  await screen.findByText('Mock selected start');
  await waitFor(() => expect(screen.getByText('Start long test')).toBeEnabled());
  expect(screen.getByText('Long test with VPN switch-off')).toBeTruthy();
  expect(screen.queryByText('Stop recording')).toBeNull();
  expect(mockStart).not.toHaveBeenCalled();
});

it('presents an unfinished old long test with its date and a way to finish or discard it', async () => {
  const oldId = '22222222-2222-4222-8222-222222222222';
  await AsyncStorage.setItem(
    'verity.connectionRecording.v1.paired-core',
    JSON.stringify({
      runId: oldId,
      // Local noon, so the rendered local date is 1 Oct in every timezone.
      startedAt: new Date(2025, 9, 1, 12).getTime(),
      expiresAt: new Date(2025, 9, 1, 12, 0, 45).getTime(),
      local: null,
    }),
  );
  testingRender(<ConnectionRecording client={client() as never} />);
  await screen.findByText(/Recording finished · 1 Oct 2025/);
  expect(screen.getByText('Collect report')).toBeTruthy();
  expect(screen.getByText('Discard and start over')).toBeTruthy();
  expect(screen.queryByText('Start long test')).toBeNull();
  // The quick test explains why it waits instead of silently greying out.
  expect(screen.getByText('Mock selected start')).toBeDisabled();
  expect(mockStart).not.toHaveBeenCalled();
});

it('does not restore the old profile run after its session digest resolves late', async () => {
  const api = client();
  let release!: (value: string) => void;
  mockDigest.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const view = render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await waitFor(() => expect(release).toBeDefined());
  mockServerId = 'other-core';
  view.rerender(<ConnectionRecording client={client() as never} />);
  await act(async () => {
    release('abcdef0123456789');
  });
  await screen.findByText('Start long test');
  expect(screen.queryByText(`Problem recording · ${runId.slice(0, 8)}`)).toBeNull();
  expect(await AsyncStorage.getItem('verity.connectionRecording.v1.other-core')).toBeNull();
  expect(api.startConnectionRecording).not.toHaveBeenCalled();
});

it('locks the transition to another problem recording until the old reference is removed', async () => {
  const api = client();
  render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  pressCollect();
  await screen.findByText('Start new long test');
  const original = jest.mocked(AsyncStorage.removeItem).getMockImplementation()!;
  let release!: () => void;
  const spy = jest.spyOn(AsyncStorage, 'removeItem').mockImplementation(async (key) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return original(key);
  });
  try {
    const button = screen.getByText('Start new long test');
    act(() => {
      fireEvent.press(button);
      fireEvent.press(button);
    });
    await waitFor(() => expect(release).toBeDefined());
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await screen.findByText('Start long test');
    expect(await AsyncStorage.getItem('verity.connectionRecording.v1.paired-core')).toBeNull();
  } finally {
    spy.mockImplementation(original);
  }
});

it('copies local evidence without opening an administration fallback when direct verification fails', async () => {
  const api = client();
  render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  mockVerifyAdministration.mockRejectedValue(new Error('direct unavailable'));
  pressCollect();
  await waitFor(() => expect(mockCopy).toHaveBeenCalled());
  expect(mockStop).toHaveBeenCalled();
  expect(api.stopConnectionRecording).not.toHaveBeenCalled();
  expect(api.exportConnectionRecording).not.toHaveBeenCalled();
  const report = JSON.parse(mockCopy.mock.calls[0]![0] as string);
  expect(report.remote.available).toBe(false);
  expect(report.complete).toBe(false);
});

it('does not block future problem recordings forever when the verified Core has no retained run', async () => {
  const api = client();
  render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  api.exportConnectionRecording.mockRejectedValue(
    Object.assign(new Error('not retained'), { status: 404 }),
  );
  api.stopConnectionRecording.mockRejectedValue(
    Object.assign(new Error('not retained'), { status: 404 }),
  );
  pressCollect();
  await screen.findByText(/Your Core no longer has data for this test/);
  mockRemaining.mockResolvedValue(0);
  fireEvent.press(screen.getByText('Start new long test'));
  await screen.findByText('Start long test');
  expect(await AsyncStorage.getItem('verity.connectionRecording.v1.paired-core')).toBeNull();
});

it('blocks quick capture until an ended problem recording is collected', async () => {
  render(<ConnectionRecording client={client() as never} />);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  mockRemaining.mockResolvedValue(0);
  await screen.findByText(/Recording time is up/, {}, { timeout: 3000 });
  expect(screen.getByText('Mock selected start')).toBeDisabled();
  pressCollect();
  await screen.findByText('Start new long test');
  expect(screen.getByText('Mock selected start')).toBeEnabled();
});
it('keeps an archived problem restart available after deleting an unrelated report', async () => {
  const otherId = '22222222-2222-4222-8222-222222222222';
  await saveConnectionDiagnosticReport(
    'paired-core',
    createConnectionDiagnosticReport({
      runId: otherId,
      startedAt: null,
      testType: 'quick_test',
      outcome: 'unknown',
      local: null,
      localStopped: true,
      remote: null,
      remoteStopped: false,
    }),
  );
  render(<ConnectionRecording client={client() as never} />);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  pressCollect();
  await screen.findByText('Start new long test');
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    fireEvent.press(screen.getByText('Quick test · Earlier test'));
    fireEvent.press(screen.getByText('Delete'));
    await act(async () =>
      alert.mock.calls[0]![2]!.find((button) => button.text === 'Delete')!.onPress!(),
    );
    await waitFor(() => expect(screen.queryByText('Quick test · Earlier test')).toBeNull());
    expect(screen.getByText('Start new long test')).toBeTruthy();
  } finally {
    alert.mockRestore();
  }
});

it('does not release quick capture after a partial problem report with unconfirmed Stop', async () => {
  const api = client();
  render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  api.stopConnectionRecording.mockRejectedValue(new Error('offline'));
  api.exportConnectionRecording.mockRejectedValue(new Error('offline'));
  pressCollect();
  await screen.findByText('Not confirmed as stopped');
  expect(screen.queryByText('Start new long test')).toBeNull();
  expect(screen.getByText('Mock selected start')).toBeDisabled();
});

it('copies the retained merged problem report when later remote collection fails', async () => {
  const api = client();
  render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  pressCollect();
  await waitFor(() => expect(mockCopy).toHaveBeenCalledTimes(1));
  const previous = JSON.parse(mockCopy.mock.calls[0]![0] as string);
  api.stopConnectionRecording.mockRejectedValue(new Error('unavailable'));
  api.exportConnectionRecording.mockRejectedValue(new Error('unavailable'));
  pressCollect();
  await waitFor(() => expect(mockCopy).toHaveBeenCalledTimes(2));
  const report = JSON.parse(mockCopy.mock.calls[1]![0] as string);
  expect(report.remote).toEqual(previous.remote);
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
it('discards a stuck long test only after a confirmed local Stop and keeps saved reports', async () => {
  const storageKey = 'verity.connectionRecording.v1.paired-core';
  const api = client();
  const view = render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  api.stopConnectionRecording.mockRejectedValue(new Error('offline'));
  api.exportConnectionRecording.mockRejectedValue(new Error('offline'));
  pressCollect();
  await screen.findByText('Not confirmed as stopped');
  // Without a confirmed local Stop the run, and its evidence, stays.
  mockStop.mockResolvedValueOnce(false);
  await confirmDiscard();
  await screen.findByText(/could not confirm that this device stopped recording/);
  expect(await AsyncStorage.getItem(storageKey)).not.toBeNull();
  await confirmDiscard();
  await waitFor(() => expect(AsyncStorage.getItem(storageKey)).resolves.toBeNull());
  expect(screen.getByText(/^Long test · Today/)).toBeTruthy();
  // Core and Uplink never confirmed Stop: they may still record the discarded run,
  // so neither test may start on top of it until that run has expired.
  expect(
    screen.getAllByText(/still finishing the previous test · ready in \d+ s/),
  ).not.toHaveLength(0);
  expect(screen.getByText('Mock selected start')).toBeDisabled();
  expect(screen.getByText('Start long test')).toBeDisabled();
  // Reopening Diagnostics must not skip the wait.
  view.unmount();
  render(<ConnectionRecording client={api as never} />);
  await screen.findByText(/still finishing the previous test · ready in \d+ s/);
  expect(screen.getByText('Start long test')).toBeDisabled();
});
it('releases both tests at once when Core and Uplink confirm Stop while discarding', async () => {
  const api = client();
  render(<ConnectionRecording client={api as never} />);
  await pressStart();
  await screen.findByText(/Ready — turn off VPN/);
  const stopped = api.stopConnectionRecording.getMockImplementation();
  api.stopConnectionRecording.mockRejectedValue(new Error('offline'));
  api.exportConnectionRecording.mockRejectedValue(new Error('offline'));
  pressCollect();
  await screen.findByText('Not confirmed as stopped');
  api.stopConnectionRecording.mockImplementation(stopped!);
  await confirmDiscard();
  await waitFor(() => expect(screen.getByText('Start long test')).toBeEnabled());
  expect(screen.queryByText(/still finishing the previous test/)).toBeNull();
  expect(screen.getByText('Mock selected start')).toBeEnabled();
});

it('stays idle without a saved long test even while a native capture is reported', async () => {
  // A quick test's native capture must never read as a running long test.
  mockRemaining.mockResolvedValue(25_000);
  const api = client();
  testingRender(<ConnectionRecording client={api as never} />);
  await waitFor(() => expect(screen.getByText('Start long test')).toBeEnabled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });
  // No saved long test: the poll must not even read the native capture.
  expect(mockRemaining).not.toHaveBeenCalled();
  expect(screen.queryByText(/^Recording/)).toBeNull();
  expect(screen.queryByText('Stop recording')).toBeNull();
  expect(screen.getByText('Mock selected start')).toBeEnabled();
  expect(api.getConnectionRecording).not.toHaveBeenCalled();
  expect(mockStop).not.toHaveBeenCalled();
});

it('lets a device without the native tunnel discard a long test whose preparation failed', async () => {
  const storageKey = 'verity.connectionRecording.v1.paired-core';
  await AsyncStorage.setItem(
    storageKey,
    JSON.stringify({
      runId,
      startedAt: new Date(2025, 9, 1, 12).getTime(),
      expiresAt: new Date(2025, 9, 1, 12, 0, 45).getTime(),
      local: null,
      preparation: { stage: 'local-and-admission', failed: true },
    }),
  );
  // Without the native module, local Stop can never be confirmed.
  mockStop.mockResolvedValue(false);
  mockNativeInactive.mockRejectedValueOnce(new Error('Native connection test unsupported.'));
  testingRender(<ConnectionRecording client={client() as never} />);
  await screen.findByText('Preparation failed');
  await confirmDiscard();
  await waitFor(() => expect(AsyncStorage.getItem(storageKey)).resolves.toBeNull());
  await waitFor(() => expect(screen.getByText('Start long test')).toBeEnabled());
});
