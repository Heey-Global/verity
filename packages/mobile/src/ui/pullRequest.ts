import type { SessionPr } from '../api.js';

/**
 * The pure parts of the session's PR status bar: is the PR blocked by a merge
 * conflict, and what does its status line say. Lives here (not in the RN screen) so
 * the exact case that used to read as a dead end — a PR GitHub refuses to build a
 * merge ref for — is unit-testable. See {@link isPullRequestConflicted}.
 */

/** The status-bar inputs. A structural subset of the branch endpoint's `pullRequest`
 * (which carries title/url/number too), so both that and the compact
 * {@link SessionPr} projection satisfy it. */
export interface PullRequestStatusView extends SessionPr {
  checks: {
    completed: number;
    total: number;
    successful: number;
    failed: number;
    pending: number;
  };
  baseRef?: string | undefined;
}

/**
 * Whether the PR is blocked by a genuine merge conflict.
 *
 * `mergeable_state: 'dirty'` is the only signal for this, and it must be read
 * INDEPENDENTLY of the pipeline: GitHub builds no merge ref for a conflicting PR, so
 * its `pull_request` workflows never start, `checks.total` stays 0 and the pipeline
 * reads `unknown` forever. Judged by CI alone such a PR is indistinguishable from one
 * whose CI simply hasn't reported yet — which is why it used to render as the
 * dead-end "status unavailable".
 */
export function isPullRequestConflicted(pr: PullRequestStatusView): boolean {
  return pr.phase === 'open' && pr.mergeState === 'dirty';
}

/**
 * Whether GitHub is still computing mergeability for a PR whose checks are green.
 *
 * Right after a push (or a base-branch move) GitHub answers `mergeable: null` until
 * its background merge test finishes — the "Checking for the ability to merge
 * automatically…" box on github.com. The merge button must stay off until it
 * settles, and without naming the wait it reads as a dead green button next to
 * "all checks passed".
 */
export function isPullRequestCheckingMergeability(pr: PullRequestStatusView): boolean {
  return (
    pr.phase === 'open' &&
    pr.pipeline === 'success' &&
    pr.mergeable === null &&
    !isPullRequestConflicted(pr)
  );
}

/** The status line's second half ("open · <this>"). */
export function pullRequestStatusText(pr: PullRequestStatusView): string {
  const merged = pr.phase === 'merged';
  const unit = merged ? 'Actions' : 'checks';
  const { checks } = pr;
  if (isPullRequestConflicted(pr)) {
    return `conflicts with ${pr.baseRef ?? 'the base branch'}`;
  }
  // No checks AND no conflict to explain it: either GitHub hasn't answered (unknown)
  // or nothing has been reported for this PR yet.
  if (pr.pipeline === 'unknown') return 'status unavailable';
  if (checks.total === 0) return merged ? 'No Actions' : 'waiting for checks';
  if (pr.pipeline === 'failure') {
    return `${String(checks.failed)}/${String(checks.total)} ${unit} failed`;
  }
  if (pr.pipeline === 'pending' || pr.pipeline === 'running') {
    return `${String(checks.completed)}/${String(checks.total)} ${unit} run`;
  }
  if (isPullRequestCheckingMergeability(pr)) return 'checks passed · checking mergeability';
  return `${String(checks.total)}/${String(checks.total)} ${unit} passed`;
}

export type PullRequestBlockReason = 'rejected' | 'conflict' | 'ci_failed' | 'blocked';

/**
 * What the merge button shows. `waiting` covers every state that resolves on its
 * own (checks pending or running, GitHub computing mergeability): the button carries
 * the spinner, so nothing else on the screen has to pulse. `blocked` names its cause
 * so the button never just says "no" while the reason sits in a different line.
 * `closed` is a terminal PR, which has nothing left to merge.
 */
export type PullRequestMergeButton =
  | { kind: 'merge'; label: 'Merge' }
  | { kind: 'merging' }
  | { kind: 'waiting'; label: string }
  | { kind: 'blocked'; reason: PullRequestBlockReason; label: string }
  | { kind: 'refresh'; label: 'Refresh' }
  | { kind: 'closed' };

const BLOCK_LABELS: Record<PullRequestBlockReason, string> = {
  rejected: 'Blocked',
  conflict: 'Conflict',
  ci_failed: 'CI failed',
  blocked: 'Blocked',
};

const blocked = (reason: PullRequestBlockReason): PullRequestMergeButton => ({
  kind: 'blocked',
  reason,
  label: BLOCK_LABELS[reason],
});

export function pullRequestMergeButton(
  pr: PullRequestStatusView,
  state: { merging: boolean; mergeRejected: boolean },
): PullRequestMergeButton {
  if (state.merging) return { kind: 'merging' };
  if (pr.phase !== 'open') return { kind: 'closed' };
  if (state.mergeRejected) return blocked('rejected');
  if (isPullRequestConflicted(pr)) return blocked('conflict');
  // A failing check that is not required leaves the PR `unstable`, and GitHub still
  // merges it; only a failure GitHub enforces blocks the button.
  if (pr.pipeline === 'failure' && !(pr.mergeable === true && pr.mergeState === 'unstable')) {
    return blocked('ci_failed');
  }
  if (pr.pipeline === 'pending' || pr.pipeline === 'running') {
    return pr.checks.total === 0
      ? { kind: 'waiting', label: 'Waiting…' }
      : {
          kind: 'waiting',
          label: `CI ${String(pr.checks.completed)}/${String(pr.checks.total)}`,
        };
  }
  // GitHub's own merge verdict outranks a CI status it could not report: a repository
  // without checks still merges. Anything short of that with no status is a status to
  // re-read, not a block to explain.
  if (pr.mergeable === true) return { kind: 'merge', label: 'Merge' };
  if (pr.pipeline === 'unknown') return { kind: 'refresh', label: 'Refresh' };
  if (pr.mergeable === false) return blocked('blocked');
  return { kind: 'waiting', label: 'Checking…' };
}
