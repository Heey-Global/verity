import { describe, expect, it } from 'vitest';
import { joinableMeeting, meetingLinkFromEvent } from './calendar-meeting-links.js';
import type { CalendarEventRecord } from './google-calendar.js';

const event = (fields: Partial<CalendarEventRecord> = {}): CalendarEventRecord => ({
  id: 'event-1',
  etag: '"1"',
  status: 'confirmed',
  start: { dateTime: '2026-11-02T09:00:00Z' },
  end: { dateTime: '2026-11-02T09:30:00Z' },
  ...fields,
});

describe('meetingLinkFromEvent', () => {
  it('prefers the Meet link over links further down the event', () => {
    expect(
      meetingLinkFromEvent(
        event({
          hangoutLink: 'https://meet.google.com/abc-defg-hij',
          description: 'https://zoom.us/j/1',
        }),
      ),
    ).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('takes the video entry point before a phone entry point', () => {
    expect(
      meetingLinkFromEvent(
        event({
          conferenceData: {
            entryPoints: [
              { entryPointType: 'phone', uri: 'tel:+49-30-1234' },
              { entryPointType: 'video', uri: 'https://acme.zoom.us/j/123?pwd=x' },
            ],
          },
        }),
      ),
    ).toBe('https://acme.zoom.us/j/123?pwd=x');
  });

  it('finds a Teams link in an HTML description and decodes its query', () => {
    expect(
      meetingLinkFromEvent(
        event({
          description:
            '<a href="https://teams.microsoft.com/l/meetup-join/19%3a?context=1&amp;tenant=2">Join</a>',
        }),
      ),
    ).toBe('https://teams.microsoft.com/l/meetup-join/19%3a?context=1&tenant=2');
  });

  it('reads the location field', () => {
    expect(meetingLinkFromEvent(event({ location: 'Online: https://zoom.us/j/9 (Zoom)' }))).toBe(
      'https://zoom.us/j/9',
    );
  });

  // A lookalike host or plain HTTP must never hand the bot a link outside the allowlist.
  it.each([
    'https://meet.google.com.evil.example/abc',
    'http://meet.google.com/abc',
    'https://user:pw@zoom.us/j/1',
    'https://evilzoom.us/j/1',
    'https://example.com/?next=https://zoom.us/j/1',
  ])('ignores %s', (link) => {
    expect(meetingLinkFromEvent(event({ location: link, description: link }))).toBeUndefined();
  });
});

describe('joinableMeeting', () => {
  const linked = { hangoutLink: 'https://meet.google.com/abc-defg-hij' };

  it('returns link and times of a confirmed, timed meeting', () => {
    expect(joinableMeeting(event(linked))).toEqual({
      link: 'https://meet.google.com/abc-defg-hij',
      start: Date.parse('2026-11-02T09:00:00Z'),
      end: Date.parse('2026-11-02T09:30:00Z'),
    });
  });

  it.each([
    ['tentative', { status: 'tentative' }],
    ['cancelled', { status: 'cancelled' }],
    ['all-day', { start: { date: '2026-11-02' }, end: { date: '2026-11-03' } }],
    [
      'declined by the owner',
      { attendees: [{ email: 'me@example.com', self: true, responseStatus: 'declined' }] },
    ],
  ] satisfies [string, Partial<CalendarEventRecord>][])('skips a %s event', (_, fields) => {
    expect(joinableMeeting(event({ ...linked, ...fields }))).toBeUndefined();
  });

  it('skips an event without a link', () => {
    expect(joinableMeeting(event())).toBeUndefined();
  });

  it('keeps an event someone else declined', () => {
    expect(
      joinableMeeting(
        event({
          ...linked,
          attendees: [
            { email: 'me@example.com', self: true, responseStatus: 'accepted' },
            { email: 'other@example.com', responseStatus: 'declined' },
          ],
        }),
      ),
    ).toBeDefined();
  });
});
