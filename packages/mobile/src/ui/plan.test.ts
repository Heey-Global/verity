import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../happy/message.js';
import {
  planHeadline,
  planProposalContent,
  planProposal,
  planProposalRevision,
  planProposalDisplay,
  planProposalHeadline,
  planView,
} from './plan.js';

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

  it('reads the plan out of the arguments Codex wraps an MCP call input in', () => {
    expect(
      planProposal(
        call('mcp__verity__verity_present_plan', {
          server: 'verity',
          tool: 'verity_present_plan',
          arguments: { plan: '1. Step' },
        }),
      ),
    ).toBe('1. Step');
  });

  it('keeps a refused ExitPlanMode plan but drops a presentation the gateway refused', () => {
    // Planning mode refuses Claude's ExitPlanMode on purpose; its plan still stands.
    expect(planProposal(call('ExitPlanMode', { plan: 'Plan' }, 'error'))).toBe('Plan');
    // A refused presentation happened outside planning mode and never reached anyone.
    expect(planProposal(call('verity_present_plan', { plan: 'Plan' }, 'error'))).toBeNull();
  });

  it('waits for the gateway to accept a plan before offering it', () => {
    expect(planProposal(call('verity_present_plan', { plan: 'Plan' }, 'running'))).toBeNull();
  });

  it('ignores other tools and empty or malformed plans', () => {
    expect(planProposal(call('Bash', { plan: 'Plan' }))).toBeNull();
    expect(planProposal(call('verity_present_plan', { plan: '  ' }))).toBeNull();
    expect(planProposal(call('verity_present_plan', { plan: 3 }))).toBeNull();
  });
});

describe('planProposalRevision', () => {
  it('reads the displayed presentation revision from MCP text', () => {
    const tool = call('verity_present_plan', { plan: 'First' });
    tool.result = {
      content: [{ type: 'text', text: JSON.stringify({ presented: true, planningRevision: 3 }) }],
    };
    expect(planProposalRevision(tool)).toBe(3);
    expect(planProposalRevision({ ...tool, state: 'error' })).toBeUndefined();
    expect(planProposalRevision({ ...tool, result: { planningRevision: -1 } })).toBeUndefined();
  });
});

describe('planProposalDisplay', () => {
  it('updates both displayed text and approval revision together', () => {
    const shown = { markdown: 'Old plan', revision: 2 };
    const current = { planningPlan: 'New plan', planningRevision: 3 };
    expect(planProposalDisplay(shown, true, current)).toEqual({
      markdown: 'New plan',
      revision: 3,
    });
    expect(planProposalDisplay(shown, false, current)).toEqual(shown);
    expect(planProposalDisplay(shown, true, { planningRevision: 3 })).toEqual(shown);
    expect(
      planProposalDisplay(shown, true, { planningPlan: 'Older poll', planningRevision: 1 }),
    ).toEqual(shown);
  });
});

describe('planProposalHeadline', () => {
  it('counts the top-level steps of the Steps section only', () => {
    const plan = [
      '## Goal',
      '1. Not a step, just a numbered goal line.',
      '',
      '## Steps',
      '1. **Server** — allow the task list.',
      '   1. A sub-step belongs to its parent.',
      '2. **App** — show the step count.',
      '10. **Docs** — two-digit numbers count too.',
      '',
      '## Open questions',
      '1. Not a step either.',
    ].join('\n');
    expect(planProposalHeadline(plan)).toBe('Plan · 3 steps');
  });

  it('falls back to every numbered item, and to a bare title without any', () => {
    expect(planProposalHeadline('1. Only step')).toBe('Plan · 1 step');
    expect(planProposalHeadline('Free text, no list.')).toBe('Plan');
  });
});

describe('planProposalContent', () => {
  it('separates the submitted plan without rendering questions as steps', () => {
    expect(
      planProposalContent(
        '# Separate gestures\n\n## Goal\nAvoid accidental drags.\n\n## Steps\n1. **Threshold** — change detection.\n2. **Tests** — verify scrolling.\n\n## Open questions\n- Haptics?',
      ),
    ).toEqual({
      title: 'Separate gestures',
      goal: 'Avoid accidental drags.',
      steps: ['**Threshold** — change detection.', '**Tests** — verify scrolling.'],
    });
  });
  it('keeps old plain plans readable and preserves multiline steps', () => {
    expect(planProposalContent('A plain plan')).toEqual({
      title: '',
      goal: 'A plain plan',
      steps: [],
    });
    expect(planProposalContent('## Steps\n1. Change detection\n   and verify it.')).toEqual({
      title: '',
      goal: '',
      steps: ['Change detection\nand verify it.'],
    });
  });
});

it('counts only the numbered steps when the goal also contains a numbered list', () => {
  const markdown =
    '## Goal\n1. Describe the outcome.\n## Steps\n1. Make the change.\n2. Verify it.';
  expect(planProposalContent(markdown).steps).toEqual(['Make the change.', 'Verify it.']);
  expect(planProposalHeadline(markdown)).toBe('Plan · 2 steps');
});
