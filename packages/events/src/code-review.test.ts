import { describe, expect, it } from 'vitest';
import { CODE_REVIEW_SYSTEM_PROMPT } from './code-review.js';

describe('CODE_REVIEW_SYSTEM_PROMPT', () => {
  it('names the review command, not only the marker', () => {
    // The whole point of the fragment: the hook used to hand the agent `mark`
    // alone, which is the one command that satisfies the gate without reviewing
    // anything. `run` has to be present and has to come first.
    expect(CODE_REVIEW_SYSTEM_PROMPT).toContain('verity-code-review run');
    expect(CODE_REVIEW_SYSTEM_PROMPT).toContain('verity-code-review mark');
    expect(CODE_REVIEW_SYSTEM_PROMPT.indexOf('verity-code-review run')).toBeLessThan(
      CODE_REVIEW_SYSTEM_PROMPT.indexOf('verity-code-review mark'),
    );
  });

  it('says the marker verifies nothing and names the marker path', () => {
    expect(CODE_REVIEW_SYSTEM_PROMPT).toContain('.agents/.last-code-review-sha');
    expect(CODE_REVIEW_SYSTEM_PROMPT).toMatch(/verifies nothing/i);
  });

  it('triages findings without turning cleanup into more scope', () => {
    expect(CODE_REVIEW_SYSTEM_PROMPT).toMatch(/fix BLOCKER and HIGH findings/i);
    expect(CODE_REVIEW_SYSTEM_PROMPT).toMatch(/MEDIUM.*in scope/i);
    expect(CODE_REVIEW_SYSTEM_PROMPT).toMatch(/do not expand the task for LOW cleanup/i);
    expect(CODE_REVIEW_SYSTEM_PROMPT).toMatch(/declined with a brief reason/i);
    expect(CODE_REVIEW_SYSTEM_PROMPT).toMatch(
      /declined finding alone does not require another pass/i,
    );
  });

  it('rules out the two improvised alternatives', () => {
    expect(CODE_REVIEW_SYSTEM_PROMPT).toMatch(/inline in this chat/i);
    expect(CODE_REVIEW_SYSTEM_PROMPT).toContain('code_review');
    expect(CODE_REVIEW_SYSTEM_PROMPT).toMatch(/--no-verify/);
  });
});
