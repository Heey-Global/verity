import { describe, expect, it, vi } from 'vitest';
import {
  deleteCalendarEvent,
  googleCalendarRequestSchema,
  insertCalendarEvent,
  invokeGoogleCalendarApi,
  listCalendarEventsInRange,
  patchCalendarEvent,
  readCalendarEvent,
} from './google-calendar.js';

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

describe('Google Calendar scheduling helpers', () => {
  const response = (status: number, body: unknown = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  });

  it('follows pagination and keeps the hold markers availability depends on', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          items: [
            {
              id: 'hold',
              etag: '"1"',
              start: { dateTime: '2026-11-03T14:00:00+01:00' },
              end: { dateTime: '2026-11-03T16:00:00+01:00' },
              extendedProperties: { private: { verityScheduling: 'r1', ignored: 3 } },
              attendees: [{ email: 'me@example.test', self: true, responseStatus: 'accepted' }],
              privateMetadata: 'dropped',
            },
          ],
          nextPageToken: 'p2',
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          items: [
            {
              id: 'all-day',
              etag: '"2"',
              start: { date: '2026-11-04' },
              end: { date: '2026-11-05' },
              transparency: 'transparent',
            },
          ],
        }),
      );
    const events = await listCalendarEventsInRange(
      'token',
      { calendarId: 'primary', timeMin: '2026-11-03T00:00:00Z', timeMax: '2026-11-05T00:00:00Z' },
      fetch,
    );
    expect(events).toEqual([
      {
        id: 'hold',
        etag: '"1"',
        status: 'confirmed',
        start: { dateTime: '2026-11-03T14:00:00+01:00' },
        end: { dateTime: '2026-11-03T16:00:00+01:00' },
        attendees: [{ email: 'me@example.test', self: true, responseStatus: 'accepted' }],
        extendedProperties: { private: { verityScheduling: 'r1' } },
      },
      {
        id: 'all-day',
        etag: '"2"',
        status: 'confirmed',
        start: { date: '2026-11-04' },
        end: { date: '2026-11-05' },
        transparency: 'transparent',
      },
    ]);
    expect(new URL(fetch.mock.calls[1]![0] as string).searchParams.get('pageToken')).toBe('p2');
  });

  it('refuses to report availability from a truncated event list', async () => {
    const fetch = vi.fn().mockResolvedValue(response(200, { items: [], nextPageToken: 'more' }));
    await expect(
      listCalendarEventsInRange(
        'token',
        { calendarId: 'primary', timeMin: '2026-11-03T00:00:00Z', timeMax: '2026-11-04T00:00:00Z' },
        fetch,
      ),
    ).rejects.toThrow('too many events');
  });

  it('treats a vanished event as missing rather than as an error', async () => {
    const fetch = vi.fn().mockResolvedValue(response(410));
    expect(await readCalendarEvent('token', { calendarId: 'primary', eventId: 'e' }, fetch)).toBe(
      undefined,
    );
    await expect(
      deleteCalendarEvent(
        'token',
        { calendarId: 'primary', eventId: 'e', sendUpdates: 'all' },
        fetch,
      ),
    ).resolves.toBeUndefined();
  });

  it('patches conditionally and adds Meet with a stable request id', async () => {
    const fetch = vi.fn().mockResolvedValue(response(412));
    expect(
      await patchCalendarEvent(
        'token',
        {
          calendarId: 'primary',
          eventId: 'hold',
          expectedEtag: '"1"',
          event: { summary: 'Intro call' },
          sendUpdates: 'all',
          meetRequestId: 'booking-r1',
        },
        fetch,
      ),
    ).toEqual({ status: 'conflict' });
    const [url, init] = fetch.mock.calls[0]! as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(new URL(url).searchParams.get('conferenceDataVersion')).toBe('1');
    expect(new URL(url).searchParams.get('sendUpdates')).toBe('all');
    expect(init.headers['If-Match']).toBe('"1"');
    expect(JSON.parse(init.body)).toEqual({
      summary: 'Intro call',
      conferenceData: {
        createRequest: { requestId: 'booking-r1', conferenceSolutionKey: { type: 'hangoutsMeet' } },
      },
    });
  });

  it('writes private markers when creating holds', async () => {
    const fetch = vi.fn().mockResolvedValue(
      response(200, {
        id: 'hold',
        etag: '"1"',
        start: { dateTime: '2026-11-03T13:00:00Z' },
        end: { dateTime: '2026-11-03T15:00:00Z' },
        extendedProperties: { private: { verityScheduling: 'r1' } },
      }),
    );
    const event = await insertCalendarEvent(
      'token',
      {
        calendarId: 'primary',
        event: {
          summary: 'Hold',
          start: { dateTime: '2026-11-03T13:00:00Z' },
          end: { dateTime: '2026-11-03T15:00:00Z' },
          extendedProperties: { private: { verityScheduling: 'r1' } },
        },
        sendUpdates: 'all',
      },
      fetch,
    );
    expect(event.extendedProperties).toEqual({ private: { verityScheduling: 'r1' } });
    const [url, init] = fetch.mock.calls[0]! as [string, { method: string; body: string }];
    expect(init.method).toBe('POST');
    expect(new URL(url).searchParams.has('conferenceDataVersion')).toBe(false);
    expect(JSON.parse(init.body).extendedProperties).toEqual({
      private: { verityScheduling: 'r1' },
    });
  });
});
