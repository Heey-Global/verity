import { describe, expect, it, vi } from 'vitest';
import { googleCalendarRequestSchema, invokeGoogleCalendarApi } from './google-calendar.js';

describe('Google Calendar API', () => {
  it('bounds searches and encodes calendar identifiers', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ id: 'e', summary: 'Meeting', privateMetadata: 'hidden' }],
        nextPageToken: 'next',
      }),
    });
    const request = googleCalendarRequestSchema.parse({
      action: 'list_events',
      calendarId: 'me/a@example.test',
      timeMin: '2026-10-01T00:00:00Z',
      timeMax: '2026-10-02T00:00:00Z',
    });
    expect(await invokeGoogleCalendarApi('token', request, fetch)).toEqual({
      items: [{ id: 'e', summary: 'Meeting' }],
      nextPageToken: 'next',
    });
    const url = new URL(fetch.mock.calls[0]![0] as string);
    expect(url.pathname).toContain('me%2Fa%40example.test');
    expect(url.searchParams.get('maxResults')).toBe('25');
    expect(url.searchParams.get('singleEvents')).toBe('true');
  });
  it('uses conditional updates and rejects stale events without exposing response bodies', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 412,
      json: async () => ({ secret: 'provider body' }),
    });
    const request = googleCalendarRequestSchema.parse({
      action: 'update_event',
      calendarId: 'primary',
      eventId: 'e',
      expectedEtag: '"old"',
      event: { summary: 'Changed' },
      sendUpdates: 'all',
    });
    await expect(invokeGoogleCalendarApi('token', request, fetch)).rejects.toThrow(
      'Calendar event changed',
    );
    expect(
      new URL(fetch.mock.calls[0]![0] as string).searchParams.get('conferenceDataVersion'),
    ).toBe('1');
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      method: 'PATCH',
      headers: { 'If-Match': '"old"' },
      body: '{"summary":"Changed"}',
    });
  });
  it('requires explicit temporal bounds and rejects unrecognized event properties', () => {
    expect(
      googleCalendarRequestSchema.safeParse({ action: 'list_events', calendarId: 'primary' })
        .success,
    ).toBe(false);
    expect(
      googleCalendarRequestSchema.safeParse({
        action: 'update_event',
        calendarId: 'primary',
        eventId: 'e',
        expectedEtag: '"etag"',
        event: { recurrence: [] },
      }).success,
    ).toBe(false);
  });
  it('creates exactly the approved event and forwards notification policy', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ id: 'new', summary: 'Meeting' }) });
    const event = {
      summary: 'Meeting',
      start: { dateTime: '2026-10-01T10:00:00Z' },
      end: { dateTime: '2026-10-01T11:00:00Z' },
      attendees: [{ email: 'guest@example.test' }],
    };
    const request = googleCalendarRequestSchema.parse({
      action: 'create_event',
      addGoogleMeet: false,
      calendarId: 'primary',
      event,
      sendUpdates: 'all',
    });
    expect(await invokeGoogleCalendarApi('token', request, fetch)).toEqual({
      id: 'new',
      summary: 'Meeting',
    });
    expect(fetch.mock.calls[0]![0]).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all',
    );
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'Content-Type': 'application/json' },
    });
  });
  it('deletes only the approved event revision without trying to parse a 204 body', async () => {
    const json = vi.fn();
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204, json });
    const request = googleCalendarRequestSchema.parse({
      action: 'delete_event',
      calendarId: 'primary',
      eventId: 'event/a',
      expectedEtag: '"version"',
      sendUpdates: 'none',
    });
    expect(await invokeGoogleCalendarApi('token', request, fetch)).toEqual({
      deleted: true,
      eventId: 'event/a',
    });
    expect(fetch.mock.calls[0]![0]).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/event%2Fa?sendUpdates=none',
    );
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      method: 'DELETE',
      headers: { 'If-Match': '"version"' },
    });
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty('body');
    expect(json).not.toHaveBeenCalled();
  });
  it('rejects wildcard revisions and invalid create intervals before Google', () => {
    expect(
      googleCalendarRequestSchema.safeParse({
        action: 'delete_event',
        calendarId: 'primary',
        eventId: 'e',
        expectedEtag: '*',
      }).success,
    ).toBe(false);
    const base = { action: 'create_event', addGoogleMeet: false, calendarId: 'primary' };
    for (const event of [
      { summary: 'Meeting', start: { date: '2026-10-02' }, end: { date: '2026-10-01' } },
      {
        summary: 'Meeting',
        start: { date: '2026-10-01' },
        end: { dateTime: '2026-10-02T00:00:00Z' },
      },
      { summary: 'Meeting', start: { date: '2026-02-30' }, end: { date: '2026-03-02' } },
    ])
      expect(googleCalendarRequestSchema.safeParse({ ...base, event }).success).toBe(false);
  });
});

// Missing a Meet decision must never silently create an event without asking.
it('requires an explicit Meet choice and returns the actual conference status and link', async () => {
  const event = { summary: 'Meeting', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } };
  const base = { action: 'create_event', calendarId: 'primary', event };
  expect(googleCalendarRequestSchema.safeParse(base).success).toBe(false);
  const conferenceData = { createRequest: { status: { statusCode: 'pending' } } };
  const fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ id: 'new', conferenceData }) });
  expect(
    await invokeGoogleCalendarApi(
      'token',
      googleCalendarRequestSchema.parse({ ...base, addGoogleMeet: true }),
      fetch,
    ),
  ).toEqual({ id: 'new', conferenceData });
  const url = new URL(fetch.mock.calls[0]![0] as string);
  expect(url.searchParams.get('conferenceDataVersion')).toBe('1');
  const options = fetch.mock.calls[0]![1] as { body: string };
  expect(JSON.parse(options.body)).toEqual({
    ...event,
    conferenceData: {
      createRequest: {
        requestId: expect.any(String),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
  });
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      id: 'new',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      conferenceData: {
        entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }],
      },
    }),
  });
  expect(
    await invokeGoogleCalendarApi(
      'token',
      googleCalendarRequestSchema.parse({
        action: 'read_event',
        calendarId: 'primary',
        eventId: 'new',
      }),
      fetch,
    ),
  ).toMatchObject({ hangoutLink: 'https://meet.google.com/abc-defg-hij' });
});
