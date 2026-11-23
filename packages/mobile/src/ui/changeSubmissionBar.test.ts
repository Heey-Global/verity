import { describe, expect, it } from 'vitest';

import type { ChangeSubmission, ChangeSubmissionState } from '../changeSubmissions.js';
import { agentEventDescriptor } from './agentEvent.js';
import { changeSubmissionBar } from './changeSubmissionBar.js';

const submitted = (over: Partial<ChangeSubmission> = {}): ChangeSubmission => ({
  status: 'waiting',
  submittedBy: { id: 'mara', name: 'Mara' },
  submittedAt: 1,
  ...over,
});
const bar = (state: ChangeSubmissionState, pullRequestShown = false) =>
  changeSubmissionBar({ state, pullRequestShown, noun: 'the project' });
const titles = (state: ChangeSubmissionState) => {
  const model = bar(state);
  return model && [model.title, model.subtitle, model.action?.label];
};

describe('change submission bar without Code', () => {
  const editor = (submission: ChangeSubmission | null, hasChanges?: boolean) => ({
    submission,
    viewerCanCode: false,
    ...(hasChanges === undefined ? {} : { hasChanges }),
  });

  it('offers to submit changed work, and nothing when there is none', () => {
    expect(titles(editor(null, true))).toEqual([
      'Changes from this session',
      'A developer checks them and adds them to the project',
      'Submit changes',
    ]);
    // An older server cannot tell; offering is the safer mistake.
    expect(bar(editor(null))?.action?.kind).toBe('submit');
    expect(bar(editor(null, false))).toBeUndefined();
    // A reader cannot submit; the button would only end in a refusal.
    expect(bar({ ...editor(null, true), viewerCanSubmit: false })).toBeUndefined();
  });

  it('follows the submission until the changes are added', () => {
    const alex = { id: 'alex', name: 'Alex' };
    expect(titles(editor(submitted()))).toEqual([
      'Submitted',
      'Waiting for a developer',
      undefined,
    ]);
    expect(titles(editor(submitted({ status: 'checking', checker: alex })))).toEqual([
      'Submitted',
      'Alex is checking',
      undefined,
    ]);
    expect(titles(editor(submitted({ status: 'adding', checker: alex })))).toEqual([
      'Submitted',
      'Alex is adding them',
      undefined,
    ]);
    expect(titles(editor(submitted({ status: 'adding' })))).toContain('A developer is adding them');
    // Follow-up work in the same session must remain submittable.
    expect(titles(editor(submitted({ status: 'added' })))).toEqual([
      'Added to the project',
      'Submit again when there is more',
      'Submit changes',
    ]);
  });
});

describe('change submission bar with Code', () => {
  const developer = (submission: ChangeSubmission | null) => ({ submission, viewerCanCode: true });

  it('names who submitted and offers a pull request until one is on screen', () => {
    expect(bar(developer(null))).toBeUndefined();
    expect(titles(developer(submitted()))).toEqual([
      'Mara submitted changes',
      'Check them, then open a pull request',
      'Open PR',
    ]);
    // The pull request bar takes over; two bars would offer two ways to add.
    expect(bar(developer(submitted({ status: 'checking' })), true)).toBeUndefined();
    expect(bar(developer(submitted({ status: 'adding' })))).toBeUndefined();
    expect(bar(developer(submitted({ status: 'added' })))).toBeUndefined();
    // A local project has no pull requests; its save bar adds the changes.
    expect(
      changeSubmissionBar({
        state: developer(submitted()),
        pullRequestShown: false,
        noun: 'the project',
        local: true,
      }),
    ).toBeUndefined();
  });
});

it('shows a submission in the history as a quiet line', () => {
  expect(
    agentEventDescriptor({
      t: 'notice',
      text: 'Mara submitted changes',
      changeSubmission: { action: 'submitted', userId: 'mara' },
    }),
  ).toEqual({ kind: 'change-submission', label: 'Mara submitted changes', tone: 'neutral' });
});
