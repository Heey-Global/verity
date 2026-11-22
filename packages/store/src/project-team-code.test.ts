// The "Code" right (ADR 0023 §1): it needs Edit, managing includes it, it stays
// on this server when an invitation goes through Uplink, and nobody who could
// edit before the upgrade loses the ability to merge and save.
import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSecretCipher } from './crypto.js';
import { migrationProvider } from './migrations.js';
import { ProjectTeamStore } from './project-team.js';
import { createIsolatedTestDb, createTestDb, truncateAll, type TestDb } from './testing.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const cipher = createSecretCipher('cd'.repeat(32));

describe('the Code right', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await createTestDb();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await truncateAll(ctx.db);
    await ctx.db
      .insertInto('users')
      .values([{ id: ADMIN, role: 'administrator', status: 'active' }])
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute();
    await ctx.store.upsertProject({
      id: 'p1',
      owner: 'acme',
      repo: 'app',
      containerName: 'verity-acme--app',
      state: 'active',
    });
  });

  const team = () => new ProjectTeamStore(ctx.db, cipher);

  /** Invite, admit and redeem until the person is an active member. */
  async function join(rights: { canExecute: boolean; canCode?: boolean }): Promise<string> {
    const created = await team().createInvitation({
      projectId: 'p1',
      inviterUserId: ADMIN,
      inviteeName: 'Mara',
      ...rights,
    });
    await team().markInvitationCreated(
      created.invitation.id,
      'inv-1',
      created.invitation.expiresAt,
    );
    // Uplink's admission carries only read and execute, exactly as before.
    await expect(
      team().admitJoin({
        sessionId: 'session-r1',
        invitationId: 'inv-1',
        redemptionId: 'r1',
        projectId: 'p1',
        permissions: rights.canExecute ? ['read', 'execute'] : ['read'],
      }),
    ).resolves.toBe('accepted');
    const joined = await team().redeemInvitation({
      invitationId: 'inv-1',
      secret: created.secret,
      redemptionId: 'r1',
      displayName: 'Mara',
    });
    const admission = await ctx.db
      .selectFrom('team_join_admissions')
      .select('device_token_encrypted')
      .where('redemption_id', '=', 'r1')
      .executeTakeFirstOrThrow();
    await team().completeJoin(cipher.decrypt(admission.device_token_encrypted!));
    await team().confirmJoin('r1');
    return joined.userId;
  }

  it("gives a new project's creator Code through the creator trigger", async () => {
    expect(await ctx.store.hasProjectPermission(ADMIN, 'p1', 'code')).toBe(true);
    expect((await team().listMembers('p1'))[0]).toMatchObject({ creator: true, canCode: true });
  });

  // Uplink must not learn of Code: its contract compares the permissions list
  // on admission, and a changed list would refuse every join.
  it('applies Code from the stored invitation on joining, without telling Uplink', async () => {
    const userId = await join({ canExecute: true, canCode: true });
    const [operation] = await team().dueOperations();
    expect(operation?.payload).toMatchObject({ permissions: ['read', 'execute'] });
    expect(JSON.stringify(operation?.payload)).not.toContain('code');
    expect(await ctx.store.hasProjectPermission(userId, 'p1', 'code')).toBe(true);
  });

  it('invites without Code unless it is chosen, and never Code without Edit', async () => {
    const userId = await join({ canExecute: true });
    expect(await ctx.store.hasProjectPermission(userId, 'p1', 'execute')).toBe(true);
    expect(await ctx.store.hasProjectPermission(userId, 'p1', 'code')).toBe(false);
    await expect(
      team().createInvitation({
        projectId: 'p1',
        inviterUserId: ADMIN,
        inviteeName: 'Kim',
        canExecute: false,
        canCode: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_rights' });
  });

  it('refuses rights whose prerequisites are missing', async () => {
    const userId = await join({ canExecute: true });
    await expect(
      team().setMemberRights('p1', userId, { canExecute: false, canCode: true, canManage: false }),
    ).rejects.toMatchObject({ code: 'invalid_rights' });
    await expect(
      team().setMemberRights('p1', userId, { canExecute: true, canCode: false, canManage: true }),
    ).rejects.toMatchObject({ code: 'invalid_rights' });
    await expect(
      team().setMemberRights('p1', userId, { canExecute: true, canCode: true, canManage: false }),
    ).resolves.toMatchObject({ canExecute: true, canCode: true, canManage: false });
  });

  // An app from before Code sends only Edit and Manage. Keeping Code where the
  // rights still allow it means such an app cannot silently strip it.
  it('keeps Code for an app that predates it, and brings it along with managing', async () => {
    const userId = await join({ canExecute: true, canCode: true });
    await expect(
      team().setMemberRights('p1', userId, { canExecute: true, canManage: false }),
    ).resolves.toMatchObject({ canCode: true });
    await expect(
      team().setMemberRights('p1', userId, { canExecute: false, canManage: false }),
    ).resolves.toMatchObject({ canExecute: false, canCode: false });
    await expect(
      team().setMemberRights('p1', userId, { canExecute: true, canManage: true }),
    ).resolves.toMatchObject({ canCode: true, canManage: true });
  });

  // The constraint holds even for a writer that bypasses the store.
  it('rejects Code without Edit in the database itself', async () => {
    const userId = await join({ canExecute: true });
    await expect(
      sql`update project_memberships set can_execute = false, can_code = true
        where user_id = ${userId}`.execute(ctx.db),
    ).rejects.toThrow(/project_memberships_code_needs_execute/);
  });
});

// Before Code, Edit alone allowed merging and saving to the project. The
// upgrade must not take that from anyone, including open invitations and
// projects that an older server creates during a rolling upgrade.
describe('migration 0237', () => {
  it('gives Code to every member and invitation with Edit, and to new creators', async () => {
    const legacy = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: legacy.db, provider: migrationProvider });
      expect((await migrator.migrateTo('0236_session_message_recency_index')).error).toBe(
        undefined,
      );
      await sql`insert into projects (id, owner, repo, container_name, state)
        values ('old', 'local', 'old', 'old', 'active')`.execute(legacy.db);
      await sql`insert into users (id, role, status) values
        ('editor', 'member', 'active'), ('reader', 'member', 'active')`.execute(legacy.db);
      await sql`insert into project_memberships
        (project_id, user_id, can_read, can_execute, can_manage) values
        ('old', 'editor', true, true, false), ('old', 'reader', true, false, false)`.execute(
        legacy.db,
      );
      await sql`insert into project_invitations
        (id, project_id, inviter_user_id, invitee_name, can_execute, secret_hash, state, expires_at)
        values
        ('00000000-0000-4000-8000-0000000000a1', 'old', ${ADMIN}, 'Edit', true, 'h1', 'open', now() + interval '1 day'),
        ('00000000-0000-4000-8000-0000000000a2', 'old', ${ADMIN}, 'Read', false, 'h2', 'open', now() + interval '1 day')`.execute(
        legacy.db,
      );

      expect((await migrator.migrateTo('0237_project_code_permission')).error).toBe(undefined);

      const members = await sql<{ user_id: string; can_code: boolean }>`
        select user_id, can_code from project_memberships where project_id = 'old'
        order by user_id`.execute(legacy.db);
      expect(members.rows).toEqual([
        { user_id: ADMIN, can_code: true },
        { user_id: 'editor', can_code: true },
        { user_id: 'reader', can_code: false },
      ]);
      const invitations = await sql<{ invitee_name: string; can_code: boolean }>`
        select invitee_name, can_code from project_invitations order by invitee_name`.execute(
        legacy.db,
      );
      expect(invitations.rows).toEqual([
        { invitee_name: 'Edit', can_code: true },
        { invitee_name: 'Read', can_code: false },
      ]);
      // An older server's insert names no `can_code`; the trigger still gives it.
      await sql`insert into projects (id, owner, repo, container_name, state)
        values ('new', 'local', 'new', 'new', 'active')`.execute(legacy.db);
      const creator = await sql<{ can_code: boolean }>`
        select can_code from project_memberships where project_id = 'new'`.execute(legacy.db);
      expect(creator.rows).toEqual([{ can_code: true }]);

      expect((await migrator.migrateDown()).error).toBe(undefined);
      await sql`insert into projects (id, owner, repo, container_name, state)
        values ('after-down', 'local', 'after-down', 'after-down', 'active')`.execute(legacy.db);
    } finally {
      await legacy.close();
    }
  }, 60_000);
});
