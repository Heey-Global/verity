import { exportSessionSwitchTimings, cancelSessionSwitch } from './sessionSwitchTiming.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginSessionSwitch,
  markSessionSwitch,
  sessionSwitchTiming,
} from './sessionSwitchTiming.js';

afterEach(() => vi.restoreAllMocks());
describe('session switch timing', () => {
  it('rejects stale completions, including returning to the same session', () => {
    const first = beginSessionSwitch('a');
    markSessionSwitch(first, 'request-start');
    beginSessionSwitch('b');
    const returned = beginSessionSwitch('a');
    markSessionSwitch(first, 'request-end');
    markSessionSwitch(returned, 'press');
    expect(first.status).toBe('superseded');
    expect(first.phases.map((p) => p.phase)).toEqual(['request-start']);
    expect(returned.id).not.toBe(first.id);
    expect(sessionSwitchTiming('b')).toBeUndefined();
  });
  it('caps lifetime collection even after batches are drained', () => {
    const trace = beginSessionSwitch('bounded');
    for (let i = 0; i < 64; i++) markSessionSwitch(trace, 'phase');
    expect(trace.phases).toHaveLength(64);
    trace.phases.splice(0);
    markSessionSwitch(trace, 'overflow');
    expect(trace.phases).toHaveLength(0);
  });
  it('expires without retaining or collecting late results', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    const trace = beginSessionSwitch('expired');
    clock.mockReturnValue(30_100);
    expect(sessionSwitchTiming('expired')).toBeUndefined();
    markSessionSwitch(trace, 'late');
    expect(trace.phases).toEqual([]);
  });
});

it('retains only eight copied, identity-free traces and records cancellation', () => {
  for (let i = 0; i < 12; i++) {
    const trace = beginSessionSwitch(`private-session-${i}`);
    markSessionSwitch(trace, 'js-touch-start');
  }
  cancelSessionSwitch('private-session-11');
  expect(sessionSwitchTiming('private-session-11')).toBeUndefined();
  const report = exportSessionSwitchTimings();
  expect(report).toHaveLength(8);
  expect(report.at(-1)?.status).toBe('cancelled');
  expect(JSON.stringify(report)).not.toContain('private-session');
  report.at(-1)!.phases.length = 0;
  expect(exportSessionSwitchTimings().at(-1)?.phases).toHaveLength(2);
});

it('separates permission gestures from session loading without retaining approval content', () => {
  const session = beginSessionSwitch('same');
  const allow = beginSessionSwitch('same', 'permission');
  markSessionSwitch(session, 'late-history');
  markSessionSwitch(allow, 'allow-js-press-handler');
  expect(sessionSwitchTiming('same')).toBeUndefined();
  expect(sessionSwitchTiming('same', 'permission')).toBe(allow);
  expect(session.phases).toEqual([]);
  expect(exportSessionSwitchTimings().at(-1)?.kind).toBe('permission');
});

// Activity aggregation previously silently displaced the final readiness markers.
it('reserves lifecycle capacity after metrics fill their bounded budget', () => {
  const trace = beginSessionSwitch('full-metrics');
  for (let i = 0; i < 100; i++) markSessionSwitch(trace, 'activity-test');
  markSessionSwitch(trace, 'anchor-read-end');
  markSessionSwitch(trace, 'transcript-ready-react-commit');
  markSessionSwitch(trace, 'flash-list-on-load');
  expect(trace.phases).toHaveLength(67);
  expect(trace.phases.at(-1)?.phase).toBe('flash-list-on-load');
});
