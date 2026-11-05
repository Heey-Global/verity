import { describe, expect, it } from 'vitest';
import {
  PLANNING_ACTIVE_SYSTEM_PROMPT,
  PRESENT_PLAN_TOOL,
  planningToolName,
  parsePlanningProposal,
} from './planning.js';

describe('planningToolName', () => {
  it('recognizes a planning tool under every backend qualification', () => {
    // Claude, Codex and OpenCode each report the same gateway tool differently; a
    // form missed here renders that backend's plans as a plain tool card.
    for (const reported of [
      'verity_present_plan',
      'mcp__verity__verity_present_plan',
      'verity_verity_present_plan',
    ]) {
      expect(planningToolName(reported)).toBe(PRESENT_PLAN_TOOL);
    }
  });

  it('ignores other tools, including near misses', () => {
    expect(planningToolName('verity_gmail')).toBeUndefined();
    expect(planningToolName('present_plan')).toBeUndefined();
    expect(planningToolName('mcp__other__verity_present_plan')).toBeUndefined();
  });
});

describe('parsePlanningProposal', () => {
  it('extracts only accepted steps, excluding numbered questions and nested items', () => {
    expect(
      parsePlanningProposal(
        '# Swipe gestures\n\n## Goal\nAvoid conflicting gestures.\n\n## Steps\n1. **Threshold** — distinguish horizontal swipes.\n   Supporting detail.\n2. **Tests** — cover the threshold.\n\n## Open questions\n1. Haptics?',
      ),
    ).toEqual({
      title: 'Swipe gestures',
      goal: 'Avoid conflicting gestures.',
      steps: [
        '**Threshold** — distinguish horizontal swipes.\nSupporting detail.',
        '**Tests** — cover the threshold.',
      ],
      outOfScope: '',
      criteria: [],
      decisions: [],
    });
  });
  it('keeps legacy numbered plans readable', () => {
    expect(parsePlanningProposal('1. First\n2. Second').steps).toEqual(['First', 'Second']);
  });
});

describe('parsePlanningProposal spec sections', () => {
  const spec = [
    '# Pricing page',
    '',
    '## Goal',
    'Pick a plan and reach checkout in two taps.',
    '',
    '## Out of scope',
    'Coupons and invoices.',
    '',
    '## Acceptance criteria',
    '- Toggle above the plans',
    '- Recommended plan highlighted',
    '  on every width',
    '',
    '## Open decisions',
    '1. **Show prices incl. VAT?** — Incl. VAT (recommended) | Excl. VAT',
    '2. Which payment provider?',
    '',
    '## Steps',
    '1. **Page** — build the pricing page.',
    '2. **Tests** — cover the toggle.',
  ].join('\n');

  it('reads scope, criteria and decisions without turning them into steps', () => {
    // Steps become accepted tasks; a criterion or decision counted as a step
    // would land in the task list as work nobody agreed to.
    expect(parsePlanningProposal(spec)).toEqual({
      title: 'Pricing page',
      goal: 'Pick a plan and reach checkout in two taps.',
      steps: ['**Page** — build the pricing page.', '**Tests** — cover the toggle.'],
      outOfScope: 'Coupons and invoices.',
      criteria: ['Toggle above the plans', 'Recommended plan highlighted\non every width'],
      decisions: [
        {
          question: 'Show prices incl. VAT?',
          options: ['Incl. VAT', 'Excl. VAT'],
          recommended: 'Incl. VAT',
        },
        { question: 'Which payment provider?', options: [] },
      ],
    });
  });

  it.each([
    [
      '**Region?** - EU | US (empfohlen)',
      { question: 'Region?', options: ['EU', 'US'], recommended: 'US' },
    ],
    ['**Region?**: EU | US', { question: 'Region?', options: ['EU', 'US'] }],
    [
      'Region? — EU (Recommended) | US',
      { question: 'Region?', options: ['EU', 'US'], recommended: 'EU' },
    ],
    ['- Keep the old endpoint', { question: 'Keep the old endpoint', options: [] }],
  ])('reads the decision %s', (line, decision) => {
    const item = line.startsWith('- ') ? line : `1. ${line}`;
    expect(
      parsePlanningProposal(`## Open decisions\n${item}\n## Steps\n1. Do it`).decisions,
    ).toEqual([decision]);
  });

  it('folds nested bullets into the item above instead of counting them', () => {
    // Options written as sub-bullets would otherwise each become a decision
    // nobody can answer, locking the plan.
    const plan = parsePlanningProposal(
      '## Open decisions\n1. **Region?**\n   - EU\n   - US\n## Acceptance criteria\n- Fast\n  - under 200 ms\n## Steps\n1. Do it',
    );
    expect(plan.decisions.map((decision) => decision.question)).toEqual(['Region?']);
    expect(plan.criteria).toEqual(['Fast\n- under 200 ms']);
  });

  it.each(['None', 'None.', 'N/A', 'n.a.', 'Keine'])(
    'does not block on the placeholder %s',
    (placeholder) => {
      // Agents write out empty sections; a placeholder would lock the plan with
      // nothing to answer.
      expect(
        parsePlanningProposal(`## Open decisions\n- ${placeholder}\n## Steps\n1. Do it`).decisions,
      ).toEqual([]);
    },
  );

  it('does not block on decisions recorded as already made', () => {
    expect(
      parsePlanningProposal('## Decisions made\n1. EU hosting\n## Steps\n1. Do it').decisions,
    ).toEqual([]);
  });

  it('keeps free-form open questions out of the blocking decisions', () => {
    // Plans written before this format list "Open questions"; reading them as
    // decisions would lock their Implement button with no way to answer.
    expect(
      parsePlanningProposal('## Steps\n1. Do it\n## Open questions\n1. Haptics?').decisions,
    ).toEqual([]);
  });

  it('documents for the agent exactly the decision format the parser reads', () => {
    const example = /^1\. \*\*Question.*$/m.exec(PLANNING_ACTIVE_SYSTEM_PROMPT)?.[0];
    expect(example).toBeDefined();
    const [decision] = parsePlanningProposal(`## Open decisions\n${example}`).decisions;
    expect(decision?.options.length).toBeGreaterThan(1);
    expect(decision?.recommended).toBe(decision?.options[0]);
  });
});
