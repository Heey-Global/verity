import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

/** A coding project's QA role: its session and its own review dispatch. */
export interface ProjectQARole {
  project_id: string;
  session_id: string | null;
  health: string;
  active_dispatch: string | null;
  active_seq: number | null;
  active_revision: number | null;
  active_snapshot: string | null;
}

export type QAIssueState = 'open' | 'needs_you' | 'deferred' | 'taken_over' | 'resolved';
/** Why QA stopped and asks the user. */
export type QAIssueReason = 'rounds-exhausted' | 'beyond-mandate' | 'emergency-brake';
export type QAIssueDecision = 'another_round' | 'take_over' | 'defer';

export interface QAIssue {
  id: string;
  project_id: string;
  key: string;
  state: QAIssueState;
  reason: QAIssueReason | null;
  detail: string | null;
  extra_rounds: number;
  /** Revisions failing when the user deferred, comma-separated. */
  deferred_revision: string | null;
  notified_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What a project's QA row shows without opening QA. */
export interface ProjectQASummary {
  mode: 'off' | 'monitor' | 'automatic' | 'paused';
  /** Forge observation health of the last sweep (`healthy`, `partial`, `unavailable` …). */
  health: string;
  checkedAt: string | null;
  open: number;
  repairing: number;
  needsYou: number;
  failingPullRequests: number;
  failingWorkflows: number;
  /** Issues where QA stopped and waits for the user, newest first (at most five). */
  stopped: {
    id: string;
    key: string;
    reason: QAIssueReason | null;
    detail: string | null;
    updatedAt: string;
  }[];
}

/** Repair attempts started within an hour, installation-wide, that trip the brake. */
export const QA_EMERGENCY_BRAKE_STARTS = 20;
/** Repairs that may run at once in one project; further issues wait in line. */
export const QA_PARALLEL_REPAIRS = 3;
/** Repair rounds per issue before QA stops and asks. */
export const QA_REPAIR_ROUNDS = 2;

const ROLE_COLUMNS = sql`project_id, session_id, health, active_dispatch, active_seq::int as active_seq, active_revision, active_snapshot`;

/**
 * Per-project QA: the role session that reviews a project's CI state, the
 * issues that group its incidents by cause, and the emergency brake. The
 * system switch stays in `qa_coordinator` (RepairSupervisionStore.qa()).
 */
export class ProjectQAStore {
  constructor(private readonly db: Kysely<Database>) {}

  async role(projectId: string): Promise<ProjectQARole | undefined> {
    return (
      await sql<ProjectQARole>`select ${ROLE_COLUMNS} from project_roles where project_id = ${projectId} and role = 'qa'`.execute(
        this.db,
      )
    ).rows[0];
  }

  /** The project whose QA role this session is, if any. */
  async roleForSession(sessionId: string): Promise<ProjectQARole | undefined> {
    return (
      await sql<ProjectQARole>`select ${ROLE_COLUMNS} from project_roles where session_id = ${sessionId} and role = 'qa'`.execute(
        this.db,
      )
    ).rows[0];
  }

  /** True for a project QA session and for the retired installation-wide QA session. */
  async isQASession(sessionId: string): Promise<boolean> {
    return (
      (
        await sql`select 1 from project_roles where session_id = ${sessionId}
          union all select 1 from qa_coordinator where session_id = ${sessionId}`.execute(this.db)
      ).rows.length > 0
    );
  }

  /** Creates the role row; the session is attached once it exists (it is a foreign key). */
  async ensureRole(projectId: string): Promise<ProjectQARole> {
    await sql`insert into project_roles (project_id, role) values (${projectId}, 'qa') on conflict do nothing`.execute(
      this.db,
    );
    return (await this.role(projectId))!;
  }

  /** Attaches a newly created session unless another one was attached first. */
  async attachSession(projectId: string, sessionId: string): Promise<string | null> {
    return (
      (
        await sql<{
          session_id: string | null;
        }>`update project_roles set session_id = coalesce(session_id, ${sessionId}) where project_id = ${projectId} and role = 'qa' returning session_id`.execute(
          this.db,
        )
      ).rows[0]?.session_id ?? null
    );
  }

  async health(projectId: string, health: string): Promise<void> {
    await sql`update project_roles set health = ${health} where project_id = ${projectId} and role = 'qa'`.execute(
      this.db,
    );
  }

  /** Reserves one review of this project; one at a time per project, none while braked. */
  async claimReview(
    projectId: string,
    qaRevision: number,
    snapshot: string,
    seq: number,
  ): Promise<string | undefined> {
    const id = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const rows = (
        await sql<{
          session_id: string;
        }>`update project_roles r set active_dispatch = ${id}, active_seq = ${seq}, active_revision = ${qaRevision}, active_snapshot = ${snapshot}, health = 'working' where r.project_id = ${projectId} and r.role = 'qa' and r.session_id is not null and r.active_dispatch is null and exists (select 1 from qa_coordinator q where q.id = 1 and q.enabled = true and q.revision = ${qaRevision} and q.brake_at is null) returning r.session_id`.execute(
          trx,
        )
      ).rows;
      const sessionId = rows[0]?.session_id;
      if (!sessionId) return undefined;
      await sql`insert into qa_decisions(dispatch_id, session_id, snapshot) values (${id}, ${sessionId}, ${snapshot})`.execute(
        trx,
      );
      await sql`insert into qa_dispatches(id, session_id, state) values (${id}, ${sessionId}, 'reserved')`.execute(
        trx,
      );
      return id;
    });
  }

  async finishReview(
    projectId: string,
    dispatchId: string,
    outcome: string,
    detail?: string,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const result =
        await sql`update qa_decisions set outcome = ${detail ?? outcome} where dispatch_id = ${dispatchId} and outcome is null returning dispatch_id`.execute(
          trx,
        );
      await sql`update project_roles set active_dispatch = null, active_seq = null, active_revision = null, active_snapshot = null, health = ${outcome} where project_id = ${projectId} and role = 'qa' and active_dispatch = ${dispatchId}`.execute(
        trx,
      );
      return result.rows.length > 0;
    });
  }

  // ---- issues ----

  async issues(projectId: string): Promise<QAIssue[]> {
    return (
      await sql<QAIssue>`select * from qa_issues where project_id = ${projectId} and (state <> 'resolved' or updated_at > now() - interval '7 days') order by updated_at desc limit 200`.execute(
        this.db,
      )
    ).rows;
  }

  async issue(projectId: string, issueId: string): Promise<QAIssue | undefined> {
    return (
      await sql<QAIssue>`select * from qa_issues where project_id = ${projectId} and id = ${issueId}`.execute(
        this.db,
      )
    ).rows[0];
  }

  /**
   * Files an incident under its issue: by default one issue per resource, or
   * the issue QA grouped it into. A new revision of a deferred or resolved
   * issue reopens it.
   */
  async file(projectId: string, incidentId: string, resource: string, revision: string) {
    // A resource QA grouped stays with that issue: later revisions join it too.
    await sql`update repair_incidents i set issue_id = (select o.issue_id from repair_incidents o where o.project_id = ${projectId} and o.resource = ${resource} and o.issue_id is not null order by o.updated_at desc limit 1) where i.id = ${incidentId} and i.issue_id is null`.execute(
      this.db,
    );
    const filed = (
      await sql<{
        issue_id: string | null;
      }>`select issue_id from repair_incidents where id = ${incidentId}`.execute(this.db)
    ).rows[0]?.issue_id;
    if (!filed) {
      await sql`insert into qa_issues (id, project_id, key) values (${randomUUID()}, ${projectId}, ${resource}) on conflict (project_id, key) do nothing`.execute(
        this.db,
      );
      await sql`update repair_incidents i set issue_id = q.id from qa_issues q where i.id = ${incidentId} and i.issue_id is null and q.project_id = ${projectId} and q.key = ${resource}`.execute(
        this.db,
      );
    }
    await sql`update qa_issues q set state = 'open', reason = null, detail = null, notified_at = null, updated_at = now() from repair_incidents i where i.id = ${incidentId} and q.id = i.issue_id and i.state not in ('resolved', 'superseded') and (q.state = 'resolved' or (q.state = 'deferred' and not (${revision} = any(string_to_array(coalesce(q.deferred_revision, ''), ',')))))`.execute(
      this.db,
    );
  }

  /** Groups incidents QA found to share one cause under the first one's issue. */
  async group(projectId: string, incidentIds: readonly string[]): Promise<boolean> {
    const ids = [...new Set(incidentIds)];
    if (ids.length < 2) return false;
    const refused = new Error('group refused');
    try {
      return await this.db.transaction().execute(async (trx) => {
        const rows = (
          await sql<{
            id: string;
            issue_id: string | null;
            owner_session_id: string | null;
            state: QAIssueState | null;
          }>`select i.id, i.issue_id, i.owner_session_id, q.state from repair_incidents i left join qa_issues q on q.id = i.issue_id where i.project_id = ${projectId} and i.id in (${sql.join(ids)}) for update of i`.execute(
            trx,
          )
        ).rows;
        const target = rows.find((row) => row.id === ids[0])?.issue_id;
        // A user's decision on an issue (stopped, deferred, taken over) is never
        // overridden by grouping, and a group never ends up with two repairs.
        if (
          !target ||
          rows.length !== ids.length ||
          rows.some((row) => row.state !== 'open') ||
          rows.filter((row) => row.owner_session_id !== null).length > 1
        )
          throw refused;
        // Count running repairs across every issue involved, not only the named incidents.
        const issues = [...new Set(rows.map((row) => row.issue_id!))];
        const owned = (
          await sql<{
            n: number;
          }>`select count(*)::int as n from repair_incidents where project_id = ${projectId} and owner_session_id is not null and (issue_id in (${sql.join(issues)}) or id in (${sql.join(ids)}))`.execute(
            trx,
          )
        ).rows[0]!.n;
        if (owned > 1) throw refused;
        await sql`update repair_incidents set issue_id = ${target} where project_id = ${projectId} and id in (${sql.join(ids)})`.execute(
          trx,
        );
        // An issue left without incidents has nothing to track.
        await sql`delete from qa_issues q where q.project_id = ${projectId} and q.id <> ${target} and not exists (select 1 from repair_incidents i where i.issue_id = q.id)`.execute(
          trx,
        );
        return true;
      });
    } catch (error) {
      if (error === refused) return false;
      throw error;
    }
  }

  /** QA stops and asks; returns false when the issue was not open. */
  async stop(
    projectId: string,
    issueId: string,
    reason: QAIssueReason,
    detail: string,
  ): Promise<boolean> {
    return (
      (
        await sql`update qa_issues set state = 'needs_you', reason = ${reason}, detail = ${detail.slice(0, 2000)}, notified_at = null, updated_at = now() where project_id = ${projectId} and id = ${issueId} and state = 'open' returning id`.execute(
          this.db,
        )
      ).rows.length > 0
    );
  }

  /** The user's answer to a stopped issue. */
  async decide(projectId: string, issueId: string, decision: QAIssueDecision): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const issue = (
        await sql<QAIssue>`select * from qa_issues where project_id = ${projectId} and id = ${issueId} and state = 'needs_you' for update`.execute(
          trx,
        )
      ).rows[0];
      if (!issue) return false;
      if (decision === 'another_round') {
        await sql`update qa_issues set state = 'open', reason = null, detail = null, notified_at = null, extra_rounds = least(extra_rounds + 1, 20), updated_at = now() where id = ${issueId}`.execute(
          trx,
        );
        await sql`update repair_incidents set state = 'open', updated_at = now() where issue_id = ${issueId} and state = 'blocked' and owner_session_id is null`.execute(
          trx,
        );
        return true;
      }
      // Every revision failing now, across all of the issue's resources: only a
      // revision outside this set reopens a deferred issue.
      const live = (
        await sql<{
          revisions: string | null;
        }>`select string_agg(distinct revision, ',') as revisions from repair_incidents where issue_id = ${issueId} and state not in ('resolved', 'superseded')`.execute(
          trx,
        )
      ).rows[0]?.revisions;
      await sql`update qa_issues set state = ${decision === 'take_over' ? 'taken_over' : 'deferred'}, deferred_revision = ${live ?? null}, notified_at = coalesce(notified_at, now()), updated_at = now() where id = ${issueId}`.execute(
        trx,
      );
      return true;
    });
  }

  /**
   * Reconciles issues with their incidents: an issue is resolved once none of
   * its incidents is open, and stops for the user once one ran out of rounds.
   */
  async reconcile(projectId: string): Promise<void> {
    await sql`update qa_issues q set state = 'resolved', reason = null, updated_at = now() where q.project_id = ${projectId} and q.state in ('open', 'needs_you', 'deferred', 'taken_over') and exists (select 1 from repair_incidents i where i.issue_id = q.id) and not exists (select 1 from repair_incidents i where i.issue_id = q.id and i.state not in ('resolved', 'superseded'))`.execute(
      this.db,
    );
    await sql`update qa_issues q set state = 'needs_you', reason = 'rounds-exhausted', notified_at = null, updated_at = now() where q.project_id = ${projectId} and q.state = 'open' and exists (select 1 from repair_incidents i where i.issue_id = q.id and i.state = 'blocked' and i.owner_session_id is null and coalesce((select used from repair_resource_budgets b where b.project_id = i.project_id and b.resource = i.resource), 0) >= ${QA_REPAIR_ROUNDS} + q.extra_rounds)`.execute(
      this.db,
    );
  }

  /** Stopped issues nobody was told about yet; marks them told. */
  async takeUnnotified(projectId: string): Promise<QAIssue[]> {
    return (
      await sql<QAIssue>`update qa_issues set notified_at = now() where project_id = ${projectId} and state = 'needs_you' and notified_at is null returning *`.execute(
        this.db,
      )
    ).rows;
  }

  /** Rounds an incident may still use: the base rounds plus the user's extra ones. */
  async roundsAllowed(incidentId: string): Promise<number> {
    return (
      QA_REPAIR_ROUNDS +
      ((
        await sql<{
          extra_rounds: number;
        }>`select q.extra_rounds from repair_incidents i join qa_issues q on q.id = i.issue_id where i.id = ${incidentId}`.execute(
          this.db,
        )
      ).rows[0]?.extra_rounds ?? 0)
    );
  }

  /** QA summaries of the given projects with a QA choice, including switched-off ones. */
  async summaries(projectIds: readonly string[]): Promise<Map<string, ProjectQASummary>> {
    const result = new Map<string, ProjectQASummary>();
    if (!projectIds.length) return result;
    const rows = (
      await sql<{
        project_id: string;
        mode: ProjectQASummary['mode'];
        health: string;
        checked_at: Date | string | null;
        open: number;
        repairing: number;
        needs_you: number;
        failing_prs: number;
        failing_workflows: number;
      }>`select m.project_id, m.mode, m.health, m.checked_at,
          (select count(*)::int from qa_issues q where q.project_id = m.project_id and q.state in ('open','needs_you')) as open,
          (select count(*)::int from repair_incidents i where i.project_id = m.project_id and i.owner_session_id is not null) as repairing,
          (select count(*)::int from qa_issues q where q.project_id = m.project_id and q.state = 'needs_you') as needs_you,
          (select count(distinct i.resource)::int from repair_incidents i where i.project_id = m.project_id and i.resource like 'pr:%' and i.state not in ('resolved','superseded')) as failing_prs,
          (select count(distinct i.resource)::int from repair_incidents i where i.project_id = m.project_id and i.resource like 'workflow:%' and i.state not in ('resolved','superseded')) as failing_workflows
        from repair_mandates m where m.project_id in (${sql.join(projectIds)})`.execute(this.db)
    ).rows;
    for (const row of rows)
      result.set(row.project_id, {
        mode: row.mode,
        health: row.health,
        checkedAt: row.checked_at ? new Date(row.checked_at).toISOString() : null,
        open: row.open,
        repairing: row.repairing,
        needsYou: row.needs_you,
        failingPullRequests: row.failing_prs,
        failingWorkflows: row.failing_workflows,
        stopped: [],
      });
    const stopped = (
      await sql<{
        id: string;
        project_id: string;
        key: string;
        reason: QAIssueReason | null;
        detail: string | null;
        updated_at: Date | string;
      }>`select id, project_id, key, reason, detail, updated_at from qa_issues where state = 'needs_you' and project_id in (${sql.join(projectIds)}) order by updated_at desc`.execute(
        this.db,
      )
    ).rows;
    for (const row of stopped) {
      const list = result.get(row.project_id)?.stopped;
      if (list && list.length < 5)
        list.push({
          id: row.id,
          key: row.key,
          reason: row.reason,
          detail: row.detail,
          updatedAt: new Date(row.updated_at).toISOString(),
        });
    }
    return result;
  }

  // ---- emergency brake ----

  async brake(): Promise<string | null> {
    const row = (
      await sql<{
        brake_at: Date | string | null;
      }>`select brake_at from qa_coordinator where id = 1`.execute(this.db)
    ).rows[0];
    return row?.brake_at ? new Date(row.brake_at).toISOString() : null;
  }

  /** Trips the brake when repairs start faster than any normal workload; true once tripped. */
  async checkBrake(): Promise<boolean> {
    const tripped = (
      await sql<{
        brake_at: unknown;
      }>`update qa_coordinator set brake_at = coalesce(brake_at, now()) where id = 1 and (brake_at is not null or (select count(*) from repair_attempts where started_at > greatest(now() - interval '1 hour', coalesce(brake_released_at, '-infinity'::timestamptz))) >= ${QA_EMERGENCY_BRAKE_STARTS}) returning brake_at`.execute(
        this.db,
      )
    ).rows;
    return tripped.length > 0;
  }

  async releaseBrake(): Promise<void> {
    // Starts before the release no longer count toward the next trip.
    await sql`update qa_coordinator set brake_at = null, brake_released_at = now() where id = 1`.execute(
      this.db,
    );
  }

  /** Sessions QA started or sent repairs to in this project, newest first. */
  async repairSessions(
    projectId: string,
  ): Promise<{ session_id: string; issue_id: string | null }[]> {
    return (
      await sql<{
        session_id: string;
        issue_id: string | null;
      }>`select distinct on (a.session_id) a.session_id, i.issue_id from repair_attempts a join repair_incidents i on i.id = a.incident_id where i.project_id = ${projectId} and a.automation_marker is null order by a.session_id, a.started_at desc`.execute(
        this.db,
      )
    ).rows;
  }
}
