import { describe, expect, it } from 'vitest';
import { PRESENT_PLAN_TOOL, planningToolName, parsePlanningProposal } from './planning.js';

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
    });
  });
  it('keeps legacy numbered plans readable', () => {
    expect(parsePlanningProposal('1. First\n2. Second').steps).toEqual(['First', 'Second']);
  });
});
