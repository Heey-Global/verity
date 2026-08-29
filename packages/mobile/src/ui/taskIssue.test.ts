import { describe, expect, it } from 'vitest';
import { composeRefinedIssueBody } from './taskIssue.js';

describe('composeRefinedIssueBody', () => {
  it('renders problem + non-empty sections as markdown', () => {
    expect(
      composeRefinedIssueBody({
        title: 'Add dark mode toggle',
        problem: 'Users want a dark theme.',
        acceptanceCriteria: ['Toggle in settings', 'Persists'],
        affectedAreas: ['settings.tsx'],
        openQuestions: ['OS default?'],
      }),
    ).toBe(
      'Users want a dark theme.\n\n' +
        '## Acceptance criteria\n- Toggle in settings\n- Persists\n\n' +
        '## Affected areas\n- settings.tsx\n\n' +
        '## Open questions\n- OS default?',
    );
  });

  it('omits empty sections (just the problem when all lists are empty)', () => {
    expect(
      composeRefinedIssueBody({
        title: 'T',
        problem: 'Just the problem.',
        acceptanceCriteria: [],
        affectedAreas: [],
        openQuestions: [],
      }),
    ).toBe('Just the problem.');
  });
});
