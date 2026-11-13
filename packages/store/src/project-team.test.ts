import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { INVITATION_MAX_TTL_MS, ProjectTeamError } from './project-team.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
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

const team = () => ctx.store.projectTeam;
const invite = async (canExecute = true) => {
  const created = await team().createInvitation({
    projectId: 'p1',
    inviterUserId: ADMIN,
    inviteeName: 'Lena',
    canExecute,
  });
  await team().markInvitationCreated(created.invitation.id, 'inv-1', created.invitation.expiresAt);
  return created;
};
const redeem = (secret: string, redemptionId = 'r1') =>
  team().redeemInvitation({ invitationId: 'inv-1', secret, redemptionId, displayName: 'Lena' });

// The link secret is the only thing that lets someone join; it must not be
// readable from the database, and Uplink learns only its commitment.
it('keeps the link secret out of storage and queues the creation for Uplink', async () => {
  const { invitation, secret } = await invite();
  const stored = await ctx.db.selectFrom('project_invitations').selectAll().executeTakeFirst();
  expect(JSON.stringify(stored)).not.toContain(secret);
  const [operation] = await team().dueOperations();
  expect(operation).toMatchObject({
    kind: 'team.invite.create',
    payload: { localInviteId: invitation.id, permissions: ['read', 'execute'] },
  });
  expect(JSON.stringify(operation)).not.toContain(secret);
  expect(invitation.expiresAt.getTime() - invitation.createdAt.getTime()).toBeLessThanOrEqual(
    INVITATION_MAX_TTL_MS + 1000,
  );
});

// One invitation brings in one person, once; a replay of that same redemption
// changes nothing, any other use is refused.
it('redeems an invitation exactly once, as a member who cannot manage', async () => {
  const { secret } = await invite();
  const first = await redeem(secret);
  expect(first.replay).toBe(false);
  await expect(redeem(secret)).resolves.toEqual({ ...first, replay: true });
  await expect(redeem(secret, 'r2')).rejects.toBeInstanceOf(ProjectTeamError);
  const members = await team().listMembers('p1');
  expect(members.find((member) => member.userId === first.userId)).toMatchObject({
    displayName: 'Lena',
    canRead: true,
    canExecute: true,
    canManage: false,
  });
  const user = await ctx.db
    .selectFrom('users')
    .select('role')
    .where('id', '=', first.userId)
    .executeTakeFirst();
  expect(user?.role).toBe('member');
});

it('refuses a wrong secret, a revoked or expired invitation and a departed inviter', async () => {
  const { invitation, secret } = await invite();
  await expect(redeem('wrong')).rejects.toBeInstanceOf(ProjectTeamError);
  await expect(
    team().redeemInvitation({
      invitationId: 'inv-1',
      secret,
      redemptionId: 'late',
      displayName: 'Lena',
      now: new Date(invitation.expiresAt.getTime() + 1),
    }),
  ).rejects.toBeInstanceOf(ProjectTeamError);
  // An inviter who may no longer manage the project cannot bring anyone in.
  const manage = (value: boolean) =>
    ctx.db
      .updateTable('project_memberships')
      .set({ can_manage: value })
      .where('project_id', '=', 'p1')
      .where('user_id', '=', ADMIN)
      .execute();
  await manage(false);
  await expect(redeem(secret)).rejects.toBeInstanceOf(ProjectTeamError);
  await manage(true);
  expect(await team().revokeInvitation('p1', invitation.id)).toBe(true);
  await expect(redeem(secret)).rejects.toBeInstanceOf(ProjectTeamError);
  expect((await team().dueOperations()).map((operation) => operation.kind)).toContain(
    'team.invite.cancel',
  );
});

it('never shares the control-plane project', async () => {
  await ctx.store.upsertProject({
    id: 'control',
    kind: 'control_plane',
    owner: 'verity',
    repo: 'control',
    containerName: 'verity-control',
    state: 'active',
  });
  await expect(
    team().createInvitation({
      projectId: 'control',
      inviterUserId: ADMIN,
      inviteeName: 'Lena',
      canExecute: false,
    }),
  ).rejects.toMatchObject({ code: 'project_not_shareable' });
});

// The creator always keeps the project; anyone else's rights can change, and
// leaving their last project tells Uplink the person left the team.
it('changes and removes members but never the creator', async () => {
  const { secret } = await invite(false);
  const { userId } = await redeem(secret);
  await expect(
    team().setMemberRights('p1', userId, { canExecute: true, canManage: true }),
  ).resolves.toMatchObject({ canExecute: true, canManage: true });
  await expect(
    team().setMemberRights('p1', ADMIN, { canExecute: false, canManage: false }),
  ).rejects.toMatchObject({ code: 'creator_unchangeable' });
  await expect(team().removeMember('p1', userId)).resolves.toEqual({ lastProject: true });
  expect((await team().listMembers('p1')).map((member) => member.userId)).toEqual([ADMIN]);
  expect((await team().dueOperations()).map((operation) => operation.kind)).toContain(
    'team.membership.remove',
  );
});
