import { Migrator } from 'kysely/migration';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { migrationProvider } from './migrations.js';
import { createIsolatedTestDb } from './testing.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';

// The per-person migrations assign existing data to the administrator created
// by 0112. An installation whose administrator row is gone must still upgrade:
// one unguarded backfill aborts the whole upgrade and the Server cannot start.
describe('per-person migrations without the administrator row', () => {
  it('upgrades, drops Google data no one can own and keeps the project default', async () => {
    const legacy = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: legacy.db, provider: migrationProvider });
      expect((await migrator.migrateTo('0206_user_display_name')).error).toBeUndefined();
      await sql`insert into users (id, role, status) values ('other-admin', 'administrator', 'active')`.execute(
        legacy.db,
      );
      await sql`insert into projects (id, owner, repo, container_name, state, created_by_user_id)
        values ('orphaned', 'local', 'orphaned', 'orphaned', 'active', 'other-admin')`.execute(
        legacy.db,
      );
      await sql`delete from project_memberships where user_id = ${ADMIN}`.execute(legacy.db);
      await sql`delete from users where id = ${ADMIN}`.execute(legacy.db);
      await sql`insert into google_accounts (id, email, client_id, refresh_token)
        values ('unowned-google', 'unowned@example.test', 'client', 'sealed')`.execute(legacy.db);
      await sql`insert into project_google_connections (project_id, service, account_email, account_id)
        values ('orphaned', 'gmail', 'unowned@example.test', 'unowned-google')`.execute(legacy.db);
      await sql`insert into project_settings (project_id, default_model)
        values ('orphaned', 'claude-sonnet-5-5')`.execute(legacy.db);

      expect((await migrator.migrateToLatest()).error).toBeUndefined();

      expect(await legacy.db.selectFrom('google_accounts').select('id').execute()).toEqual([]);
      expect(
        await legacy.db.selectFrom('project_google_connections').select('project_id').execute(),
      ).toEqual([]);
      // 0216 had no one to copy the default to, so 0217 must not retire it.
      expect(
        await legacy.db
          .selectFrom('project_settings')
          .select('default_model')
          .where('project_id', '=', 'orphaned')
          .executeTakeFirstOrThrow(),
      ).toEqual({ default_model: 'claude-sonnet-5-5' });
    } finally {
      await legacy.close();
    }
  }, 60_000);

  it('retires only the project default 0216 copied to the administrator', async () => {
    const legacy = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: legacy.db, provider: migrationProvider });
      expect((await migrator.migrateTo('0215_project_sandbox_state')).error).toBeUndefined();
      await sql`insert into projects (id, owner, repo, container_name, state)
        values ('copied', 'local', 'copied', 'copied', 'active')`.execute(legacy.db);
      await sql`insert into project_settings (project_id, default_model)
        values ('copied', 'claude-opus-5-5')`.execute(legacy.db);
      expect((await migrator.migrateToLatest()).error).toBeUndefined();

      expect(
        await legacy.db
          .selectFrom('project_settings')
          .select('default_model')
          .where('project_id', '=', 'copied')
          .executeTakeFirstOrThrow(),
      ).toEqual({ default_model: null });
      expect(
        await legacy.db
          .selectFrom('user_project_preferences')
          .select(['user_id', 'default_model'])
          .where('project_id', '=', 'copied')
          .executeTakeFirstOrThrow(),
      ).toEqual({ user_id: ADMIN, default_model: 'claude-opus-5-5' });
    } finally {
      await legacy.close();
    }
  }, 60_000);

  // A default owner turns every writer that forgets the owner into a silent
  // grant to the administrator, which is what per-person ownership rules out.
  it('leaves no administrator default on Google owners', async () => {
    const current = await createIsolatedTestDb();
    try {
      await expect(
        sql`insert into google_accounts (id, email, client_id, refresh_token)
          values ('no-owner', 'no-owner@example.test', 'client', 'sealed')`.execute(current.db),
      ).rejects.toThrow(/owner_user_id/u);
    } finally {
      await current.close();
    }
  }, 60_000);
});
