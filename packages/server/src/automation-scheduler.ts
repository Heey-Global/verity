// Session automation scheduler (ADR 0008): one self-rescheduling, unref'd timer
// that runs due automations through the shared executor. The house pattern for
// periodic server work: a single timer, an overlap guard, state read at run
// time, and an `onClose` disposer.
import { computeNextRun } from '@verity/store';
import type { SessionAutomationOutcome, SessionAutomationRecord } from '@verity/store';

/** The store surface the scheduler needs (a subset of EventStore). */
export interface AutomationSchedulerStore {
  listDueSessionAutomations(now: Date): Promise<SessionAutomationRecord[]>;
  nextSessionAutomationDueAt(): Promise<Date | null>;
  claimSessionAutomationRun(id: string, ranAt: Date, nextRunAt: Date): Promise<boolean>;
  recordSessionAutomationOutcome(
    id: string,
    result: { outcome: SessionAutomationOutcome; detail: string | null },
  ): Promise<void>;
}

interface AutomationSchedulerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface AutomationSchedulerDeps {
  store: AutomationSchedulerStore;
  run: (
    automation: SessionAutomationRecord,
  ) => Promise<{ outcome: SessionAutomationOutcome; detail: string | null }>;
  log: AutomationSchedulerLogger;
  /** Injectable clock (ms) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface AutomationScheduler {
  /** Stop the timer; safe to call repeatedly. */
  stop(): void;
  /** Re-arm immediately after an automation is created, resumed, or removed. */
  wake(): void;
  /** Run one pass (test seam; does not touch the timer). */
  runOnce(): Promise<void>;
}

// Safety net so an automation changed by another server generation is still
// picked up without a wake(). Not a poll: the timer sleeps until the next due
// time, capped at this bound.
const MAX_SLEEP_MS = 5 * 60_000;

export function startAutomationScheduler(deps: AutomationSchedulerDeps): AutomationScheduler {
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;

  const processAutomation = async (automation: SessionAutomationRecord): Promise<void> => {
    const at = new Date(now());
    // Claim first: advancing the due time before any work means a crash mid-run
    // cannot re-fire the same slot on restart, and a second generation loses.
    const claimed = await deps.store.claimSessionAutomationRun(
      automation.id,
      at,
      computeNextRun(automation.schedule, at),
    );
    if (!claimed) return;
    let result: { outcome: SessionAutomationOutcome; detail: string | null };
    try {
      result = await deps.run(automation);
    } catch (err) {
      result = { outcome: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
    await deps.store.recordSessionAutomationOutcome(automation.id, result);
    deps.log.info(
      { automationId: automation.id, sessionId: automation.sessionId, outcome: result.outcome },
      'automation run settled',
    );
  };

  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const due = await deps.store.listDueSessionAutomations(new Date(now()));
      for (const automation of due) {
        try {
          await processAutomation(automation);
        } catch (err) {
          deps.log.warn({ err, automationId: automation.id }, 'automation run failed');
        }
      }
    } catch (err) {
      deps.log.warn({ err }, 'automation scheduler pass failed');
    } finally {
      running = false;
      void scheduleNext();
    }
  };

  const scheduleNext = async (): Promise<void> => {
    if (stopped) return;
    let delay = MAX_SLEEP_MS;
    try {
      const dueAt = await deps.store.nextSessionAutomationDueAt();
      if (dueAt !== null) delay = Math.max(0, Math.min(MAX_SLEEP_MS, dueAt.getTime() - now()));
    } catch (err) {
      deps.log.warn({ err }, 'automation scheduler failed to compute next wake');
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
