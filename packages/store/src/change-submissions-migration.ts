import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * A member without Code submits a session's changes; members with Code check and
 * add them (ADR 0023). One current submission per session: submitting again after
 * a withdrawal replaces it. A table of its own, so an older server writing
 * sessions during a rolling upgrade never trips over it.
 */
export const changeSubmissionsMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table change_submissions (
      session_id text primary key references sessions(session_id) on delete cascade,
      submitted_by text not null references users(id) on delete cascade,
      submitted_at timestamptz not null default now(),
      revision text,
      pull_request_url text,
      pull_request_head text,
      state text not null check (state in ('submitted', 'withdrawn', 'added')),
      updated_at timestamptz not null default now()
    )`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table change_submissions`.execute(db);
  },
};
