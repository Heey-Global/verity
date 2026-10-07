// Plain-language wording for session automations. The schedule is stored as
// structure (never cron), and these sentences are the only way it reaches the
// operator, so they avoid every technical term the server uses internally.
import type { AutomationProposalMessage, SessionAutomation } from '@verity/mobile';

import { formatClockTime } from './time';

type Schedule = SessionAutomation['schedule'];
type Proposal = AutomationProposalMessage['proposal'];

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MINUTES_PER_DAY = 24 * 60;

function clockTime(hour: number, minute: number): string {
  const at = new Date(2026, 0, 5, hour, minute, 0, 0);
  return formatClockTime(at.getTime() / 1000);
}

/**
 * "Every Monday at 09:00", "Every day at 07:30", "Every 2 hours".
 *
 * Proposals default to device time. Saved schedules retain their time zone;
 * the next run, when available, is displayed in the current device's zone.
 */
export function automationScheduleLabel(schedule: Schedule, nextRunAt?: string | null): string {
  if (schedule.kind === 'interval') {
    const minutes = schedule.everyMinutes;
    if (minutes % MINUTES_PER_DAY === 0) {
      const days = minutes / MINUTES_PER_DAY;
      return days === 1 ? 'Every day' : `Every ${String(days)} days`;
    }
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return hours === 1 ? 'Every hour' : `Every ${String(hours)} hours`;
    }
    return `Every ${String(minutes)} minutes`;
  }
  const next = nextRunAt ? new Date(nextRunAt) : null;
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zoneLabel = schedule.timeZone
    ? schedule.timeZone === deviceZone
      ? ''
      : ` (${schedule.timeZone})`
    : nextRunAt === null
      ? ' server time'
      : '';
  const time = next
    ? formatClockTime(next.getTime() / 1000)
    : `${clockTime(schedule.hour, schedule.minute)}${zoneLabel}`;
  if (schedule.kind === 'daily') return `Every day at ${time}`;
  const weekday = next ? next.getDay() : schedule.weekday;
  return `Every ${WEEKDAYS[weekday] ?? 'week'} at ${time}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "today at 09:00", "tomorrow at 09:00", or "Mon 06.10. at 09:00". */
export function automationRunTime(iso: string, now: Date = new Date()): string {
  const when = new Date(iso);
  const time = formatClockTime(when.getTime() / 1000);
  const dayDelta = Math.round((startOfDay(when) - startOfDay(now)) / 86_400_000);
  if (dayDelta === 0) return `today at ${time}`;
  if (dayDelta === 1) return `tomorrow at ${time}`;
  if (dayDelta === -1) return `yesterday at ${time}`;
  const day = String(when.getDate()).padStart(2, '0');
  const month = String(when.getMonth() + 1).padStart(2, '0');
  return `${SHORT_WEEKDAYS[when.getDay()] ?? ''} ${day}.${month}. at ${time}`;
}

/** One sentence about what happens next. */
export function automationNextRunText(
  automation: SessionAutomation,
  now: Date = new Date(),
): string {
  if (automation.status === 'paused') {
    return automation.consecutiveErrorCount >= 5
      ? 'Paused after several failed runs. Resume it to try again.'
      : 'Paused. It will not run until you resume it.';
  }
  return automation.nextRunAt
    ? `Next run ${automationRunTime(automation.nextRunAt, now)}.`
    : 'Waiting for its next run.';
}

/** One sentence about the most recent run. */
export function automationLastRunText(
  automation: SessionAutomation,
  now: Date = new Date(),
): string {
  if (automation.lastRunAt === null) return 'Has not run yet.';
  const when = automationRunTime(automation.lastRunAt, now);
  const detail = automation.lastDetail ? ` ${automation.lastDetail}` : '';
  switch (automation.lastOutcome) {
    case 'acted':
      return `Last ran ${when}.`;
    case 'ok':
      return `Last checked ${when}. There was nothing to do.`;
    case 'skipped':
      return `Skipped ${when}.${detail}`;
    case 'error':
      return `Could not run ${when}.${detail}`;
    default:
      return `Started ${when}.`;
  }
}

function sameSchedule(a: Schedule, b: Schedule): boolean {
  if (
    a.kind !== 'interval' &&
    b.kind !== 'interval' &&
    a.timeZone !== (b.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  )
    return false;
  switch (a.kind) {
    case 'interval':
      return b.kind === 'interval' && a.everyMinutes === b.everyMinutes;
    case 'daily':
      return b.kind === 'daily' && a.hour === b.hour && a.minute === b.minute;
    case 'weekly':
      return (
        b.kind === 'weekly' && a.weekday === b.weekday && a.hour === b.hour && a.minute === b.minute
      );
  }
}

/** Whether a proposal describes exactly the automation already in place. Field
 * by field: the saved schedule comes back from the database with its keys in a
 * different order than the proposal carries them. */
export function isSameAutomation(
  automation: SessionAutomation | null,
  proposal: Proposal,
): boolean {
  if (automation === null) return false;
  return (
    automation.name === proposal.name &&
    automation.prompt === proposal.prompt &&
    automation.script === (proposal.script ?? null) &&
    automation.model === (proposal.model ?? null) &&
    sameSchedule(automation.schedule, proposal.schedule)
  );
}
