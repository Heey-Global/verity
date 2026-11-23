import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Who started a session (ADR 0023): the agent's questions and permission prompts
 * in it are theirs to answer when no turn names a person. A table of its own
 * rather than a column on `sessions`, so an older server still inserting
 * sessions during a rolling upgrade never trips over it. Sessions from before
 * this migration have no row and fall back to their project's creator.
 */
export const sessionCreatorMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table session_creators (
      session_id text primary key references sessions(session_id) on delete cascade,
      user_id text not null references users(id) on delete cascade,
      created_at timestamptz not null default now()
    )`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table session_creators`.execute(db);
  },
};
