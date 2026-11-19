import { readFileSync } from 'node:fs';
import { createIsolatedTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTeamOutboxWorker,
  TEAM_OFFLINE_GRACE_MS,
  TEAM_WAIT_LOG_MS,
} from './team-outbox-worker.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const IDENTITY_KEY = 'MCowBQYDK2VwAyEAERERERERERERERERERERERERERERERERERERERE';

/** The valid wire fixture of each team message, as the contract defines it. */
const fixtures = (
  JSON.parse(
    readFileSync(
      new URL('../../../scripts/team-control-contract/wire-fixtures.json', import.meta.url),
      'utf8',
    ),
  ) as { valid: boolean; value: Record<string, unknown> }[]
).filter((fixture) => fixture.valid);
const fixtureKeys = (type: string): string[] =>
  Object.keys(fixtures.find((fixture) => fixture.value.type === type)!.value).sort();

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createIsolatedTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'acme',
    repo: 'app',
    containerName: 'verity-acme--app',
    state: 'active',
  });
});

function uplink(
  answers: Record<string, (fields: Record<string, unknown>) => Record<string, unknown>>,
) {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    uplink: {
      teamNegotiated: () => true,
      teamRequest: async (type: string, fields: Record<string, unknown>) => {
        // What the control client puts on the wire around these fields.
        sent.push({ type, requestId: 'r', teamVersion: 1, ...fields });
        return { type: 'unused', ...answers[type]!(fields) };
      },
    },
  };
}

describe('team outbox worker', () => {
  // An outage beyond the retry window must be visible, but polling cannot
  // revive changes on its own or give a replay a new id.
  it('records exhaustion once offline and resumes unfinished changes on the next team change', async () => {
    const team = ctx.store.projectTeam;
    const now = new Date();
    const expired = new Date(now.getTime() - 1);
    await ctx.db
      .insertInto('team_outbox')
      .values([
        {
          operation_id: 'exhausted',
          kind: 'team.membership.remove',
          payload: '{}',
          give_up_at: expired,
        },
        {
          operation_id: 'completed',
          kind: 'team.membership.remove',
          payload: '{}',
          give_up_at: expired,
          done_at: expired,
        },
      ])
      .execute();
    const warn = vi.fn();
    const worker = createTeamOutboxWorker({
      team,
      uplink: { teamNegotiated: () => false, teamRequest: vi.fn() },
      identityKey: () => IDENTITY_KEY,
      now: () => now,
      log: { warn },
    });
    await worker.run();
    await worker.run();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      operationId: 'exhausted',
      kind: 'team.membership.remove',
    });
    expect(await team.dueOperations(now)).toEqual([]);
    expect(await team.hasTeamWork(now)).toBe(false);
    const row = await ctx.db
      .selectFrom('team_outbox')
      .selectAll()
      .where('operation_id', '=', 'exhausted')
      .executeTakeFirstOrThrow();
    expect(row.failed_at).toEqual(now);

    await team.createInvitation({
      projectId: 'p1',
      inviterUserId: ADMIN,
      inviteeName: 'Next',
      canExecute: false,
      now,
    });
    const due = await team.dueOperations(now);
    expect(due.map((operation) => operation.operationId)).toContain('exhausted');
    expect(due.map((operation) => operation.operationId)).not.toContain('completed');
    expect(await team.hasTeamWork(now)).toBe(true);
    const resumed = await ctx.db
      .selectFrom('team_outbox')
      .selectAll()
      .where('operation_id', '=', 'exhausted')
      .executeTakeFirstOrThrow();
    expect(resumed.failed_at).toBeNull();
    expect(resumed.give_up_at.getTime()).toBeGreaterThan(now.getTime());
    await worker.run();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Work queued while Uplink withholds team v1 used to wait in silence for
  // seven days. The reason must reach the log, without one line per pass.
  it('logs queued team work that waits for team v1, with its reason and rate-limited', async () => {
    const start = new Date();
    let clock = start;
    let availability: 'uplink_offline' | 'not_entitled' = 'uplink_offline';
    const warn = vi.fn();
    const teamRequest = vi.fn();
    const worker = createTeamOutboxWorker({
      team: ctx.store.projectTeam,
      uplink: { teamNegotiated: () => false, teamAvailability: () => availability, teamRequest },
      identityKey: () => IDENTITY_KEY,
      now: () => clock,
      log: { warn },
    });
    await worker.run();
    expect(warn).not.toHaveBeenCalled();

    await ctx.store.projectTeam.createInvitation({
      projectId: 'p1',
      inviterUserId: ADMIN,
      inviteeName: 'Neil',
      canExecute: true,
      now: start,
    });
    const at = (ms: number) => new Date(start.getTime() + ms);
    // Waking the connection for new work takes a moment; that is no news.
    await worker.run();
    clock = at(TEAM_OFFLINE_GRACE_MS - 1);
    await worker.run();
    expect(warn).not.toHaveBeenCalled();
    // A definitive reason is logged at once.
    availability = 'not_entitled';
    await worker.run();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({ queued: 1, teamSharing: 'not_entitled' });

    // Flapping reasons do not bypass the interval.
    availability = 'uplink_offline';
    clock = at(2 * TEAM_OFFLINE_GRACE_MS);
    await worker.run();
    availability = 'not_entitled';
    clock = at(2 * TEAM_OFFLINE_GRACE_MS + 1);
    await worker.run();
    expect(warn).toHaveBeenCalledTimes(1);
    clock = at(TEAM_OFFLINE_GRACE_MS - 1 + TEAM_WAIT_LOG_MS);
    await worker.run();
    expect(warn).toHaveBeenCalledTimes(2);

    // Offline that lasts beyond the grace period is worth a line too.
    availability = 'uplink_offline';
    clock = at(2 * TEAM_WAIT_LOG_MS);
    await worker.run();
    expect(warn).toHaveBeenCalledTimes(2);
    clock = at(2 * TEAM_WAIT_LOG_MS + TEAM_OFFLINE_GRACE_MS);
    await worker.run();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2]?.[0]).toEqual({ queued: 1, teamSharing: 'uplink_offline' });
    expect(teamRequest).not.toHaveBeenCalled();
  });

  // Team messages are strict: Uplink rejects an unknown field and a missing one.
  // Every message sent must carry exactly the fields of its contract fixture.
  it('sends invitations, joins and removals exactly as the contract defines them', async () => {
    const team = ctx.store.projectTeam;
    const { uplink: fake, sent } = uplink({
      'team.invite.create': () => ({
        type: 'team.invite.created',
        invitationId: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
      'team.join.commit': (fields) => ({
        type: 'team.join.committed',
        redemptionId: fields.redemptionId,
      }),
      'team.membership.remove': (fields) => ({
        type: 'team.membership.removed',
        membershipRef: fields.membershipRef,
      }),
    });
    const worker = createTeamOutboxWorker({ team, uplink: fake, identityKey: () => IDENTITY_KEY });
    const { invitation, secret } = await team.createInvitation({
      projectId: 'p1',
      inviterUserId: ADMIN,
      inviteeName: 'Lena',
      canExecute: true,
    });
    await worker.run();
    const [open] = await team.listInvitations('p1');
    expect(open).toMatchObject({ id: invitation.id, state: 'open' });

    await team.admitJoin({
      sessionId: 'session_1',
      invitationId: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM',
      redemptionId: 'redemption_1',
      projectId: 'p1',
      permissions: ['read', 'execute'],
    });
    const joined = await team.redeemInvitation({
      invitationId: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM',
      secret,
      redemptionId: 'redemption_1',
      displayName: 'Lena',
    });
    await team.completeJoin(joined.token);
    await worker.run();
    // Uplink confirmed the join: the person is now an active member.
    expect((await team.listMembers('p1')).map((member) => member.userId)).toContain(joined.userId);

    await team.removeMember('p1', joined.userId);
    await worker.run();
    expect(await team.dueOperations()).toEqual([]);

    for (const type of ['team.invite.create', 'team.join.commit', 'team.membership.remove'])
      expect(Object.keys(sent.find((message) => message.type === type)!).sort(), type).toEqual(
        fixtureKeys(type),
      );
  });

  it('retries what Uplink calls retryable and marks the invitation failed on a final refusal', async () => {
    const team = ctx.store.projectTeam;
    let retryable = true;
    const { uplink: fake } = uplink({
      'team.invite.create': () => ({ type: 'team.error', code: 'unavailable', retryable }),
    });
    const worker = createTeamOutboxWorker({ team, uplink: fake, identityKey: () => IDENTITY_KEY });
    await team.createInvitation({
      projectId: 'p1',
      inviterUserId: ADMIN,
      inviteeName: 'Lena',
      canExecute: false,
    });
    await worker.run();
    const later = new Date(Date.now() + 2 * 60 * 60_000);
    expect(await team.dueOperations(later)).toHaveLength(1);
    retryable = false;
    const late = createTeamOutboxWorker({
      team,
      uplink: fake,
      identityKey: () => IDENTITY_KEY,
      now: () => later,
    });
    await late.run();
    expect(await team.dueOperations(later)).toEqual([]);
    // Never left "creating": the inviter sees it failed and invites again.
    expect((await team.listInvitations('p1', later))[0]).toMatchObject({ state: 'failed' });
  });

  it('keeps a join held back by the seat limit pending, and fences one refused for good', async () => {
    const team = ctx.store.projectTeam;
    const INVITATION = 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM';
    let commit: Record<string, unknown> = {
      type: 'team.error',
      code: 'member_limit_reached',
      retryable: true,
      retryAfterSeconds: 300,
    };
    const { uplink: fake } = uplink({
      'team.invite.create': () => ({
        type: 'team.invite.created',
        invitationId: INVITATION,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
      'team.join.commit': () => commit,
    });
    const worker = createTeamOutboxWorker({ team, uplink: fake, identityKey: () => IDENTITY_KEY });
    const { secret } = await team.createInvitation({
      projectId: 'p1',
      inviterUserId: ADMIN,
      inviteeName: 'Lena',
      canExecute: false,
    });
    await worker.run();
    await team.admitJoin({
      sessionId: 'session_1',
      invitationId: INVITATION,
      redemptionId: 'redemption_1',
      projectId: 'p1',
      permissions: ['read'],
    });
    const joined = await team.redeemInvitation({
      invitationId: INVITATION,
      secret,
      redemptionId: 'redemption_1',
      displayName: 'Lena',
    });
    await team.completeJoin(joined.token);
    await worker.run();
    const later = new Date(Date.now() + 10 * 60_000);
    expect(await team.dueOperations(later)).toHaveLength(1);
    expect(
      await ctx.db
        .selectFrom('users')
        .select('status')
        .where('id', '=', joined.userId)
        .executeTakeFirst(),
    ).toEqual({ status: 'disabled' });

    commit = { type: 'team.error', code: 'invitation_unavailable', retryable: false };
    await createTeamOutboxWorker({
      team,
      uplink: fake,
      identityKey: () => IDENTITY_KEY,
      now: () => later,
    }).run();
    expect(await team.dueOperations(later)).toEqual([]);
    expect((await team.listMembers('p1')).map((member) => member.userId)).not.toContain(
      joined.userId,
    );
    expect((await team.listInvitations('p1', later))[0]).toMatchObject({ state: 'failed' });
  });
});
