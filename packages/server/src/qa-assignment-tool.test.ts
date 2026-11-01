import { beforeAll, afterAll, beforeEach, it, expect, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import {
  createQAAssignmentTool,
  trustedQAAssignmentConsent,
  type QAAssignmentDeps,
} from './qa-assignment-tool.js';
let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'team',
    repo: 'app',
    containerName: 'app',
    state: 'active',
  });
  for (const sessionId of ['qa', 'target'])
    await ctx.store.createSession({
      sessionId,
      projectId: 'p',
      worktree: `/tmp/${sessionId}`,
      model: 'claude',
    });
  await ctx.store.repairs.configureQA(true, 'user');
  await ctx.store.repairs.qaSession('qa');
  await ctx.store.repairs.configure('p', 'user', 'monitor');
});
const caller = { sessionId: 'qa', userId: 'user' };
function setup() {
  const deps: QAAssignmentDeps = {
    store: ctx.store,
    permitted: async () => true,
    busy: () => false,
    pendingPermissions: () => [],
    target: async () => true,
    create: vi.fn(async () => ({ sessionId: 'target' })),
    cancel: vi.fn(async () => true),
    inspect: async () => ({
      verified: true,
      revision: 'sha',
      pull: { number: 1, pipeline: 'success' },
    }),
    dispatch: vi.fn<QAAssignmentDeps['dispatch']>(
      async (sessionId, prompt, id, userId, validate) => {
        if (!(await validate())) return false;
        return !!(await ctx.store.admitBackgroundDispatch(id, sessionId, {
          t: 'prompt',
          text: prompt,
          initiatedBy: { userId },
        }));
      },
    ),
  };
  const service = createQAAssignmentTool(deps);
  const propose = async (key = 'one') =>
    service.propose(
      caller,
      {
        projectId: 'p',
        title: 'Optimize CI',
        instruction: 'Optimize CI in team/app',
        criteria: 'CI',
      },
      key,
    );
  const finish = async () => {
    await ctx.store.appendEvent('target', { t: 'status', state: 'completed' });
    await ctx.store.clearRunningTurn('target');
    await service.sweep();
  };
  return { deps, service, propose, finish };
}
it('creates a project session without a PR, admits once and reports execution separately from verification', async () => {
  const { service, propose, deps, finish } = setup();
  const p = await propose();
  expect(p.status).toBe('proposed');
  expect(deps.create).not.toHaveBeenCalled();
  expect(await service.request(caller, 'p', p.assignmentId, 'card:one')).toMatchObject({
    status: 'running',
    sessionId: 'target',
  });
  expect(deps.create).toHaveBeenCalledOnce();
  await service.request(caller, 'p', p.assignmentId, 'card:one');
  expect(deps.create).toHaveBeenCalledOnce();
  await finish();
  expect(await service.status(caller, 'p', p.assignmentId)).toMatchObject({ status: 'verifying' });
  expect((await ctx.store.repairs.mandate('p'))?.mode).toBe('monitor');
});
it('keeps busy work queued across restart without steering it', async () => {
  const { service, propose, deps } = setup();
  deps.busy = () => true;
  const p = await propose();
  expect(await service.request(caller, 'p', p.assignmentId, 'one')).toMatchObject({
    status: 'queued',
  });
  expect(deps.dispatch).not.toHaveBeenCalled();
  deps.busy = () => false;
  await createQAAssignmentTool(deps).sweep();
  expect(await service.status(caller, 'p', p.assignmentId)).toMatchObject({ status: 'running' });
});
it('fences competing assignments, background repairs and reused consent', async () => {
  const { service, propose } = setup();
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  const second = await propose('two');
  await expect(service.request(caller, 'p', second.assignmentId, 'new')).rejects.toThrow(
    'capacity',
  );
  const incident = await ctx.store.repairs.observe('p', 'pr:1', 'sha', '{}');
  await ctx.store.repairs.configure('p', 'user', 'automatic');
  expect(await ctx.store.repairs.claim(incident.id, 'other', 2)).toBeUndefined();
});
it('requires present execution rights and cancels reserved work after revocation', async () => {
  const { service, propose, deps } = setup();
  deps.busy = () => true;
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'one');
  deps.permitted = async () => false;
  await service.sweep();
  expect((await ctx.store.qaAssignments.get(p.assignmentId))?.state).toBe('blocked');
  expect(deps.dispatch).not.toHaveBeenCalled();
  await expect(service.status(caller, 'p', p.assignmentId)).rejects.toThrow('permission');
});
it('permits only two follow-ups and refuses stale reviews or unverified completion', async () => {
  const { service, propose, deps, finish } = setup();
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'one');
  for (let attempt = 0; attempt < 3; attempt++) {
    await finish();
    const current = await service.status(caller, 'p', p.assignmentId);
    await expect(
      service.review(caller, 'p', p.assignmentId, current.version - 1, 'completed', 'done'),
    ).rejects.toThrow('current');
    deps.inspect = async () => ({ verified: false });
    await expect(
      service.review(caller, 'p', p.assignmentId, current.version, 'completed', 'done'),
    ).rejects.toThrow('evidence');
    deps.inspect = async () => ({ verified: true });
    if (attempt < 2) {
      await service.review(
        caller,
        'p',
        p.assignmentId,
        current.version,
        'retry',
        'Provide the missing duration evidence.',
      );
      await service.sweep();
    } else
      await expect(
        service.review(caller, 'p', p.assignmentId, current.version, 'retry', 'Again'),
      ).rejects.toThrow('exhausted');
  }
});
it('stops a queued assignment without dispatch and does not replay it', async () => {
  const { service, propose, deps } = setup();
  deps.busy = () => true;
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'one');
  await service.stop(caller, 'p', p.assignmentId);
  deps.busy = () => false;
  await service.sweep();
  expect(await service.status(caller, 'p', p.assignmentId)).toMatchObject({ status: 'stopped' });
  const calls = vi.mocked(deps.dispatch).mock.calls.filter((c) => c[0] === 'target');
  expect(calls).toHaveLength(0);
});
it('does not mistake a successor terminal for the assigned attempt', async () => {
  const { service, propose } = setup();
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'one');
  await ctx.store.clearRunningTurn('target');
  await ctx.store.appendEvent('target', { t: 'prompt', text: 'unrelated' });
  await ctx.store.appendEvent('target', { t: 'status', state: 'completed' });
  await service.sweep();
  expect(await service.status(caller, 'p', p.assignmentId)).toMatchObject({ status: 'blocked' });
});
it('binds direct consent to the exact current user instruction and project', async () => {
  const { propose } = setup();
  const p = await propose();
  const row = await ctx.store.appendEvent('qa', {
    t: 'prompt',
    text: 'Optimize CI in team/app',
    initiatedBy: { userId: 'user' },
  });
  await ctx.store.markTurnRunning({ sessionId: 'qa', promptSeq: row.seq });
  await ctx.store.bindTurnIdentity('qa', { turnId: 'turn', startCommandId: 'start' });
  expect(await trustedQAAssignmentConsent(ctx.store, 'qa', 'turn', p.assignmentId)).toBe(
    `qa:${row.seq}`,
  );
  await ctx.store.appendEvent('qa', {
    t: 'prompt',
    text: 'just analyze',
    steered: true,
    initiatedBy: { userId: 'user' },
  });
  expect(await trustedQAAssignmentConsent(ctx.store, 'qa', 'turn', p.assignmentId)).toBeUndefined();
});

it('recovers admission before the running-state write even when the worktree became dirty', async () => {
  const { service, propose, deps } = setup();
  deps.busy = () => true;
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  const a = (await ctx.store.qaAssignments.get(p.assignmentId))!;
  await ctx.store.admitBackgroundDispatch(a.dispatch_id!, 'target', {
    t: 'prompt',
    text: 'already accepted',
  });
  deps.target = async () => false;
  deps.busy = () => false;
  await createQAAssignmentTool(deps).sweep();
  expect((await ctx.store.qaAssignments.get(p.assignmentId))?.state).toBe('running');
  expect(vi.mocked(deps.dispatch).mock.calls.filter((c) => c[0] === 'target')).toHaveLength(0);
});
it('replays a completion notification once after QA becomes idle', async () => {
  const { service, propose, deps, finish } = setup();
  deps.busy = (id) => id === 'qa';
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  await finish();
  expect(vi.mocked(deps.dispatch).mock.calls.filter((c) => c[0] === 'qa')).toHaveLength(0);
  deps.busy = () => false;
  await createQAAssignmentTool(deps).sweep();
  await createQAAssignmentTool(deps).sweep();
  expect(vi.mocked(deps.dispatch).mock.calls.filter((c) => c[0] === 'qa')).toHaveLength(1);
});
it('atomically admits only one competing project assignment', async () => {
  const { propose } = setup();
  const one = await propose('one');
  const two = await propose('two');
  const claims = await Promise.all([
    ctx.store.qaAssignments.approve(one.assignmentId, 1, 'a'),
    ctx.store.qaAssignments.approve(two.assignmentId, 1, 'b'),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
});
it('does not reuse consumed consent after an assignment is stopped', async () => {
  const { service, propose } = setup();
  const p = await propose();
  await ctx.store.qaAssignments.approve(p.assignmentId, 1, 'consumed');
  await service.stop(caller, 'p', p.assignmentId);
  const next = await propose('next');
  expect(await ctx.store.qaAssignments.approve(next.assignmentId, 1, 'consumed')).toBe(false);
});
it('moves a revoked admitted assignment to stopping instead of releasing its capacity', async () => {
  const { service, propose, deps } = setup();
  deps.busy = () => true;
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  const a = (await ctx.store.qaAssignments.get(p.assignmentId))!;
  await ctx.store.admitBackgroundDispatch(a.dispatch_id!, 'target', {
    t: 'prompt',
    text: 'already accepted',
  });
  deps.permitted = async () => false;
  await service.sweep();
  expect((await ctx.store.qaAssignments.get(p.assignmentId))?.state).toBe('stopping');
});

it('releases verification ownership after QA authorization changes', async () => {
  const { service, propose, finish } = setup();
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  await finish();
  expect((await ctx.store.qaAssignments.get(p.assignmentId))?.state).toBe('verifying');
  await ctx.store.repairs.configureQA(false, 'user');
  await service.sweep();
  expect((await ctx.store.qaAssignments.get(p.assignmentId))?.state).toBe('blocked');
});
it('rejects a follow-up when the captured worktree or prompt changed', async () => {
  const { service, propose, finish, deps } = setup();
  deps.inspect = async () => ({
    verified: false,
    worktreeFingerprint: 'own-dirty-state',
    lastPromptSeq: 2,
  });
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  await finish();
  const a = await service.status(caller, 'p', p.assignmentId);
  deps.inspect = async () => ({
    verified: false,
    worktreeFingerprint: 'someone-else-edited',
    lastPromptSeq: 2,
  });
  await expect(
    service.review(caller, 'p', p.assignmentId, a.version, 'retry', 'Finish the existing change.'),
  ).rejects.toThrow('changed after');
  deps.inspect = async () => ({
    verified: false,
    worktreeFingerprint: 'own-dirty-state',
    lastPromptSeq: 2,
  });
  expect(
    await service.review(
      caller,
      'p',
      p.assignmentId,
      a.version,
      'retry',
      'Finish the existing change.',
    ),
  ).toMatchObject({ status: 'queued' });
});

it('waits for an occupied dirty target instead of failing its pending assignment', async () => {
  const { service, propose, deps } = setup();
  const p = await propose();
  deps.busy = () => true;
  deps.target = async () => false;
  expect(await service.request(caller, 'p', p.assignmentId, 'once')).toMatchObject({
    status: 'queued',
  });
  expect(vi.mocked(deps.dispatch).mock.calls).toHaveLength(0);
  deps.busy = () => false;
  deps.target = async () => true;
  await service.sweep();
  expect(await service.status(caller, 'p', p.assignmentId)).toMatchObject({ status: 'running' });
});
it('rejects terminal-then-successor history before capturing continuation evidence', async () => {
  const { service, propose, deps } = setup();
  const inspect = vi.fn(deps.inspect);
  deps.inspect = inspect;
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  await ctx.store.appendEvent('target', { t: 'status', state: 'completed' });
  await ctx.store.clearRunningTurn('target');
  await ctx.store.appendEvent('target', { t: 'prompt', text: 'unrelated new work' });
  await ctx.store.appendEvent('target', { t: 'status', state: 'completed' });
  await service.sweep();
  expect(await service.status(caller, 'p', p.assignmentId)).toMatchObject({ status: 'blocked' });
  expect(inspect).not.toHaveBeenCalled();
});

it('keeps waiting when unrelated work begins during target validation', async () => {
  const { service, propose, deps } = setup();
  const p = await propose();
  deps.target = async () => {
    deps.busy = () => true;
    return false;
  };
  expect(await service.request(caller, 'p', p.assignmentId, 'once')).toMatchObject({
    status: 'queued',
  });
  expect(deps.dispatch).not.toHaveBeenCalled();
});

it('rediscovers only the current user project assignments after restart', async () => {
  const { service, propose, deps } = setup();
  const p = await propose();
  expect(await createQAAssignmentTool(deps).list(caller, 'p')).toMatchObject({
    assignments: [{ assignmentId: p.assignmentId }],
  });
  expect(await service.list({ sessionId: 'qa', userId: 'other' }, 'p')).toEqual({
    assignments: [],
  });
});

it('delivers a changed question while the assignment is already waiting', async () => {
  const { service, propose, deps } = setup();
  deps.busy = (id) => id === 'qa';
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  await ctx.store.appendEvent('target', {
    t: 'session_progress',
    summary: 'Need a decision',
    outcomeDelivered: false,
    requiredDecision: 'Choose the first option?',
  });
  await service.sweep();
  const first = await service.status(caller, 'p', p.assignmentId);
  await ctx.store.appendEvent('target', {
    t: 'session_progress',
    summary: 'Need a different decision',
    outcomeDelivered: false,
    requiredDecision: 'Choose the second option?',
  });
  await service.sweep();
  const second = await service.status(caller, 'p', p.assignmentId);
  expect(second).toMatchObject({ status: 'waiting', reason: 'Choose the second option?' });
  expect(second.version).toBeGreaterThan(first.version);
  deps.busy = () => false;
  await service.sweep();
  expect(
    vi
      .mocked(deps.dispatch)
      .mock.calls.filter((c) => c[0] === 'qa')
      .at(-1)?.[1],
  ).toContain('Choose the second option?');
});
it('releases an assignment whose target session was deleted instead of holding capacity forever', async () => {
  const { service, propose } = setup();
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  await ctx.store.clearRunningTurn('target');
  await ctx.store.deleteSession('target');
  await service.sweep();
  await service.sweep();
  expect(await service.status(caller, 'p', p.assignmentId)).toMatchObject({ status: 'stopped' });
});

it('marks clipped reports incomplete and refuses completion until evidence is complete', async () => {
  const { service, propose, finish } = setup();
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  await ctx.store.appendEvent('target', { t: 'text', delta: 'x'.repeat(17000) });
  await finish();
  const a = await service.status(caller, 'p', p.assignmentId);
  expect(JSON.parse(a.evidence)).toMatchObject({ reportTruncated: true, truncated: true });
  await expect(
    service.review(caller, 'p', p.assignmentId, a.version, 'completed', 'Looks good'),
  ).rejects.toThrow('evidence');
});
it('reports actual pending permissions even without a worker progress message', async () => {
  const { service, propose, deps } = setup();
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  await ctx.store.appendEvent('target', {
    t: 'permission',
    id: 'permission-1',
    tool: 'Bash',
    input: {},
    riskClass: 'ask',
  });
  deps.pendingPermissions = () => ['permission-1'];
  await service.sweep();
  expect(await service.status(caller, 'p', p.assignmentId)).toMatchObject({ status: 'waiting' });
  deps.pendingPermissions = () => [];
  await service.sweep();
  expect(await service.status(caller, 'p', p.assignmentId)).toMatchObject({ status: 'running' });
});

it('releases ownership when the verification target is deleted', async () => {
  const { service, propose, finish } = setup();
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  await finish();
  await ctx.store.deleteSession('target');
  await service.sweep();
  expect(await service.status(caller, 'p', p.assignmentId)).toMatchObject({ status: 'blocked' });
});
it('does not treat a terminal event as settled execution while its durable marker remains', async () => {
  const { service, propose } = setup();
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  await ctx.store.appendEvent('target', { t: 'status', state: 'completed' });
  await service.sweep();
  expect(await service.status(caller, 'p', p.assignmentId)).toMatchObject({ status: 'running' });
  await ctx.store.clearRunningTurn('target');
  await service.sweep();
  expect(await service.status(caller, 'p', p.assignmentId)).toMatchObject({ status: 'verifying' });
});
it('retains stop ownership while a lost live handle still has an unsettled durable marker', async () => {
  const { service, propose, deps } = setup();
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  deps.cancel = async () => false;
  expect(await service.stop(caller, 'p', p.assignmentId)).toMatchObject({ status: 'stopping' });
  await ctx.store.clearRunningTurn('target');
  await service.sweep();
  expect(await service.status(caller, 'p', p.assignmentId)).toMatchObject({ status: 'stopped' });
});

it('redelivers an admitted notification after a confirmed interrupted QA turn on restart', async () => {
  const { service, propose, deps, finish } = setup();
  deps.busy = (id) => id === 'qa';
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  await finish();
  deps.busy = () => false;
  await service.sweep();
  const deliveries = () => vi.mocked(deps.dispatch).mock.calls.filter((c) => c[0] === 'qa');
  expect(deliveries()).toHaveLength(1);
  await ctx.store.appendEvent('qa', { t: 'interrupted' });
  const restarted = createQAAssignmentTool(deps);
  await restarted.sweep();
  expect(deliveries()).toHaveLength(1);
  await ctx.store.clearRunningTurn('qa');
  await restarted.sweep();
  await restarted.sweep();
  expect(deliveries()).toHaveLength(2);
  expect(deliveries()[1]?.[2]).not.toBe(deliveries()[0]?.[2]);
  await ctx.store.appendEvent('qa', { t: 'status', state: 'completed' });
  await ctx.store.clearRunningTurn('qa');
  await restarted.sweep();
  await restarted.sweep();
  expect(deliveries()).toHaveLength(2);
  expect(await ctx.store.qaAssignments.notifications()).toHaveLength(0);
});
it('limits repeated notification delivery failures without losing the failed verification state', async () => {
  const { service, propose, deps, finish } = setup();
  deps.busy = (id) => id === 'qa';
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  await finish();
  deps.busy = () => false;
  await service.sweep();
  for (let attempt = 0; attempt < 3; attempt++) {
    await ctx.store.appendEvent('qa', { t: 'interrupted' });
    await ctx.store.clearRunningTurn('qa');
    await service.sweep();
    if (attempt < 2) await service.sweep();
  }
  expect(await service.status(caller, 'p', p.assignmentId)).toMatchObject({
    status: 'blocked',
    reason: expect.stringContaining('delivery failed'),
  });
});

it('does not acknowledge an unrelated completion when notification history was clipped', async () => {
  const { service, propose, deps, finish } = setup();
  deps.busy = (id) => id === 'qa';
  const p = await propose();
  await service.request(caller, 'p', p.assignmentId, 'once');
  await finish();
  deps.busy = () => false;
  await service.sweep();
  const previous = (await ctx.store.qaAssignments.notifications())[0]!;
  await ctx.store.clearRunningTurn('qa');
  const history = vi.spyOn(ctx.store, 'getEventsBeforeSeq').mockResolvedValueOnce({
    hasMore: true,
    events: [{ seq: 100000, ts: Date.now(), event: { t: 'status', state: 'completed' } }],
  });
  await service.sweep();
  history.mockRestore();
  expect((await ctx.store.qaAssignments.notifications())[0]?.dispatch_id).not.toBe(
    previous.dispatch_id,
  );
});

it.each(['revision', 'branch', 'worktreeFingerprint', 'lastPromptSeq'])(
  'requires a new assessment when reviewed %s changes',
  async (key) => {
    const { service, propose, deps, finish } = setup();
    const original = {
      verified: true,
      revision: 'sha',
      branch: 'feature',
      worktreeFingerprint: 'one',
      lastPromptSeq: 1,
    };
    deps.inspect = async () => original;
    const p = await propose();
    await service.request(caller, 'p', p.assignmentId, 'one');
    await finish();
    const reviewed = await service.status(caller, 'p', p.assignmentId);
    deps.inspect = async () => ({ ...original, [key]: key === 'lastPromptSeq' ? 2 : 'changed' });
    await expect(
      service.review(caller, 'p', p.assignmentId, reviewed.version, 'completed', 'Old assessment'),
    ).rejects.toThrow('evidence changed');
    const refreshed = await service.status(caller, 'p', p.assignmentId);
    expect(refreshed.status).toBe('verifying');
    expect(refreshed.version).toBeGreaterThan(reviewed.version);
    await expect(
      service.review(caller, 'p', p.assignmentId, reviewed.version, 'completed', 'Old assessment'),
    ).rejects.toThrow('current');
    expect(
      await service.review(
        caller,
        'p',
        p.assignmentId,
        refreshed.version,
        'completed',
        'Reassessed current evidence',
      ),
    ).toMatchObject({ status: 'completed' });
  },
);
