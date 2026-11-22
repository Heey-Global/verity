import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

export const capacityLeasesMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    // No cascading owner FKs: deleting a session or project cannot prove that
    // an admitted filesystem operation stopped or released its reservation.
    await sql`create table dependency_capacity_leases (
      id uuid primary key,
      project_id text not null check (char_length(project_id) between 1 and 255),
      user_id text not null check (char_length(user_id) between 1 and 255),
      session_id text not null check (char_length(session_id) between 1 and 255),
      container_generation text not null check (char_length(container_generation) between 1 and 255),
      kind text not null check (kind in ('dependency-copy','dependency-prepare','dependency-private')),
      bytes bigint not null check (bytes between 0 and 9007199254740991),
      inodes bigint not null check (inodes between 0 and 9007199254740991),
      state text not null check (state in ('reserved','started','uncertain','settled')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`.execute(db);
    await sql`create index dependency_capacity_leases_unsettled
      on dependency_capacity_leases(created_at,id) where state <> 'settled'`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table dependency_capacity_leases`.execute(db);
  },
};
