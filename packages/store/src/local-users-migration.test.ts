import { Migrator } from 'kysely/migration';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { migrationProvider } from './migrations.js';
import { createRawDb } from './testing.js';

it('binds legacy devices and projects to one administrator without granting other users access', async () => {
  const ctx = createRawDb();
  try {
    const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
    const before = await migrator.migrateTo('0111_session_links');
    if (before.error) throw new Error('Migration failed', { cause: before.error });
    await sql`insert into auth_tokens (id, token_hash) values ('device', 'hash')`.execute(ctx.db);
    await sql`insert into projects (id, owner, repo, container_name, state, overview_visible)
      values ('project', 'owner', 'repo', 'container', 'absent', true)`.execute(ctx.db);

    const after = await migrator.migrateToLatest();
    if (after.error) throw new Error('Migration failed', { cause: after.error });

    const users = await sql<{ id: string; role: string }>`select id, role from users`.execute(
      ctx.db,
    );
    expect(users.rows).toHaveLength(1);
    const adminId = users.rows[0]!.id;
    expect(users.rows[0]!.role).toBe('administrator');
    await expect(
      sql`select user_id from auth_tokens where id = 'device'`.execute(ctx.db),
    ).resolves.toMatchObject({ rows: [{ user_id: adminId }] });
    await expect(
      sql`select created_by_user_id from projects where id = 'project'`.execute(ctx.db),
    ).resolves.toMatchObject({ rows: [{ created_by_user_id: adminId }] });
    await expect(sql`select * from project_memberships`.execute(ctx.db)).resolves.toMatchObject({
      rows: [
        {
          project_id: 'project',
          user_id: adminId,
          can_read: true,
          can_execute: true,
          can_manage: true,
        },
      ],
    });

    // An old server can still pair a device during a rolling upgrade.
    await sql`insert into auth_tokens (id, token_hash) values ('new-device', 'new-hash')`.execute(
      ctx.db,
    );
    await expect(
      sql`select user_id from auth_tokens where id = 'new-device'`.execute(ctx.db),
    ).resolves.toMatchObject({ rows: [{ user_id: adminId }] });
    await sql`insert into projects (id, owner, repo, container_name, state, overview_visible)
      values ('new-project', 'owner', 'new-repo', 'new-container', 'absent', true)`.execute(ctx.db);
    await expect(
      sql`select user_id, can_execute from project_memberships
        where project_id = 'new-project'`.execute(ctx.db),
    ).resolves.toMatchObject({ rows: [{ user_id: adminId, can_execute: true }] });
    await expect(
      sql`insert into project_memberships
        (project_id, user_id, can_read, can_execute, can_manage)
        values ('project', 'missing', true, true, true)`.execute(ctx.db),
    ).rejects.toThrow();
  } finally {
    await ctx.close();
  }
});
