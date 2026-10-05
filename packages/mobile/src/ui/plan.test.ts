import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../happy/message.js';
import { planHeadline, planProposal, planView } from './plan.js';

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

describe('planProposal', () => {
  it('reads a presented plan under every backend qualification and from ExitPlanMode', () => {
    for (const name of [
      'verity_present_plan',
      'mcp__verity__verity_present_plan',
      'verity_verity_present_plan',
      'ExitPlanMode',
    ]) {
      expect(planProposal(call(name, { plan: '## Goal\n1. Step' }))).toBe('## Goal\n1. Step');
    }
  });

  it('keeps a refused ExitPlanMode plan but drops a presentation the gateway refused', () => {
    // Planning mode refuses Claude's ExitPlanMode on purpose; its plan still stands.
    expect(planProposal(call('ExitPlanMode', { plan: 'Plan' }, 'error'))).toBe('Plan');
    // A refused presentation happened outside planning mode and never reached anyone.
    expect(planProposal(call('verity_present_plan', { plan: 'Plan' }, 'error'))).toBeNull();
  });

  it('ignores other tools and empty or malformed plans', () => {
    expect(planProposal(call('Bash', { plan: 'Plan' }))).toBeNull();
    expect(planProposal(call('verity_present_plan', { plan: '  ' }))).toBeNull();
    expect(planProposal(call('verity_present_plan', { plan: 3 }))).toBeNull();
  });
});
