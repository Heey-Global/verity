import { describe, expect, it } from 'vitest';
import { REPO_CONVENTIONS_SYSTEM_PROMPT } from './repo-conventions.js';

describe('REPO_CONVENTIONS_SYSTEM_PROMPT', () => {
  it('states the branch shape the Issue chip parses', () => {
    expect(REPO_CONVENTIONS_SYSTEM_PROMPT).toContain('<type>/<issue>-<slug>');
    expect(REPO_CONVENTIONS_SYSTEM_PROMPT).toContain('Issue chip');
    // That the worked examples actually survive the header's parser is asserted
    // against the real `parseBranchIssue` in
    // `packages/mobile/src/ui/branchRef.test.ts` — this package cannot import
    // mobile (the dependency runs the other way), and re-implementing the regex
    // here would only assert that a copy agrees with itself.
  });

  it('requires Conventional Commit titles and names the breaking-change markers', () => {
    expect(REPO_CONVENTIONS_SYSTEM_PROMPT).toContain('Conventional Commits');
    expect(REPO_CONVENTIONS_SYSTEM_PROMPT).toContain('BREAKING CHANGE:');
  });

  it('yields to a repository that uses another convention', () => {
    expect(REPO_CONVENTIONS_SYSTEM_PROMPT).toMatch(/follow the repository/i);
  });
});
