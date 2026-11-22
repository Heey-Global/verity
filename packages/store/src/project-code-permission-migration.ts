import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * The project permission "Code": seeing a session's technical side and adding
 * its changes to the project's code. It needs "Edit" (`can_execute`), which the
 * check constraints hold even against a writer that skips the store.
 *
 * Everyone who could edit until now could already merge and save to the
 * project, so every member and invitation with Edit receives Code and nobody
 * loses an ability. The trigger that gives a project's creator full rights is
 * replaced in place, so a project created by an older server during a rolling
 * upgrade still gets a creator who holds Code.
 */
export const projectCodePermissionMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table project_memberships
      add column can_code boolean not null default false,
      add constraint project_memberships_code_needs_execute check (not can_code or can_execute)`.execute(
      db,
    );
    await sql`update project_memberships set can_code = true where can_execute`.execute(db);
    await sql`alter table project_invitations
      add column can_code boolean not null default false,
      add constraint project_invitations_code_needs_execute check (not can_code or can_execute)`.execute(
      db,
    );
    await sql`update project_invitations set can_code = true where can_execute`.execute(db);
    await sql`create or replace function add_project_creator_membership() returns trigger as $$
        begin
          insert into project_memberships
            (project_id, user_id, can_read, can_execute, can_code, can_manage)
          values (new.id, new.created_by_user_id, true, true, true, true);
          return new;
        end
      $$ language plpgsql`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`create or replace function add_project_creator_membership() returns trigger as $$
        begin
          insert into project_memberships
            (project_id, user_id, can_read, can_execute, can_manage)
          values (new.id, new.created_by_user_id, true, true, true);
          return new;
        end
      $$ language plpgsql`.execute(db);
    await sql`alter table project_invitations drop column can_code`.execute(db);
    await sql`alter table project_memberships drop column can_code`.execute(db);
  },
};
