import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calendarChangeSummary } from './calendarChangeSummary.js';

describe('calendarChangeSummary', () => {
  it('makes the event and attendee notifications visible before approval', () => {
    expect(
      calendarChangeSummary({
        action: 'create_event',
        calendarId: 'primary',
        sendUpdates: 'all',
        event: {
          summary: 'Team meeting',
          start: { dateTime: '2026-10-02T10:00:00Z' },
          end: { dateTime: '2026-10-02T11:00:00Z' },
          attendees: [{ email: 'team@example.com' }],
        },
      }),
    ).toEqual({
      title: 'Create calendar event?',
      details: [
        'Calendar: primary',
        'summary: Team meeting',
        'start: 2026-10-02T10:00:00Z',
        'end: 2026-10-02T11:00:00Z',
        'Attendees: team@example.com',
        'Google will notify attendees.',
      ],
    });
  });
  it('identifies the exact deletion target', () => {
    expect(
      calendarChangeSummary({ action: 'delete_event', calendarId: 'work', eventId: 'event-1' })
        ?.details,
    ).toContain('Event: event-1');
  });
  it('falls back for reads and malformed mutations', () => {
    expect(calendarChangeSummary({ action: 'list_events', calendarId: 'primary' })).toBeNull();
    expect(
      calendarChangeSummary({ action: 'update_event', calendarId: 'primary', event: {} }),
    ).toBeNull();
  });
});

// A renamed server tool can silently leave approvals with raw JSON instead of the calendar preview.
it('recognizes the registered Calendar tool in the session approval card', () => {
  const gateway = readFileSync(
    new URL('../../../server/src/mcp-gateway.ts', import.meta.url),
    'utf8',
  );
  const registeredName = gateway.match(/(\w+): googleCalendarRequestSchema/)?.[1];
  expect(registeredName).toBeDefined();
  const screen = readFileSync(
    new URL('../../../../apps/mobile/app/session/[id].tsx', import.meta.url),
    'utf8',
  );
  const calendarTool = screen.match(/const isCalendar = pending\.tool === '([^']+)'/)?.[1];
  expect(calendarTool).toBe(registeredName);
});
