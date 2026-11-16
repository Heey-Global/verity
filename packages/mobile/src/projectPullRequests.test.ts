import { describe, expect, it } from 'vitest';
import {
  pullRequestAction,
  pullRequestCounts,
  pullRequestSummary,
  type ProjectPullRequest,
} from './projectPullRequests.js';

function pull(
  state: ProjectPullRequest['state'],
  origin: ProjectPullRequest['origin'] = { kind: 'renovate' },
  viewerCanMerge: boolean | null = true,
): ProjectPullRequest {
  return {
    number: 1,
    title: 'PR',
    url: null,
    author: null,
    branch: 'b',
    headSha: 'abc1234',
    baseRef: 'main',
    fork: false,
    state,
    checks: null,
    viewerCanMerge,
    origin,
  };
}

describe('pullRequestSummary', () => {
  it('names failures and conflicts only when there are any', () => {
    const pulls = [pull('ready'), pull('failing'), pull('conflict'), pull('running')];
    expect(pullRequestSummary(pullRequestCounts(pulls))).toBe('4 open · 1 failing · 1 conflict');
    expect(pullRequestSummary(pullRequestCounts([pull('ready')]), 'PR')).toBe('1 open PR');
    expect(pullRequestSummary(pullRequestCounts([]), 'PR')).toBe('0 open PRs');
  });
});

describe('pullRequestAction', () => {
  it('leaves a session’s own failure to that session', () => {
    expect(pullRequestAction(pull('failing'))).toBe('fix');
    expect(pullRequestAction(pull('conflict', { kind: 'external' }))).toBe('fix');
    expect(
      pullRequestAction(pull('failing', { kind: 'session', sessionId: 's', name: null })),
    ).toBeNull();
  });

  it('offers merge only when green and the connection may merge', () => {
    expect(pullRequestAction(pull('ready'))).toBe('merge');
    expect(pullRequestAction(pull('ready', { kind: 'renovate' }, false))).toBeNull();
    expect(pullRequestAction(pull('running'))).toBeNull();
    expect(pullRequestAction(pull('blocked'))).toBeNull();
  });
});
