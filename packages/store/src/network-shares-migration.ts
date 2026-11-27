import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Central SMB share connections and per-project folder grants. */
export const networkSharesMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table network_share_connections (
      id text primary key,
      label text not null check (label <> ''),
      host text not null check (host <> ''),
      port integer check (port between 1 and 65535),
      share text not null check (share <> ''),
      username text not null,
      password text not null,
      target_revision text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`.execute(db);
    await sql`create table project_network_share_folders (
      id text primary key,
      project_id text not null references projects(id) on delete cascade,
      connection_id text not null references network_share_connections(id) on delete cascade,
      connection_target_revision text not null,
      path text not null,
      name text not null,
      access_mode text not null check (access_mode in ('read-only', 'read-write')),
      revision text not null,
      created_at timestamptz not null default now()
    )`.execute(db);
    // SMB names are case-insensitive: "Projects" and "projects" are one folder
    // and must be one grant, or revoking one would leave the other in force.
    await sql`create unique index project_network_share_folders_path
      on project_network_share_folders(project_id, connection_id, lower(path))`.execute(db);
    await sql`create index project_network_share_folders_connection
      on project_network_share_folders(connection_id)`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table if exists project_network_share_folders`.execute(db);
    await sql`drop table if exists network_share_connections`.execute(db);
  },
};
