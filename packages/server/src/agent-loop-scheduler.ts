// Agent Loop scheduler (ADR 0008): one self-rescheduling, unref'd timer that
// fires due loops and delegates script-first execution to the shared executor.
// The house pattern for periodic server work: a single timer, an overlap guard,
// config/state read at run time, and an `onClose` disposer. The executor is
// injected rather than reached for, so this module stays free of
// container/session details.
import { computeNextRun } from '@verity/store';
import type { AgentLoopRecord, AgentLoopRunOutcome, ProjectRecord } from '@verity/store';

/** The store surface the scheduler needs (a subset of EventStore). */
export interface AgentLoopSchedulerStore {
  listDueAgentLoops(now: Date): Promise<AgentLoopRecord[]>;
  nextAgentLoopDueAt(): Promise<Date | null>;
  claimAgentLoopRun(id: string, ranAt: Date, nextRunAt: Date | null): Promise<boolean>;
  startAgentLoopRun(loopId: string): Promise<{ id: string }>;
  finishAgentLoopRun(
    runId: string,
    result: {
      outcome: AgentLoopRunOutcome;
      detail?: string | null;
      sessionId?: string | null;
      exitCode?: number | null;
      isTest?: boolean;
    },
  ): Promise<void>;
  getProject(id: string): Promise<ProjectRecord | undefined>;
}

export interface AgentLoopSchedulerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface AgentLoopSchedulerDeps {
  store: AgentLoopSchedulerStore;
  executeAgentLoop: (input: { loop: AgentLoopRecord; project: ProjectRecord }) => Promise<{
    outcome: AgentLoopRunOutcome;
    detail: string | null;
    sessionId: string | null;
    exitCode: number | null;
  }>;
  log: AgentLoopSchedulerLogger;
  /** Injectable clock (ms) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface AgentLoopScheduler {
  /** Stop the timer; safe to call repeatedly. */
  stop(): void;
  /** Re-arm immediately — call after a loop is created/updated so a newly due
   *  loop doesn't wait for the safety-net re-check. */
  wake(): void;
  /** Run one pass synchronously (test seam; does not touch the timer). */
  runOnce(): Promise<void>;
}

// Safety net so a loop created/edited during a long sleep is still picked up
// even without an explicit wake(); wake() is the fast path. NOT a tight poll —
// the timer sleeps until the next due time, capped at this bound.
const MAX_SLEEP_MS = 5 * 60_000;

export function startAgentLoopScheduler(deps: AgentLoopSchedulerDeps): AgentLoopScheduler {
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;

  const processLoop = async (loop: AgentLoopRecord): Promise<void> => {
    const at = new Date(now());
    // Claim first: advance the due time before doing any work so a crash mid-run
    // cannot re-fire the same tick on restart (the DB is the source of truth).
    const nextRunAt =
      loop.status === 'enabled' && loop.schedule ? computeNextRun(loop.schedule, at) : null;
    const claimed = await deps.store.claimAgentLoopRun(loop.id, at, nextRunAt);
    if (!claimed) return;

    const run = await deps.store.startAgentLoopRun(loop.id);
    const finish = (
      outcome: AgentLoopRunOutcome,
      detail: string | null = null,
      sessionId: string | null = null,
    ): Promise<void> => deps.store.finishAgentLoopRun(run.id, { outcome, detail, sessionId });

    try {
      const project = await deps.store.getProject(loop.projectId);
      if (project === undefined) {
        await finish('error', 'project not found');
        return;
      }
      if (project.state !== 'active') {
        await finish('skipped', `project is not active (state=${project.state})`);
        return;
      }
      const result = await deps.executeAgentLoop({ loop, project });
      await deps.store.finishAgentLoopRun(run.id, result);
      deps.log.info(
        { loopId: loop.id, projectId: project.id, outcome: result.outcome },
        'agent loop run settled',
      );
    } catch (err) {
      await finish('error', errorMessage(err)).catch(() => undefined);
      deps.log.warn({ err, loopId: loop.id }, 'agent loop run failed');
    }
  };

  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const due = await deps.store.listDueAgentLoops(new Date(now()));
      for (const loop of due) {
        await processLoop(loop);
      }
    } catch (err) {
      deps.log.warn({ err }, 'agent loop scheduler pass failed');
    } finally {
      running = false;
      void scheduleNext();
    }
  };

  const scheduleNext = async (): Promise<void> => {
    if (stopped) return;
    let delay = MAX_SLEEP_MS;
    try {
      const dueAt = await deps.store.nextAgentLoopDueAt();
      if (dueAt !== null) {
        delay = Math.max(0, Math.min(MAX_SLEEP_MS, dueAt.getTime() - now()));
      }
    } catch (err) {
      deps.log.warn({ err }, 'agent loop scheduler failed to compute next wake');
    }
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void run(), delay);
    timer.unref?.();
  };

  void scheduleNext();

  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    wake(): void {
      if (stopped) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void run(), 0);
      timer.unref?.();
    },
    runOnce: run,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
