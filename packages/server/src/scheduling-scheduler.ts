// Scheduling request scheduler: one self-rescheduling, unref'd timer in the house pattern of
// `automation-scheduler.ts`. Each pass resumes interrupted provisioning, closes requests at their
// deadline, removes holds with backoff, retires links at day 30 and reconnects public links —
// all from durable state, so a restart simply continues where the last generation stopped.

interface SchedulingSchedulerLogger {
  warn(obj: unknown, msg?: string): void;
}

export interface SchedulingSchedulerDeps {
  /** Runs due work; returns when the next work is due. */
  runDue: () => Promise<Date | undefined>;
  log: SchedulingSchedulerLogger;
  now?: () => number;
}

export interface SchedulingScheduler {
  stop(): void;
  wake(): void;
  runOnce(): Promise<void>;
}

// A public link that dropped reconnects within this bound, so the timer never sleeps longer.
const MAX_SLEEP_MS = 60_000;

export function startSchedulingScheduler(deps: SchedulingSchedulerDeps): SchedulingScheduler {
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  let again = false;

  const arm = (delay: number) => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void run(), delay);
    timer.unref?.();
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    let delay = MAX_SLEEP_MS;
    try {
      const dueAt = await deps.runDue();
      if (dueAt) delay = Math.max(1_000, Math.min(MAX_SLEEP_MS, dueAt.getTime() - now()));
    } catch (err) {
      deps.log.warn({ err }, 'scheduling scheduler pass failed');
    } finally {
      running = false;
      if (again) {
        again = false;
        arm(0);
      } else arm(delay);
    }
  };

  arm(0);

  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    wake(): void {
      arm(0);
    },
    runOnce: run,
  };
}
