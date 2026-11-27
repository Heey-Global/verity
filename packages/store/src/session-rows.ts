import type { Selectable } from 'kysely';
import type { SessionsTable } from './schema.js';
import { mockupReview } from './session-mockups.js';
import type { SessionMockupReview } from './session-mockups.js';
import type { SessionPlanning } from './session-planning.js';

export interface SessionRecord {
  sessionId: string;
  worktree: string;
  model: string;
  /** Operator-assigned display name; `null` until set at spawn or via rename. */
  name: string | null;
  /** Project the session runs in (concept §19); `null` for project-less
   *  (or pre-projects-slice) sessions. */
  projectId: string | null;
  /** "Last seen" mark for the overview unread dot (#387): the session's `eventCount`
   *  at the last open. `null` = never opened → not unread. The store fills in the
   *  legacy shared column; the server replaces it with the requesting person's mark
   *  from {@link ViewStateStore} before it reaches a client. */
  lastSeenEventCount: number | null;
  /** Planning mode. Optional so records built outside the store need not state it;
   *  absent and `null` both mean the session never planned. */
  planning?: SessionPlanning | null;
  planningRevision?: number;
  planningPlan?: string | null;
  /** Mockups the agent presented for review. Absent when it never presented any. */
  mockupReview?: SessionMockupReview;
  /** Operator-marked favorite, highlighted in the session list. Global like the
   *  unread mark, so it syncs across devices. Absent means not a favorite. */
  favorite?: boolean;
}

/** The columns a {@link SessionRecord} is read from, shared by every session read. */
export const SESSION_COLUMNS = [
  'session_id',
  'worktree',
  'model',
  'name',
  'project_id',
  'last_seen_event_count',
  'planning',
  'planning_revision',
  'planning_plan',
  'mockup_review',
  'mockup_revision',
  'mockup_screens',
  'favorite',
] as const;

type SessionRow = Pick<Selectable<SessionsTable>, (typeof SESSION_COLUMNS)[number]>;

export function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    sessionId: row.session_id,
    worktree: row.worktree,
    model: row.model,
    name: row.name,
    projectId: row.project_id,
    lastSeenEventCount: row.last_seen_event_count,
    ...(row.planning !== null ? { planning: row.planning } : {}),
    planningRevision: row.planning_revision,
    planningPlan: row.planning_plan,
    ...mockupReview(row.mockup_review, row.mockup_revision, row.mockup_screens),
    ...(row.favorite ? { favorite: true } : {}),
  };
}
