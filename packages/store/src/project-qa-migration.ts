import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * QA becomes a role of each coding project (docs/ci-supervision.md). The
 * installation-wide `qa_coordinator` row stays as the system switch; the role
 * session, its review dispatch and health move to `project_roles`, one row per
 * project. Issues group a project's incidents by cause, so failures with one
 * cause get one repair and one decision. Repairs may run three at a time per
 * project instead of one; the emergency brake replaces the daily wake cap.
 */
export const projectQAMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table project_roles (
      project_id text not null references projects(id) on delete cascade,
      role text not null check (role in ('qa')),
      session_id text unique references sessions(session_id) on delete set null,
      health text not null default 'pending',
      active_dispatch text, active_seq bigint, active_revision integer, active_snapshot text,
      created_at timestamptz not null default now(),
      primary key (project_id, role)
    )`.execute(db);
    await sql`alter table repair_mandates drop constraint repair_mandates_mode_check`.execute(db);
    await sql`alter table repair_mandates add constraint repair_mandates_mode_check
      check (mode in ('off', 'monitor', 'automatic', 'paused'))`.execute(db);
    await sql`create table qa_issues (
      id text primary key,
      project_id text not null references projects(id) on delete cascade,
      key text not null,
      state text not null default 'open'
        check (state in ('open', 'needs_you', 'deferred', 'taken_over', 'resolved')),
      reason text, detail text,
      extra_rounds integer not null default 0 check (extra_rounds between 0 and 20),
      deferred_revision text, notified_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (project_id, key)
    )`.execute(db);
    await sql`alter table repair_incidents add column issue_id text
      references qa_issues(id) on delete set null`.execute(db);
    await sql`create index repair_incidents_issue on repair_incidents(issue_id)`.execute(db);
    // Existing incidents become one issue per resource (a PR or a workflow). One
    // already blocked before the upgrade starts out stopped and counts as told, so
    // the upgrade sends no burst of pushes; every later stop is told as usual.
    await sql`insert into qa_issues (id, project_id, key, state, reason, notified_at)
      select md5(project_id || ':' || resource), project_id, resource,
        case when bool_and(state in ('resolved', 'superseded')) then 'resolved'
          when bool_or(state = 'blocked') then 'needs_you' else 'open' end,
        case when bool_or(state = 'blocked') and not bool_and(state in ('resolved', 'superseded'))
          then 'rounds-exhausted' end,
        case when bool_or(state = 'blocked') then now() end
      from repair_incidents group by project_id, resource`.execute(db);
    await sql`update repair_incidents set issue_id = md5(project_id || ':' || resource)`.execute(
      db,
    );
    // Three repairs per project may run at once; the per-project cap is in the claim.
    await sql`drop index repair_project_owner`.execute(db);
    await sql`alter table qa_coordinator add column brake_at timestamptz,
      add column brake_released_at timestamptz`.execute(db);
    // The old installation-wide QA review is retired: an unfinished dispatch is
    // cancelled, its session stays readable but is never addressed again.
    await sql`update qa_dispatches set state = 'cancelled'
      where state = 'reserved' and id in (select active_dispatch from qa_coordinator)`.execute(db);
    await sql`update qa_decisions set outcome = 'retired'
      where outcome is null and dispatch_id in (select active_dispatch from qa_coordinator)`.execute(
      db,
    );
    await sql`update qa_coordinator set active_dispatch = null, active_seq = null,
      active_revision = null, active_snapshot = null`.execute(db);
    // Acknowledged fingerprints referred to the retired review; each project QA
    // reviews its current state once.
    await sql`delete from qa_inbox`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`alter table qa_coordinator drop column brake_at, drop column brake_released_at`.execute(
      db,
    );
    await sql`create unique index repair_project_owner on repair_incidents(project_id)
      where owner_session_id is not null`.execute(db);
    await sql`drop index repair_incidents_issue`.execute(db);
    await sql`alter table repair_incidents drop column issue_id`.execute(db);
    await sql`drop table qa_issues`.execute(db);
    await sql`update repair_mandates set mode = 'monitor' where mode = 'paused'`.execute(db);
    await sql`alter table repair_mandates drop constraint repair_mandates_mode_check`.execute(db);
    await sql`alter table repair_mandates add constraint repair_mandates_mode_check
      check (mode in ('off', 'monitor', 'automatic'))`.execute(db);
    await sql`drop table project_roles`.execute(db);
  },
};
