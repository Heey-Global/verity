import type { SessionSummary } from '../api.js';
import { sessionAttention, type AttentionFlag } from './attention.js';
import type { InboxItem } from './inbox.js';
import { workOrder } from './workOrder.js';

/** A live reason for asking the user, rather than a remembered row position. */
export type SessionWorkEntry =
  | {
      kind: 'session';
      session: SessionSummary;
      item?: InboxItem;
      additionalItems?: InboxItem[];
      flag?: AttentionFlag;
    }
  | { kind: 'project'; item: InboxItem };

export interface SessionWorkSections {
  needsYou: SessionWorkEntry[];
  active: SessionSummary[];
  results: SessionSummary[];
}

export const WORK_PROBLEM_LABELS: Partial<Record<AttentionFlag['kind'], string>> = {
  sandbox_disconnected: 'Sandbox disconnected',
  merge_conflict: 'Merge conflicts',
  ci_failed: 'CI failed',
  merge_blocked: 'Merge blocked',
};

/** A turn or background job is moving; dependency waiting alone proves no work. */
export function sessionAgentWorking(session: SessionSummary): boolean {
  return session.status === 'running' || session.backgroundWorking === true;
}

/** Activity includes waiting for another session, but never unread messages alone. */
export function sessionWorkActive(session: SessionSummary): boolean {
  return sessionAgentWorking(session) || session.status === 'awaiting_dependency';
}

function runningCi(session: SessionSummary): boolean {
  const pr = session.pr ?? session.pullRequest;
  return pr?.phase === 'open' && (pr.pipeline === 'running' || pr.pipeline === 'pending');
}

/**
 * One classification for Home and project work. Visible decisions outrank activity;
 * dismissed decisions are not reconstructed from lifecycle flags. PR problems stay
 * visible during a running turn without asserting the agent is fixing them.
 */
export function sessionWorkSections(
  sessions: readonly SessionSummary[],
  items: readonly InboxItem[],
  unread: ReadonlySet<string>,
  previous: readonly SessionSummary[] = [],
): SessionWorkSections {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const needsYou: SessionWorkEntry[] = [];
  const taken = new Set<string>();
  const decisions = new Map<string, Extract<SessionWorkEntry, { kind: 'session' }>>();
  for (const item of items) {
    if (item.sessionId === undefined) {
      if (item.kind !== 'meeting') needsYou.push({ kind: 'project', item });
      continue;
    }
    const session = byId.get(item.sessionId);
    if (session === undefined) continue;
    const existing = decisions.get(session.sessionId);
    if (existing !== undefined) {
      (existing.additionalItems ??= []).push(item);
      continue;
    }
    taken.add(session.sessionId);
    const entry = { kind: 'session' as const, session, item };
    decisions.set(session.sessionId, entry);
    needsYou.push(entry);
  }
  for (const session of workOrder(sessions)) {
    if (taken.has(session.sessionId)) continue;
    const flag = sessionAttention({
      status: session.status,
      pr: session.pr ?? session.pullRequest,
      attention: session.attention,
    }).find(
      (candidate) =>
        candidate.kind === 'sandbox_disconnected' ||
        (WORK_PROBLEM_LABELS[candidate.kind] !== undefined && !sessionAgentWorking(session)),
    );
    if (flag === undefined) continue;
    taken.add(session.sessionId);
    needsYou.push({ kind: 'session', session, flag });
  }
  const rest = workOrder(
    sessions.filter((s) => !taken.has(s.sessionId)),
    new Map(),
    previous,
  );
  const active = rest.filter((s) => sessionWorkActive(s) || runningCi(s));
  const activeIds = new Set(active.map((s) => s.sessionId));
  const results = rest.filter((s) => !activeIds.has(s.sessionId) && unread.has(s.sessionId));
  return { needsYou, active, results };
}

/** Keep positions only while entries still belong to this group. */
export function retainWorkMembers(
  previous: readonly string[],
  candidates: readonly string[],
): string[] {
  const eligible = new Set(candidates);
  const kept = previous.filter((id) => eligible.has(id));
  const known = new Set(kept);
  return [...kept, ...candidates.filter((id) => !known.has(id))];
}
