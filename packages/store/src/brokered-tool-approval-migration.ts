import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Unanswered consent is durable; only the exact approved invocation may consume it. */
export const brokeredToolApprovalMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table brokered_tool_approvals (
      id text primary key,
      project_id text not null references projects(id) on delete cascade,
      session_id text not null references sessions(session_id) on delete cascade,
      invocation_id text not null,
      consumed_invocation_id text,
      tool_name text not null check (tool_name in ('verity_http_request', 'verity_secret_run')),
      canonical_input text not null,
      request_mac text not null,
      mac_key_id text not null,
      authorization_snapshot text not null,
      binding_digest text not null,
      status text not null check (status in ('pending', 'approved', 'denied', 'consumed')),
      scope text check (scope in ('once', 'session', 'project')),
      decided_by text,
      created_at timestamptz not null,
      decided_at timestamptz
    )`.execute(db);
    await sql`create unique index brokered_tool_approvals_live_binding
      on brokered_tool_approvals(binding_digest) where status <> 'consumed'`.execute(db);
    await sql`create unique index brokered_tool_approvals_consumed_invocation
      on brokered_tool_approvals(binding_digest, consumed_invocation_id)
      where consumed_invocation_id is not null`.execute(db);
    await sql`create index brokered_tool_approvals_session
      on brokered_tool_approvals(session_id, created_at) where status = 'pending'`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table brokered_tool_approvals`.execute(db);
  },
};
