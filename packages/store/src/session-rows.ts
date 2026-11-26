import type { Selectable } from 'kysely';
import type { SessionsTable } from './schema.js';
import { mockupReview } from './session-mockups.js';
import type { SessionRecord } from './store.js';

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
