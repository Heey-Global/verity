import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { GoogleFetch } from './google-drive.js';

const eventTimeSchema = z.union([
  z.object({ date: z.string().date() }).strict(),
  z
    .object({
      dateTime: z.string().datetime({ offset: true }),
      timeZone: z.string().min(1).optional(),
    })
    .strict(),
]);
const calendarEventSchema = z
  .object({
    summary: z.string().min(1).max(1024).optional(),
    description: z.string().max(100_000).optional(),
    location: z.string().max(4096).optional(),
    start: eventTimeSchema.optional(),
    end: eventTimeSchema.optional(),
    attendees: z
      .array(z.object({ email: z.string().email() }).strict())
      .max(100)
      .optional(),
  })
  .strict();
const calendarId = z.string().min(1).max(1024);
const sendUpdates = z.enum(['all', 'none']).default('none');
export const googleCalendarRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list_calendars'),
      pageToken: z.string().max(4096).optional(),
      maxResults: z.number().int().min(1).max(100).default(25),
    })
    .strict(),
  z
    .object({
      action: z.literal('list_events'),
      calendarId,
      timeMin: z.string().datetime({ offset: true }),
      timeMax: z.string().datetime({ offset: true }),
      query: z.string().max(1024).optional(),
      pageToken: z.string().max(4096).optional(),
      maxResults: z.number().int().min(1).max(100).default(25),
    })
    .strict(),
  z.object({ action: z.literal('read_event'), calendarId, eventId: calendarId }).strict(),
  z
    .object({
      action: z.literal('create_event'),
      addGoogleMeet: z
        .boolean()
        .describe(
          'Ask the user whether to add Google Meet before creating every event. Use their explicit answer; never assume a default.',
        ),
      calendarId,
      event: calendarEventSchema
        .required({ summary: true, start: true, end: true })
        .refine((event) => {
          if ('date' in event.start && 'date' in event.end)
            return event.end.date > event.start.date;
          if ('dateTime' in event.start && 'dateTime' in event.end)
            return Date.parse(event.end.dateTime) > Date.parse(event.start.dateTime);
          return false;
        }, 'Event start and end must use matching date types and end must be after start'),
      sendUpdates,
    })
    .strict(),
  z
    .object({
      action: z.literal('update_event'),
      calendarId,
      eventId: calendarId,
      expectedEtag: z
        .string()
        .min(3)
        .max(1024)
        .regex(/^"[^"\r\n]+"$/),
      event: calendarEventSchema.refine(
        (event) => Object.keys(event).length > 0,
        'At least one event field is required',
      ),
      sendUpdates,
    })
    .strict(),
  z
    .object({
      action: z.literal('delete_event'),
      calendarId,
      eventId: calendarId,
      expectedEtag: z
        .string()
        .min(3)
        .max(1024)
        .regex(/^"[^"\r\n]+"$/),
      sendUpdates,
    })
    .strict(),
]);
export type GoogleCalendarRequest = z.infer<typeof googleCalendarRequestSchema>;

/** Return bounded event fields, excluding arbitrary provider metadata. */
function eventResult(value: unknown): unknown {
  const event = value as Record<string, unknown>;
  return Object.fromEntries(
    [
      'id',
      'etag',
      'status',
      'htmlLink',
      'hangoutLink',
      'conferenceData',
      'summary',
      'description',
      'location',
      'start',
      'end',
      'attendees',
      'organizer',
      'recurringEventId',
    ]
      .filter((key) => event[key] !== undefined)
      .map((key) => [key, event[key]]),
  );
}
export async function invokeGoogleCalendarApi(
  token: string,
  request: GoogleCalendarRequest,
  doFetch: GoogleFetch = fetch,
): Promise<unknown> {
  const params = new URLSearchParams();
  let path: string;
  let method = 'GET';
  let body: string | undefined;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (request.action === 'list_calendars') {
    path = '/users/me/calendarList';
    params.set('maxResults', String(request.maxResults));
    if (request.pageToken) params.set('pageToken', request.pageToken);
  } else {
    path = `/calendars/${encodeURIComponent(request.calendarId)}/events`;
    if (request.action === 'list_events') {
      if (Date.parse(request.timeMax) <= Date.parse(request.timeMin))
        throw new Error('Calendar timeMax must be after timeMin');
      params.set('timeMin', request.timeMin);
      params.set('timeMax', request.timeMax);
      params.set('singleEvents', 'true');
      params.set('orderBy', 'startTime');
      params.set('maxResults', String(request.maxResults));
      if (request.query) params.set('q', request.query);
      if (request.pageToken) params.set('pageToken', request.pageToken);
    } else {
      if (request.action !== 'create_event') path += `/${encodeURIComponent(request.eventId)}`;
      if (request.action !== 'read_event') {
        method =
          request.action === 'create_event'
            ? 'POST'
            : request.action === 'update_event'
              ? 'PATCH'
              : 'DELETE';
        params.set('sendUpdates', request.sendUpdates);
        if (request.action === 'update_event') params.set('conferenceDataVersion', '1');
        if (request.action !== 'create_event') headers['If-Match'] = request.expectedEtag;
        if (request.action !== 'delete_event') {
          const event = { ...request.event };
          if (request.action === 'create_event' && request.addGoogleMeet) {
            params.set('conferenceDataVersion', '1');
            body = JSON.stringify({
              ...event,
              conferenceData: {
                createRequest: {
                  requestId: randomUUID(),
                  conferenceSolutionKey: { type: 'hangoutsMeet' },
                },
              },
            });
          } else {
            body = JSON.stringify(event);
          }
          headers['Content-Type'] = 'application/json';
        }
      }
    }
  }
  const response = await doFetch(
    `https://www.googleapis.com/calendar/v3${path}${params.size ? `?${params.toString()}` : ''}`,
    {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok)
    throw new Error(
      response.status === 412
        ? 'Calendar event changed; read it again before requesting approval'
        : `Calendar request failed (HTTP ${String(response.status)})`,
    );
  if (request.action === 'delete_event') return { deleted: true, eventId: request.eventId };
  const result = (await response.json()) as Record<string, unknown>;
  if (request.action === 'list_events' || request.action === 'list_calendars') {
    return {
      items: Array.isArray(result.items)
        ? result.items.map((item: unknown) =>
            request.action === 'list_events'
              ? eventResult(item)
              : Object.fromEntries(
                  ['id', 'summary', 'timeZone', 'accessRole', 'primary']
                    .filter((key) => (item as Record<string, unknown>)[key] !== undefined)
                    .map((key) => [key, (item as Record<string, unknown>)[key]]),
                ),
          )
        : [],
      ...(typeof result.nextPageToken === 'string' ? { nextPageToken: result.nextPageToken } : {}),
    };
  }
  return eventResult(result);
}
