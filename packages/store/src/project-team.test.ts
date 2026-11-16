import { sql } from 'kysely';
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

async function authorize(redemptionId: string) {
  const row = await ctx.db
    .selectFrom('team_join_admissions')
    .select('device_token_encrypted')
    .where('redemption_id', '=', redemptionId)
    .executeTakeFirstOrThrow();
  await team().completeJoin(
    createSecretCipher('cd'.repeat(32)).decrypt(row.device_token_encrypted!),
  );
}

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
  const admission = await ctx.db
    .selectFrom('team_join_admissions')
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(admission.device_token_encrypted).toMatch(/^enc:v1:/);
  expect(JSON.stringify(admission)).not.toContain(first.token);
  // Losing the token response cannot activate a person without a stored credential.
  expect((await team().listMembers('p1')).map((member) => member.userId)).toEqual([ADMIN]);
  expect((await team().dueOperations()).map((operation) => operation.kind)).not.toContain(
    'team.join.commit',
  );
  expect(await team().confirmJoin('r1')).toBe(false);
  await expect(team().completeJoin(secret)).rejects.toBeInstanceOf(ProjectTeamError);
  await expect(team().completeJoin(first.token)).resolves.toEqual({
    projectId: 'p1',
    confirmed: false,
  });
  await team().completeJoin(first.token);
  await expect(
    team().completeJoin(first.token, new Date(Date.now() + 86_400_000)),
  ).resolves.toEqual({ projectId: 'p1', confirmed: false });
  expect(
    (await team().dueOperations()).filter((operation) => operation.kind === 'team.join.commit'),
  ).toHaveLength(1);
  await expect(redeem(secret)).resolves.toEqual({ ...first, replay: true });
  expect(await team().confirmJoin('r1')).toBe(true);
  await expect(
    team().completeJoin(first.token, new Date(Date.now() + 86_400_000)),
  ).resolves.toEqual({ projectId: 'p1', confirmed: true });
  await expect(redeem(secret)).rejects.toBeInstanceOf(ProjectTeamError);
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
  await authorize('r1');
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
  ).resolves.toBe('accepted');
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

it('never fences a person Uplink already confirmed, nor confirms one it fenced', async () => {
  const { secret } = await invite();
  const joined = await redeem(secret);
  await authorize('r1');
  await team().confirmJoin('r1');
  await expect(team().failJoin('r1')).resolves.toBe(false);
  expect((await team().listMembers('p1')).map((member) => member.userId)).toContain(joined.userId);

  const second = await team().createInvitation({
    projectId: 'p1',
    inviterUserId: ADMIN,
    inviteeName: 'Mia',
    canExecute: false,
  });
  await team().markInvitationCreated(second.invitation.id, 'inv-2', second.invitation.expiresAt);
  await admit('r2', 'inv-2');
  const mia = await team().redeemInvitation({
    invitationId: 'inv-2',
    secret: second.secret,
    redemptionId: 'r2',
    displayName: 'Mia',
  });
  // Fence and confirmation race; whichever runs second must not undo the fence.
  await Promise.all([team().failJoin('r2'), team().confirmJoin('r2')]);
  const status = await ctx.db
    .selectFrom('users')
    .select('status')
    .where('id', '=', mia.userId)
    .executeTakeFirst();
  const fenced = (await team().listInvitations('p1')).some(
    (invitation) => invitation.id === second.invitation.id && invitation.state === 'failed',
  );
  // Either the fence won (still disabled) or the confirmation won (active, not failed).
  expect(fenced ? status?.status === 'disabled' : status?.status === 'active').toBe(true);
});

it('never brings a removed person back with a replayed confirmation', async () => {
  const { secret } = await invite();
  const joined = await redeem(secret);
  await authorize('r1');
  await team().confirmJoin('r1');
  await team().removeMember('p1', joined.userId);
  await ctx.db
    .updateTable('users')
    .set({ status: 'disabled' })
    .where('id', '=', joined.userId)
    .execute();
  await expect(team().confirmJoin('r1')).resolves.toBe(false);
  const user = await ctx.db
    .selectFrom('users')
    .select('status')
    .where('id', '=', joined.userId)
    .executeTakeFirst();
  expect(user?.status).toBe('disabled');
});

it("keeps a joiner's name free of controls that would reorder other people's lists", async () => {
  const { secret } = await invite();
  await admit('r-bidi');
  await expect(
    team().redeemInvitation({
      invitationId: 'inv-1',
      secret,
      redemptionId: 'r-bidi',
      displayName: 'Lena \u202e',
    }),
  ).rejects.toThrow();
});

it('refuses a replay after admission expiry or token revocation', async () => {
  const { secret } = await invite();
  const first = await redeem(secret);
  const replay = () =>
    team().redeemInvitation({
      invitationId: 'inv-1',
      secret,
      redemptionId: 'r1',
      displayName: 'Lena',
    });
  await sql`update team_join_admissions set expires_at = ${new Date(0)}`.execute(ctx.db);
  await expect(replay()).rejects.toBeInstanceOf(ProjectTeamError);
  await expect(admit('r1')).resolves.toBe('refused');
  await sql`update team_join_admissions set expires_at = ${new Date(Date.now() + 60_000)}`.execute(
    ctx.db,
  );
  await ctx.db.deleteFrom('auth_tokens').where('id', '=', first.tokenId).execute();
  await expect(replay()).rejects.toBeInstanceOf(ProjectTeamError);
});

it('keeps a saved credential across reattachment but refuses expired, revoked and cancelled completion', async () => {
  const { invitation, secret } = await invite();
  const joined = await redeem(secret);
  const original = await ctx.db
    .selectFrom('team_join_admissions')
    .selectAll()
    .where('redemption_id', '=', 'r1')
    .executeTakeFirstOrThrow();
  await expect(
    team().admitJoin({
      sessionId: 'resume',
      invitationId: 'inv-1',
      redemptionId: 'r1',
      projectId: 'p1',
      permissions: ['read', 'execute'],
    }),
  ).resolves.toBe('accepted');
  await team().rollbackJoinAdmission({ sessionId: 'resume', redemptionId: 'r1' });
  const after = await ctx.db
    .selectFrom('team_join_admissions')
    .selectAll()
    .where('redemption_id', '=', 'r1')
    .executeTakeFirstOrThrow();
  expect(after.expires_at).toEqual(original.expires_at);
  await expect(
    team().completeJoin(joined.token, new Date(original.expires_at.getTime() + 1)),
  ).rejects.toBeInstanceOf(ProjectTeamError);
  await expect(team().revokeInvitation('p1', invitation.id)).resolves.toBe(true);
  await expect(team().completeJoin(joined.token)).rejects.toBeInstanceOf(ProjectTeamError);
  expect(await team().confirmJoin('r1')).toBe(false);
  expect((await team().listMembers('p1')).map((member) => member.userId)).toEqual([ADMIN]);
});

// PGlite serializes transactions; this interleaving needs separate PostgreSQL connections.
it.skipIf(!process.env.VERITY_TEST_SHARED_POSTGRES_URL)(
  'keeps the admission when tunnel rollback races credential redemption',
  async () => {
    const created = await invite();
    await admit('r1');
    let selected!: () => void;
    const selection = new Promise<void>((resolve) => {
      selected = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admissionQueries = new Set<unknown>();
    const db = ctx.db.withPlugin({
      transformQuery(args) {
        if (
          args.node.kind === 'SelectQueryNode' &&
          JSON.stringify(args.node).includes('team_join_admissions')
        )
          admissionQueries.add(args.queryId);
        return args.node;
      },
      async transformResult(args) {
        if (admissionQueries.delete(args.queryId)) {
          selected();
          await held;
        }
        return args.result;
      },
    });
    const redemption = new ProjectTeamStore(
      db,
      createSecretCipher('cd'.repeat(32)),
    ).redeemInvitation({
      invitationId: 'inv-1',
      secret: created.secret,
      redemptionId: 'r1',
      displayName: 'Lena',
    });
    await selection;
    const rollback = team().rollbackJoinAdmission({ sessionId: 'session-r1', redemptionId: 'r1' });
    // Give the second connection time to attempt deletion while redemption holds its row.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const joined = await redemption;
    await rollback;
    await expect(team().completeJoin(joined.token)).resolves.toEqual({
      projectId: 'p1',
      confirmed: false,
    });
  },
);

it('retires encrypted replay secrets on confirmation and expiry while retaining completion bindings', async () => {
  const created = await invite();
  await admit('r1');
  const joined = await redeem(created.secret);
  await team().completeJoin(joined.token);
  await team().clearExpiredJoinCredentials(new Date(Date.now() + 11 * 60_000));
  const expired = await ctx.db
    .selectFrom('team_join_admissions')
    .select(['device_token_encrypted', 'device_token_id'])
    .where('redemption_id', '=', 'r1')
    .executeTakeFirstOrThrow();
  expect(expired).toEqual({ device_token_encrypted: null, device_token_id: joined.tokenId });
  await expect(team().completeJoin(joined.token)).resolves.toEqual({
    projectId: 'p1',
    confirmed: false,
  });
  // Simulate a retained copy from before expiry cleanup to exercise confirmation independently.
  await ctx.db
    .updateTable('team_join_admissions')
    .set({ device_token_encrypted: 'retained-copy' })
    .where('redemption_id', '=', 'r1')
    .execute();
  await team().confirmJoin('r1');
  const confirmed = await ctx.db
    .selectFrom('team_join_admissions')
    .select('device_token_encrypted')
    .where('redemption_id', '=', 'r1')
    .executeTakeFirstOrThrow();
  expect(confirmed.device_token_encrypted).toBeNull();
  await expect(team().completeJoin(joined.token)).resolves.toEqual({
    projectId: 'p1',
    confirmed: true,
  });
});

it('holds Uplink demand while a redeemed join can still recover without an outbox commit', async () => {
  const created = await invite();
  const joined = await redeem(created.secret);
  const operations = await team().dueOperations();
  for (const operation of operations) await team().completeOperation(operation.operationId);
  expect(await team().hasTeamWork()).toBe(true);
  expect(await team().hasTeamWork(new Date(Date.now() + 11 * 60_000))).toBe(false);
  await team().completeJoin(joined.token);
  await team().confirmJoin('r1');
  for (const operation of await team().dueOperations())
    await team().completeOperation(operation.operationId);
  expect(await team().hasTeamWork()).toBe(false);
});

it('queues removal when a pending join is revoked after its commit answer was lost', async () => {
  const created = await invite();
  const joined = await redeem(created.secret);
  await team().completeJoin(joined.token);
  const person = await ctx.db
    .selectFrom('users')
    .select('team_membership_ref')
    .where('id', '=', joined.userId)
    .executeTakeFirstOrThrow();
  await team().revokeInvitation('p1', created.invitation.id);
  expect(await team().confirmJoin('r1')).toBe(false);
  expect(
    (await team().dueOperations()).find((entry) => entry.kind === 'team.membership.remove')
      ?.payload,
  ).toMatchObject({ membershipRef: person.team_membership_ref, reason: 'membership_removed' });
});

it.each(['expired', 'authority', 'unshareable'])(
  'rechecks %s invitation conditions before rebinding a saved admission',
  async (changed) => {
    const created = await invite();
    await redeem(created.secret);
    if (changed === 'expired')
      await ctx.db
        .updateTable('project_invitations')
        .set({ expires_at: new Date(0) })
        .execute();
    if (changed === 'authority')
      await ctx.db
        .updateTable('project_memberships')
        .set({ can_manage: false })
        .where('user_id', '=', ADMIN)
        .execute();
    if (changed === 'unshareable')
      await ctx.db
        .updateTable('projects')
        .set({ kind: 'control_plane' })
        .where('id', '=', 'p1')
        .execute();
    await expect(
      team().admitJoin({
        sessionId: 'resume-invalid',
        invitationId: 'inv-1',
        redemptionId: 'r1',
        projectId: 'p1',
        permissions: ['read', 'execute'],
      }),
    ).resolves.toBe('refused');
    const original = await ctx.db
      .selectFrom('team_join_admissions')
      .select('session_id')
      .where('redemption_id', '=', 'r1')
      .executeTakeFirstOrThrow();
    expect(original.session_id).toBe('session-r1');
  },
);
