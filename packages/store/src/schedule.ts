import type { ScheduleConfig } from './schema.js';

/**
 * Pure schedule arithmetic for the Agent Loop scheduler (ADR 0008 §3). Kept free of
 * any DB/timer dependency so it is unit-tested in isolation. All times are
 * server-local (no per-operator timezone in v1 — see the ADR's accepted
 * negatives).
 */

const MINUTE_MS = 60_000;

/** Interval schedules never fire faster than this (guards a runaway loop from a
 *  degenerate `everyMinutes`). Mirrored by the route-level validation. */
export const MIN_INTERVAL_MINUTES = 15;

/**
 * The earliest time STRICTLY AFTER `from` that matches `schedule`. Strict so a
 * loop that just ran at its scheduled instant advances to the next slot
 * instead of re-firing on the same tick.
 */
export function computeNextRun(schedule: ScheduleConfig, from: Date): Date {
  switch (schedule.kind) {
    case 'interval': {
      const minutes = Math.max(MIN_INTERVAL_MINUTES, Math.floor(schedule.everyMinutes));
      return new Date(from.getTime() + minutes * MINUTE_MS);
    }
    case 'daily': {
      const next = new Date(from);
      next.setHours(schedule.hour, schedule.minute, 0, 0);
      if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
      return next;
    }
    case 'weekly': {
      const next = new Date(from);
      next.setHours(schedule.hour, schedule.minute, 0, 0);
      // Days to add to reach the target weekday (0–6, Sun–Sat). 0 keeps today.
      let deltaDays = (schedule.weekday - next.getDay() + 7) % 7;
      if (deltaDays === 0 && next.getTime() <= from.getTime()) deltaDays = 7;
      next.setDate(next.getDate() + deltaDays);
      return next;
    }
  }
}

/** Whether a schedule is structurally valid (defensive; the route also validates
 *  via zod). Returns a short reason string when invalid, else null. */
export function validateSchedule(schedule: ScheduleConfig): string | null {
  switch (schedule.kind) {
    case 'interval':
      return Number.isSafeInteger(schedule.everyMinutes) &&
        schedule.everyMinutes >= MIN_INTERVAL_MINUTES
        ? null
        : `interval must be at least ${MIN_INTERVAL_MINUTES} minutes`;
    case 'daily':
      return isHour(schedule.hour) && isMinute(schedule.minute) ? null : 'invalid daily time';
    case 'weekly':
      return isWeekday(schedule.weekday) && isHour(schedule.hour) && isMinute(schedule.minute)
        ? null
        : 'invalid weekly time';
  }
}

function isHour(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 23;
}
function isMinute(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 59;
}
function isWeekday(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 6;
}
