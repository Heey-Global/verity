import { describe, expect, it } from 'vitest';
import {
  MOCKUPS_FIRST_PROMPT,
  mockupReviewPrompt,
  planningDesignNote,
  type DesignLevel,
} from './mockups.js';
import {
  COMPLETE_MOCKUPS_FOCUSED_TOOL,
  PRESENT_MOCKUPS_FOCUSED_TOOL,
  PRESENT_MOCKUPS_TOOL,
  isPresentMockupsTool,
} from './planning.js';

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

  it('starts the build only from the chat and ends the review first', () => {
    // Without the complete call the review bar and Home item stay after the build starts.
    expect(MOCKUPS_FIRST_PROMPT).toContain(COMPLETE_MOCKUPS_FOCUSED_TOOL);
    expect(MOCKUPS_FIRST_PROMPT).toMatch(/tells you in the chat to implement/);
    expect(MOCKUPS_FIRST_PROMPT).not.toMatch(/every screen was approved/);
  });
});

describe('mockupReviewPrompt', () => {
  const screens = [
    { name: 'Home', verdict: 'approved' as const },
    { name: 'Spec', verdict: 'discarded' as const },
    { name: 'Settings', verdict: 'open' as const },
  ];

  it('hands every mark to the agent while the round is under review', () => {
    const prompt = mockupReviewPrompt({ state: 'pending', screens });
    expect(prompt).toContain('- Home: approved');
    expect(prompt).toContain('- Spec: discarded');
    expect(prompt).toContain('- Settings: not marked yet');
    expect(prompt).toContain(PRESENT_MOCKUPS_FOCUSED_TOOL);
    expect(prompt).toContain(COMPLETE_MOCKUPS_FOCUSED_TOOL);
  });

  it('never reads approved marks as an instruction to build', () => {
    // All screens approved is still only an opinion: the user starts the build.
    const prompt = mockupReviewPrompt({
      state: 'pending',
      screens: screens.map((screen) => ({ ...screen, verdict: 'approved' as const })),
    });
    expect(prompt).toMatch(
      /implement the rest of a plan, until the user tells you in the chat to implement/,
    );
  });

  it.each([
    ['no review', undefined],
    ['an ended review', { state: 'approved', screens }],
    ['a review never presented', { state: null, screens: [] }],
  ])('adds nothing for %s', (_label, review) => {
    expect(mockupReviewPrompt(review)).toBe('');
  });
});
