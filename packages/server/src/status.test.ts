import type { AgentEvent } from '@verity/events';
import { describe, expect, it } from 'vitest';
import { deriveSessionStatus } from './status.js';

const text: AgentEvent = { t: 'text', delta: 'hi' };
const running: AgentEvent = { t: 'status', state: 'running' };
const awaitingDep: AgentEvent = { t: 'status', state: 'awaiting_dependency' };
const result: AgentEvent = {
  t: 'result',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  stopReason: 'end_turn',
};
const error: AgentEvent = { t: 'error', kind: 'boom', message: 'x' };
const taskStarted: AgentEvent = { t: 'task', id: 'bg1', phase: 'started' };
const taskEnded: AgentEvent = { t: 'task', id: 'bg1', phase: 'ended', status: 'completed' };
const permission: AgentEvent = {
  t: 'permission',
  id: 'p1',
  tool: 'Bash',
  input: {},
  riskClass: 'ask',
};

describe('deriveSessionStatus', () => {
  it('is idle for an empty log', () => {
    expect(deriveSessionStatus([])).toBe('idle');
  });

  it('returns the most recent explicit status state', () => {
    expect(deriveSessionStatus([running])).toBe('running');
    expect(deriveSessionStatus([running, awaitingDep])).toBe('awaiting_dependency');
  });

  it('maps result -> completed, error -> crashed, permission -> awaiting_input', () => {
    expect(deriveSessionStatus([text, result])).toBe('completed');
    expect(deriveSessionStatus([text, error])).toBe('crashed');
    expect(deriveSessionStatus([text, permission])).toBe('awaiting_input');
  });

  it('treats an interrupted turn as terminal and non-crashed', () => {
    expect(deriveSessionStatus([text, { t: 'interrupted' }])).toBe('completed');
    expect(
      deriveSessionStatus([
        { t: 'prompt', text: 'old turn' },
        error,
        { t: 'prompt', text: 'resume' },
        { t: 'interrupted' },
      ]),
    ).toBe('completed');
  });

  it('lets the most recent status-bearing event win', () => {
    // a later running status overrides an earlier result
    expect(deriveSessionStatus([result, running])).toBe('running');
  });

  it('treats a log of only neutral events as running', () => {
    expect(deriveSessionStatus([text, text])).toBe('running');
  });

  it('stays running when a `result` fires while a background task is still open', () => {
    // A run_in_background dispatch: the turn's first `result` lands while the task
    // runs on. The session is not done — the backend re-invokes once it finishes.
    expect(deriveSessionStatus([taskStarted, result])).toBe('running');
  });

  it('completes once the background task ends and the final result lands', () => {
    expect(deriveSessionStatus([taskStarted, result, taskEnded, result])).toBe('completed');
  });

  it('an unfinished background task keeps the session running regardless of result order', () => {
    // Two tasks open, only one closed → still outstanding work.
    const other: AgentEvent = { t: 'task', id: 'bg2', phase: 'started' };
    expect(deriveSessionStatus([taskStarted, other, taskEnded, result])).toBe('running');
  });

  it('does not let an orphaned task from an older turn poison a later completion', () => {
    expect(
      deriveSessionStatus([
        { t: 'prompt', text: 'first' },
        taskStarted,
        result,
        { t: 'prompt', text: 'second' },
        result,
      ]),
    ).toBe('completed');
  });

  it('keeps a task open across a prompt steered into the current turn', () => {
    expect(
      deriveSessionStatus([
        { t: 'prompt', text: 'first' },
        taskStarted,
        result,
        { t: 'prompt', text: 'more context', steered: true },
        result,
      ]),
    ).toBe('running');
  });
});
