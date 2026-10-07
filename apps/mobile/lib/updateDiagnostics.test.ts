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
