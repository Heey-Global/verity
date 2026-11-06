import { describe, expect, it } from 'vitest';
import {
  MOCKUPS_FIRST_PROMPT,
  mockupFeedbackDisplay,
  mockupFeedbackPrompt,
  planningDesignNote,
  type DesignLevel,
} from './mockups.js';
import { PRESENT_MOCKUPS_TOOL, isPresentMockupsTool } from './planning.js';

describe('isPresentMockupsTool', () => {
  it.each([
    PRESENT_MOCKUPS_TOOL,
    `mcp__verity__${PRESENT_MOCKUPS_TOOL}`,
    `verity_${PRESENT_MOCKUPS_TOOL}`,
    'verity_mockups_present',
    'mcp__verity__verity_mockups_present',
  ])('recognizes %s', (name) => {
    // The chat shows the gallery only for calls it recognizes; a backend's own
    // qualification that slips through leaves the review without its images.
    expect(isPresentMockupsTool(name)).toBe(true);
  });

  it.each(['mcp__other__verity_present_mockups', 'verity_present_plan', 'present_mockups'])(
    'ignores %s',
    (name) => {
      expect(isPresentMockupsTool(name)).toBe(false);
    },
  );
});

describe('design prompts', () => {
  it('asks for mockups of every UI change only at the required level', () => {
    const levels: DesignLevel[] = ['off', 'on_request', 'required'];
    const requiring = levels.filter((level) => /requires mockups/.test(planningDesignNote(level)));
    expect(requiring).toEqual(['required']);
  });

  it('tells the agent to stop after presenting', () => {
    expect(MOCKUPS_FIRST_PROMPT).toContain(PRESENT_MOCKUPS_TOOL);
    expect(MOCKUPS_FIRST_PROMPT).toMatch(/end your turn/);
  });

  it('passes every comment with the screen it belongs to', () => {
    const prompt = mockupFeedbackPrompt([
      { name: 'Home', verdict: 'approved' },
      { name: 'Spec', verdict: 'comment', comment: 'Decision above the criteria.' },
    ]);
    expect(prompt).toContain('- Spec: Decision above the criteria.');
    expect(prompt).toContain('- Home: approved');
    expect(mockupFeedbackDisplay(1)).toBe('1 mockup comment');
    expect(mockupFeedbackDisplay(2)).toBe('2 mockup comments');
  });
});
