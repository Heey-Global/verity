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
  expect(exportGestureDiagnostics()).toEqual({
    enabled: false,
    dropped: 0,
    events: [],
    schedulingSummaries: [],
  });
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

it('keeps no row keys while recording is off', () => {
  expect(gestureRowNumber('session:a')).toBe(0);
  setGestureDiagnosticsEnabled(true);
  expect(gestureRowNumber('session:b')).toBe(1);
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

it('keeps touch evidence through scheduling floods and summarizes their peak', () => {
  setGestureDiagnosticsEnabled(true);
  recordGesture({ source: 'row', event: 'touch-down', row: 1 });
  for (let i = 0; i < 1000; i++)
    recordGesture({
      source: 'scheduling',
      event: 'sidebar-timer',
      detail: { waitMs: i === 1 ? 2000 : 1 },
    });
  const report = exportGestureDiagnostics();
  expect(report.events.filter((event) => event.source === 'scheduling')).toHaveLength(60);
  expect(report.events[0]).toMatchObject({ source: 'row', event: 'touch-down' });
  expect(report.dropped).toBe(940);
  expect(report.schedulingSummaries).toEqual([
    expect.objectContaining({
      event: 'sidebar-timer',
      count: 1000,
      maxWaitMs: 2000,
      maxWaitAt: expect.any(String),
    }),
  ]);
  report.schedulingSummaries[0]!.count = -1;
  expect(exportGestureDiagnostics().schedulingSummaries[0]!.count).toBe(1000);
  setGestureDiagnosticsEnabled(false);
  expect(exportGestureDiagnostics().schedulingSummaries).toEqual([]);
});

it('never replaces a full touch buffer with scheduling probes', () => {
  setGestureDiagnosticsEnabled(true);
  for (let i = 0; i < 300; i++) recordGesture({ source: 'row', event: 'touch-up', row: i });
  recordGesture({ source: 'scheduling', event: 'session-microtask', detail: { waitMs: 10 } });
  const report = exportGestureDiagnostics();
  expect(report.events).toHaveLength(300);
  expect(report.events.every((event) => event.source === 'row')).toBe(true);
  expect(report.dropped).toBe(1);
  expect(report.schedulingSummaries[0]).toMatchObject({ count: 1, maxWaitMs: 10 });
});
