import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { createSecretCipher } from './crypto.js';
import { INVITATION_MAX_TTL_MS, ProjectTeamError, ProjectTeamStore } from './project-team.js';
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

// A real cipher: the test store's passthrough would store the secret in clear.
const team = () => new ProjectTeamStore(ctx.db, createSecretCipher('cd'.repeat(32)));
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
/** Core accepts the join's tunnel, as `team.join.pending` would have it. */
const admit = async (redemptionId: string, invitationId = 'inv-1', permissions?: string[]) => {
  const row = await ctx.db
    .selectFrom('project_invitations')
    .select('can_execute')
    .where('invitation_id', '=', invitationId)
    .executeTakeFirst();
  return team().admitJoin({
    sessionId: `session-${redemptionId}`,
    invitationId,
    redemptionId,
    projectId: 'p1',
    permissions: permissions ?? (row?.can_execute ? ['read', 'execute'] : ['read']),
  });
};
const redeem = async (secret: string, redemptionId = 'r1') => {
  await admit(redemptionId);
  return team().redeemInvitation({
    invitationId: 'inv-1',
    secret,
    redemptionId,
    displayName: 'Lena',
  });
};

// The link secret is the only thing that lets someone join; it must not be
// readable from the database, and Uplink learns only its commitment.
it('keeps the link secret out of storage and queues the creation for Uplink', async () => {
  const { invitation, secret } = await invite();
  const stored = await ctx.db.selectFrom('project_invitations').selectAll().executeTakeFirst();
  expect(JSON.stringify(stored)).not.toContain(secret);
  // Kept encrypted to rebuild the link, and only while it can still be shared.
  await expect(team().invitationSecret('p1', invitation.id)).resolves.toBe(secret);
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
  // Pending until Uplink confirms the join, which it is asked to do.
  expect((await team().listMembers('p1')).map((member) => member.userId)).toEqual([ADMIN]);
  expect((await team().dueOperations()).map((operation) => operation.kind)).toContain(
    'team.join.commit',
  );
  expect(await team().confirmJoin('r1')).toBe(true);
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
  await admit('late');
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
  await expect(team().invitationSecret('p1', invitation.id)).resolves.toBeUndefined();
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
  await team().confirmJoin('r1');
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

// Revoked before Uplink answered the creation: the answer must not bring it
// back, and Uplink has to be told to cancel it.
it('withdraws an invitation revoked while Uplink was still creating it', async () => {
  const created = await team().createInvitation({
    projectId: 'p1',
    inviterUserId: ADMIN,
    inviteeName: 'Lena',
    canExecute: false,
  });
  expect(await team().revokeInvitation('p1', created.invitation.id)).toBe(true);
  expect((await team().dueOperations()).map((operation) => operation.kind)).not.toContain(
    'team.invite.cancel',
  );
  expect(
    await team().markInvitationCreated(
      created.invitation.id,
      'inv-late',
      new Date(Date.now() + 1000),
    ),
  ).toBeUndefined();
  const cancel = (await team().dueOperations()).find(
    (operation) => operation.kind === 'team.invite.cancel',
  );
  expect(cancel?.payload).toMatchObject({ invitationId: 'inv-late' });
  await admit('r9', 'inv-late');
  await expect(
    team().redeemInvitation({
      invitationId: 'inv-late',
      secret: created.secret,
      redemptionId: 'r9',
      displayName: 'Lena',
    }),
  ).rejects.toBeInstanceOf(ProjectTeamError);
});

it('admits a join tunnel only for what the invitation binds, and stores the decision', async () => {
  await invite(false);
  // The permissions Uplink presents must be the invitation's own.
  await expect(admit('r-wide', 'inv-1', ['read', 'execute'])).resolves.toBe('refused');
  await expect(admit('r-ok', 'inv-1', ['read'])).resolves.toBe('accepted');
  // A repeated pending message gets the same stored answer, not a new decision.
  await expect(admit('r-ok', 'inv-1', ['read'])).resolves.toBe('accepted');
  await expect(
    team().admitJoin({
      sessionId: 'session-other',
      invitationId: 'inv-1',
      redemptionId: 'r-ok',
      projectId: 'p1',
      permissions: ['read'],
    }),
  ).resolves.toBe('refused');
  await expect(
    team().admitJoin({
      sessionId: 'session-p2',
      invitationId: 'inv-1',
      redemptionId: 'r-p2',
      projectId: 'p2',
      permissions: ['read'],
    }),
  ).resolves.toBe('refused');
  await expect(admit('r-unknown', 'inv-unknown', ['read'])).resolves.toBe('refused');
});

it('redeems only with the redemption of an accepted tunnel', async () => {
  const { secret } = await invite();
  // A redemption the app made up itself is never accepted.
  await expect(
    team().redeemInvitation({
      invitationId: 'inv-1',
      secret,
      redemptionId: 'mine',
      displayName: 'Lena',
    }),
  ).rejects.toBeInstanceOf(ProjectTeamError);
  // Nor one whose tunnel Core refused.
  await admit('refused', 'inv-1', ['read']);
  await expect(
    team().redeemInvitation({
      invitationId: 'inv-1',
      secret,
      redemptionId: 'refused',
      displayName: 'Lena',
    }),
  ).rejects.toBeInstanceOf(ProjectTeamError);
  // Nor one past its tunnel's lifetime.
  await admit('stale');
  await expect(
    team().redeemInvitation({
      invitationId: 'inv-1',
      secret,
      redemptionId: 'stale',
      displayName: 'Lena',
      now: new Date(Date.now() + 11 * 60 * 1000),
    }),
  ).rejects.toBeInstanceOf(ProjectTeamError);
  await expect(redeem(secret, 'r1')).resolves.toMatchObject({ replay: false });
});

it('fences a pending person whose join Uplink refused for good', async () => {
  const { secret, invitation } = await invite();
  const joined = await redeem(secret);
  await ctx.db
    .insertInto('auth_tokens')
    .values({ id: 't1', user_id: joined.userId, token_hash: 'h' })
    .execute();
  await expect(team().failJoin('r1')).resolves.toBe(true);
  const memberships = await ctx.db
    .selectFrom('project_memberships')
    .select('user_id')
    .where('user_id', '=', joined.userId)
    .execute();
  expect(memberships).toEqual([]);
  const tokens = await ctx.db
    .selectFrom('auth_tokens')
    .select('id')
    .where('user_id', '=', joined.userId)
    .execute();
  expect(tokens).toEqual([]);
  // The inviter sees it failed and invites again.
  const [listed] = await team().listInvitations('p1');
  expect(listed).toMatchObject({ id: invitation.id, state: 'failed' });
  // A later confirmation cannot bring the fenced person back.
  expect((await team().listMembers('p1')).map((member) => member.userId)).not.toContain(
    joined.userId,
  );
});

it('marks an invitation Uplink refused to create as failed', async () => {
  const created = await team().createInvitation({
    projectId: 'p1',
    inviterUserId: ADMIN,
    inviteeName: 'Mia',
    canExecute: false,
  });
  await team().failInvitation(created.invitation.id);
  const [listed] = await team().listInvitations('p1');
  expect(listed).toMatchObject({ state: 'failed' });
  await expect(team().invitationSecret('p1', created.invitation.id)).resolves.toBeUndefined();
});
