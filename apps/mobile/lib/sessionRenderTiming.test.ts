import {
  beginSessionSwitch,
  exportSessionSwitchTimings,
  markSessionSwitch,
  sessionSwitchTiming,
} from '@verity/mobile';
import { beginRenderWork, rowPress, type RenderWorkStage } from './sessionSwitchTiming';

let clock = 0;
beforeEach(() => {
  clock = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
});
afterEach(() => jest.restoreAllMocks());

it('aggregates durations and counts without spending a phase for each row', () => {
  rowPress('private-session');
  for (let i = 0; i < 1000; i++) {
    const finish = beginRenderWork('sidebar-row-body');
    clock += 0.04;
    finish();
    finish();
  }
  const trace = sessionSwitchTiming('private-session')!;
  expect(trace.phases.filter((p) => p.phase.startsWith('render-'))).toEqual([
    expect.objectContaining({ phase: 'render-sidebar-row-body-total-ms', value: 40 }),
    expect.objectContaining({ phase: 'render-sidebar-row-body-count', value: 1000 }),
  ]);
  expect(JSON.stringify(exportSessionSwitchTimings())).not.toContain('private-session');
});

it('does not assign an old render to a later switch even when returning to the same session', () => {
  rowPress('a');
  const old = sessionSwitchTiming('a')!;
  beginRenderWork('chat-body', 'a')();
  const before = JSON.stringify(old.phases);
  const finish = beginRenderWork('chat-body', 'a');
  rowPress('b');
  rowPress('a');
  clock += 100;
  finish();
  expect(JSON.stringify(old.phases)).toBe(before);
  expect(sessionSwitchTiming('a')!.phases.some((p) => p.phase.startsWith('render-'))).toBe(false);
});

it('stops collecting after initial list load, including unfinished work', () => {
  rowPress('a');
  const trace = sessionSwitchTiming('a')!;
  const finish = beginRenderWork('chat-body', 'a');
  markSessionSwitch(trace, 'flash-list-on-load');
  clock += 100;
  finish();
  beginRenderWork('sidebar-row-body')();
  expect(trace.phases.some((p) => p.phase.startsWith('render-'))).toBe(false);
});

it('keeps stages independent and bounds them to twelve phase entries', () => {
  rowPress('a');
  const stages: RenderWorkStage[] = [
    'home-body',
    'sidebar-group-body',
    'sidebar-row-body',
    'chat-body',
    'transcript-reconcile',
    'list-item-elements',
  ];
  for (const stage of stages) {
    const finish = beginRenderWork(stage, 'a');
    clock += 2;
    finish();
  }
  const phases = sessionSwitchTiming('a')!.phases.filter((p) => p.phase.startsWith('render-'));
  expect(phases).toHaveLength(stages.length * 2);
  expect(phases.filter((p) => p.phase.endsWith('total-ms')).map((p) => p.value)).toEqual(
    stages.map(() => 2),
  );
});

it('does not leave partial aggregates or change unrelated entries when the trace is full', () => {
  rowPress('a');
  const trace = sessionSwitchTiming('a')!;
  while (trace.recorded < 63) markSessionSwitch(trace, 'existing');
  const before = JSON.stringify(trace.phases);
  beginRenderWork('chat-body', 'a')();
  expect(JSON.stringify(trace.phases)).toBe(before);
  markSessionSwitch(trace, 'final');
  expect(trace.phases).toHaveLength(64);
});

it('ignores expired and permission traces', () => {
  rowPress('a');
  const expired = sessionSwitchTiming('a')!;
  const finish = beginRenderWork('chat-body', 'a');
  clock = 30001;
  finish();
  expect(expired.phases.some((p) => p.phase.startsWith('render-'))).toBe(false);
  const permission = beginSessionSwitch('a', 'permission');
  beginRenderWork('chat-body', 'a')();
  expect(permission.phases).toHaveLength(0);
});
