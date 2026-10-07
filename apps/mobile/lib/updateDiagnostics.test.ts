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
