import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createIsolatedTestDb, truncateAll, type TestDb } from './testing.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
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
    id: 'p',
    owner: 'o',
    repo: 'r',
    containerName: 'o-r',
    state: 'active',
  });
});

async function invitation() {
  const created = await ctx.store.projectTeam.createInvitation({
    projectId: 'p',
    inviterUserId: ADMIN,
    inviteeName: 'Lena',
    canExecute: false,
  });
  await ctx.store.projectTeam.markInvitationCreated(
    created.invitation.id,
    'i',
    created.invitation.expiresAt,
  );
  return {
    sessionId: 's',
    invitationId: 'i',
    redemptionId: 'd',
    projectId: 'p',
    permissions: ['read'],
  };
}

it('does not write authority for an already cancelled tunnel', async () => {
  const pending = await invitation();
  const controller = new AbortController();
  controller.abort();
  await expect(
    ctx.store.projectTeam.admitJoin({ ...pending, signal: controller.signal }),
  ).rejects.toThrow();
  expect(await ctx.db.selectFrom('team_join_admissions').selectAll().execute()).toEqual([]);
});

it('retires only the admission of the cancelled session and redemption', async () => {
  const pending = await invitation();
  expect(await ctx.store.projectTeam.admitJoin(pending)).toBe('accepted');
  await ctx.store.projectTeam.rollbackJoinAdmission({ ...pending, redemptionId: 'another' });
  expect(await ctx.db.selectFrom('team_join_admissions').selectAll().execute()).toHaveLength(1);
  await ctx.store.projectTeam.rollbackJoinAdmission(pending);
  expect(await ctx.db.selectFrom('team_join_admissions').selectAll().execute()).toEqual([]);
});
