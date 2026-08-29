import type { SessionPr } from './api.js';

export interface PullRequestStatusMutation {
  sessionId: string;
  /** Exact action projection when known; absent requests immediate reconciliation. */
  pr?: SessionPr;
}

type Listener = (mutation: PullRequestStatusMutation) => void;
const listeners = new Set<Listener>();

/** Publish a PR action result so mounted status projections update before polling. */
export function publishPullRequestStatusMutation(mutation: PullRequestStatusMutation): void {
  for (const listener of listeners) listener(mutation);
}

export function subscribePullRequestStatusMutations(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
