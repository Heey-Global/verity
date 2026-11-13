import { readFileSync } from 'node:fs';
import { createIsolatedTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTeamOutboxWorker } from './team-outbox-worker.js';

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

    const joined = await team.redeemInvitation({
      invitationId: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM',
      secret,
      redemptionId: 'redemption_1',
      displayName: 'Lena',
    });
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

  it('retries what Uplink calls retryable and drops a final refusal', async () => {
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
  });
});
