import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { GoogleFetch, GoogleHttpResponse } from './google-drive.js';

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
      'transparency',
      'extendedProperties',
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

/** Event fields the scheduling service reads; everything else is dropped. */
export interface CalendarEventRecord {
  id: string;
  etag: string;
  status: string;
  summary?: string;
  description?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  transparency?: string;
  attendees?: { email: string; responseStatus?: string; self?: boolean; organizer?: boolean }[];
  extendedProperties?: { private?: Record<string, string> };
  hangoutLink?: string;
  htmlLink?: string;
}

/** The writable part of an event the scheduling service creates or patches. */
export interface CalendarEventWrite {
  /** Client-chosen id (base32hex); makes a retried create fail with 409 instead of duplicating. */
  id?: string;
  summary?: string;
  description?: string;
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
  transparency?: 'opaque' | 'transparent';
  attendees?: { email: string }[];
  extendedProperties?: { private: Record<string, string> };
  reminders?: { useDefault: boolean };
}

export class GoogleCalendarHttpError extends Error {
  constructor(readonly status: number) {
    super(`Calendar request failed (HTTP ${String(status)})`);
    this.name = 'GoogleCalendarHttpError';
  }
}

function eventRecord(value: unknown): CalendarEventRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const event = value as Record<string, unknown>;
  if (typeof event.id !== 'string' || typeof event.etag !== 'string') return undefined;
  const time = (raw: unknown) => {
    const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    return {
      ...(typeof t.dateTime === 'string' ? { dateTime: t.dateTime } : {}),
      ...(typeof t.date === 'string' ? { date: t.date } : {}),
      ...(typeof t.timeZone === 'string' ? { timeZone: t.timeZone } : {}),
    };
  };
  const privateProperties = (event.extendedProperties as { private?: unknown } | undefined)
    ?.private;
  return {
    id: event.id,
    etag: event.etag,
    status: typeof event.status === 'string' ? event.status : 'confirmed',
    ...(typeof event.summary === 'string' ? { summary: event.summary } : {}),
    ...(typeof event.description === 'string' ? { description: event.description } : {}),
    start: time(event.start),
    end: time(event.end),
    ...(typeof event.transparency === 'string' ? { transparency: event.transparency } : {}),
    ...(Array.isArray(event.attendees)
      ? {
          attendees: event.attendees.flatMap((raw: unknown) => {
            const a = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
              string,
              unknown
            >;
            if (typeof a.email !== 'string') return [];
            return [
              {
                email: a.email,
                ...(typeof a.responseStatus === 'string'
                  ? { responseStatus: a.responseStatus }
                  : {}),
                ...(a.self === true ? { self: true } : {}),
                ...(a.organizer === true ? { organizer: true } : {}),
              },
            ];
          }),
        }
      : {}),
    ...(typeof privateProperties === 'object' && privateProperties !== null
      ? {
          extendedProperties: {
            private: Object.fromEntries(
              Object.entries(privateProperties).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            ),
          },
        }
      : {}),
    ...(typeof event.hangoutLink === 'string' ? { hangoutLink: event.hangoutLink } : {}),
    ...(typeof event.htmlLink === 'string' ? { htmlLink: event.htmlLink } : {}),
  };
}

function eventsPath(calendarId: string, eventId?: string): string {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${
    eventId === undefined ? '' : `/${encodeURIComponent(eventId)}`
  }`;
}

async function calendarFetch(
  doFetch: GoogleFetch,
  token: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<GoogleHttpResponse> {
  return doFetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
    signal: AbortSignal.timeout(20_000),
  });
}

const MAX_EVENT_PAGES = 10;

/**
 * Every single event of a calendar overlapping [timeMin, timeMax), following pagination up
 * to a fixed bound. Availability is computed from this list, so a truncated result must not
 * pass silently as "free": exceeding the bound throws.
 */
export async function listCalendarEventsInRange(
  token: string,
  input: {
    calendarId: string;
    timeMin: string;
    timeMax: string;
    privateExtendedProperty?: string;
  },
  doFetch: GoogleFetch = fetch,
): Promise<CalendarEventRecord[]> {
  const events: CalendarEventRecord[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const params = new URLSearchParams({
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    });
    if (input.privateExtendedProperty)
      params.set('privateExtendedProperty', input.privateExtendedProperty);
    if (pageToken) params.set('pageToken', pageToken);
    const response = await calendarFetch(
      doFetch,
      token,
      `${eventsPath(input.calendarId)}?${params.toString()}`,
    );
    if (response.status < 200 || response.status >= 300)
      throw new GoogleCalendarHttpError(response.status);
    const body = (await response.json()) as { items?: unknown; nextPageToken?: unknown };
    if (Array.isArray(body.items))
      for (const item of body.items) {
        const event = eventRecord(item);
        if (event) events.push(event);
      }
    if (typeof body.nextPageToken !== 'string') return events;
    pageToken = body.nextPageToken;
  }
  throw new Error('Calendar has too many events in this range to check availability');
}

/** One event, or undefined when it no longer exists. */
export async function readCalendarEvent(
  token: string,
  input: { calendarId: string; eventId: string },
  doFetch: GoogleFetch = fetch,
): Promise<CalendarEventRecord | undefined> {
  const response = await calendarFetch(doFetch, token, eventsPath(input.calendarId, input.eventId));
  if (response.status === 404 || response.status === 410) return undefined;
  if (response.status < 200 || response.status >= 300)
    throw new GoogleCalendarHttpError(response.status);
  return eventRecord(await response.json());
}

function conferenceRequest(requestId: string) {
  return { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
}

/**
 * Create an event. `meetRequestId` makes the Meet request idempotent: Google answers a
 * repeated create request with the same id with the same conference.
 */
export async function insertCalendarEvent(
  token: string,
  input: {
    calendarId: string;
    event: CalendarEventWrite & Required<Pick<CalendarEventWrite, 'summary' | 'start' | 'end'>>;
    sendUpdates: 'all' | 'none';
    meetRequestId?: string;
  },
  doFetch: GoogleFetch = fetch,
): Promise<CalendarEventRecord> {
  const params = new URLSearchParams({ sendUpdates: input.sendUpdates });
  if (input.meetRequestId) params.set('conferenceDataVersion', '1');
  const response = await calendarFetch(
    doFetch,
    token,
    `${eventsPath(input.calendarId)}?${params.toString()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...input.event,
        ...(input.meetRequestId ? { conferenceData: conferenceRequest(input.meetRequestId) } : {}),
      }),
    },
  );
  if (response.status < 200 || response.status >= 300)
    throw new GoogleCalendarHttpError(response.status);
  const event = eventRecord(await response.json());
  if (!event) throw new Error('Calendar returned an unreadable event');
  return event;
}

/**
 * Patch an event under `If-Match`. A 412 is returned as `conflict` so callers re-read the
 * live event instead of overwriting a change made in the calendar meanwhile.
 */
export async function patchCalendarEvent(
  token: string,
  input: {
    calendarId: string;
    eventId: string;
    expectedEtag: string;
    event: CalendarEventWrite;
    sendUpdates: 'all' | 'none';
    meetRequestId?: string;
  },
  doFetch: GoogleFetch = fetch,
): Promise<{ status: 'patched'; event: CalendarEventRecord } | { status: 'conflict' | 'missing' }> {
  const params = new URLSearchParams({
    sendUpdates: input.sendUpdates,
    conferenceDataVersion: '1',
  });
  const response = await calendarFetch(
    doFetch,
    token,
    `${eventsPath(input.calendarId, input.eventId)}?${params.toString()}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': input.expectedEtag },
      body: JSON.stringify({
        ...input.event,
        ...(input.meetRequestId ? { conferenceData: conferenceRequest(input.meetRequestId) } : {}),
      }),
    },
  );
  if (response.status === 412) return { status: 'conflict' };
  if (response.status === 404 || response.status === 410) return { status: 'missing' };
  if (response.status < 200 || response.status >= 300)
    throw new GoogleCalendarHttpError(response.status);
  const event = eventRecord(await response.json());
  if (!event) throw new Error('Calendar returned an unreadable event');
  return { status: 'patched', event };
}

/** Delete an event; an event that is already gone counts as deleted. */
export async function deleteCalendarEvent(
  token: string,
  input: { calendarId: string; eventId: string; sendUpdates: 'all' | 'none' },
  doFetch: GoogleFetch = fetch,
): Promise<void> {
  const params = new URLSearchParams({ sendUpdates: input.sendUpdates });
  const response = await calendarFetch(
    doFetch,
    token,
    `${eventsPath(input.calendarId, input.eventId)}?${params.toString()}`,
    { method: 'DELETE' },
  );
  if (response.status === 404 || response.status === 410) return;
  if (response.status < 200 || response.status >= 300)
    throw new GoogleCalendarHttpError(response.status);
}
