import { AppState, type AppStateStatus } from 'react-native';
import { setGestureDiagnosticsEnabled } from './gestureDiagnostics';
import {
  exportRuntimeDiagnostics,
  setRuntimeDiagnosticsScreen,
  startRuntimeDiagnostics,
} from './runtimeDiagnostics';

jest.mock('@verity/mobile', () => ({
  mobileRuntimeSnapshot: () => ({
    activeSessionSubscriptions: 2,
    sessionEventsReceived: 42,
    inFlightApiRequests: 1,
  }),
}));

let stop: () => void;
let appState: (state: AppStateStatus) => void;
const remove = jest.fn();
beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    appState = listener;
    return { remove };
  });
  setGestureDiagnosticsEnabled(false);
  stop = startRuntimeDiagnostics();
});
afterEach(() => {
  setGestureDiagnosticsEnabled(false);
  stop();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('samples only when enabled and erases recording on disable', () => {
  expect(jest.getTimerCount()).toBe(0);
  setGestureDiagnosticsEnabled(true);
  expect(exportRuntimeDiagnostics().baseline).toMatchObject({
    activeSessionSubscriptions: 2,
    inFlightApiRequests: 1,
  });
  jest.advanceTimersByTime(5_000);
  expect(exportRuntimeDiagnostics().samples).toHaveLength(2);
  setGestureDiagnosticsEnabled(false);
  expect(exportRuntimeDiagnostics()).toMatchObject({ baseline: null, samples: [], dropped: 0 });
  expect(jest.getTimerCount()).toBe(0);
});

it('preserves the initial baseline while bounding recent samples', () => {
  setGestureDiagnosticsEnabled(true);
  const initial = exportRuntimeDiagnostics().baseline;
  jest.advanceTimersByTime(5_000 * 150);
  const report = exportRuntimeDiagnostics();
  expect(report.baseline).toEqual(initial);
  expect(report.samples).toHaveLength(report.maxSamples);
  expect(report.dropped).toBe(151 - report.maxSamples);
  expect(report.samples[0]!.recordingAgeMs).toBeGreaterThan(0);
});

it('does not attribute background time to JS lag and disposes its resources', () => {
  setGestureDiagnosticsEnabled(true);
  appState('background');
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(120_000);
  expect(exportRuntimeDiagnostics().samples).toHaveLength(1);
  appState('active');
  jest.advanceTimersByTime(5_000);
  expect(exportRuntimeDiagnostics().samples.at(-1)?.timerLagMs).toBe(0);
  stop();
  expect(jest.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalled();
});

it('records delayed timer delivery and only coarse route categories', () => {
  setRuntimeDiagnosticsScreen('/settings/private-service-name');
  setGestureDiagnosticsEnabled(true);
  const monotonic = performance.now.bind(performance);
  const spy = jest.spyOn(performance, 'now').mockImplementation(() => monotonic() + 700);
  jest.advanceTimersByTime(5_000);
  spy.mockRestore();
  const report = exportRuntimeDiagnostics();
  expect(report.samples.at(-1)).toMatchObject({ screen: 'settings', timerLagMs: 700 });
  expect(JSON.stringify(report)).not.toContain('private-service-name');
  setRuntimeDiagnosticsScreen('/session/private-session-id');
  jest.advanceTimersByTime(5_000);
  expect(exportRuntimeDiagnostics().samples.at(-1)?.screen).toBe('session');
  expect(JSON.stringify(exportRuntimeDiagnostics())).not.toContain('private-session-id');
});
