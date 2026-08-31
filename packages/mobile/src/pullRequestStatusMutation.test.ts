import { describe, expect, it, vi } from 'vitest';
import {
  publishPullRequestStatusMutation,
  subscribePullRequestStatusMutations,
} from './pullRequestStatusMutation.js';

describe('pull request status mutations', () => {
  it('publishes to mounted projections and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePullRequestStatusMutations(listener);
    const mutation = {
      sessionId: 's1',
      pr: { phase: 'merged', pipeline: 'success', mergeable: false } as const,
    };

    publishPullRequestStatusMutation(mutation);
    unsubscribe();
    publishPullRequestStatusMutation(mutation);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(mutation);
  });
});
