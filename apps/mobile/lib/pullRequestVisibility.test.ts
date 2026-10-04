import { shouldShowPullRequest } from './pullRequestVisibility';

it('shows an open PR before dismissal preferences have finished loading', () => {
  // Open PRs cannot be dismissed; waiting for unrelated storage hides a known bar.
  expect(shouldShowPullRequest('open', false, false)).toBe(true);
});

it('waits for preferences before showing a terminal PR and respects its dismissal', () => {
  for (const phase of ['merged', 'closed'] as const) {
    expect(shouldShowPullRequest(phase, false, false)).toBe(false);
    expect(shouldShowPullRequest(phase, true, true)).toBe(false);
    expect(shouldShowPullRequest(phase, true, false)).toBe(true);
  }
});

it('does not render a bar when no PR is known', () => {
  expect(shouldShowPullRequest(undefined, true, false)).toBe(false);
});
