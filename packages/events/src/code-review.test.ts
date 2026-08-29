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

  it('rules out the two improvised alternatives', () => {
    expect(CODE_REVIEW_SYSTEM_PROMPT).toMatch(/inline in this chat/i);
    expect(CODE_REVIEW_SYSTEM_PROMPT).toContain('code_review');
    expect(CODE_REVIEW_SYSTEM_PROMPT).toMatch(/--no-verify/);
  });
});
