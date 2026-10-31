import { NativeModules, Platform } from 'react-native';
import * as Sharing from 'expo-sharing';
import { exportSessionSwitchTimings } from '@verity/mobile';
import { exportGestureDiagnostics, setGestureDiagnosticsEnabled } from './gestureDiagnostics';
import { exportRuntimeDiagnostics } from './runtimeDiagnostics';

type CPUCapture = {
  recording: boolean;
  captureId: string;
  startedAt: number;
  startedMonotonicUs: number;
  stoppedMonotonicUs: number;
  stoppedAt: number;
  reason: string;
  error: string;
  ready: boolean;
};
type Profiler = {
  status(): Promise<{ supported: boolean; capture: CPUCapture }>;
  jsThreadId(): string;
  start(jsThreadId: string): Promise<CPUCapture>;
  stop(): Promise<CPUCapture>;
  exportCapture(context: string): Promise<string>;
};
function profiler(): Profiler | undefined {
  return Platform.OS === 'ios'
    ? (NativeModules.VerityCPUProfiler as Profiler | undefined)
    : undefined;
}
export async function cpuProfilingStatus() {
  return profiler()?.status() ?? { supported: false, capture: null };
}
export async function startCPUProfiling() {
  const native = profiler();
  if (!native) throw new Error('Install the latest native staging build to record CPU activity.');
  const capture = await native.start(native.jsThreadId());
  setGestureDiagnosticsEnabled(true);
  return capture;
}
export async function stopCPUProfiling() {
  const native = profiler();
  if (!native) throw new Error('CPU profiling is unavailable.');
  return native.stop();
}
export async function shareCPUProfile() {
  const native = profiler();
  if (!native || !(await Sharing.isAvailableAsync())) throw new Error('CPU export is unavailable.');
  const context = JSON.stringify({
    exportedAt: Date.now(),
    clock:
      'Native and interaction wall times are Unix milliseconds; Hermes sample timestamps are monotonic microseconds. Hermes V1 uses CLOCK_UPTIME_RAW; align via recording.startedAt and startedMonotonicUs.',
    switches: exportSessionSwitchTimings(),
    gestures: exportGestureDiagnostics(),
    runtime: exportRuntimeDiagnostics(),
  });
  const uri = await native.exportCapture(context);
  await Sharing.shareAsync(uri, {
    mimeType: 'application/json',
    dialogTitle: 'Export CPU capture',
  });
}
