import { describe, expect, it } from 'vitest';
import { PULL_REQUEST_SYSTEM_PROMPT, repoToolPullRequestSystemPrompt } from './pull-requests.js';

describe('PULL_REQUEST_SYSTEM_PROMPT', () => {
  it('forbids draft pull requests and names the escape hatch', () => {
    expect(PULL_REQUEST_SYSTEM_PROMPT).toMatch(/never a draft/i);
    expect(PULL_REQUEST_SYSTEM_PROMPT).toContain('--draft');
    expect(PULL_REQUEST_SYSTEM_PROMPT).toContain('gh pr ready');
  });
});

describe('repoToolPullRequestSystemPrompt', () => {
  const prompt = repoToolPullRequestSystemPrompt('Forgejo');
  it('names the host, the tool and the draft rule, and rules out gh', () => {
    expect(prompt).toContain("This project's code host is Forgejo");
    expect(prompt).toMatch(/never a draft/i);
    expect(prompt).toContain('WIP:');
    for (const command of [
      'pr create',
      'pr ready',
      'pr view',
      'issue list',
      'issue view',
      'issue comment',
    ])
      expect(prompt).toContain(`verity-repo ${command}`);
    expect(prompt).toContain('does not work here');
  });
});
