import type { CalendarEventRecord } from './google-calendar.js';

/** Private extended property naming the scheduling request an event belongs to. */
export const SCHEDULING_REQUEST_PROPERTY = 'verityScheduling';
/** Private extended property: `hold` while offered, `booked` once it is the appointment. */
export const SCHEDULING_ROLE_PROPERTY = 'verityRole';
/** Private extended property: which offered window of the request a hold stands for. */
export const SCHEDULING_POSITION_PROPERTY = 'verityPosition';

export type SchedulingRole = 'hold' | 'booked';

export function schedulingMarkers(
  requestId: string,
  role: SchedulingRole,
  position: number,
): Record<string, string> {
  return {
    [SCHEDULING_REQUEST_PROPERTY]: requestId,
    [SCHEDULING_ROLE_PROPERTY]: role,
    [SCHEDULING_POSITION_PROPERTY]: String(position),
  };
}

export function schedulingRole(event: CalendarEventRecord): SchedulingRole | undefined {
  const role = event.extendedProperties?.private?.[SCHEDULING_ROLE_PROPERTY];
  return role === 'hold' || role === 'booked' ? role : undefined;
}

export interface Interval {
  start: number;
  end: number;
}

export interface Slot {
  start: Date;
  end: Date;
  /** The offered window (hold) the slot lies in. */
  position: number;
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/** Offset of `timeZone` from UTC at instant `at`, in milliseconds. */
function zoneOffset(at: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant a wall-clock date and time occurs in `timeZone`. */
export function zonedTime(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle the offset also next to a daylight-saving switch.
  const first = guess - zoneOffset(guess, timeZone);
  return new Date(guess - zoneOffset(first, timeZone));
}

function eventInterval(event: CalendarEventRecord, timeZone: string): Interval | undefined {
  if (event.start.dateTime && event.end.dateTime) {
    const start = Date.parse(event.start.dateTime);
    const end = Date.parse(event.end.dateTime);
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? { start, end }
      : undefined;
  }
  if (event.start.date && event.end.date)
    return {
      start: zonedTime(event.start.date, '00:00', timeZone).getTime(),
      end: zonedTime(event.end.date, '00:00', timeZone).getTime(),
    };
  return undefined;
}

/**
 * Whether an event makes its time unavailable. Holds of any scheduling request never do — they
 * may overlap freely — while everything the organizer actually attends does: other meetings,
 * busy all-day events, and appointments booked through other requests.
 */
export function isBlocking(event: CalendarEventRecord): boolean {
  if (event.status === 'cancelled') return false;
  if (event.transparency === 'transparent') return false;
  if (schedulingRole(event) === 'hold') return false;
  if (event.attendees?.some((attendee) => attendee.self && attendee.responseStatus === 'declined'))
    return false;
  return true;
}

export function busyIntervals(events: CalendarEventRecord[], timeZone: string): Interval[] {
  return events.flatMap((event) => {
    if (!isBlocking(event)) return [];
    const interval = eventInterval(event, timeZone);
    return interval ? [interval] : [];
  });
}

/**
 * The live window of a hold: its current position in the calendar, so deleting, moving or
 * resizing a hold changes what is offered. Anything that is no longer a hold of this request
 * offers nothing.
 */
export function holdWindow(
  event: CalendarEventRecord | undefined,
  requestId: string,
): Interval | undefined {
  if (!event || event.status === 'cancelled') return undefined;
  if (event.extendedProperties?.private?.[SCHEDULING_REQUEST_PROPERTY] !== requestId)
    return undefined;
  if (schedulingRole(event) !== 'hold') return undefined;
  if (!event.start.dateTime || !event.end.dateTime) return undefined;
  const start = Date.parse(event.start.dateTime);
  const end = Date.parse(event.end.dateTime);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : undefined;
}

export interface SlotInput {
  /** Live windows by hold position. */
  windows: { position: number; window: Interval }[];
  busy: Interval[];
  durationMinutes: number;
  now: Date;
  closesAt: Date;
  /** Earliest start relative to now. */
  minimumNoticeMinutes?: number;
}

/**
 * Bookable start times: each window is cut into consecutive slots of the meeting's duration,
 * starting at the window's start; a slot must fit completely, start after the minimum notice, and must not overlap any busy interval, even partially.
 */
export function bookableSlots(input: SlotInput): Slot[] {
  const duration = input.durationMinutes * 60_000;
  if (!(duration > 0)) return [];
  // The deadline closes booking, not the calendar: a meeting may take place after it.
  if (input.now.getTime() >= input.closesAt.getTime()) return [];
  const earliest = input.now.getTime() + (input.minimumNoticeMinutes ?? 60) * 60_000;
  const seen = new Set<number>();
  const slots: Slot[] = [];
  for (const { position, window } of [...input.windows].sort(
    (a, b) => a.window.start - b.window.start,
  )) {
    for (let start = window.start; start + duration <= window.end; start += duration) {
      const slot = { start, end: start + duration };
      if (start < earliest || seen.has(start)) continue;
      if (input.busy.some((busy) => overlaps(busy, slot))) continue;
      seen.add(start);
      slots.push({ start: new Date(start), end: new Date(slot.end), position });
    }
  }
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}
