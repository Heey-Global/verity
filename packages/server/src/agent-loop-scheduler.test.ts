import type { AgentLoopRecord, AgentLoopRunOutcome, ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';

import { startAgentLoopScheduler, type AgentLoopSchedulerStore } from './agent-loop-scheduler.js';

const NOW = new Date('2026-07-13T10:00:00Z').getTime();

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'verity-heey-global--verity',
    imageRef: null,
    state: 'active',
    provisionError: null,
    provisionWarning: null,
    hiddenAt: null,
    latestReleaseTag: null,
    latestReleaseName: null,
    latestReleaseUrl: null,
    latestReleasePublishedAt: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    stateChangedAt: new Date(NOW),
    ...overrides,
  };
}

function loop(overrides: Partial<AgentLoopRecord> = {}): AgentLoopRecord {
  return {
    id: 'l1',
    projectId: 'p1',
    name: 'Nightly',
    status: 'enabled',
    schedule: { kind: 'interval', everyMinutes: 30 },
    script: 'exit 0',
    reactionPrompt: 'Audit the repo.',
    reactionModel: null,
    sessionId: null,
    testedScriptFingerprint: null,
    consecutiveErrorCount: 0,
    lastRunAt: null,
    lastOutcome: null,
    nextRunAt: new Date(NOW - 60_000),
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

/** In-memory fake of the store surface the scheduler uses. Records the calls the
 *  tests assert on; timers are never armed (we drive `runOnce`). */
function fakeStore(due: AgentLoopRecord[], proj: ProjectRecord | null = project()) {
  const finished: Array<{
    runId: string;
    outcome: string;
    detail?: string | null;
    sessionId?: string | null;
  }> = [];
  const ran: Array<{ id: string; nextRunAt: Date | null }> = [];
  let runSeq = 0;
  const claimAgentLoopRun = vi.fn(async (id: string, _ranAt: Date, nextRunAt: Date | null) => {
    ran.push({ id, nextRunAt });
    return true;
  });
  const startAgentLoopRun = vi.fn(async () => ({ id: `run-${++runSeq}` }));
  const store: AgentLoopSchedulerStore = {
    listDueAgentLoops: vi.fn(async () => due),
    nextAgentLoopDueAt: vi.fn(async () => null),
    claimAgentLoopRun,
    startAgentLoopRun,
    finishAgentLoopRun: vi.fn(
      async (
        runId: string,
        result: {
          outcome: AgentLoopRunOutcome;
          detail?: string | null;
          sessionId?: string | null;
        },
      ) => {
        finished.push({ runId, ...result });
      },
    ),
    getProject: vi.fn(async () => proj ?? undefined),
  };
  return { store, finished, ran, claimAgentLoopRun, startAgentLoopRun };
}

const log = { info: vi.fn(), warn: vi.fn() };

describe('startAgentLoopScheduler', () => {
  it('executes a due loop and records its result', async () => {
    const { store, finished, ran } = fakeStore([loop()]);
    const executeAgentLoop = vi.fn(async () => ({
      outcome: 'acted' as const,
      detail: 'finding dispatched',
      sessionId: 'sess-1',
      exitCode: 10,
    }));
    const sched = startAgentLoopScheduler({ store, executeAgentLoop, log, now: () => NOW });

    await sched.runOnce();
    sched.stop();

    expect(executeAgentLoop).toHaveBeenCalledOnce();
    expect(finished).toEqual([
      {
        runId: 'run-1',
        outcome: 'acted',
        detail: 'finding dispatched',
        sessionId: 'sess-1',
        exitCode: 10,
      },
    ]);
    // Claim-first: due time advanced by the interval before the session started.
    expect(ran[0]?.id).toBe('l1');
    expect(ran[0]?.nextRunAt?.getTime()).toBe(NOW + 30 * 60_000);
  });

  it('does not execute a loop when another scheduler already claimed the tick', async () => {
    const { store, claimAgentLoopRun, startAgentLoopRun } = fakeStore([loop()]);
    claimAgentLoopRun.mockResolvedValue(false);
    const executeAgentLoop = vi.fn();
    const sched = startAgentLoopScheduler({ store, executeAgentLoop, log, now: () => NOW });

    await sched.runOnce();
    sched.stop();

    expect(executeAgentLoop).not.toHaveBeenCalled();
    expect(startAgentLoopRun).not.toHaveBeenCalled();
  });

  it('skips when the project is not active', async () => {
    const { store, finished } = fakeStore([loop()], project({ state: 'absent' }));
    const executeAgentLoop = vi.fn();
    const sched = startAgentLoopScheduler({ store, executeAgentLoop, log, now: () => NOW });

    await sched.runOnce();
    sched.stop();

    expect(executeAgentLoop).not.toHaveBeenCalled();
    expect(finished[0]?.outcome).toBe('skipped');
    expect(finished[0]?.detail).toContain('not active');
  });

  it('records an error run when the project is missing', async () => {
    const { store, finished } = fakeStore([loop()], null);
    const executeAgentLoop = vi.fn();
    const sched = startAgentLoopScheduler({ store, executeAgentLoop, log, now: () => NOW });

    await sched.runOnce();
    sched.stop();

    expect(executeAgentLoop).not.toHaveBeenCalled();
    expect(finished[0]?.outcome).toBe('error');
    expect(finished[0]?.detail).toBe('project not found');
  });

  it('records an error run without throwing when the session start fails', async () => {
    const { store, finished } = fakeStore([loop()]);
    const executeAgentLoop = vi.fn(async () => {
      throw new Error('worktree add failed');
    });
    const sched = startAgentLoopScheduler({ store, executeAgentLoop, log, now: () => NOW });

    await expect(sched.runOnce()).resolves.toBeUndefined();
    sched.stop();

    expect(finished[0]?.outcome).toBe('error');
    expect(finished[0]?.detail).toBe('worktree add failed');
  });

  it('processes every due loop in one pass', async () => {
    const { store, finished } = fakeStore([
      loop({ id: 'l1' }),
      loop({ id: 'l2' }),
      loop({ id: 'l3' }),
    ]);
    const executeAgentLoop = vi.fn(async () => ({
      outcome: 'ok' as const,
      detail: null,
      sessionId: 's',
      exitCode: 0,
    }));
    const sched = startAgentLoopScheduler({ store, executeAgentLoop, log, now: () => NOW });

    await sched.runOnce();
    sched.stop();

    expect(executeAgentLoop).toHaveBeenCalledTimes(3);
    expect(finished).toHaveLength(3);
  });

  it('does not run after stop()', async () => {
    const { store } = fakeStore([loop()]);
    const executeAgentLoop = vi.fn();
    const sched = startAgentLoopScheduler({ store, executeAgentLoop, log, now: () => NOW });

    sched.stop();
    await sched.runOnce();

    expect(executeAgentLoop).not.toHaveBeenCalled();
  });
});
