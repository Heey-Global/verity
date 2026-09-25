import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { EventStore } from './store.js';
import { createTestDb } from './testing.js';

it('uses active membership rights and keeps the control-plane project private', async () => {
  const ctx = await createTestDb();
  try {
    const store = new EventStore(ctx.db);
    const admin = '00000000-0000-4000-8000-000000000001';
    await sql`insert into users (id, role, status)
      values ('member', 'member', 'active')`.execute(ctx.db);
    await sql`insert into projects
      (id, owner, repo, container_name, kind, state, overview_visible)
      values ('ordinary', 'owner', 'repo', 'container', 'local', 'absent', true),
             ('control', 'owner', 'control', 'control-container', 'control_plane', 'absent', true)`.execute(
      ctx.db,
    );

    expect(await store.hasProjectPermission(admin, 'ordinary', 'manage')).toBe(true);
    expect(await store.isActiveAdministrator(admin)).toBe(true);
    expect(await store.isActiveAdministrator('member')).toBe(false);
    expect(await store.hasProjectPermission('member', 'ordinary', 'read')).toBe(false);
    await sql`insert into project_memberships
      (project_id, user_id, can_read, can_execute, can_manage)
      values ('ordinary', 'member', true, false, false),
             ('control', 'member', true, true, true)`.execute(ctx.db);
    expect(await store.hasProjectPermission('member', 'ordinary', 'read')).toBe(true);
    expect(await store.hasProjectPermission('member', 'ordinary', 'execute')).toBe(false);
    expect(await store.hasProjectPermission('member', 'ordinary', 'manage')).toBe(false);
    expect(await store.hasProjectPermission('member', 'control', 'read')).toBe(false);
    expect(await store.isActiveLocalUser('member')).toBe(true);
    expect(await store.listReadableProjectIds('member')).toEqual(['ordinary']);
    await sql`update project_memberships set can_read = false
      where project_id = 'ordinary' and user_id = 'member'`.execute(ctx.db);
    expect(await store.listReadableProjectIds('member')).toEqual([]);
    await sql`update project_memberships set can_read = true
      where project_id = 'ordinary' and user_id = 'member'`.execute(ctx.db);
    await sql`update users set status = 'disabled' where id = 'member'`.execute(ctx.db);
    expect(await store.hasProjectPermission('member', 'ordinary', 'read')).toBe(false);
    expect(await store.isActiveLocalUser('member')).toBe(false);
    expect(await store.listReadableProjectIds('member')).toEqual([]);
    await sql`delete from project_memberships
      where project_id = 'ordinary' and user_id = ${admin}`.execute(ctx.db);
    expect(await store.hasProjectPermission(admin, 'ordinary', 'manage')).toBe(false);
    await expect(
      sql`update project_memberships set can_read = false, can_execute = true
        where project_id = 'ordinary' and user_id = 'member'`.execute(ctx.db),
    ).rejects.toThrow();
  } finally {
    await ctx.close();
  }
});
