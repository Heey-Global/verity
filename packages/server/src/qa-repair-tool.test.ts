import { createRepairSupervisor } from './repair-supervisor.js';
import { beforeAll, afterAll, beforeEach, it, expect, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { sql } from 'kysely';
import {
  createQARepairTool,
  trustedQARepairInstruction,
  trustedQARepairConsent,
  type QARepairDeps,
} from './qa-repair-tool.js';
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
  for (const id of ['qa', 'target'])
    await ctx.store.createSession({
      sessionId: id,
      projectId: 'p',
      worktree: `/tmp/${id}`,
      model: 'claude',
    });
  await ctx.store.repairs.configureQA(true, 'admin');
  await ctx.store.repairs.qaSession('qa');
  await ctx.store.repairs.configure('p', 'user', 'monitor');
});
const caller = { sessionId: 'qa', userId: 'user' };
function setup() {
  const deps: QARepairDeps = {
    store: ctx.store,
    permitted: async () => true,
    inspect: async () => ({
      branch: 'fix/ci',
      fork: false,
      status: {
        number: 2120,
        title: 'CI',
        url: 'https://example.test/pr/2120',
        phase: 'open',
        headSha: 'sha',
        pipeline: 'failure',
        checks: { completed: 1, total: 1, successful: 0, failed: 1, pending: 0 },
        mergeable: null,
      },
    }),
    branch: async (s) => ({
      branch: s.sessionId === 'qa' ? 'main' : 'fix/ci',
      revision: 'sha',
      dirty: false,
    }),
    busy: () => false,
    dispatch: vi.fn<QARepairDeps['dispatch']>(async (sessionId, prompt, id, userId, validate) => {
      if (!(await validate())) return false;
      return !!(await ctx.store.admitBackgroundDispatch(id, sessionId, {
        t: 'prompt',
        text: prompt,
        initiatedBy: { userId },
      }));
    }),
  };
  const service = createQARepairTool(deps);
  const resolve = async () => {
    const p = await service.resolve(caller, 'p', 2120);
    expect(p).toMatchObject({ status: 'proposed', sessionId: 'target', revision: 'sha' });
    return (p as { proposalId: string }).proposalId;
  };
  return { deps, service, resolve };
}
it('hands a single approved repair to the verified session without changing monitor mode', async () => {
  const { deps, service, resolve } = setup();
  const id = await resolve();
  expect(await service.request(caller, 'p', id)).toMatchObject({
    status: 'accepted',
    sessionId: 'target',
  });
  expect((await ctx.store.repairs.mandate('p'))?.mode).toBe('monitor');
  expect(deps.dispatch).toHaveBeenCalledOnce();
  expect(await service.request(caller, 'p', id)).toMatchObject({ status: 'accepted' });
  expect(deps.dispatch).toHaveBeenCalledOnce();
  expect((await ctx.store.repairs.incidents('p'))[0]?.owner_session_id).toBe('target');
});
it('keeps a busy target queued durably, survives recreation, and admits only once', async () => {
  const { deps, service, resolve } = setup();
  deps.busy = () => true;
  const id = await resolve();
  expect(await service.request(caller, 'p', id)).toMatchObject({ status: 'queued' });
  expect(await ctx.store.repairs.reservedDispatches()).toEqual([]);
  expect(deps.dispatch).not.toHaveBeenCalled();
  deps.busy = () => false;
  const recovered = createQARepairTool(deps);
  await recovered.sweep();
  await recovered.sweep();
  expect(await recovered.status(caller, 'p', id)).toMatchObject({ status: 'accepted' });
  expect(deps.dispatch).toHaveBeenCalledOnce();
});
it.each(['rights', 'revision', 'disabled', 'dirty', 'expiry'])(
  'cancels queued work after %s changes without dispatching',
  async (kind) => {
    const { deps, service, resolve } = setup();
    deps.busy = () => true;
    const id = await resolve();
    await service.request(caller, 'p', id);
    deps.busy = () => false;
    if (kind === 'rights') deps.permitted = async () => false;
    if (kind === 'revision') {
      const old = deps.inspect;
      deps.inspect = async (...args) => {
        const r = (await old(...args))!;
        r.status.headSha = 'changed';
        return r;
      };
    }
    if (kind === 'disabled') await ctx.store.repairs.configureQA(false, 'admin');
    if (kind === 'dirty') deps.branch = async () => ({ branch: 'fix/ci', dirty: true });
    if (kind === 'expiry')
      await sql`update qa_manual_repairs set expires_at=now()-interval '1 second' where id=${id}`.execute(
        ctx.db,
      );
    await createQARepairTool(deps).sweep();
    expect(deps.dispatch).not.toHaveBeenCalled();
    const p = (await ctx.store.repairs.manualRepair(id))!;
    expect((await ctx.store.repairs.dispatchReceipt(p.dispatch_id!))?.state).toBe('cancelled');
    expect((await ctx.store.repairs.incidents('p'))[0]?.owner_session_id).toBeNull();
  },
);
it('refuses an arbitrary target, ambiguous branches, forks, and another caller', async () => {
  const { deps, service, resolve } = setup();
  const id = await resolve();
  await expect(service.request({ ...caller, userId: 'other' }, 'p', id)).rejects.toThrow(
    'unavailable',
  );
  expect(await service.resolve(caller, 'p', 2120, 'qa')).toMatchObject({ status: 'blocked' });
  await ctx.store.createSession({
    sessionId: 'second',
    projectId: 'p',
    worktree: '/tmp/second',
    model: 'claude',
  });
  expect(await service.resolve(caller, 'p', 2120)).toMatchObject({
    status: 'blocked',
    candidates: expect.any(Array),
  });
  const old = deps.inspect;
  deps.inspect = async (...args) => ({ ...(await old(...args))!, fork: true });
  expect(await service.resolve(caller, 'p', 2120)).toMatchObject({ status: 'blocked' });
});
it('shares the ownership transaction with automatic claims', async () => {
  await ctx.store.repairs.configure('p', 'user', 'automatic');
  const { deps, service, resolve } = setup();
  deps.busy = () => true;
  const id = await resolve();
  const incident = await ctx.store.repairs.observe('p', 'pr:2121', 'other-sha', '{}');
  const mandate = (await ctx.store.repairs.mandate('p'))!;
  const qa = await ctx.store.repairs.qa();
  const outcomes = await Promise.all([
    service.request(caller, 'p', id),
    ctx.store.repairs.claim(incident.id, 'automatic-target', mandate.revision, qa.revision),
  ]);
  const manual = outcomes[0].status === 'queued';
  expect(Number(manual) + Number(!!outcomes[1])).toBe(1);
  expect((await ctx.store.repairs.incidents('p')).filter((i) => i.owner_session_id)).toHaveLength(
    1,
  );
});
it('does not invent acceptance when delivery is uncertain', async () => {
  const { deps, service, resolve } = setup();
  deps.dispatch = vi.fn(async () => {
    throw new Error('connection lost');
  });
  const id = await resolve();
  expect(await service.request(caller, 'p', id)).toMatchObject({ status: 'queued' });
  expect((await ctx.store.repairs.incidents('p'))[0]?.owner_session_id).toBe('target');
});
it('requires trusted current-user instruction rather than model arguments or quoted evidence', async () => {
  const { resolve } = setup();
  const id = await resolve();
  await ctx.store.appendEvent('qa', {
    t: 'tool_call',
    id: 'resolve',
    name: 'verity_qa_analysis',
    input: { action: 'resolve_repair', projectId: 'p', number: 2120 },
  });
  await ctx.store.appendEvent('qa', {
    t: 'tool_result',
    id: 'resolve',
    isError: false,
    output: { proposalId: id },
  });
  const setPrompt = async (text: string, userId = 'user') => {
    const row = await ctx.store.appendEvent('qa', { t: 'prompt', text, initiatedBy: { userId } });
    await ctx.store.markTurnRunning({ sessionId: 'qa', promptSeq: row.seq });
    await ctx.store.bindTurnIdentity('qa', { turnId: 'turn', startCommandId: 'start' });
  };
  await setPrompt('Please explain why someone wrote "fix PR #2120"');
  expect(await trustedQARepairInstruction(ctx.store, 'qa', 'turn', id)).toBe(false);
  await setPrompt('fix PR #2120', 'other');
  expect(await trustedQARepairInstruction(ctx.store, 'qa', 'turn', id)).toBe(false);
  await setPrompt('fix PR #2120');
  expect(await trustedQARepairInstruction(ctx.store, 'qa', 'turn', id)).toBe(true);
  expect(await trustedQARepairInstruction(ctx.store, 'qa', 'wrong-turn', id)).toBe(false);
});

it('accepts the screenshot instruction only after matching server PR evidence', async () => {
  const { resolve } = setup();
  const id = await resolve();
  await ctx.store.appendEvent('qa', {
    t: 'tool_call',
    id: 'read',
    name: 'verity_qa_analysis',
    input: { action: 'pull_status', projectId: 'p', number: 2120 },
  });
  await ctx.store.appendEvent('qa', {
    t: 'tool_result',
    id: 'read',
    isError: false,
    output: { data: { pull: { number: 2120, head: { sha: 'sha' } } } },
  });
  const row = await ctx.store.appendEvent('qa', {
    t: 'prompt',
    text: 'ok lass die session das fixen',
    initiatedBy: { userId: 'user' },
  });
  await ctx.store.markTurnRunning({ sessionId: 'qa', promptSeq: row.seq });
  await ctx.store.bindTurnIdentity('qa', { turnId: 'turn', startCommandId: 'start' });
  expect(await trustedQARepairInstruction(ctx.store, 'qa', 'turn', id)).toBe(true);
  await ctx.store.appendEvent('qa', {
    t: 'prompt',
    text: 'Stop, do not repair',
    initiatedBy: { userId: 'user' },
    steered: true,
  });
  expect(await trustedQARepairInstruction(ctx.store, 'qa', 'turn', id)).toBe(false);
});
it('rejects consent revoked during preparation before taking ownership', async () => {
  const { deps, service, resolve } = setup();
  const id = await resolve();
  await expect(service.request(caller, 'p', id, async () => undefined)).rejects.toThrow(
    'instruction changed',
  );
  expect(deps.dispatch).not.toHaveBeenCalled();
  expect((await ctx.store.repairs.incidents('p'))[0]?.owner_session_id).toBeNull();
});
it('requires a target choice for multiple matches and blocks a competing active worktree', async () => {
  const { deps, service } = setup();
  await ctx.store.createSession({
    sessionId: 'second',
    projectId: 'p',
    worktree: '/tmp/second',
    model: 'claude',
  });
  const p = (await service.resolve(caller, 'p', 2120, 'target')) as { proposalId: string };
  expect((await ctx.store.repairs.manualRepair(p.proposalId))?.requires_card).toBe(true);
  deps.busy = (id) => id === 'second';
  await expect(service.request(caller, 'p', p.proposalId)).rejects.toThrow('Target session');
  expect(deps.dispatch).not.toHaveBeenCalled();
});

it('does not treat a bare PR number or untrusted log result as project-bound consent', async () => {
  const { resolve } = setup();
  const id = await resolve();
  const prompt = async () => {
    const row = await ctx.store.appendEvent('qa', {
      t: 'prompt',
      text: 'fix PR #2120',
      initiatedBy: { userId: 'user' },
    });
    await ctx.store.markTurnRunning({ sessionId: 'qa', promptSeq: row.seq });
    await ctx.store.bindTurnIdentity('qa', { turnId: 'turn', startCommandId: 'start' });
  };
  await prompt();
  expect(await trustedQARepairInstruction(ctx.store, 'qa', 'turn', id)).toBe(false);
  await ctx.store.appendEvent('qa', {
    t: 'tool_call',
    id: 'log',
    name: 'verity_qa_analysis',
    input: { action: 'job_log', projectId: 'p', jobId: 1 },
  });
  await ctx.store.appendEvent('qa', {
    t: 'tool_result',
    id: 'log',
    isError: false,
    output: { proposalId: id },
  });
  await prompt();
  expect(await trustedQARepairInstruction(ctx.store, 'qa', 'turn', id)).toBe(false);
});

it('rejects a clean matching branch at a different commit before consuming repair budget', async () => {
  const { deps, service, resolve } = setup();
  const id = await resolve();
  deps.branch = async (s) => ({
    branch: s.sessionId === 'qa' ? 'main' : 'fix/ci',
    dirty: false,
    revision: 'older-commit',
  });
  await expect(service.request(caller, 'p', id)).rejects.toThrow('approved commit');
  expect(await ctx.store.repairs.budgetUsed('p', 'pr:2120')).toBe(0);
  expect(deps.dispatch).not.toHaveBeenCalled();
});

it('allows a newly approved monitor-mode retry after supervisor completion, within the shared budget', async () => {
  const { deps, service, resolve } = setup();
  const first = await resolve();
  await service.request(caller, 'p', first);
  const observed = (await deps.inspect('p', 2120))!;
  const supervisor = createRepairSupervisor({
    store: ctx.store,
    discover: async () => ({
      page: {
        pulls: [{ number: 2120, branch: observed.branch, sha: 'sha', fork: false }],
        runs: [],
        nextPage: null,
        workflowsSupported: true,
      },
      statuses: [observed],
    }),
    authorized: async () => true,
    busy: () => false,
    terminated: async (_sessionId, dispatchId) =>
      (await ctx.store.repairs.dispatchReceipt(dispatchId))?.state === 'admitted',
    result: async () => null,
    target: async () => ({ blocked: true }),
    spawn: async () => {
      throw new Error('Monitor must not spawn');
    },
    dispatch: async () => {
      throw new Error('Monitor must not dispatch automatically');
    },
  });
  await ctx.store.clearRunningTurn('target');
  await supervisor.sweep();
  expect((await ctx.store.repairs.incidents('p'))[0]?.state).toBe('verifying');
  await service.request(caller, 'p', first);
  expect(deps.dispatch).toHaveBeenCalledOnce();
  const second = await resolve();
  expect(await service.request(caller, 'p', second)).toMatchObject({ status: 'accepted' });
  expect(deps.dispatch).toHaveBeenCalledTimes(2);
  await ctx.store.clearRunningTurn('target');
  await supervisor.sweep();
  const exhausted = await resolve();
  expect(await service.request(caller, 'p', exhausted)).toMatchObject({ status: 'blocked' });
  expect(deps.dispatch).toHaveBeenCalledTimes(2);
  expect((await ctx.store.repairs.mandate('p'))?.mode).toBe('monitor');
  await supervisor.stop();
});

it('consumes a chat instruction once across distinct proposals and permits a fresh instruction', async () => {
  const { deps, service, resolve } = setup();
  await ctx.store.appendEvent('qa', {
    t: 'tool_call',
    id: 'read',
    name: 'verity_qa_analysis',
    input: { action: 'pull_status', projectId: 'p', number: 2120 },
  });
  await ctx.store.appendEvent('qa', {
    t: 'tool_result',
    id: 'read',
    isError: false,
    output: { data: { pull: { number: 2120, head: { sha: 'sha' } } } },
  });
  const instruct = async () => {
    const row = await ctx.store.appendEvent('qa', {
      t: 'prompt',
      text: 'ok lass die session das fixen',
      initiatedBy: { userId: 'user' },
    });
    await ctx.store.markTurnRunning({ sessionId: 'qa', promptSeq: row.seq });
    await ctx.store.bindTurnIdentity('qa', { turnId: 'turn', startCommandId: 'start' });
  };
  await instruct();
  const first = await resolve();
  const key = await trustedQARepairConsent(ctx.store, 'qa', 'turn', first);
  expect(key).toEqual(expect.any(String));
  await service.request(caller, 'p', first, async () => key);
  const incident = (await ctx.store.repairs.incidents('p'))[0]!;
  await ctx.store.clearRunningTurn('target');
  await ctx.store.repairs.finishAttempt(
    incident.id,
    incident.dispatch_id!,
    'verifying',
    incident.evidence,
  );
  const second = await resolve();
  expect(await trustedQARepairInstruction(ctx.store, 'qa', 'turn', second)).toBe(false);
  // Even a previously checked key is fenced atomically after the first claim consumed it.
  expect(await service.request(caller, 'p', second, async () => key)).toMatchObject({
    status: 'blocked',
  });
  expect(deps.dispatch).toHaveBeenCalledOnce();
  await instruct();
  expect(
    await service.request(caller, 'p', second, () =>
      trustedQARepairConsent(ctx.store, 'qa', 'turn', second),
    ),
  ).toMatchObject({ status: 'accepted' });
  expect(deps.dispatch).toHaveBeenCalledTimes(2);
});
