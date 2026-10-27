export const DEFAULT_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const BACKUP_RUN_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const FIRST_RETRY_MS = 15 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
export interface BackupScheduleState {
  intervalMs: number;
  paused: boolean;
  lastSuccess: number | null;
  lastAttempt: number | null;
  failures: number;
}
export interface BackupScheduleDependencies {
  load: () => Promise<BackupScheduleState>;
  update: (
    change: (state: BackupScheduleState) => BackupScheduleState,
  ) => Promise<BackupScheduleState>;
  capture: (signal: AbortSignal) => Promise<void>;
  maintain: () => Promise<void>;
  syncRevocations: () => Promise<void>;
  now?: () => number;
}
export function validateScheduleState(state: BackupScheduleState): void {
  if (
    !Number.isSafeInteger(state.intervalMs) ||
    state.intervalMs < 60 * 60 * 1000 ||
    state.intervalMs > DAY ||
    typeof state.paused !== 'boolean' ||
    !Number.isSafeInteger(state.failures) ||
    state.failures < 0 ||
    [state.lastSuccess, state.lastAttempt].some(
      (value) => value !== null && (!Number.isSafeInteger(value) || value < 0),
    )
  )
    throw new Error('Invalid backup schedule state');
}
export function backupScheduleAlerts(state: BackupScheduleState, now: number): string[] {
  validateScheduleState(state);
  if (state.paused) return [];
  const alerts: string[] = [];
  if (state.failures >= 2) alerts.push('consecutive-failures');
  if (
    state.lastSuccess === null ||
    now - state.lastSuccess >= Math.min(2 * state.intervalMs, 2 * DAY)
  )
    alerts.push('stale-backup');
  return alerts;
}

/** Tick from the Server timer. Persisted attempts survive restart; one overdue run catches up. */
export class BackupScheduler {
  private active: Promise<void> | undefined;
  private readonly now: () => number;
  constructor(private readonly dependencies: BackupScheduleDependencies) {
    this.now = dependencies.now ?? Date.now;
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    const active = this.runTick();
    this.active = active;
    void active
      .finally(() => {
        if (this.active === active) this.active = undefined;
      })
      .catch(() => undefined);
    return active;
  }
  private async runTick(): Promise<void> {
    // Pausing capture must never pause revocation durability.
    await this.dependencies.syncRevocations();
    const state = await this.dependencies.load();
    validateScheduleState(state);
    if (state.paused) return;
    const now = this.now();
    const due = (state: BackupScheduleState): boolean => {
      const backoff = Math.min(
        FIRST_RETRY_MS * 2 ** Math.min(state.failures - 1, 10),
        DEFAULT_BACKUP_INTERVAL_MS,
      );
      const next =
        state.failures > 0 && state.lastAttempt !== null
          ? state.lastAttempt + backoff
          : (state.lastSuccess ?? -state.intervalMs) + state.intervalMs;
      return !state.paused && now >= next;
    };
    if (!due(state)) return;
    // Reserve an attempt before starting work. A crash is retried after the first backoff.
    let reserved = false;
    const started = await this.dependencies.update((current) => {
      validateScheduleState(current);
      if (!due(current)) return current;
      reserved = true;
      return {
        ...current,
        lastAttempt: now,
        failures: Math.min(current.failures + 1, 1000000),
      };
    });
    if (!reserved || started.paused) return;
    try {
      const signal = AbortSignal.timeout(BACKUP_RUN_TIMEOUT_MS);
      await this.dependencies.capture(signal);
      signal.throwIfAborted();
    } catch {
      // The attempt was durably recorded already. Never prune after a failed capture.
      return;
    }
    const finished = await this.dependencies.update((current) => {
      validateScheduleState(current);
      return { ...current, lastSuccess: this.now(), failures: 0 };
    });
    // A pause selected during capture also prevents its subsequent retention and GC.
    if (!finished.paused) await this.dependencies.maintain();
  }
}
