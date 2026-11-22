import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * The project permission "Code": seeing a session's technical side and adding
 * its changes to the project's code. It needs "Edit" (`can_execute`). For an
 * invitation a check constraint holds that. A membership instead loses Code
 * whenever Edit goes: an older server still running during the upgrade demotes
 * a member by clearing `can_execute` alone, and must neither fail on a
 * constraint nor leave Code behind.
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
      add column can_code boolean not null default false`.execute(db);
    await sql`create function project_membership_code_needs_execute() returns trigger as $$
        begin
          if not new.can_execute then
            new.can_code := false;
          end if;
          return new;
        end
      $$ language plpgsql`.execute(db);
    await sql`create trigger project_membership_code_needs_execute
      before insert or update on project_memberships for each row
      execute function project_membership_code_needs_execute()`.execute(db);
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
    await sql`drop trigger project_membership_code_needs_execute on project_memberships`.execute(
      db,
    );
    await sql`drop function project_membership_code_needs_execute()`.execute(db);
    await sql`alter table project_invitations drop column can_code`.execute(db);
    await sql`alter table project_memberships drop column can_code`.execute(db);
  },
};
