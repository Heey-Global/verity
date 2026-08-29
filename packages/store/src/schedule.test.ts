import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIN_INTERVAL_MINUTES, computeNextRun, validateSchedule } from './schedule.js';
import type { ScheduleConfig } from './schema.js';

describe('computeNextRun — interval', () => {
  it('adds the interval to the from-time', () => {
    const from = new Date('2026-07-13T10:00:00');
    const next = computeNextRun({ kind: 'interval', everyMinutes: 30 }, from);
    expect(next.getTime()).toBe(from.getTime() + 30 * 60_000);
  });

  it('floors a sub-minimum interval up to the guard (never a runaway loop)', () => {
    const from = new Date('2026-07-13T10:00:00');
    const next = computeNextRun({ kind: 'interval', everyMinutes: 1 }, from);
    expect(next.getTime()).toBe(from.getTime() + MIN_INTERVAL_MINUTES * 60_000);
  });
});

describe('computeNextRun — daily', () => {
  it('returns today at the target time when it is still ahead', () => {
    const from = new Date('2026-07-13T08:00:00');
    const next = computeNextRun({ kind: 'daily', hour: 9, minute: 30 }, from);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(6); // July
    expect(next.getDate()).toBe(13);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
  });

  it('rolls to tomorrow when the target time already passed today', () => {
    const from = new Date('2026-07-13T10:00:00');
    const next = computeNextRun({ kind: 'daily', hour: 9, minute: 0 }, from);
    expect(next.getDate()).toBe(14);
    expect(next.getHours()).toBe(9);
  });

  it('rolls to tomorrow when from IS exactly the target instant (strictly after)', () => {
    const from = new Date('2026-07-13T09:00:00');
    const next = computeNextRun({ kind: 'daily', hour: 9, minute: 0 }, from);
    expect(next.getDate()).toBe(14);
  });
});

describe('computeNextRun — daylight-saving transitions', () => {
  const originalTimezone = process.env['TZ'];
  beforeAll(() => {
    process.env['TZ'] = 'America/New_York';
  });
  afterAll(() => {
    if (originalTimezone === undefined) delete process.env['TZ'];
    else process.env['TZ'] = originalTimezone;
  });

  it('keeps the configured local hour when a daily schedule crosses into DST', () => {
    const from = new Date(2026, 2, 7, 10, 0, 0);
    const next = computeNextRun({ kind: 'daily', hour: 9, minute: 0 }, from);
    expect(next.getDate()).toBe(8);
    expect(next.getHours()).toBe(9);
    expect(next.getTime() - from.getTime()).toBe(22 * 60 * 60_000);
  });
});

describe('computeNextRun — weekly', () => {
  it('advances to the next occurrence of the weekday', () => {
    // 2026-07-13 is a Monday (getDay() === 1).
    const from = new Date('2026-07-13T10:00:00');
    // Target Wednesday (3) at 08:00.
    const next = computeNextRun({ kind: 'weekly', weekday: 3, hour: 8, minute: 0 }, from);
    expect(next.getDay()).toBe(3);
    expect(next.getDate()).toBe(15);
    expect(next.getHours()).toBe(8);
  });

  it('rolls a full week when today is the weekday but the time passed', () => {
    const from = new Date('2026-07-13T12:00:00'); // Monday noon
    const next = computeNextRun({ kind: 'weekly', weekday: 1, hour: 9, minute: 0 }, from);
    expect(next.getDay()).toBe(1);
    expect(next.getDate()).toBe(20); // next Monday
  });

  it('keeps today when the weekday matches and the time is still ahead', () => {
    const from = new Date('2026-07-13T07:00:00'); // Monday 07:00
    const next = computeNextRun({ kind: 'weekly', weekday: 1, hour: 9, minute: 0 }, from);
    expect(next.getDate()).toBe(13);
    expect(next.getHours()).toBe(9);
  });
});

describe('validateSchedule', () => {
  const cases: Array<[ScheduleConfig, boolean]> = [
    [{ kind: 'interval', everyMinutes: 15 }, true],
    [{ kind: 'interval', everyMinutes: 5 }, false],
    [{ kind: 'daily', hour: 9, minute: 30 }, true],
    [{ kind: 'daily', hour: 24, minute: 0 }, false],
    [{ kind: 'daily', hour: 9, minute: 60 }, false],
    [{ kind: 'weekly', weekday: 0, hour: 0, minute: 0 }, true],
    [{ kind: 'weekly', weekday: 7, hour: 0, minute: 0 }, false],
  ];
  it.each(cases)('validates %o → valid=%s', (schedule, valid) => {
    expect(validateSchedule(schedule) === null).toBe(valid);
  });
});
