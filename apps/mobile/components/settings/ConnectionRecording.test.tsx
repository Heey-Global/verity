jest.mock('./SelectedConnectionTest', () => ({
  SelectedConnectionTest: ({
    disabled,
    onBusy,
    visible,
  }: {
    disabled: boolean;
    visible?: boolean;
    onBusy: (busy: boolean) => void;
  }) => {
    const { Pressable, Text } = require('react-native');
    if (!visible) return null;
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
jest.mock('../../lib/selectedRecordingContext', () => ({
  selectedRecordingContext: () => ({
    verify: () => mockVerifyAdministration(),
    client: mockAdministration,
  }),
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
function render(element: React.ReactElement) {
  const result = testingRender(element);
  fireEvent.press(screen.getByText('Record a connection problem'));
  return result;
}
function pressCollect() {
  fireEvent.press(
    screen.queryByText('Stop and collect') ?? screen.getByText('Collect problem report'),
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
  await waitFor(() =>
    expect(screen.getByText('Start problem recording').parent?.parent).toBeTruthy(),
  );
  // Wait for the saved run read to settle before pressing its enabled action.
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.press(screen.getByText('Start problem recording'));
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
  await screen.findByText(/Partial report copied/);
  expect(mockStop.mock.invocationCallOrder[0]).toBeLessThan(
    api.stopConnectionRecording.mock.invocationCallOrder[0]!,
  );
  expect(JSON.parse(mockCopy.mock.calls[0]![0] as string).remote.available).toBe(false);
  first.unmount();
  const next = client();
  render(<ConnectionRecording client={next as never} />);
  await screen.findByText(/Saved problem recording ·/);
  pressCollect();
  await screen.findByText(/Partial report copied/);
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
  await screen.findByText(/Partial report copied/);
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
  await screen.findByText(/Saved problem recording ·/);
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
    expect(screen.getByText(/Recording readiness is unconfirmed/)).toBeTruthy();
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
    expect(screen.getByText(/Recording readiness is unconfirmed/)).toBeTruthy();
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
  expect(screen.queryByText('Start problem recording')).toBeNull();
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
  await screen.findByText(/Saved problem recording ·/);
  pressCollect();
  await waitFor(() => expect(mockCopy).toHaveBeenCalled());
  const report = JSON.parse(mockCopy.mock.calls[0]![0] as string);
  expect(report.preparation).toEqual({ stage: 'remote-start', failed: true });
  expect(JSON.stringify(report)).not.toContain('private token');
});

it('retrieves retained remote evidence even when stop acknowledgement fails', async () => {
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
  expect(report.remote.stopped).toBe(false);
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
  await screen.findByText(/Saved problem recording ·/);
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
  fireEvent.press(screen.getByText('Quick connection test'));
  await screen.findByText('Mock selected start');
  act(() => {
    fireEvent.press(screen.getByText('Mock selected start'));
    fireEvent.press(screen.getByText('Record a connection problem'));
  });
  expect(mockStart).not.toHaveBeenCalled();
});

it('shows a test choice before actions and never mixes the quick and problem controls', async () => {
  testingRender(<ConnectionRecording client={client() as never} />);
  await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
  expect(screen.queryByText('Start problem recording')).toBeNull();
  expect(screen.queryByText('Mock selected start')).toBeNull();
  expect(screen.queryByText('Stop and collect')).toBeNull();
  fireEvent.press(screen.getByText('Quick connection test'));
  await screen.findByText('Mock selected start');
  expect(screen.queryByText('Start problem recording')).toBeNull();
  fireEvent.press(screen.getByText('Record a connection problem'));
  await screen.findByText('Start problem recording');
  expect(screen.queryByText('Mock selected start')).toBeNull();
  expect(mockStart).not.toHaveBeenCalled();
});

it('labels an old problem recording by date and identity instead of presenting it as the quick test', async () => {
  const oldId = '22222222-2222-4222-8222-222222222222';
  await AsyncStorage.setItem(
    'verity.connectionRecording.v1.paired-core',
    JSON.stringify({
      runId: oldId,
      startedAt: Date.parse('2025-10-01T12:00:00.000Z'),
      expiresAt: Date.parse('2025-10-01T12:00:45.000Z'),
      local: null,
      preparation: { stage: 'remote-start', failed: true },
    }),
  );
  testingRender(<ConnectionRecording client={client() as never} />);
  fireEvent.press(screen.getByText('Quick connection test'));
  await screen.findByText('Mock selected start');
  expect(screen.queryByText('Collect problem report')).toBeNull();
  fireEvent.press(screen.getByText('Record a connection problem'));
  await screen.findByText('Problem recording · 22222222');
  expect(screen.getByText(/Saved problem recording · 2025-10-01T12:00:00.000Z/)).toBeTruthy();
  expect(screen.getByText('Collect problem report')).toBeTruthy();
  expect(screen.queryByText('Start problem recording')).toBeNull();
  expect(screen.queryByText('Mock selected start')).toBeNull();
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
  await screen.findByText('Start problem recording');
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
  await screen.findByText('Start another problem recording');
  const original = jest.mocked(AsyncStorage.removeItem).getMockImplementation()!;
  let release!: () => void;
  const spy = jest.spyOn(AsyncStorage, 'removeItem').mockImplementation(async (key) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return original(key);
  });
  try {
    const button = screen.getByText('Start another problem recording');
    act(() => {
      fireEvent.press(button);
      fireEvent.press(button);
    });
    await waitFor(() => expect(release).toBeDefined());
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await screen.findByText('Start problem recording');
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
  await screen.findByText(/Core has no retained report for this run/);
  mockRemaining.mockResolvedValue(0);
  fireEvent.press(screen.getByText('Start another problem recording'));
  await screen.findByText('Start problem recording');
  expect(await AsyncStorage.getItem('verity.connectionRecording.v1.paired-core')).toBeNull();
});
