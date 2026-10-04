import type { ScheduleConfig } from './schema.js';

/**
 * Pure schedule arithmetic for the session automation scheduler (ADR 0008 §3). Kept free of
 * any DB/timer dependency so it is unit-tested in isolation. Calendar schedules
 * use their saved IANA time zone; zone-less legacy schedules remain server-local.
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
  if (schedule.kind !== 'interval' && schedule.timeZone) {
    return computeZonedNextRun(schedule, from);
  }
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
  if (schedule.kind !== 'interval' && schedule.timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: schedule.timeZone });
    } catch {
      return 'invalid time zone';
    }
  }
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

/** Treat civil dates as UTC only for calendar arithmetic, never as instants. */
function computeZonedNextRun(
  schedule: Extract<ScheduleConfig, { kind: 'daily' | 'weekly' }>,
  from: Date,
): Date {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: schedule.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const civilTime = (instant: number): number => {
    const parts = formatter.formatToParts(instant);
    const value = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value);
    return Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour'),
      value('minute'),
      value('second'),
    );
  };
  const day = new Date(civilTime(from.getTime()));
  day.setUTCHours(schedule.hour, schedule.minute, 0, 0);
  for (let i = 0; i <= 8; i += 1) {
    if (schedule.kind === 'daily' || day.getUTCDay() === schedule.weekday) {
      const target = day.getTime();
      // Sample both sides of a possible offset transition. On overlaps choose
      // the first occurrence; on gaps advance by the skipped clock duration.
      const offsets = new Set(
        [-1, 0, 1].map((delta) => {
          const sample = target + delta * 86_400_000;
          return civilTime(sample) - sample;
        }),
      );
      const candidates = [...offsets].map((offset) => target - offset);
      const matching = candidates.filter((instant) => civilTime(instant) === target);
      const instant = matching.length > 0 ? Math.min(...matching) : Math.max(...candidates);
      if (instant > from.getTime()) return new Date(instant);
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  throw new Error('Unable to compute next scheduled run');
}
