import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb, truncateAll } from '@verity/store/testing';
import {
  APPROVAL_REDEMPTION_TTL_MS,
  createBrokeredToolApprovalStore,
  type BrokeredToolApprovalInput,
  type BrokeredToolApprovalStore,
} from './brokered-tool-approval-store.js';

let ctx: Awaited<ReturnType<typeof createTestDb>>;
let store: BrokeredToolApprovalStore;
let now = 1_800_000_000_000;
const input: BrokeredToolApprovalInput = {
  projectId: 'project',
  sessionId: 'session',
  invocationId: 'invocation',
  toolName: 'verity_http_request',
  canonicalInput: '{"method":"GET","secretAlias":"TEST_KEY","url":"https://api.example.com"}',
  requestMac: 'original-mac',
  macKeyId: 'mac-key',
  authorizationSnapshot: '{"binding":"staging"}',
};

beforeAll(async () => {
  ctx = await createTestDb();
  store = createBrokeredToolApprovalStore(ctx.db, () => now);
});
beforeEach(async () => {
  now = 1_800_000_000_000;
  await truncateAll(ctx.db);
  await sql`insert into projects(id,owner,repo,container_name,kind,state,overview_visible)
    values ('project','owner','repo','sandbox','local','absent',true)`.execute(ctx.db);
  await sql`insert into sessions(session_id,worktree,model,project_id)
    values ('session','/tmp/session','default','project'),
      ('other-session','/tmp/other-session','default','project')`.execute(ctx.db);
});
afterAll(async () => ctx.close());

it('deduplicates concurrent retries and retains the original MAC binding', async () => {
  const first = await store.createOrFindPending(input);
  const retries = await Promise.all([
    store.createOrFindPending({ ...input, invocationId: 'retry-1', requestMac: 'retry-mac-1' }),
    store.createOrFindPending({ ...input, invocationId: 'retry-2', requestMac: 'retry-mac-2' }),
  ]);
  expect(retries).toEqual([first, first]);
  expect(first).toMatchObject({
    status: 'pending',
    invocationId: 'invocation',
    requestMac: 'original-mac',
    decidedAt: null,
    decidedBy: null,
    scope: null,
  });
  expect(await store.listPending('session')).toEqual([first]);
  expect(await store.listPending('other-session')).toEqual([]);
  expect(await store.get(first.id, 'other-session')).toBeUndefined();
});

it('retains unanswered requests across store recreation regardless of elapsed time', async () => {
  const pending = await store.createOrFindPending(input);
  await sql`update brokered_tool_approvals set created_at = '2020-01-01T00:00:00Z'
    where id = ${pending.id}`.execute(ctx.db);
  const restored = createBrokeredToolApprovalStore(ctx.db, () => now);
  expect((await restored.listPending('session'))[0]).toMatchObject({
    id: pending.id,
    status: 'pending',
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  expect(await restored.decide(pending.id, 'session', true, 'manager', 'project')).toMatchObject({
    id: pending.id,
    status: 'approved',
    scope: 'project',
    decidedBy: 'manager',
  });
  expect(await restored.listPending('session')).toEqual([]);
});

it('binds approval to exact session, tool, request and provider before single-use consumption', async () => {
  const pending = await store.createOrFindPending(input);
  expect(await store.consume(pending.id, input)).toBeUndefined();
  expect(await store.decide(pending.id, 'other-session', true, 'manager')).toBeUndefined();
  await store.decide(pending.id, 'session', true, 'manager');
  for (const changed of [
    { projectId: 'other-project' },
    { sessionId: 'other-session' },
    { toolName: 'verity_secret_run' as const },
    { canonicalInput: '{"url":"https://other.example.com"}' },
    { authorizationSnapshot: '{"binding":"production"}' },
  ])
    expect(await store.consume(pending.id, { ...input, ...changed })).toBeUndefined();
  const consumed = await Promise.all([
    store.consume(pending.id, input),
    store.consume(pending.id, input),
  ]);
  expect(consumed.filter(Boolean)).toHaveLength(1);
  expect(consumed.find(Boolean)).toMatchObject({ id: pending.id, status: 'consumed' });
  expect(await store.consume(pending.id, input)).toBeUndefined();
  const next = await store.createOrFindPending({ ...input, invocationId: 'next-action' });
  expect(next.id).not.toBe(pending.id);
  expect(next.status).toBe('pending');
});

it('does not silently replace an approved or denied receipt on an exact retry', async () => {
  const pending = await store.createOrFindPending(input);
  await store.decide(pending.id, 'session', false, 'manager');
  expect(await store.decide(pending.id, 'session', true, 'manager')).toBeUndefined();
  expect(await store.createOrFindPending({ ...input, invocationId: 'retry' })).toMatchObject({
    id: pending.id,
    status: 'denied',
    scope: null,
  });
  expect(await store.consume(pending.id, input)).toBeUndefined();
  const changed = await store.createOrFindPending({
    ...input,
    canonicalInput: '{"different":true}',
  });
  await store.decide(changed.id, 'session', true, 'manager');
  expect(
    await store.createOrFindPending({ ...input, canonicalInput: '{"different":true}' }),
  ).toMatchObject({
    id: changed.id,
    status: 'approved',
  });
});

it('keeps provider replacements and other sessions separate and removes deleted sessions', async () => {
  const pending = await store.createOrFindPending(input);
  const provider = await store.createOrFindPending({
    ...input,
    authorizationSnapshot: 'replacement',
  });
  const session = await store.createOrFindPending({ ...input, sessionId: 'other-session' });
  expect(new Set([pending.id, provider.id, session.id]).size).toBe(3);
  await sql`delete from sessions where session_id = 'session'`.execute(ctx.db);
  expect(await store.get(pending.id, 'session')).toBeUndefined();
  expect(await store.listPending('other-session')).toEqual([session]);
});

it('keeps unanswered consent indefinitely but bounds redemption from the decision time', async () => {
  const pending = await store.createOrFindPending(input);
  now += 365 * 24 * 3_600_000;
  expect((await store.listPending('session'))[0]?.id).toBe(pending.id);
  const approved = await store.decide(pending.id, 'session', true, 'manager');
  expect(approved?.decidedAt).toBe(new Date(now).toISOString());
  now += APPROVAL_REDEMPTION_TTL_MS - 1;
  expect((await store.listApproved('session'))[0]?.id).toBe(pending.id);
  expect(await store.reopen(pending.id, 'session')).toBeUndefined();
  now += 1;
  expect(await store.listApproved('session')).toEqual([]);
  expect(await store.consume(pending.id, input, 'redemption')).toBeUndefined();
  expect((await store.listReopenable('session'))[0]?.id).toBe(pending.id);
  expect(await store.reopen(pending.id, 'other-session')).toBeUndefined();
  const reopened = await store.reopen(pending.id, 'session');
  expect(reopened?.id).not.toBe(pending.id);
  expect(reopened).toMatchObject({
    status: 'pending',
    decidedAt: null,
    decidedBy: null,
    scope: null,
    canonicalInput: input.canonicalInput,
    authorizationSnapshot: input.authorizationSnapshot,
    requestMac: input.requestMac,
  });
  expect(await store.listReopenable('session')).toEqual([]);
  await store.decide(reopened!.id, 'session', true, 'manager');
  expect(await store.consume(reopened!.id, input, 'redemption')).toMatchObject({
    status: 'consumed',
  });
});

it('reopens a denial only through the explicit session-scoped operation', async () => {
  const pending = await store.createOrFindPending(input);
  expect(await store.reopen(pending.id, 'session')).toBeUndefined();
  await store.decide(pending.id, 'session', false, 'manager');
  expect((await store.listReopenable('session'))[0]?.id).toBe(pending.id);
  const reopened = await store.reopen(pending.id, 'session');
  expect(reopened).toMatchObject({ status: 'pending', decidedAt: null, decidedBy: null });
  expect(reopened?.id).not.toBe(pending.id);
  expect((await store.listPending('session'))[0]?.id).toBe(reopened?.id);
  expect(await store.get(pending.id, 'session')).toMatchObject({ status: 'consumed', scope: null });
  expect(await store.listApproved('session')).toEqual([]);
});

it('does not create another approval for the same invocation after dispatch consumption', async () => {
  const pending = await store.createOrFindPending(input);
  await store.decide(pending.id, 'session', true, 'manager');
  await store.consume(pending.id, input, 'redemption');
  const retry = await store.createOrFindPending({ ...input, invocationId: 'redemption' });
  expect(retry).toMatchObject({
    id: pending.id,
    status: 'consumed',
    consumedInvocationId: 'redemption',
  });
  expect(await store.listPending('session')).toEqual([]);
  const next = await store.createOrFindPending({
    ...input,
    invocationId: 'next-deliberate-action',
  });
  expect(next.status).toBe('pending');
  expect(next.id).not.toBe(pending.id);
});

it('recovers scoped consent before continuation but exposes a failed grant save for explicit reopening', async () => {
  const pending = await store.createOrFindPending(input);
  await store.decide(pending.id, 'session', true, 'manager', 'project');
  await store.consume(pending.id, input);
  expect(await store.listApproved('session')).toEqual([]);
  expect(await store.consume(pending.id, input, 'concurrent-retry')).toBeUndefined();
  expect(await store.failScoped(pending.id, 'other-session')).toBeUndefined();
  expect(await store.failScoped(pending.id, 'session')).toMatchObject({
    status: 'denied',
    scope: 'project',
  });
  expect(await store.listApproved('session')).toEqual([]);
  expect((await store.listReopenable('session'))[0]?.id).toBe(pending.id);
  const reopened = await store.reopen(pending.id, 'session');
  expect(reopened?.id).not.toBe(pending.id);
  expect(await store.failScoped(pending.id, 'session')).toBeUndefined();
  await store.decide(reopened!.id, 'session', true, 'manager', 'session');
  await store.consume(reopened!.id, input);
  await store.markScopedSaved(reopened!.id, 'session');
  expect(await store.failScoped(reopened!.id, 'session')).toBeUndefined();
  expect((await store.listApproved('session'))[0]?.id).toBe(reopened!.id);
});

it('bounds recovery of a saved scoped grant to the approval redemption interval', async () => {
  const pending = await store.createOrFindPending(input);
  await store.decide(pending.id, 'session', true, 'manager', 'session');
  await store.consume(pending.id, input);
  expect(await store.listApproved('session')).toEqual([]);
  await store.markScopedSaved(pending.id, 'session');
  expect((await store.listApproved('session'))[0]?.id).toBe(pending.id);
  now += APPROVAL_REDEMPTION_TTL_MS;
  expect(await store.listApproved('session')).toEqual([]);
});

it('blocks concurrent recovery while a reusable grant save is pending or fails', async () => {
  const { DetachedPermissions, decideDetachedPermission } =
    await import('../../session/src/detached-permissions.js');
  const pending = await store.createOrFindPending(input);
  const permissions = new DetachedPermissions();
  let resumed = 0;
  permissions.configure({
    list: async () => [
      { requestId: pending.id, toolUseId: pending.id, toolName: input.toolName, input: {} },
    ],
    decide: async (sessionId, id, decision, actor, scope) =>
      !!(await store.decide(id, sessionId, decision.behavior === 'allow', actor, scope)),
    completeScoped: async () => {
      await store.consume(pending.id, input);
    },
    markScopedSaved: async () => {
      await store.markScopedSaved(pending.id, 'session');
    },
    failScoped: async () => {
      await store.failScoped(pending.id, 'session');
    },
    resumeApproved: async () => {
      resumed += (await store.listApproved('session')).length;
    },
  });
  await permissions.refresh('session', async () => {});
  await decideDetachedPermission({
    permissions,
    sessionId: 'session',
    toolUseId: pending.id,
    decision: { behavior: 'allow' },
    options: { actorId: 'manager', scope: 'project' },
    persistScoped: async () => {
      const retry = await store.createOrFindPending({ ...input, invocationId: 'concurrent-retry' });
      expect(retry.id).toBe(pending.id);
      await permissions.resumeApproved('session');
      const restarted = createBrokeredToolApprovalStore(ctx.db, () => now);
      expect(await restarted.listApproved('session')).toEqual([]);
      throw new Error('save failed');
    },
    notice: async () => {},
    resume: async () => {
      resumed++;
    },
  });
  expect(resumed).toBe(0);
  expect((await store.listReopenable('session'))[0]?.id).toBe(pending.id);
});

it('reopens interrupted scoped saves after restart without restoring execution authority', async () => {
  const pending = await store.createOrFindPending(input);
  await store.decide(pending.id, 'session', true, 'manager', 'project');
  await store.consume(pending.id, input);
  const restarted = createBrokeredToolApprovalStore(ctx.db, () => now);
  expect(await restarted.reopen(pending.id, 'session')).toBeUndefined();
  now += APPROVAL_REDEMPTION_TTL_MS;
  expect((await restarted.listReopenable('session'))[0]?.id).toBe(pending.id);
  expect(await restarted.listApproved('session')).toEqual([]);
  const reopened = await restarted.reopen(pending.id, 'session');
  expect(reopened).toMatchObject({ status: 'pending', decidedBy: null, scope: null });
  expect(reopened?.id).not.toBe(pending.id);
  expect(await restarted.createOrFindPending(input)).toEqual(reopened);
  // A delayed pre-crash save completion cannot reactivate the retired receipt.
  await restarted.markScopedSaved(pending.id, 'session');
  expect(await restarted.listApproved('session')).toEqual([]);
  expect(await restarted.consume(reopened!.id, input, 'retry')).toBeUndefined();
});

it('recovers a saved decision with no transcript card and deduplicates concurrent writers', async () => {
  const approval = await store.createOrFindPending(input);
  await ctx.store.appendEvent(input.sessionId, {
    t: 'permission',
    id: approval.id,
    tool: input.toolName,
    input: JSON.parse(input.canonicalInput) as unknown,
    riskClass: 'ask',
  });
  await store.decide(approval.id, input.sessionId, true, 'approver', 'once');
  const restarted = createBrokeredToolApprovalStore(ctx.db, () => now);
  expect(await restarted.listUnrecordedDecisions(input.sessionId)).toMatchObject([
    { id: approval.id, scope: 'once', decidedBy: 'approver' },
  ]);

  const event = {
    t: 'notice',
    text: 'Secret request allowed once.',
    secretApproval: { id: approval.id, tool: input.toolName, input: {}, decision: 'once' },
  } as const;
  const results = await Promise.all([
    ctx.store.appendEvent(input.sessionId, event),
    ctx.store.appendEvent(input.sessionId, event),
  ]);
  expect(results.filter(({ existing }) => existing)).toHaveLength(1);
  expect(results[1]).toMatchObject({ seq: results[0].seq, ts: results[0].ts });
  expect(await restarted.listUnrecordedDecisions(input.sessionId)).toEqual([]);
  expect(
    (await ctx.store.getEvents(input.sessionId)).filter(({ t }) => t === 'notice'),
  ).toHaveLength(1);
  await ctx.store.waitForMessageProjectionIdle();
});

it('lets a decision on the current snapshot supersede a legacy denial', async () => {
  const legacySnapshot = '{"binding":"legacy"}';
  const legacy = await store.createOrFindPending({
    ...input,
    authorizationSnapshot: legacySnapshot,
  });
  await store.decide(legacy.id, 'session', false, 'manager');
  const current = await store.createOrFindPending({ ...input, invocationId: 'current' });
  await store.decide(current.id, 'session', true, 'manager');
  // Returning the legacy denial here hid the approval the person just gave.
  expect(
    await store.createOrFindPending({ ...input, invocationId: 'retry' }, undefined, legacySnapshot),
  ).toMatchObject({ id: current.id, status: 'approved' });
  expect(
    await store.findStandingAuthorizationBlock(input, 'retry', undefined, legacySnapshot),
  ).toBeUndefined();
});
