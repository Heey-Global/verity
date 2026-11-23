import type { ChangeSubmissionPerson, ChangeSubmissionState } from '../changeSubmissions.js';

/** What the session's change bar says, and the one thing it offers. */
export interface ChangeSubmissionBarModel {
  title: string;
  subtitle: string;
  action?: { kind: 'submit' | 'open_pr'; label: string };
}

const nameOf = (person: ChangeSubmissionPerson | undefined, fallback: string) =>
  person?.name ?? fallback;

/**
 * The bar above the composer for a session's submitted changes (ADR 0023). A
 * member without Code submits and then follows where the changes stand; a member
 * with Code sees who submitted until a pull request takes over, after which the
 * existing pull request bar shows it. `undefined` hides the bar.
 */
export function changeSubmissionBar(input: {
  state: ChangeSubmissionState;
  /** Whether the pull request bar is already on screen. */
  pullRequestShown: boolean;
  /** What the project is called, e.g. "the project". */
  noun: string;
  /** A local project adds changes with "Save to project", not a pull request. */
  local?: boolean;
}): ChangeSubmissionBarModel | undefined {
  const { submission, viewerCanCode, viewerCanSubmit, hasChanges } = input.state;
  if (viewerCanCode) {
    // The save bar already offers the one way to add a local project's changes.
    if (submission === null || input.pullRequestShown || input.local === true) return undefined;
    if (submission.status !== 'waiting' && submission.status !== 'checking') return undefined;
    return {
      title: `${nameOf(submission.submittedBy, 'A member')} submitted changes`,
      subtitle:
        submission.checker === undefined
          ? 'Check them, then open a pull request'
          : `${nameOf(submission.checker, 'A developer')} is checking`,
      action: { kind: 'open_pr', label: 'Open PR' },
    };
  }
  if (submission === null) {
    // Nothing to hand over yet. Unknown counts as changed: offering a submission
    // that turns out empty costs less than hiding one that is not.
    if (hasChanges === false || viewerCanSubmit === false) return undefined;
    return {
      title: 'Changes from this session',
      subtitle: `A developer checks them and adds them to ${input.noun}`,
      action: { kind: 'submit', label: 'Submit changes' },
    };
  }
  switch (submission.status) {
    case 'waiting':
      return { title: 'Submitted', subtitle: 'Waiting for a developer' };
    case 'checking':
      return {
        title: 'Submitted',
        subtitle: `${nameOf(submission.checker, 'A developer')} is checking`,
      };
    case 'adding':
      return {
        title: 'Submitted',
        subtitle: `${nameOf(submission.checker, 'A developer')} is adding them`,
      };
    case 'added':
      return { title: `Added to ${input.noun}`, subtitle: 'Changes from this session' };
  }
}

/** What a member with Code asks the agent when opening a pull request for them. */
export function openPullRequestPrompt(submittedBy: ChangeSubmissionPerson): string {
  return `Open a pull request with the changes ${nameOf(submittedBy, 'a member')} submitted in this session.`;
}
