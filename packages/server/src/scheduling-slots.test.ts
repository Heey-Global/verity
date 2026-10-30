import { describe, expect, it } from 'vitest';
import type { CalendarEventRecord } from './google-calendar.js';
import {
  bookableSlots,
  busyIntervals,
  holdWindow,
  schedulingMarkers,
  zonedTime,
} from './scheduling-slots.js';

const at = (iso: string) => Date.parse(iso);
const event = (
  id: string,
  start: string,
  end: string,
  extra: Partial<CalendarEventRecord> = {},
): CalendarEventRecord => ({
  id,
  etag: `"${id}"`,
  status: 'confirmed',
  start: { dateTime: start },
  end: { dateTime: end },
  ...extra,
});
const times = (slots: { start: Date }[]) =>
  slots.map((slot) => slot.start.toISOString().slice(11, 16));
const base = {
  busy: [],
  now: new Date('2026-11-01T00:00:00Z'),
  closesAt: new Date('2026-11-06T00:00:00Z'),
};
// Tue 3 Nov 2026, 14:00-16:00 Berlin (UTC+1).
const window = {
  position: 0,
  window: { start: at('2026-11-03T13:00:00Z'), end: at('2026-11-03T15:00:00Z') },
};

describe('bookable slots', () => {
  it.each([
    [20, ['13:00', '13:20', '13:40', '14:00', '14:20', '14:40']],
    [30, ['13:00', '13:30', '14:00', '14:30']],
    [45, ['13:00', '13:45']],
  ])('cuts a two-hour window into %i-minute slots that fit completely', (minutes, expected) => {
    expect(times(bookableSlots({ ...base, windows: [window], durationMinutes: minutes }))).toEqual(
      expected,
    );
  });

  it('drops slots that overlap a busy interval even partially', () => {
    const busy = [{ start: at('2026-11-03T13:45:00Z'), end: at('2026-11-03T14:10:00Z') }];
    expect(times(bookableSlots({ ...base, busy, windows: [window], durationMinutes: 30 }))).toEqual(
      ['13:00', '14:30'],
    );
  });

  it('respects the minimum notice and the closing deadline', () => {
    expect(
      times(
        bookableSlots({
          ...base,
          now: new Date('2026-11-03T12:10:00Z'),
          closesAt: new Date('2026-11-03T14:00:00Z'),
          windows: [window],
          durationMinutes: 30,
        }),
      ),
    ).toEqual(['13:30']);
  });

  it('offers a start once when two windows of the request overlap', () => {
    const second = {
      position: 1,
      window: { start: at('2026-11-03T14:00:00Z'), end: at('2026-11-03T16:00:00Z') },
    };
    const slots = bookableSlots({ ...base, windows: [second, window], durationMinutes: 60 });
    expect(times(slots)).toEqual(['13:00', '14:00', '15:00']);
    expect(slots.map((slot) => slot.position)).toEqual([0, 0, 1]);
  });
});

describe('availability from calendar events', () => {
  it('ignores holds of every request but blocks appointments, including booked ones', () => {
    const events = [
      event('own-hold', '2026-11-03T13:00:00Z', '2026-11-03T15:00:00Z', {
        extendedProperties: { private: schedulingMarkers('r1', 'hold', 0) },
      }),
      event('other-hold', '2026-11-03T13:00:00Z', '2026-11-03T14:00:00Z', {
        extendedProperties: { private: schedulingMarkers('r2', 'hold', 0) },
      }),
      event('booked', '2026-11-03T13:30:00Z', '2026-11-03T14:00:00Z', {
        extendedProperties: { private: schedulingMarkers('r2', 'booked', 0) },
      }),
      event('free', '2026-11-03T14:00:00Z', '2026-11-03T15:00:00Z', {
        transparency: 'transparent',
      }),
      event('declined', '2026-11-03T14:30:00Z', '2026-11-03T15:00:00Z', {
        attendees: [{ email: 'me@example.test', self: true, responseStatus: 'declined' }],
      }),
      event('cancelled', '2026-11-03T13:00:00Z', '2026-11-03T15:00:00Z', { status: 'cancelled' }),
    ];
    expect(busyIntervals(events, 'Europe/Berlin')).toEqual([
      { start: at('2026-11-03T13:30:00Z'), end: at('2026-11-03T14:00:00Z') },
    ]);
  });

  it('blocks busy all-day events for the whole local day', () => {
    const allDay: CalendarEventRecord = {
      id: 'offsite',
      etag: '"o"',
      status: 'confirmed',
      start: { date: '2026-11-03' },
      end: { date: '2026-11-04' },
    };
    expect(busyIntervals([allDay], 'Europe/Berlin')).toEqual([
      { start: at('2026-11-02T23:00:00Z'), end: at('2026-11-03T23:00:00Z') },
    ]);
  });

  it('reads the live window of a hold and nothing once it is no longer this request’s hold', () => {
    const hold = event('h', '2026-11-03T13:30:00Z', '2026-11-03T15:00:00Z', {
      extendedProperties: { private: schedulingMarkers('r1', 'hold', 0) },
    });
    expect(holdWindow(hold, 'r1')).toEqual({
      start: at('2026-11-03T13:30:00Z'),
      end: at('2026-11-03T15:00:00Z'),
    });
    expect(holdWindow(hold, 'r2')).toBeUndefined();
    expect(holdWindow(undefined, 'r1')).toBeUndefined();
    expect(holdWindow({ ...hold, status: 'cancelled' }, 'r1')).toBeUndefined();
    expect(
      holdWindow(
        { ...hold, extendedProperties: { private: schedulingMarkers('r1', 'booked', 0) } },
        'r1',
      ),
    ).toBeUndefined();
  });
});

describe('zoned time', () => {
  it('resolves wall-clock times on both sides of a daylight-saving switch', () => {
    expect(zonedTime('2026-10-24', '14:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-10-24T12:00:00.000Z',
    );
    expect(zonedTime('2026-10-26', '14:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-10-26T13:00:00.000Z',
    );
    expect(zonedTime('2026-11-03', '09:30', 'America/New_York').toISOString()).toBe(
      '2026-11-03T14:30:00.000Z',
    );
  });
});
