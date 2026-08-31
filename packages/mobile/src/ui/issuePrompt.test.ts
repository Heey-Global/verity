import { describe, expect, it } from 'vitest';
import { buildIssuePrompt } from './issuePrompt.js';

describe('buildIssuePrompt (#137)', () => {
  it('includes the number, title, body and a closing PR instruction', () => {
    const prompt = buildIssuePrompt({
      number: 137,
      title: 'Issues on the overview',
      body: 'Show the backlog and spawn from it.',
    });
    expect(prompt).toBe(
      'Work on GitHub issue #137: Issues on the overview\n\n' +
        'Show the backlog and spawn from it.\n\n' +
        "Implement it end-to-end following this repo's conventions (branch, tests, " +
        'verity-code-review run then verity-code-review mark), and open a PR that ' +
        'closes #137.',
    );
  });

  it('names the review before the marker', () => {
    // `mark` alone satisfies the pre-push gate without reviewing anything, so a
    // seed prompt that abbreviates the gate to that command is an instruction to
    // turn it green on an unreviewed diff.
    const prompt = buildIssuePrompt({ number: 1, title: 't', body: '' });
    expect(prompt).toContain('verity-code-review run');
    expect(prompt.indexOf('verity-code-review run')).toBeLessThan(
      prompt.indexOf('verity-code-review mark'),
    );
  });

  it('omits the body section when the body is empty/whitespace', () => {
    const prompt = buildIssuePrompt({ number: 42, title: 'Quick fix', body: '   ' });
    expect(prompt).toBe(
      'Work on GitHub issue #42: Quick fix\n\n' +
        "Implement it end-to-end following this repo's conventions (branch, tests, " +
        'verity-code-review run then verity-code-review mark), and open a PR that ' +
        'closes #42.',
    );
    expect(prompt).not.toContain('\n\n\n'); // no empty body gap
  });

  it('trims the title and body', () => {
    const prompt = buildIssuePrompt({ number: 7, title: '  Padded  ', body: '  hi  ' });
    expect(prompt).toContain('issue #7: Padded\n\nhi\n\n');
  });
});
