import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AgentLoopCreateInput } from './store.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  // Agent loops are project-scoped (FK projects.id); every test needs a project.
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'verity-heey-global--verity',
    state: 'active',
  });
});

const base = {
  projectId: 'p1',
  name: 'Nightly audit',
};

/** A complete loop config used by the armed scheduler-test helper. */
const enabledDaily = {
  ...base,
  schedule: { kind: 'daily' as const, hour: 3, minute: 0 },
  script: '#!/bin/sh\nexit 0',
  reactionPrompt: 'Audit the repo for critical issues.',
};

async function createEnabledLoop(overrides: Partial<AgentLoopCreateInput> = {}) {
  const loop = await ctx.store.createAgentLoop({ ...enabledDaily, ...overrides });
  await ctx.store.markAgentLoopTestPassed(loop.id, loop);
  const enabled = await ctx.store.updateAgentLoop(loop.id, { status: 'enabled' });
  if (!enabled) throw new Error('expected loop to exist');
  return enabled;
}

describe('EventStore — agent loop CRUD', () => {
  it('creates a loop as a draft with no schedule/script and no armed next_run_at', async () => {
    const loop = await ctx.store.createAgentLoop(base);
    expect(loop.id).toMatch(/[0-9a-f-]{36}/);
    expect(loop.projectId).toBe('p1');
    expect(loop.status).toBe('draft');
    expect(loop.schedule).toBeNull();
    expect(loop.script).toBeNull();
    expect(loop.reactionPrompt).toBeNull();
    expect(loop.reactionModel).toBeNull();
    expect(loop.sessionId).toBeNull();
    expect(loop.testedScriptFingerprint).toBeNull();
    expect(loop.consecutiveErrorCount).toBe(0);
    expect(loop.lastOutcome).toBeNull();
    expect(loop.nextRunAt).toBeNull();
    expect(loop.lastRunAt).toBeNull();
  });

  it('always creates a draft even when full config is supplied', async () => {
    const loop = await ctx.store.createAgentLoop(enabledDaily);
    expect(loop.status).toBe('draft');
    expect(loop.schedule).toEqual({ kind: 'daily', hour: 3, minute: 0 });
    expect(loop.nextRunAt).toBeNull();
  });

  it('round-trips the structured schedule through jsonb', async () => {
    const loop = await ctx.store.createAgentLoop({
      ...base,
      schedule: { kind: 'weekly', weekday: 2, hour: 8, minute: 15 },
    });
    const read = await ctx.store.getAgentLoop(loop.id);
    expect(read?.schedule).toEqual({ kind: 'weekly', weekday: 2, hour: 8, minute: 15 });
  });

  it('records a fingerprint only through a successful test marker', async () => {
    const loop = await ctx.store.createAgentLoop({
      ...base,
      script: 'echo hello',
      reactionPrompt: 'React to the finding.',
      reactionModel: 'claude-opus-4-8',
    });
    const updated = await ctx.store.markAgentLoopTestPassed(loop.id, loop);
    const read = await ctx.store.getAgentLoop(loop.id);
    expect(read?.script).toBe('echo hello');
    expect(read?.reactionPrompt).toBe('React to the finding.');
    expect(read?.reactionModel).toBe('claude-opus-4-8');
    expect(updated?.testedScriptFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(read?.testedScriptFingerprint).toBe(updated?.testedScriptFingerprint);
  });

  it('does not attest a script that changed while its test was running', async () => {
    const loop = await ctx.store.createAgentLoop({ ...base, script: 'echo old' });
    await ctx.store.updateAgentLoop(loop.id, { script: 'echo new' });

    const updated = await ctx.store.markAgentLoopTestPassed(loop.id, loop);
    const read = await ctx.store.getAgentLoop(loop.id);

    expect(updated).toBeUndefined();
    expect(read?.script).toBe('echo new');
    expect(read?.testedScriptFingerprint).toBeNull();
  });

  it('lists loops for a project', async () => {
    await ctx.store.createAgentLoop({ ...base, name: 'first' });
    await ctx.store.createAgentLoop({ ...base, name: 'second' });
    const all = await ctx.store.listAgentLoops('p1');
    // Both belong to the project; exact ordering of same-millisecond creations is
    // not asserted (production loops are created interactively, seconds apart).
    expect(all.map((l) => l.name).sort()).toEqual(['first', 'second']);
    expect(all.every((l) => l.projectId === 'p1')).toBe(true);
  });

  it('refuses to enable until the current config has passed a test', async () => {
    const loop = await ctx.store.createAgentLoop({
      ...base,
      schedule: { kind: 'interval', everyMinutes: 30 },
      script: 'exit 0',
    });
    expect(loop.nextRunAt).toBeNull();
    await expect(ctx.store.updateAgentLoop(loop.id, { status: 'enabled' })).rejects.toThrow(
      /Test the current Agent Loop config/,
    );
    await ctx.store.markAgentLoopTestPassed(loop.id, loop);
    const updated = await ctx.store.updateAgentLoop(loop.id, { status: 'enabled' });
    expect(updated?.status).toBe('enabled');
    expect(updated?.nextRunAt).toBeInstanceOf(Date);
  });

  it('script edits invalidate the test and immediately disarm the loop', async () => {
    const loop = await createEnabledLoop();
    const updated = await ctx.store.updateAgentLoop(loop.id, { script: 'exit 1' });
    expect(updated?.status).toBe('draft');
    expect(updated?.testedScriptFingerprint).toBeNull();
    expect(updated?.nextRunAt).toBeNull();
  });

  it.each([
    ['schedule', { schedule: { kind: 'interval' as const, everyMinutes: 45 } }],
    ['reaction prompt', { reactionPrompt: 'Use the latest finding.' }],
    ['reaction model', { reactionModel: 'codex/default' }],
  ])('%s edits invalidate the complete config test', async (_label, patch) => {
    const loop = await createEnabledLoop();
    const updated = await ctx.store.updateAgentLoop(loop.id, patch);
    expect(updated).toMatchObject({
      status: 'draft',
      testedScriptFingerprint: null,
      nextRunAt: null,
    });
    await expect(ctx.store.updateAgentLoop(loop.id, { status: 'enabled' })).rejects.toThrow(
      /Test the current Agent Loop config/,
    );
  });

  it('cannot smuggle an edited script into enabled state in one patch', async () => {
    const loop = await createEnabledLoop();
    const updated = await ctx.store.updateAgentLoop(loop.id, {
      script: 'exit 10',
      status: 'enabled',
    });
    expect(updated).toMatchObject({
      script: 'exit 10',
      status: 'draft',
      testedScriptFingerprint: null,
      nextRunAt: null,
    });
  });

  it('disarms when the schedule of an enabled loop changes', async () => {
    const loop = await createEnabledLoop();
    const updated = await ctx.store.updateAgentLoop(loop.id, {
      schedule: { kind: 'interval', everyMinutes: 30 },
    });
    expect(updated?.schedule).toEqual({ kind: 'interval', everyMinutes: 30 });
    expect(updated?.status).toBe('draft');
    expect(updated?.testedScriptFingerprint).toBeNull();
    expect(updated?.nextRunAt).toBeNull();
  });

  it('clears next_run_at when an enabled loop is paused', async () => {
    const loop = await createEnabledLoop();
    expect(loop.nextRunAt).toBeInstanceOf(Date);
    const updated = await ctx.store.updateAgentLoop(loop.id, { status: 'paused' });
    expect(updated?.status).toBe('paused');
    expect(updated?.nextRunAt).toBeNull();
  });

  it('returns undefined when updating an unknown id', async () => {
    expect(await ctx.store.updateAgentLoop('nope', { name: 'x' })).toBeUndefined();
  });

  it('deletes a loop', async () => {
    const loop = await ctx.store.createAgentLoop(base);
    expect(await ctx.store.deleteAgentLoop(loop.id)).toBe(true);
    expect(await ctx.store.getAgentLoop(loop.id)).toBeUndefined();
    expect(await ctx.store.deleteAgentLoop(loop.id)).toBe(false);
  });

  it('cascades loop deletion when the project is deleted', async () => {
    const loop = await ctx.store.createAgentLoop(base);
    await ctx.store.deleteProject('p1');
    expect(await ctx.store.getAgentLoop(loop.id)).toBeUndefined();
  });
});

describe('EventStore — scheduler queries', () => {
  it('listDueAgentLoops returns only enabled loops due at or before now', async () => {
    // Due: next_run in the past. Not due: an interval far in the future.
    const due = await createEnabledLoop({
      name: 'due',
      schedule: { kind: 'interval', everyMinutes: 15 },
    });
    // Force its next_run_at into the past.
    await ctx.db
      .updateTable('agent_loops')
      .set({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
      .where('id', '=', due.id)
      .execute();
    const future = await createEnabledLoop({ name: 'future' });
    const draft = await ctx.store.createAgentLoop({ ...base, name: 'draft' });

    const list = await ctx.store.listDueAgentLoops(new Date());
    const names = list.map((l) => l.name);
    expect(names).toContain('due');
    expect(names).not.toContain('future');
    expect(names).not.toContain('draft');
    expect(future.nextRunAt && future.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(draft.status).toBe('draft');
  });

  it('nextAgentLoopDueAt returns the earliest armed due time, or null when none', async () => {
    expect(await ctx.store.nextAgentLoopDueAt()).toBeNull();
    const soon = await createEnabledLoop({
      name: 'soon',
      schedule: { kind: 'interval', everyMinutes: 15 },
    });
    await ctx.db
      .updateTable('agent_loops')
      .set({ next_run_at: new Date(Date.now() + 5 * 60_000).toISOString() })
      .where('id', '=', soon.id)
      .execute();
    await createEnabledLoop({ name: 'later' }); // daily 03:00, further out
    const next = await ctx.store.nextAgentLoopDueAt();
    expect(next).toBeInstanceOf(Date);
    expect(next && next.getTime()).toBeLessThan(Date.now() + 6 * 60_000);
  });

  it('atomically claims a due run and advances next_run_at only once', async () => {
    const loop = await createEnabledLoop();
    const ranAt = new Date('2026-07-13T03:00:00');
    const nextAt = new Date('2026-07-14T03:00:00');
    await ctx.db
      .updateTable('agent_loops')
      .set({ next_run_at: ranAt.toISOString() })
      .where('id', '=', loop.id)
      .execute();
    expect(await ctx.store.claimAgentLoopRun(loop.id, ranAt, nextAt)).toBe(true);
    expect(await ctx.store.claimAgentLoopRun(loop.id, ranAt, nextAt)).toBe(false);
    const read = await ctx.store.getAgentLoop(loop.id);
    expect(read?.lastRunAt?.getTime()).toBe(ranAt.getTime());
    expect(read?.nextRunAt?.getTime()).toBe(nextAt.getTime());
  });
});

describe('EventStore — Agent Loop session recovery', () => {
  it('allows only one concurrent replacement session to win', async () => {
    const loop = await ctx.store.createAgentLoop({ projectId: 'p1', name: 'Recovery' });
    await ctx.store.createSession({
      sessionId: 'replacement-a',
      worktree: '/worktrees/a',
      model: 'codex/default',
      projectId: 'p1',
      kind: 'agent_loop',
    });
    await ctx.store.createSession({
      sessionId: 'replacement-b',
      worktree: '/worktrees/b',
      model: 'codex/default',
      projectId: 'p1',
      kind: 'agent_loop',
    });

    const claims = await Promise.all([
      ctx.store.linkAgentLoopSessionIfMissing(loop.id, 'replacement-a'),
      ctx.store.linkAgentLoopSessionIfMissing(loop.id, 'replacement-b'),
    ]);
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect(['replacement-a', 'replacement-b']).toContain(
      (await ctx.store.getAgentLoop(loop.id))?.sessionId,
    );
  });
});

describe('EventStore — agent loop run history', () => {
  it('opens and closes a run row with outcome, exit code, detail, and session', async () => {
    const loop = await createEnabledLoop();
    const run = await ctx.store.startAgentLoopRun(loop.id);
    expect(run.outcome).toBe('ok');
    expect(run.finishedAt).toBeNull();
    expect(run.exitCode).toBeNull();
    expect(run.isTest).toBe(false);

    await ctx.store.finishAgentLoopRun(run.id, {
      outcome: 'acted',
      exitCode: 10,
      detail: 'script signaled a finding',
      sessionId: 'sess-1',
    });
    const latest = (await ctx.store.listAgentLoopRuns(loop.id))[0];
    expect(latest?.outcome).toBe('acted');
    expect(latest?.exitCode).toBe(10);
    expect(latest?.detail).toBe('script signaled a finding');
    expect(latest?.sessionId).toBe('sess-1');
    expect(latest?.finishedAt).toBeInstanceOf(Date);
  });

  it('records a test run via the is_test flag', async () => {
    const loop = await createEnabledLoop();
    const run = await ctx.store.startAgentLoopRun(loop.id);
    await ctx.store.finishAgentLoopRun(run.id, { outcome: 'ok', exitCode: 0, isTest: true });
    const latest = (await ctx.store.listAgentLoopRuns(loop.id))[0];
    expect(latest?.isTest).toBe(true);
    expect(latest?.exitCode).toBe(0);
  });

  it('auto-pauses after five consecutive execution errors and resets after success', async () => {
    const loop = await createEnabledLoop();
    for (let index = 0; index < 4; index++) {
      const run = await ctx.store.startAgentLoopRun(loop.id);
      await ctx.store.finishAgentLoopRun(run.id, { outcome: 'error' });
    }
    expect(await ctx.store.getAgentLoop(loop.id)).toMatchObject({
      status: 'enabled',
      consecutiveErrorCount: 4,
      lastOutcome: 'error',
    });

    const recovered = await ctx.store.startAgentLoopRun(loop.id);
    await ctx.store.finishAgentLoopRun(recovered.id, { outcome: 'ok' });
    expect(await ctx.store.getAgentLoop(loop.id)).toMatchObject({ consecutiveErrorCount: 0 });

    for (let index = 0; index < 5; index++) {
      const run = await ctx.store.startAgentLoopRun(loop.id);
      await ctx.store.finishAgentLoopRun(run.id, { outcome: 'error' });
    }
    expect(await ctx.store.getAgentLoop(loop.id)).toMatchObject({
      status: 'paused',
      consecutiveErrorCount: 5,
      nextRunAt: null,
    });
  });

  it('lists runs newest-first and honors the limit', async () => {
    const loop = await createEnabledLoop();
    const r1 = await ctx.store.startAgentLoopRun(loop.id);
    const r2 = await ctx.store.startAgentLoopRun(loop.id);
    const r3 = await ctx.store.startAgentLoopRun(loop.id);
    const limited = await ctx.store.listAgentLoopRuns(loop.id, 2);
    expect(limited).toHaveLength(2);
    // Newest-first: r3, r2 come before r1.
    expect(limited.map((r) => r.id)).toEqual([r3.id, r2.id]);
    expect(r1.loopId).toBe(loop.id);
  });

  it('cascades run history when the loop is deleted', async () => {
    const loop = await createEnabledLoop();
    await ctx.store.startAgentLoopRun(loop.id);
    await ctx.store.deleteAgentLoop(loop.id);
    expect(await ctx.store.listAgentLoopRuns(loop.id)).toHaveLength(0);
  });
});
