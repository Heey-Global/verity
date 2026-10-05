import { describe, expect, it } from 'vitest';
import { PRESENT_PLAN_TOOL, planningToolName } from './planning.js';

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
