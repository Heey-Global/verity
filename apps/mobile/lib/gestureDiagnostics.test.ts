import { act, renderHook } from '@testing-library/react-native';

import {
  exportGestureDiagnostics,
  gestureRowNumber,
  recordGesture,
  setGestureDiagnosticsEnabled,
  useGestureDiagnosticsEnabled,
} from './gestureDiagnostics';

afterEach(() => act(() => setGestureDiagnosticsEnabled(false)));

it('records nothing until switched on, so a normal launch collects no gestures', () => {
  recordGesture({ source: 'row', event: 'touch-down' });
  expect(exportGestureDiagnostics()).toEqual({ enabled: false, dropped: 0, events: [] });
  setGestureDiagnosticsEnabled(true);
  recordGesture({ source: 'row', event: 'touch-down', projectKind: 'local' });
  expect(exportGestureDiagnostics().events).toMatchObject([
    { source: 'row', event: 'touch-down', projectKind: 'local' },
  ]);
});

it('discards collected events when switched off', () => {
  setGestureDiagnosticsEnabled(true);
  recordGesture({ source: 'swipe', event: 'open-start-drag' });
  setGestureDiagnosticsEnabled(false);
  setGestureDiagnosticsEnabled(true);
  expect(exportGestureDiagnostics().events).toEqual([]);
});

it('keeps only the latest events and counts what it dropped', () => {
  setGestureDiagnosticsEnabled(true);
  for (let i = 0; i < 305; i++) recordGesture({ source: 'row', event: `e${String(i)}` });
  const report = exportGestureDiagnostics();
  expect(report.events).toHaveLength(300);
  expect(report.dropped).toBe(5);
  expect(report.events[0]!.event).toBe('e5');
});

it('numbers rows without exporting the key they were derived from', () => {
  setGestureDiagnosticsEnabled(true);
  const first = gestureRowNumber('session:secret-a');
  expect(gestureRowNumber('session:secret-b')).not.toBe(first);
  expect(gestureRowNumber('session:secret-a')).toBe(first);
  recordGesture({ source: 'row', event: 'touch-down', row: first });
  expect(JSON.stringify(exportGestureDiagnostics())).not.toContain('secret');
});

it('re-renders subscribers when the switch changes', () => {
  const hook = renderHook(() => useGestureDiagnosticsEnabled());
  expect(hook.result.current).toBe(false);
  act(() => setGestureDiagnosticsEnabled(true));
  expect(hook.result.current).toBe(true);
});
