import type { ColumnType, Generated } from 'kysely';
import type { QAIssueReason, QAIssueState } from './project-qa.js';

/** CI incidents QA and sessions repair; `issue_id` groups them by cause. */
interface RepairIncidentsTable {
  verified_success: Generated<boolean>;
  repair_pr: number | null;
  id: string;
  project_id: string;
  resource: string;
  revision: string;
  evidence: string;
  state: Generated<import('./repair-supervision.js').RepairIncident['state']>;
  owner_session_id: string | null;
  last_session_id: string | null;
  attempts: Generated<number>;
  dispatch_id: string | null;
  issue_id: string | null;
  updated_at: Generated<Date>;
}

/** The system switch for QA, and the emergency brake. */
interface QACoordinatorTable {
  id: number;
  enabled: Generated<boolean>;
  revision: Generated<number>;
  sponsor: string | null;
  session_id: string | null;
  health: Generated<string>;
  active_dispatch: string | null;
  active_seq: ColumnType<string | null, string | number | null, string | number | null>;
  active_revision: number | null;
  active_snapshot: string | null;
  wake_day: string | null;
  wakes: Generated<number>;
  brake_at: Date | null;
  brake_released_at: Date | null;
}

/** A coding project's QA role: its session and its own review dispatch. */
interface ProjectRolesTable {
  project_id: string;
  role: 'qa';
  session_id: string | null;
  health: Generated<string>;
  active_dispatch: string | null;
  active_seq: ColumnType<string | null, string | number | null, string | number | null>;
  active_revision: number | null;
  active_snapshot: string | null;
  created_at: Generated<Date>;
}

/** Incidents of a project grouped by cause, with the user's decision when QA stops. */
interface QAIssuesTable {
  id: string;
  project_id: string;
  key: string;
  state: Generated<QAIssueState>;
  reason: QAIssueReason | null;
  detail: string | null;
  extra_rounds: Generated<number>;
  deferred_revision: string | null;
  notified_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Repair supervision and per-project QA (migrations 0172 ff., 0234). */
export interface ProjectQADatabase {
  project_roles: ProjectRolesTable;
  qa_issues: QAIssuesTable;
  repair_incidents: RepairIncidentsTable;
  qa_coordinator: QACoordinatorTable;
}
