const mockStart = jest.fn();
const mockCapture = jest.fn();
const mockRemaining = jest.fn();
const mockDisable = jest.fn();
const mockDiagnosticExport = jest.fn();
let mockCaptureSupported = false;
const mockStop = jest.fn();
const mockActive = jest.fn();
const mockRequest = jest.fn();
const mockCancel = jest.fn();
const mockFetch = jest.fn();
const mockArm = jest.fn();
const mockAdmission = jest.fn();
const mockFinish = jest.fn();
const mockAdmissionCancel = jest.fn();
jest.mock('expo-modules-core', () => ({
  requireNativeModule: (name: string) =>
    name === 'VerityRemoteControlTunnel'
      ? {
          start: mockStart,
          stop: mockStop,
          isActive: mockActive,
          ...(mockCaptureSupported
            ? {
                captureDataDiagnostics: mockCapture,
                dataDiagnosticsRemainingMs: mockRemaining,
                disableDataDiagnostics: mockDisable,
              }
            : {}),
        }
      : { request: mockRequest, cancelRequest: mockCancel },
  requireOptionalNativeModule: () => ({ exportDataDiagnostics: mockDiagnosticExport }),
}));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_: string, value: string) =>
    require('node:crypto').createHash('sha256').update(value).digest('hex'),
}));
jest.mock('./pinnedTransport', () => ({ createPinnedFetch: () => mockFetch }));
jest.mock('./selectedRecordingArming', () => ({
  createPairedSelectedRecordingArming: () => ({
    runId: '00000000-0000-4000-8000-000000000001',
    installationFingerprint: 'a'.repeat(16),
    arm: mockArm,
  }),
}));
jest.mock('./remoteControlAdmission', () => ({
  requestRemoteControlAdmission: (options: unknown) => mockAdmission(options),
}));
import { createHash } from 'node:crypto';
import { selectedRecordingAttempt } from './selectedRecordingAttempt';
const options = {
  coreUrl: 'https://core.example',
  corePin: 'saved-pin',
  uplinkOrigin: 'https://uplink.example',
  installationHandle: 'selected',
  runId: '00000000-0000-4000-8000-000000000001',
  installationFingerprint: 'a'.repeat(16),
  getToken: () => 'paired-token',
};
const peer = {
  bound: true,
  active: true,
  generation: 'b'.repeat(16),
  socketLifetimeId: '00000000-0000-4000-8000-000000000002',
};
const status = (revision = 0) => ({
  version: 1,
  runId: options.runId,
  phase: revision ? 'recording' : 'starting',
  startedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30000).toISOString(),
  installationFingerprint: options.installationFingerprint,
  core: { state: 'recording', records: 0, dropped: 0 },
  uplink: { state: 'recording' },
  error: null,
  selection: {
    sessionHash: createHash('sha256').update('session').digest('hex').slice(0, 16),
    confirmed: true,
    preparationExpiresAt: new Date(Date.now() + 15000).toISOString(),
    readiness: {
      revision,
      checkedAt: new Date().toISOString(),
      monotonicMs: revision,
      ready: !!revision,
      installation: { ...peer },
      app: { ...peer },
    },
  },
});
const stopped = () => ({
  ...status(3),
  phase: 'stopped',
  core: { state: 'stopped', records: 0, dropped: 0 },
  uplink: { state: 'stopped' },
  selection: {
    ...status(3).selection,
    confirmed: false,
    readiness: { ...status(3).selection.readiness, ready: false },
  },
});
let order: string[];
beforeEach(() => {
  jest.clearAllMocks();
  order = [];
  mockCaptureSupported = false;
  mockRemaining.mockResolvedValue(0);
  mockCapture.mockImplementation(async () => {
    order.push('capture');
    return true;
  });
  mockDisable.mockImplementation(async () => {
    order.push('disable');
  });
  mockDiagnosticExport.mockImplementation(async () => [JSON.stringify(nativeSnapshot())]);
  mockActive.mockResolvedValue(false);
  mockStart.mockImplementation(async () => {
    order.push('data');
    return 1234;
  });
  mockStop.mockImplementation(async () => {
    order.push('stop');
  });
  mockCancel.mockResolvedValue(null);
  mockRequest.mockImplementation(async () => {
    order.push('warmup');
    return { status: 200 };
  });
  mockArm.mockImplementation(async () => {
    order.push('arm');
    return status();
  });
  mockAdmission.mockImplementation(async (input) => {
    await input.diagnosticArming.arm('session', input.signal);
    return {
      sessionId: 'session',
      ticket: 'ticket',
      expiresAt: Date.now() + 15000,
      finish: mockFinish,
      cancel: mockAdmissionCancel,
    };
  });
  let revision = 0;
  mockFetch.mockImplementation(async (_url, init) => {
    order.push(init.method);
    return {
      ok: true,
      json: async () => (init.method === 'DELETE' ? stopped() : status(++revision)),
    };
  });
});
afterEach(() => jest.useRealTimers());
it('attaches only after arming, validates two fresh statuses, warms once and stops', async () => {
  await expect(selectedRecordingAttempt(options)).resolves.toEqual({ status: 200 });
  expect(order.slice(0, 5)).toEqual(['arm', 'data', 'GET', 'GET', 'warmup']);
  expect(order).toContain('DELETE');
  expect(mockStop).toHaveBeenCalled();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockRequest.mock.calls[0].slice(1)).toEqual([
    'https://core.example/healthz',
    'GET',
    {},
    null,
    'saved-pin',
    1234,
  ]);
});
it.each([false, true])(
  'accepts unchanged readiness revision (clock advanced: %s)',
  async (advanced) => {
    let reads = 0;
    mockFetch.mockImplementation(async (_url, init) => {
      const value = status(4);
      value.selection.readiness.monotonicMs = 100 + (advanced ? reads++ : 0);
      return { ok: true, json: async () => (init.method === 'DELETE' ? stopped() : value) };
    });
    await expect(selectedRecordingAttempt(options)).resolves.toEqual({ status: 200 });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  },
);
it('rejects a readiness transition without a revision advance', async () => {
  const prepared = status(4);
  prepared.selection.readiness.ready = false;
  mockArm.mockResolvedValue(prepared);
  mockFetch.mockImplementation(async (_url, init) => ({
    ok: true,
    json: async () => (init.method === 'DELETE' ? stopped() : status(4)),
  }));
  await expect(selectedRecordingAttempt(options)).rejects.toThrow('readiness unavailable');
  expect(mockRequest).not.toHaveBeenCalled();
  expect(mockStop).toHaveBeenCalled();
});
it.each([
  'revision',
  'clock',
  'session',
  'installation',
  'generation',
  'inactive',
  'expired',
  'not-ready',
  'malformed',
])('blocks warmup on %s', async (fault) => {
  let call = 0;
  mockFetch.mockImplementation(async (_url, init) => {
    const s = status(++call);
    if (init.method === 'GET' && call === 2) {
      if (fault === 'clock') s.selection.readiness.monotonicMs = 0;
      if (fault === 'revision') s.selection.readiness.revision = 0;
      if (fault === 'session') s.selection.sessionHash = 'f'.repeat(16);
      if (fault === 'installation') s.installationFingerprint = 'f'.repeat(16);
      if (fault === 'generation') s.selection.readiness.app.generation = 'f'.repeat(16);
      if (fault === 'inactive') s.selection.readiness.app.active = false;
      if (fault === 'expired') s.expiresAt = new Date(0).toISOString();
      if (fault === 'not-ready') s.selection.readiness.ready = false;
      if (fault === 'malformed') return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => (init.method === 'DELETE' ? stopped() : s) };
  });
  await expect(selectedRecordingAttempt(options)).rejects.toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
  expect(mockStop).toHaveBeenCalled();
});
it('preserves an existing tunnel', async () => {
  mockActive.mockResolvedValue(true);
  await expect(selectedRecordingAttempt(options)).rejects.toThrow('Existing DATA');
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockStop).not.toHaveBeenCalled();
});
it('stops a late attachment after abort without warming', async () => {
  const abort = new AbortController();
  let release!: (port: number) => void;
  mockStart.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const attempt = selectedRecordingAttempt({ ...options, signal: abort.signal });
  for (let i = 0; i < 30 && !release; i++) await Promise.resolve();
  expect(release).toBeDefined();
  abort.abort();
  await expect(attempt).rejects.toThrow();
  release(1234);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(mockStop.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(mockRequest).not.toHaveBeenCalled();
});
it('times out a stalled warmup, cancels it and always stops', async () => {
  jest.useFakeTimers();
  mockRequest.mockImplementation(() => new Promise(() => {}));
  const attempt = selectedRecordingAttempt(options);
  const rejected = expect(attempt).rejects.toThrow();
  for (let i = 0; i < 60 && !mockRequest.mock.calls.length; i++) await Promise.resolve();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(5001);
  await rejected;
  expect(mockCancel).toHaveBeenCalled();
  expect(mockStop).toHaveBeenCalled();
});
it('cleans up when readiness fetch fails', async () => {
  mockFetch.mockRejectedValue(new Error('offline'));
  await expect(selectedRecordingAttempt(options)).rejects.toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
  expect(mockStop).toHaveBeenCalled();
});
it('does not admit a second caller while an attempt owns DATA', async () => {
  let release!: (value: boolean) => void;
  mockActive.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = selectedRecordingAttempt(options);
  await expect(selectedRecordingAttempt(options)).rejects.toThrow('already active');
  release(false);
  await first;
});

it('never starts an already cancelled attempt', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    selectedRecordingAttempt({ ...options, signal: controller.signal }),
  ).rejects.toThrow();
  expect(mockAdmission).not.toHaveBeenCalled();
  expect(mockStart).not.toHaveBeenCalled();
});
it('cancels during a pending readiness response and never warms later', async () => {
  const controller = new AbortController();
  let release!: (value: unknown) => void;
  mockFetch.mockImplementation((_url, init) =>
    init.method === 'DELETE'
      ? Promise.resolve({ ok: true, json: async () => stopped() })
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  const attempt = selectedRecordingAttempt({ ...options, signal: controller.signal });
  for (let i = 0; i < 50 && !release; i++) await Promise.resolve();
  expect(release).toBeDefined();
  controller.abort();
  await expect(attempt).rejects.toThrow();
  release({ ok: true, json: async () => status(1) });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(mockRequest).not.toHaveBeenCalled();
});
it('stops consent and DATA after native start failure', async () => {
  mockStart.mockRejectedValue(new Error('attach failed'));
  await expect(selectedRecordingAttempt(options)).rejects.toThrow();
  expect(mockStop).toHaveBeenCalled();
  expect(mockFetch.mock.calls.some((call) => call[1].method === 'DELETE')).toBe(true);
  expect(mockRequest).not.toHaveBeenCalled();
});
it('reports cleanup failure rather than returning a successful attempt', async () => {
  mockStop.mockRejectedValue(new Error('stop failed'));
  const onResponse = jest.fn();
  await expect(selectedRecordingAttempt({ ...options, onResponse })).rejects.toThrow(
    'cleanup failed',
  );
  expect(onResponse).toHaveBeenCalledWith(200);
});
it('does not retry a failed warmup', async () => {
  mockRequest.mockResolvedValue({ status: 503 });
  await expect(selectedRecordingAttempt(options)).rejects.toThrow('warmup failed');
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockStop).toHaveBeenCalled();
});
it('bounds preparation expiry even while DATA is pending', async () => {
  jest.useFakeTimers();
  mockArm.mockImplementation(async () => ({
    ...status(),
    selection: {
      ...status().selection,
      preparationExpiresAt: new Date(Date.now() + 1000).toISOString(),
    },
  }));
  let rejectStart!: (error: Error) => void;
  mockStart.mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejectStart = reject;
      }),
  );
  const attempt = selectedRecordingAttempt(options);
  const rejected = expect(attempt).rejects.toThrow();
  for (let i = 0; i < 40 && !rejectStart; i++) await Promise.resolve();
  expect(rejectStart).toBeDefined();
  await jest.advanceTimersByTimeAsync(1001);
  const stoppedAtPreparationExpiry = mockStop.mock.calls.length > 0;
  rejectStart(new Error('closed'));
  await rejected;
  expect(stoppedAtPreparationExpiry).toBe(true);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(mockRequest).not.toHaveBeenCalled();
  expect(mockStop).toHaveBeenCalled();
});

it.each([
  'run',
  'installation',
  'session',
  'recording',
  'failed',
  'core',
  'uplink',
  'error',
  'confirmed',
  'ready',
])('rejects an invalid terminal DELETE receipt: %s', async (fault) => {
  mockFetch.mockImplementation(async (_url, init) => {
    if (init.method !== 'DELETE')
      return {
        ok: true,
        json: async () =>
          status(mockFetch.mock.calls.filter((call) => call[1].method === 'GET').length),
      };
    const base = stopped();
    const invalid = {
      run: { ...base, runId: peer.socketLifetimeId },
      installation: { ...base, installationFingerprint: 'f'.repeat(16) },
      session: { ...base, selection: { ...base.selection, sessionHash: 'f'.repeat(16) } },
      recording: { ...base, phase: 'recording' },
      failed: { ...base, phase: 'failed' },
      core: { ...base, core: { ...base.core, state: 'recording' } },
      uplink: { ...base, uplink: { state: 'unavailable' } },
      error: { ...base, error: 'uplink_stop_failed' },
      confirmed: { ...base, selection: { ...base.selection, confirmed: true } },
      ready: {
        ...base,
        selection: { ...base.selection, readiness: { ...base.selection.readiness, ready: true } },
      },
    }[fault];
    return { ok: true, json: async () => invalid };
  });
  await expect(selectedRecordingAttempt(options)).rejects.toThrow('cleanup failed');
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
it('rejects cleanup if the native tunnel remains active after stop', async () => {
  mockActive.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
  await expect(selectedRecordingAttempt(options)).rejects.toThrow('cleanup failed');
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
it('accepts an expired terminal receipt with both sources stopped', async () => {
  mockFetch.mockImplementation(async (_url, init) => ({
    ok: true,
    json: async () =>
      init.method === 'DELETE'
        ? { ...stopped(), phase: 'expired' }
        : status(mockFetch.mock.calls.filter((call) => call[1].method === 'GET').length),
  }));
  await expect(selectedRecordingAttempt(options)).resolves.toEqual({ status: 200 });
});

function nativeSnapshot() {
  return {
    version: 1,
    channel: 'DATA',
    generation: '01234567-0123-4123-8123-0123456789ab',
    sessionHash: status().selection.sessionHash,
    clockOffsetKnown: false,
    startedLate: false,
    delegateAvailable: false,
    captureLimitMs: 30000,
    expired: false,
    dropped: 0,
    events: [
      { sequence: 1, utc: new Date().toISOString(), elapsedMs: 0, event: 'capture_started' },
    ],
  };
}
it('captures before its DATA start and reports validated same-session native evidence after stop', async () => {
  mockCaptureSupported = true;
  const local = jest.fn();
  const phase = jest.fn();
  await selectedRecordingAttempt({ ...options, onLocalRecording: local, onPhase: phase });
  expect(order.indexOf('capture')).toBeLessThan(order.indexOf('data'));
  expect(order.indexOf('stop')).toBeLessThan(order.indexOf('disable'));
  expect(local).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 'ready',
      sessionHash: status().selection.sessionHash,
      stopped: true,
    }),
  );
  expect(JSON.parse(local.mock.calls[0][0].recording)).toHaveLength(1);
  expect(phase.mock.calls.flat()).toEqual(['preparing', 'running', 'stopping']);
});
it.each(['unmatched', 'ambiguous', 'invalid'])(
  'does not attach %s native data to the run',
  async (fault) => {
    mockCaptureSupported = true;
    mockDiagnosticExport.mockImplementation(async () => {
      const snapshot = nativeSnapshot();
      if (fault === 'unmatched') snapshot.sessionHash = 'f'.repeat(16);
      if (fault === 'invalid') Object.assign(snapshot, { ticket: 'private' });
      return fault === 'ambiguous'
        ? [
            JSON.stringify(snapshot),
            JSON.stringify({ ...snapshot, generation: '11234567-0123-4123-8123-0123456789ab' }),
          ]
        : [JSON.stringify(snapshot)];
    });
    const local = jest.fn();
    await selectedRecordingAttempt({ ...options, onLocalRecording: local });
    expect(local).toHaveBeenCalledWith(expect.objectContaining({ status: fault, recording: null }));
  },
);
it('keeps delegate completion observed after local stop before freezing the native capture', async () => {
  mockCaptureSupported = true;
  let reads = 0;
  mockDiagnosticExport.mockImplementation(async () => {
    const snapshot = { ...nativeSnapshot(), delegateAvailable: true };
    if (++reads > 1)
      snapshot.events.push({
        sequence: 2,
        utc: new Date().toISOString(),
        elapsedMs: 1,
        event: 'task_completed',
      });
    return [JSON.stringify(snapshot)];
  });
  const local = jest.fn();
  await selectedRecordingAttempt({ ...options, onLocalRecording: local });
  expect(reads).toBe(2);
  expect(JSON.parse(local.mock.calls[0][0].recording)[0].events.at(-1).event).toBe(
    'task_completed',
  );
  expect(mockDisable).toHaveBeenCalledTimes(1);
});
it('reports missing native capture support without inventing a native recording', async () => {
  const local = jest.fn();
  await selectedRecordingAttempt({ ...options, onLocalRecording: local });
  expect(local).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'unsupported', recording: null }),
  );
  expect(mockDiagnosticExport).not.toHaveBeenCalled();
});
it('preserves a capture already owned by another operation', async () => {
  mockCaptureSupported = true;
  mockRemaining.mockResolvedValue(12000);
  const local = jest.fn();
  await expect(selectedRecordingAttempt({ ...options, onLocalRecording: local })).rejects.toThrow(
    'Existing DATA recording',
  );
  expect(mockCapture).not.toHaveBeenCalled();
  expect(mockDisable).not.toHaveBeenCalled();
  expect(mockStart).not.toHaveBeenCalled();
});
it('clears a late capture arm after abort and holds ownership until that cleanup completes', async () => {
  mockCaptureSupported = true;
  const controller = new AbortController();
  let release!: (enabled: boolean) => void;
  mockCapture.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const attempt = selectedRecordingAttempt({ ...options, signal: controller.signal });
  for (let i = 0; i < 60 && !release; i++) await Promise.resolve();
  expect(release).toBeDefined();
  controller.abort();
  await expect(attempt).rejects.toThrow();
  await expect(selectedRecordingAttempt(options)).rejects.toThrow('already active');
  release(true);
  for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(mockDisable).toHaveBeenCalledTimes(1);
  expect(mockStart).not.toHaveBeenCalled();
});

it('reports native disable rejection as cleanup failure', async () => {
  mockCaptureSupported = true;
  mockDisable.mockRejectedValue(new Error('disable failed'));
  await expect(selectedRecordingAttempt(options)).rejects.toThrow('capture cleanup failed');
  expect(mockDisable).toHaveBeenCalledTimes(1);
});
it('holds ownership through a timed-out native disable until it settles', async () => {
  jest.useFakeTimers();
  mockCaptureSupported = true;
  let settle!: () => void;
  mockDisable.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
  );
  const attempt = selectedRecordingAttempt(options);
  const rejected = expect(attempt).rejects.toThrow('capture cleanup failed');
  for (let i = 0; i < 300 && !settle; i++) await Promise.resolve();
  expect(settle).toBeDefined();
  await jest.advanceTimersByTimeAsync(6001);
  await rejected;
  await expect(selectedRecordingAttempt(options)).rejects.toThrow('already active');
  expect(mockDisable).toHaveBeenCalledTimes(1);
  settle();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  mockDisable.mockResolvedValue(undefined);
  await expect(selectedRecordingAttempt(options)).resolves.toEqual({ status: 200 });
});

it('exports retained native evidence after the capture timer has disabled recording', async () => {
  jest.useFakeTimers();
  mockCaptureSupported = true;
  mockArm.mockImplementation(async () => ({
    ...status(),
    expiresAt: new Date(Date.now() + 45000).toISOString(),
    selection: {
      ...status().selection,
      preparationExpiresAt: new Date(Date.now() + 45000).toISOString(),
    },
  }));
  const snapshot = nativeSnapshot();
  mockDiagnosticExport.mockResolvedValue([JSON.stringify(snapshot)]);
  let attach!: (port: number) => void;
  mockStart.mockImplementation(
    () =>
      new Promise<number>((resolve) => {
        attach = resolve;
      }),
  );
  const local = jest.fn();
  const attempt = selectedRecordingAttempt({ ...options, onLocalRecording: local });
  for (let i = 0; i < 200 && !attach; i++) await Promise.resolve();
  expect(attach).toBeDefined();
  await jest.advanceTimersByTimeAsync(30001);
  expect(mockDisable).toHaveBeenCalledTimes(1);
  attach(1234);
  await attempt;
  expect(local).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 'ready',
      recording: JSON.stringify([snapshot]),
    }),
  );
  expect(mockDisable).toHaveBeenCalledTimes(1);
});
