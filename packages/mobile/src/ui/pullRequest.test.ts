import { describe, expect, it } from 'vitest';
import {
  isPullRequestCheckingMergeability,
  isPullRequestConflicted,
  pullRequestMergeButton,
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
          mergeable: true,
          checks: { completed: 3, total: 3, successful: 3, failed: 0, pending: 0 },
        }),
      ),
    ).toBe('3/3 checks passed');
  });

  it("names GitHub's pending merge test instead of a bare 'checks passed'", () => {
    // The merge button stays off while `mergeable` is null; "3/3 checks passed" next
    // to a dead green button read as broken while github.com was still checking.
    const green = pr({
      pipeline: 'success',
      mergeable: null,
      checks: { completed: 3, total: 3, successful: 3, failed: 0, pending: 0 },
    });
    expect(isPullRequestCheckingMergeability(green)).toBe(true);
    expect(pullRequestStatusText(green)).toBe('checks passed · checking mergeability');
    expect(isPullRequestCheckingMergeability({ ...green, mergeable: true })).toBe(false);
    expect(isPullRequestCheckingMergeability({ ...green, mergeable: false })).toBe(false);
    expect(isPullRequestCheckingMergeability({ ...green, mergeState: 'dirty' })).toBe(false);
    expect(isPullRequestCheckingMergeability({ ...green, phase: 'merged' })).toBe(false);
    expect(isPullRequestCheckingMergeability({ ...green, pipeline: 'running' })).toBe(false);
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

describe('pullRequestMergeButton', () => {
  const idle = { merging: false, mergeRejected: false };
  const green = { completed: 3, total: 3, successful: 3, failed: 0, pending: 0 };

  it('enables merge only once GitHub confirms the PR can merge', () => {
    // The regression: green checks with `mergeable: null` used to look merge-ready in
    // the session list while the button was off. It must read as a wait, not a merge.
    expect(
      pullRequestMergeButton(pr({ pipeline: 'success', checks: green, mergeable: null }), idle),
    ).toEqual({ kind: 'waiting', label: 'Checking…' });
    expect(
      pullRequestMergeButton(pr({ pipeline: 'success', checks: green, mergeable: true }), idle),
    ).toEqual({ kind: 'merge', label: 'Merge' });
  });

  it('names the running phase without repeating the count, and a plain wait before any check reports', () => {
    expect(pullRequestMergeButton(pr(), idle)).toEqual({ kind: 'waiting', label: 'Running…' });
    const none = { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 };
    expect(pullRequestMergeButton(pr({ pipeline: 'pending', checks: none }), idle)).toEqual({
      kind: 'waiting',
      label: 'Waiting…',
    });
  });

  it('names the cause of a block', () => {
    expect(pullRequestMergeButton(pr({ pipeline: 'unknown', mergeState: 'dirty' }), idle)).toEqual({
      kind: 'blocked',
      reason: 'conflict',
      label: 'Conflict',
    });
    expect(pullRequestMergeButton(pr({ pipeline: 'failure' }), idle)).toEqual({
      kind: 'blocked',
      reason: 'ci_failed',
      label: 'CI failed',
    });
    expect(
      pullRequestMergeButton(pr({ pipeline: 'success', checks: green, mergeable: false }), idle),
    ).toEqual({ kind: 'blocked', reason: 'blocked', label: 'Blocked' });
    expect(
      pullRequestMergeButton(pr({ pipeline: 'success', checks: green, mergeable: true }), {
        merging: false,
        mergeRejected: true,
      }),
    ).toEqual({ kind: 'blocked', reason: 'rejected', label: 'Blocked' });
  });

  it('offers a refresh when GitHub reported neither checks nor a merge verdict', () => {
    expect(pullRequestMergeButton(pr({ pipeline: 'unknown', mergeable: null }), idle)).toEqual({
      kind: 'refresh',
      label: 'Refresh',
    });
  });

  it('keeps a repository without checks mergeable', () => {
    const none = { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 };
    for (const pipeline of ['success', 'unknown'] as const)
      expect(
        pullRequestMergeButton(pr({ pipeline, checks: none, mergeable: true }), idle).kind,
      ).toBe('merge');
  });

  it('lets GitHub merge past a failing check it does not require', () => {
    const unstable = pr({ pipeline: 'failure', mergeable: true, mergeState: 'unstable' });
    expect(pullRequestMergeButton(unstable, idle).kind).toBe('merge');
    // A required failure leaves the PR `blocked`, even though `mergeable` stays true.
    const required = pr({ pipeline: 'failure', mergeable: true, mergeState: 'blocked' });
    expect(pullRequestMergeButton(required, idle)).toMatchObject({ reason: 'ci_failed' });
  });

  it('treats a merged or closed PR as finished, not blocked', () => {
    // A blocked verdict there would paint a successfully merged PR's status red.
    for (const phase of ['merged', 'closed'] as const)
      expect(pullRequestMergeButton(pr({ phase, pipeline: 'success' }), idle)).toEqual({
        kind: 'closed',
      });
  });

  it('defers to an in-flight merge over every other state', () => {
    expect(
      pullRequestMergeButton(pr({ pipeline: 'failure' }), { merging: true, mergeRejected: false }),
    ).toEqual({ kind: 'merging' });
  });
});
