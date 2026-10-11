import { beginRowTouch, markFirstSessionRender, rowPress, rowPressIn } from './sessionSwitchTiming';
import {
  markSessionSwitch,
  sessionSwitchTiming,
  beginSessionSwitch,
  beginSwitchTransportRequest,
  markSwitchTransportRequest,
} from '@verity/mobile';
import * as Updates from 'expo-updates';
import { Share } from 'react-native';
import { shareUpdateDiagnostics } from './updateDiagnostics';

jest.mock('expo-updates', () => ({
  isEnabled: true,
  runtimeVersion: '1.57.0',
  channel: 'staging',
  updateId: 'embedded-id',
  isEmbeddedLaunch: true,
  isEmergencyLaunch: false,
  emergencyLaunchReason: null,
  readLogEntriesAsync: jest.fn(),
}));

const readLogs = jest.mocked(Updates.readLogEntriesAsync);
const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });

beforeEach(() => jest.clearAllMocks());

it('exports retained launch failures with the running update identity', async () => {
  readLogs.mockResolvedValue([
    {
      timestamp: 1,
      message: 'Fatal launch error',
      code: 'JSRuntimeError',
      level: 'error',
    } as Awaited<ReturnType<typeof Updates.readLogEntriesAsync>>[number],
  ]);
  await shareUpdateDiagnostics();
  expect(readLogs).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1000);
  const report = JSON.parse((share.mock.calls[0]![0] as { message: string }).message);
  expect(report).toMatchObject({
    runtimeVersion: '1.57.0',
    channel: 'staging',
    isEmbeddedLaunch: true,
    logs: [{ message: 'Fatal launch error' }],
  });
});

it('does not share a misleading empty report when log retrieval fails', async () => {
  readLogs.mockRejectedValue(new Error('unavailable'));
  await expect(shareUpdateDiagnostics()).rejects.toThrow('unavailable');
  expect(share).not.toHaveBeenCalled();
});

function log(message: string, timestamp: number, level = 'info', stacktrace?: string[]) {
  return { message, timestamp, level, code: 'None', stacktrace } as Awaited<
    ReturnType<typeof Updates.readLogEntriesAsync>
  >[number];
}

function sharedReport() {
  const message = (share.mock.calls[0]![0] as { message: string }).message;
  expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(256 * 1024);
  return JSON.parse(message);
}

it('compacts repeated manifest dumps while retaining the latest failure', async () => {
  readLogs.mockResolvedValue([
    ...Array.from({ length: 200 }, (_, i) =>
      log(
        'Updates state change: state = idle, event = checkError, context = UpdatesStateContext(latestManifest: ' +
          'asset'.repeat(20_000) +
          ')',
        i,
      ),
    ),
    log('Unhandled JS Exception: Unistyles is not configured', 201, 'error', ['RootLayout']),
    log('Older failure', 100, 'error'),
    log('Warning', 202, 'warn'),
  ]);
  await shareUpdateDiagnostics();
  const report = sharedReport();
  expect(report.logs.slice(0, 3).map((entry: { message: string }) => entry.message)).toEqual([
    'Unhandled JS Exception: Unistyles is not configured',
    'Older failure',
    'Warning',
  ]);
  expect(report.logs[0].stacktrace).toEqual(['RootLayout']);
  expect(report.logSummary).toMatchObject({
    retained: 203,
    exported: 103,
    omitted: 100,
    truncated: 100,
  });
  expect(JSON.stringify(report)).not.toContain('assetasset');
});

it('bounds UTF-8 and JSON escaping for many long failures and stacktraces', async () => {
  readLogs.mockResolvedValue(
    Array.from({ length: 100 }, (_, i) =>
      log(
        `Failure ${i}: ` + '😀漢字\\"\n'.repeat(10_000),
        i,
        'error',
        Array(80).fill('RootLayout ' + '界'.repeat(1000)),
      ),
    ),
  );
  await shareUpdateDiagnostics();
  const report = sharedReport();
  expect(report.logs[0].message).toContain('Failure 99:');
  expect(report.logs[0].message).toContain('[truncated]');
  expect(report.logs[0].stacktrace).toHaveLength(32);
  expect(report.logSummary.omitted).toBeGreaterThan(0);
  expect(report.logSummary.truncated).toBe(report.logs.length);
  expect(report.logSummary.exported + report.logSummary.omitted).toBe(100);
});

it('preserves bounded check and download errors while removing manifests', async () => {
  readLogs.mockResolvedValue([
    log(
      'Updates state change: state = idle, event = checkError, context = UpdatesStateContext(latestManifest: ' +
        'asset'.repeat(10000) +
        ', checkError: Optional(Error Domain=Network Code=-1009, connection offline), downloadError: Optional(Asset download failed), downloadProgress: 0.0)',
      1,
    ),
  ]);
  await shareUpdateDiagnostics();
  const report = sharedReport();
  expect(report.logs[0].contextErrors).toEqual({
    checkError: 'Optional(Error Domain=Network Code=-1009, connection offline)',
    downloadError: 'Optional(Asset download failed)',
  });
  expect(report.logs[0].message).toBe('Updates state change: state = idle, event = checkError');
  expect(JSON.stringify(report)).not.toContain('assetasset');
});

it('compacts Android map contexts without losing errors after a large manifest', async () => {
  readLogs.mockResolvedValue([
    log(
      'Updates state change: checkError, context = {isChecking=false, latestManifest=' +
        'asset'.repeat(10000) +
        ', checkError={message=Network unavailable}, downloadError={message=Asset missing}, lastCheckForUpdateTime=123}',
      1,
    ),
  ]);
  await shareUpdateDiagnostics();
  const report = sharedReport();
  expect(report.logs[0].message).toBe('Updates state change: checkError');
  expect(report.logs[0].contextErrors).toEqual({
    checkError: '{message=Network unavailable}',
    downloadError: '{message=Asset missing}',
  });
  expect(JSON.stringify(report)).not.toContain('assetasset');
});

it('exports bounded content-free switch phases with the loaded update identity', async () => {
  readLogs.mockResolvedValue([]);
  beginRowTouch('private-session', 1234);
  rowPress('private-session');
  markSessionSwitch(sessionSwitchTiming('private-session'), 'transcript-ready-react-commit');
  await shareUpdateDiagnostics();
  const report = sharedReport();
  expect(report.updateId).toBe('embedded-id');
  expect(report.sessionSwitchTimings.at(-1).phases.map((p: { phase: string }) => p.phase)).toEqual([
    'js-touch-start',
    'js-press-handler',
    'transcript-ready-react-commit',
  ]);
  expect(JSON.stringify(report)).not.toContain('private-session');
});

it('starts separate traces for repeated keyboard activation without touch callbacks', () => {
  rowPress('keyboard-session');
  const first = sessionSwitchTiming('keyboard-session')!;
  rowPress('keyboard-session');
  const second = sessionSwitchTiming('keyboard-session')!;
  expect(second.id).not.toBe(first.id);
  expect(first.status).toBe('superseded');
  expect(first.phases.map((p) => p.phase)).toEqual(['js-press-handler']);
  expect(second.phases.map((p) => p.phase)).toEqual(['js-press-handler']);
});

it('bounds render entry diagnostics and keeps them attached to the active gesture', () => {
  rowPress('first');
  const first = sessionSwitchTiming('first')!;
  for (let i = 0; i < 100; i++) markFirstSessionRender('first', 'selection-home-render-entry');
  expect(first.phases.filter((p) => p.phase === 'selection-home-render-entry')).toHaveLength(1);
  rowPress('second');
  markFirstSessionRender('first', 'session-screen-render-entry');
  expect(first.phases.some((p) => p.phase === 'session-screen-render-entry')).toBe(false);
  markFirstSessionRender('second', 'session-screen-render-entry');
  expect(sessionSwitchTiming('second')!.phases.at(-1)?.phase).toBe('session-screen-render-entry');
});

// Full transport traces must not bypass the export byte ceiling before logs are added.
it('bounds transport metadata while retaining the latest gesture', async () => {
  readLogs.mockResolvedValue([]);
  for (let i = 0; i < 8; i++) {
    const trace = beginSessionSwitch(`private-overflow-${i}`);
    for (let phase = 0; phase < 64; phase++) {
      markSessionSwitch(trace, 'render-bounded-metric', 12345678);
      markSessionSwitch(trace, 'bounded-lifecycle-marker', 12345678);
    }
    for (let request = 0; request < 16; request++) {
      const id = beginSwitchTransportRequest(trace, 'events');
      for (let phase = 0; phase < 24; phase++)
        markSwitchTransportRequest(id, 'native-return', 1791549632165);
    }
  }
  await shareUpdateDiagnostics();
  const report = sharedReport();
  expect(report.captureSummary.omittedSwitches).toBeGreaterThan(0);
  expect(report.sessionSwitchTimings.at(-1).transportRequests).toHaveLength(16);
  expect(Buffer.byteLength(JSON.stringify(report, null, 2))).toBeLessThanOrEqual(
    report.logSummary.maxBytes,
  );
  expect(JSON.stringify(report)).not.toContain('private-overflow');
});

// Responder grant precedes touch-start on Fabric; a previous tap must not receive it.
it.each([true, false])('keeps touch callbacks together with press-first=%s', (pressFirst) => {
  beginRowTouch('repeat-row', 100);
  const previous = sessionSwitchTiming('repeat-row')!;
  if (pressFirst) {
    rowPressIn('repeat-row', 200);
    beginRowTouch('repeat-row', 200);
  } else {
    beginRowTouch('repeat-row', 200);
    rowPressIn('repeat-row', 200);
  }
  rowPress('repeat-row');
  const current = sessionSwitchTiming('repeat-row')!;
  expect(current.id).not.toBe(previous.id);
  expect(previous.phases.map((p) => p.phase)).toEqual(['js-touch-start']);
  expect(current.phases.map((p) => p.phase)).toEqual(
    pressFirst
      ? ['js-press-in', 'js-touch-start', 'js-press-handler']
      : ['js-touch-start', 'js-press-in', 'js-press-handler'],
  );
});

it('does not join matching timestamps from different rows', () => {
  rowPressIn('row-a', 300);
  const previous = sessionSwitchTiming('row-a')!;
  beginRowTouch('row-b', 300);
  expect(sessionSwitchTiming('row-b')!.id).not.toBe(previous.id);
});
