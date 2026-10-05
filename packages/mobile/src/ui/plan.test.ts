import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../happy/message.js';
import { planHeadline, planView } from './plan.js';

function call(name: string, input: unknown, state: ToolCall['state'] = 'completed'): ToolCall {
  return {
    name,
    state,
    input,
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    description: null,
  };
}

describe('planView', () => {
  it('reads the checklist the session adapter carries, ignoring extra fields', () => {
    const plan = planView(
      call('TodoWrite', {
        todos: [
          { content: 'Find the cause', status: 'completed', priority: 'high' },
          { content: 'Fix it', status: 'in_progress', activeForm: 'Fixing it' },
          { content: 'Run the tests', status: 'pending' },
        ],
      }),
    );
    expect(plan).toEqual({
      entries: [
        { content: 'Find the cause', status: 'completed' },
        { content: 'Fix it', status: 'in_progress' },
        { content: 'Run the tests', status: 'pending' },
      ],
      completed: 1,
      current: 'Fix it',
    });
    expect(planHeadline(plan!)).toBe('Plan · 1 of 3 done');
  });

  // A malformed or foreign input must fall back to the ordinary tool card rather
  // than render a checklist with holes in it.
  it.each([
    ['another tool', call('Bash', { todos: [{ content: 'x', status: 'pending' }] })],
    ['no todos', call('TodoWrite', {})],
    ['an empty list', call('TodoWrite', { todos: [] })],
    ['an unknown status', call('TodoWrite', { todos: [{ content: 'x', status: 'blocked' }] })],
    ['a missing content', call('TodoWrite', { todos: [{ status: 'pending' }] })],
    ['a non-object input', call('TodoWrite', 'todos')],
    ['a failed call', call('TodoWrite', { todos: [{ content: 'x', status: 'pending' }] }, 'error')],
  ])('is null for %s', (_label, tool) => {
    expect(planView(tool)).toBeNull();
  });
});
