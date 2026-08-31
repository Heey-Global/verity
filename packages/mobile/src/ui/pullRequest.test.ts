import { describe, expect, it } from 'vitest';
import {
  isPullRequestConflicted,
  pullRequestStatusText,
  type PullRequestStatusView,
} from './pullRequest.js';

const pr = (over: Partial<PullRequestStatusView> = {}): PullRequestStatusView => ({
  phase: 'open',
  pipeline: 'running',
  mergeable: null,
  checks: { completed: 1, total: 3, successful: 1, failed: 0, pending: 2 },
  ...over,
});

describe('isPullRequestConflicted', () => {
  it('is true only for an OPEN PR GitHub reports as dirty', () => {
    expect(isPullRequestConflicted(pr({ pipeline: 'unknown', mergeState: 'dirty' }))).toBe(true);
    expect(isPullRequestConflicted(pr({ phase: 'merged', mergeState: 'dirty' }))).toBe(false);
    expect(isPullRequestConflicted(pr({ phase: 'closed', mergeState: 'dirty' }))).toBe(false);
  });

  it('is false for every other merge state, including an absent one', () => {
    for (const mergeState of [
      'clean',
      'blocked',
      'behind',
      'unstable',
      'draft',
      'unknown',
    ] as const)
      expect(isPullRequestConflicted(pr({ mergeState }))).toBe(false);
    expect(isPullRequestConflicted(pr())).toBe(false);
  });
});

describe('pullRequestStatusText', () => {
  it('names the conflict instead of reporting the absent pipeline', () => {
    // The regression: a conflicted PR has NO checks, because GitHub starts none for
    // it. Reading only the pipeline left the bar stuck on "status unavailable", with
    // nothing pointing at the actual blocker.
    const conflicted = pr({
      pipeline: 'unknown',
      mergeable: false,
      mergeState: 'dirty',
      checks: { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 },
      baseRef: 'main',
    });
    expect(pullRequestStatusText(conflicted)).toBe('conflicts with main');
  });

  it('falls back to a generic base name when the branch is unknown', () => {
    expect(pullRequestStatusText(pr({ pipeline: 'unknown', mergeState: 'dirty' }))).toBe(
      'conflicts with the base branch',
    );
  });

  it('still reports an unavailable status when nothing explains the missing checks', () => {
    expect(pullRequestStatusText(pr({ pipeline: 'unknown' }))).toBe('status unavailable');
  });

  it('reports check counts for the ordinary pipeline states', () => {
    expect(pullRequestStatusText(pr({ pipeline: 'running' }))).toBe('1/3 checks run');
    expect(pullRequestStatusText(pr({ pipeline: 'pending' }))).toBe('1/3 checks run');
    expect(
      pullRequestStatusText(
        pr({
          pipeline: 'failure',
          checks: { completed: 3, total: 3, successful: 2, failed: 1, pending: 0 },
        }),
      ),
    ).toBe('1/3 checks failed');
    expect(
      pullRequestStatusText(
        pr({
          pipeline: 'success',
          checks: { completed: 3, total: 3, successful: 3, failed: 0, pending: 0 },
        }),
      ),
    ).toBe('3/3 checks passed');
  });

  it('waits for checks that have not appeared yet, and calls them Actions once merged', () => {
    const none = { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 };
    expect(pullRequestStatusText(pr({ pipeline: 'pending', checks: none }))).toBe(
      'waiting for checks',
    );
    expect(pullRequestStatusText(pr({ phase: 'merged', pipeline: 'pending', checks: none }))).toBe(
      'No Actions',
    );
    expect(
      pullRequestStatusText(
        pr({
          phase: 'merged',
          pipeline: 'success',
          checks: { completed: 2, total: 2, successful: 2, failed: 0, pending: 0 },
        }),
      ),
    ).toBe('2/2 Actions passed');
  });
});
