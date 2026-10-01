import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calendarChangeSummary } from './calendarChangeSummary.js';

describe('calendarChangeSummary', () => {
  it('makes the event and attendee notifications visible before approval', () => {
    expect(
      calendarChangeSummary({
        action: 'create_event',
        addGoogleMeet: false,
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
        'Google Meet: no video meeting.',
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

it('shows the explicit Meet decision and falls back when it is missing', () => {
  const input = { action: 'create_event', calendarId: 'primary', event: { summary: 'Meeting' } };
  expect(calendarChangeSummary(input)).toBeNull();
  expect(calendarChangeSummary({ ...input, addGoogleMeet: true })?.details).toContain(
    'Google Meet: add a video meeting.',
  );
  expect(calendarChangeSummary({ ...input, addGoogleMeet: false })?.details).toContain(
    'Google Meet: no video meeting.',
  );
});
