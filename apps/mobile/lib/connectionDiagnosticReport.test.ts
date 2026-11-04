import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ConnectionRecordingExport } from '@verity/mobile';
import {
  createConnectionDiagnosticReport,
  loadConnectionDiagnosticReports,
  parseStoredConnectionDiagnosticReport,
  removeConnectionDiagnosticReport,
  saveConnectionDiagnosticReport,
  type ConnectionDiagnosticReportInput,
} from './connectionDiagnosticReport';

jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
const runId = '11111111-1111-4111-8111-111111111111';
const startedAt = '2026-01-01T00:00:00.000Z';
function nativeSnapshot() {
  return {
    version: 1,
    channel: 'DATA',
    generation: '01234567-0123-4123-8123-0123456789ab',
    sessionHash: 'c1448f52fd7bef90',
    clockOffsetKnown: false,
    startedLate: false,
    delegateAvailable: true,
    captureLimitMs: 45_000,
    expired: false,
    dropped: 0,
    events: [
      { sequence: 1, utc: startedAt, elapsedMs: 0, event: 'capture_started' },
      { sequence: 2, utc: '2026-11-04T11:20:00.100Z', elapsedMs: 100, event: 'task_completed' },
    ],
  };
}
function serverReport(): ConnectionRecordingExport {
  return {
    version: 1,
    status: {
      version: 1,
      runId,
      phase: 'stopped',
      startedAt,
      expiresAt: '2026-01-01T00:00:45.000Z',
      installationFingerprint: '0123456789abcdef',
      core: { state: 'stopped', records: 0, dropped: 0 },
      uplink: { state: 'stopped' },
      error: null,
      selection: {
        sessionHash: 'c1448f52fd7bef90',
        confirmed: false,
        preparationExpiresAt: null,
        readiness: null,
      },
    },
    core: { records: [], dropped: 0 },
    uplink: {
      available: true,
      data: {
        version: 1,
        runId,
        state: 'stopped',
        expiresAt: '2026-01-01T00:00:45.000Z',
        retainedUntil: '2026-01-01T01:00:00.000Z',
        collectorReady: true,
        recordCount: 0,
        droppedRecords: 0,
        records: [],
      },
      error: null,
    },
  };
}
function input(): ConnectionDiagnosticReportInput {
  return {
    runId,
    startedAt,
    testType: 'quick_test',
    outcome: 'completed',
    local: JSON.stringify([nativeSnapshot()]),
    localStopped: true,
    remote: serverReport(),
    remoteStopped: true,
  };
}
beforeEach(async () => AsyncStorage.clear());

it('combines the same-run sources without rewriting the server document', () => {
  const value = input();
  const report = createConnectionDiagnosticReport(value);
  expect(report).toMatchObject({
    version: 2,
    runId,
    testType: 'quick_test',
    outcome: 'completed',
    expectedAutomaticStop: true,
    complete: true,
    sources: { app: true, core: true, uplink: true },
  });
  expect(report.remote.recording).toBe(value.remote);
  expect(parseStoredConnectionDiagnosticReport(JSON.stringify(report))).toEqual(report);
});

it.each([
  { local: null },
  { local: '[]' },
  { localStopped: false },
  { remote: null },
  { remoteStopped: false },
])('never claims a complete report with missing evidence or stop: %j', (change) => {
  expect(createConnectionDiagnosticReport({ ...input(), ...change }).complete).toBe(false);
});

it('distinguishes user cancellation from automatic completion and absent server sources', () => {
  const report = createConnectionDiagnosticReport({
    ...input(),
    testType: 'problem_recording',
    outcome: 'cancelled',
    remote: null,
    remoteStopped: false,
  });
  expect(report.expectedAutomaticStop).toBe(false);
  expect(report.outcome).toBe('cancelled');
  expect(report.sources).toEqual({ app: true, core: false, uplink: false });
  expect(report.remote.stopped).toBe(false);
});

it('keeps a missing Uplink, dropped capture and failure receipts incomplete', () => {
  const remote = serverReport();
  remote.uplink = { available: false, data: null, error: 'uplink_export_failed' };
  expect(createConnectionDiagnosticReport({ ...input(), remote }).complete).toBe(false);
  const dropped = serverReport();
  dropped.core.dropped = 1;
  expect(createConnectionDiagnosticReport({ ...input(), remote: dropped }).complete).toBe(false);
  const late = { ...nativeSnapshot(), startedLate: true };
  expect(
    createConnectionDiagnosticReport({ ...input(), local: JSON.stringify([late]) }).complete,
  ).toBe(false);
});

it('rejects another run or another native session instead of combining unrelated captures', () => {
  const remote = serverReport();
  remote.status.runId = '22222222-2222-4222-8222-222222222222';
  expect(createConnectionDiagnosticReport({ ...input(), remote }).remote.available).toBe(false);
  const snapshot = { ...nativeSnapshot(), sessionHash: '1111111111111111' };
  expect(
    createConnectionDiagnosticReport({ ...input(), local: JSON.stringify([snapshot]) }).app,
  ).toMatchObject({ available: false, recording: null, unavailableReason: 'unmatched' });
});

it.each(['ticket', 'url', 'headers', 'payload'])('rejects private native field %s', (key) => {
  const local = JSON.stringify([{ ...nativeSnapshot(), [key]: 'PRIVATE' }]);
  const report = createConnectionDiagnosticReport({ ...input(), local });
  expect(report.app.available).toBe(false);
  expect(JSON.stringify(report)).not.toContain('PRIVATE');
});

it('rejects stored claims and unknown fields rather than trusting a saved complete flag', () => {
  const report = createConnectionDiagnosticReport({ ...input(), local: null });
  expect(
    parseStoredConnectionDiagnosticReport(JSON.stringify({ ...report, complete: true })),
  ).toBeNull();
  expect(
    parseStoredConnectionDiagnosticReport(JSON.stringify({ ...report, ticket: 'PRIVATE' })),
  ).toBeNull();
  const corrupted = JSON.parse(JSON.stringify(report)) as typeof report;
  corrupted.remote.recording!.status.runId = '22222222-2222-4222-8222-222222222222';
  expect(parseStoredConnectionDiagnosticReport(JSON.stringify(corrupted))).toBeNull();
});

it('retains separate runs, updates only the matching run and rejects corrupt history', async () => {
  const first = createConnectionDiagnosticReport(input());
  await saveConnectionDiagnosticReport('paired', first);
  const next = createConnectionDiagnosticReport({
    ...input(),
    runId: '22222222-2222-4222-8222-222222222222',
    remote: null,
  });
  await saveConnectionDiagnosticReport('paired', next);
  expect((await loadConnectionDiagnosticReports('paired')).map((report) => report.runId)).toEqual([
    next.runId,
    first.runId,
  ]);
  await saveConnectionDiagnosticReport('paired', { ...first, outcome: 'cancelled' });
  expect(await loadConnectionDiagnosticReports('paired')).toHaveLength(2);
  await AsyncStorage.setItem('verity.connectionDiagnosticReports.v1.paired', '[{"complete":true}]');
  await expect(loadConnectionDiagnosticReports('paired')).rejects.toThrow();
});

it('serializes simultaneous saves and refuses a ninth run without evicting evidence', async () => {
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      saveConnectionDiagnosticReport(
        'paired',
        createConnectionDiagnosticReport({
          ...input(),
          runId: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
          remote: null,
        }),
      ),
    ),
  );
  const before = await loadConnectionDiagnosticReports('paired');
  await expect(
    saveConnectionDiagnosticReport(
      'paired',
      createConnectionDiagnosticReport({
        ...input(),
        runId: '99999999-1111-4111-8111-111111111111',
        remote: null,
      }),
    ),
  ).rejects.toThrow('history is full');
  expect(await loadConnectionDiagnosticReports('paired')).toEqual(before);
});

it('preserves retained evidence and confirmed Stop when recollection is unavailable', async () => {
  const complete = createConnectionDiagnosticReport(input());
  await saveConnectionDiagnosticReport('paired', complete);
  await saveConnectionDiagnosticReport(
    'paired',
    createConnectionDiagnosticReport({
      ...input(),
      local: null,
      localStopped: false,
      remote: null,
      remoteStopped: false,
      outcome: 'unknown',
    }),
  );
  expect(await loadConnectionDiagnosticReports('paired')).toEqual([complete]);
});

it('never reuses a run identity for a different test type or start time', async () => {
  const report = createConnectionDiagnosticReport(input());
  await saveConnectionDiagnosticReport('paired', report);
  await expect(
    saveConnectionDiagnosticReport('paired', {
      ...report,
      testType: 'problem_recording',
      expectedAutomaticStop: false,
    }),
  ).rejects.toThrow('identity changed');
  await expect(
    saveConnectionDiagnosticReport('paired', { ...report, startedAt: '2026-11-05T11:20:00.000Z' }),
  ).rejects.toThrow('identity changed');
  expect(await loadConnectionDiagnosticReports('paired')).toEqual([report]);
});

it('retains allowlisted preparation failure metadata and rejects private stored additions', () => {
  const report = createConnectionDiagnosticReport({
    ...input(),
    preparation: { stage: 'remote-start', failed: true, httpStatus: 503 },
  });
  expect(report.preparation).toEqual({ stage: 'remote-start', failed: true, httpStatus: 503 });
  expect(parseStoredConnectionDiagnosticReport(JSON.stringify(report))).toEqual(report);
  expect(
    parseStoredConnectionDiagnosticReport(
      JSON.stringify({
        ...report,
        preparation: { ...report.preparation, reason: 'PRIVATE' },
      }),
    ),
  ).toBeNull();
});

it('does not call incomplete or inconsistent source counters complete', () => {
  const countMismatch = serverReport();
  countMismatch.status.core.records = 1;
  expect(createConnectionDiagnosticReport({ ...input(), remote: countMismatch }).complete).toBe(
    false,
  );
  const statusDropped = serverReport();
  statusDropped.status.core.dropped = 1;
  expect(createConnectionDiagnosticReport({ ...input(), remote: statusDropped }).complete).toBe(
    false,
  );
  const uplinkMismatch = serverReport();
  uplinkMismatch.uplink.data!.recordCount = 1;
  expect(createConnectionDiagnosticReport({ ...input(), remote: uplinkMismatch }).complete).toBe(
    false,
  );
});

it('reports a native lifecycle gap when Stop lacks task completion evidence', () => {
  const snapshot = nativeSnapshot();
  snapshot.events = snapshot.events.filter((event) => event.event !== 'task_completed');
  const report = createConnectionDiagnosticReport({
    ...input(),
    local: JSON.stringify([snapshot]),
  });
  expect(report.app.available).toBe(true);
  expect(report.app.stopped).toBe(true);
  expect(report.complete).toBe(false);
  expect(report.gaps).toContain('native_task_completion_missing');
});

it('removes only the chosen report and leaves absent identities and invalid UUIDs untouched', async () => {
  const first = createConnectionDiagnosticReport(input());
  const next = createConnectionDiagnosticReport({
    ...input(),
    runId: '22222222-2222-4222-8222-222222222222',
    remote: null,
  });
  await saveConnectionDiagnosticReport('paired', first);
  await saveConnectionDiagnosticReport('paired', next);
  const before = await AsyncStorage.getItem('verity.connectionDiagnosticReports.v1.paired');
  await removeConnectionDiagnosticReport('paired', '99999999-1111-4111-8111-111111111111');
  expect(await AsyncStorage.getItem('verity.connectionDiagnosticReports.v1.paired')).toBe(before);
  await expect(removeConnectionDiagnosticReport('paired', '../private')).rejects.toThrow();
  expect(await AsyncStorage.getItem('verity.connectionDiagnosticReports.v1.paired')).toBe(before);
  await removeConnectionDiagnosticReport('paired', first.runId);
  expect(await loadConnectionDiagnosticReports('paired')).toEqual([next]);
});

it('serializes deletion with collection updates instead of losing the other saved reports', async () => {
  const first = createConnectionDiagnosticReport(input());
  const next = createConnectionDiagnosticReport({
    ...input(),
    runId: '22222222-2222-4222-8222-222222222222',
    remote: null,
  });
  await saveConnectionDiagnosticReport('paired', first);
  await Promise.all([
    removeConnectionDiagnosticReport('paired', first.runId),
    saveConnectionDiagnosticReport('paired', next),
  ]);
  expect(await loadConnectionDiagnosticReports('paired')).toEqual([next]);
});

it('preserves a retained Uplink document when recollection returns a partial server report', async () => {
  const complete = createConnectionDiagnosticReport(input());
  await saveConnectionDiagnosticReport('paired', complete);
  const unavailable = serverReport();
  unavailable.uplink = { available: false, data: null, error: 'uplink_export_failed' };
  await saveConnectionDiagnosticReport(
    'paired',
    createConnectionDiagnosticReport({ ...input(), remote: unavailable }),
  );
  expect(await loadConnectionDiagnosticReports('paired')).toEqual([complete]);
});

it('rejects multiple native snapshots even when their session hashes match', () => {
  const first = nativeSnapshot();
  const next = { ...nativeSnapshot(), generation: '01234567-0123-4123-8123-0123456789ac' };
  const report = createConnectionDiagnosticReport({
    ...input(),
    local: JSON.stringify([first, next]),
  });
  expect(report.app).toMatchObject({
    available: false,
    recording: null,
    unavailableReason: 'ambiguous',
  });
  expect(report.complete).toBe(false);
  expect(report.gaps).toContain('app_unavailable');
});

it('retains terminal confirmation alongside older Uplink evidence', async () => {
  const active = serverReport();
  active.status.phase = 'recording';
  active.status.core.state = 'recording';
  active.status.uplink.state = 'recording';
  await saveConnectionDiagnosticReport(
    'paired',
    createConnectionDiagnosticReport({
      ...input(),
      remote: active,
      remoteStopped: false,
    }),
  );
  const terminal = serverReport();
  terminal.uplink = { available: false, data: null, error: 'uplink_export_failed' };
  await saveConnectionDiagnosticReport(
    'paired',
    createConnectionDiagnosticReport({
      ...input(),
      remote: terminal,
    }),
  );
  const [report] = await loadConnectionDiagnosticReports('paired');
  expect(report!.remote.recording).toEqual(active);
  expect(report!.remote.terminalRecording).toEqual(terminal);
  expect(report!.remote.stopped).toBe(true);
  expect(report!.complete).toBe(false);
  expect(report!.gaps).toContain('retained_active_snapshot');
  expect(report!.gaps).not.toContain('remote_stop_unconfirmed');
  expect(parseStoredConnectionDiagnosticReport(JSON.stringify(report))).toEqual(report);
});

it.each(['installationFingerprint', 'startedAt'] as const)(
  'rejects terminal receipts from a different %s',
  (field) => {
    const active = serverReport();
    active.status.phase = 'recording';
    const receipt = serverReport();
    receipt.status[field] = field === 'startedAt' ? '2026-01-02T00:00:00.000Z' : 'fedcba9876543210';
    const report = createConnectionDiagnosticReport({
      ...input(),
      remote: active,
      terminalRecording: receipt,
    });
    expect(report.remote.stopped).toBe(false);
    expect(report.remote.terminalRecording).toBeUndefined();
  },
);

it.each(['records', 'dropped'] as const)(
  'never calls a retained active snapshot complete when terminal Core %s increase',
  async (field) => {
    const active = serverReport();
    active.status.phase = 'recording';
    await saveConnectionDiagnosticReport(
      'paired',
      createConnectionDiagnosticReport({
        ...input(),
        remote: active,
        remoteStopped: false,
      }),
    );
    const terminal = serverReport();
    terminal.status.core[field] = 1;
    terminal.uplink = { available: false, data: null, error: 'uplink_export_failed' };
    await saveConnectionDiagnosticReport(
      'paired',
      createConnectionDiagnosticReport({
        ...input(),
        remote: terminal,
      }),
    );
    const [report] = await loadConnectionDiagnosticReports('paired');
    expect(report!.remote.stopped).toBe(true);
    expect(report!.complete).toBe(false);
    expect(report!.gaps).toContain('retained_active_snapshot');
  },
);
