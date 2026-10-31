import { NativeModules, Platform } from 'react-native';
import * as Sharing from 'expo-sharing';
import { beginSessionSwitch } from '@verity/mobile';
import {
  cpuProfilingStatus,
  shareCPUProfile,
  startCPUProfiling,
  stopCPUProfiling,
} from './cpuProfiling';
import {
  gestureDiagnosticsEnabled,
  recordGesture,
  setGestureDiagnosticsEnabled,
} from './gestureDiagnostics';

jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
const capture = { captureId: 'one', recording: true };
const native = {
  jsThreadId: jest.fn().mockReturnValue('9'),
  start: jest.fn().mockResolvedValue(capture),
  stop: jest.fn().mockResolvedValue({ ...capture, recording: false }),
  status: jest.fn().mockResolvedValue({ supported: true, capture }),
  exportCapture: jest.fn().mockResolvedValue('file:///cache/verity-cpu-capture.json'),
};
beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'ios';
  NativeModules.VerityCPUProfiler = native;
  jest.mocked(Sharing.isAvailableAsync).mockResolvedValue(true);
});
afterEach(() => {
  delete NativeModules.VerityCPUProfiler;
  setGestureDiagnosticsEnabled(false);
});
it('keeps older native builds and Android unsupported without invoking native sampling', async () => {
  Platform.OS = 'android';
  expect(await cpuProfilingStatus()).toEqual({ supported: false, capture: null });
  await expect(startCPUProfiling()).rejects.toThrow('latest native staging build');
  expect(native.start).not.toHaveBeenCalled();
  Platform.OS = 'ios';
  delete NativeModules.VerityCPUProfiler;
  await expect(stopCPUProfiling()).rejects.toThrow('unavailable');
});
it('starts interaction recording only after native start succeeds', async () => {
  native.start.mockRejectedValueOnce(new Error('busy'));
  await expect(startCPUProfiling()).rejects.toThrow('busy');
  expect(gestureDiagnosticsEnabled()).toBe(false);
  expect(await startCPUProfiling()).toBe(capture);
  expect(gestureDiagnosticsEnabled()).toBe(true);
  await stopCPUProfiling();
  // Turning off diagnostics would erase the activity needed for the export.
  expect(gestureDiagnosticsEnabled()).toBe(true);
});
it('exports current interaction context with the native file and propagates native errors', async () => {
  await startCPUProfiling();
  recordGesture({ source: 'row', event: 'touch-down', row: 3 });
  beginSessionSwitch('cpu-test-session');
  await shareCPUProfile();
  const context = JSON.parse(native.exportCapture.mock.calls[0]![0]);
  expect(context.gestures.events).toEqual(
    expect.arrayContaining([expect.objectContaining({ event: 'touch-down', row: 3 })]),
  );
  expect(context.switches.length).toBeGreaterThan(0);
  expect(Sharing.shareAsync).toHaveBeenCalledWith(
    'file:///cache/verity-cpu-capture.json',
    expect.objectContaining({ mimeType: 'application/json' }),
  );
  native.exportCapture.mockRejectedValueOnce(new Error('empty'));
  await expect(shareCPUProfile()).rejects.toThrow('empty');
  expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
});
it('does not prepare or share a file when system sharing is unavailable', async () => {
  jest.mocked(Sharing.isAvailableAsync).mockResolvedValue(false);
  await expect(shareCPUProfile()).rejects.toThrow('unavailable');
  expect(native.exportCapture).not.toHaveBeenCalled();
});
