// Joining and skipping meetings found in watched calendars (docs/live-meeting-calendar.md).
// The routes stay administrator routes: the calendars belong to the server's Google accounts,
// and a meeting joined without a session is unassigned, which only administrators see.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OnlineMeetingStartError } from './attendee-meetings.js';
import {
  CalendarEventAlreadyJoinedError,
  CalendarEventNotFoundError,
  joinCalendarMeeting,
  type CalendarMeetingDeps,
} from './calendar-meeting-watcher.js';

/** How far ahead the start screen lists meetings. */
export const UPCOMING_HORIZON_MS = 12 * 60 * 60 * 1000;
/** How early a meeting can be joined; a bot sent hours ahead would only wait in the lobby. */
export const JOIN_EARLY_MS = 15 * 60 * 1000;

const eventParams = z.object({ eventKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u) });
const joinBody = z
  .object({ sessionId: z.string().min(1).max(200).optional() })
  .strict()
  .nullish();

function provider(url: string): 'meet' | 'teams' | 'zoom' {
  const host = new URL(url).hostname;
  return host === 'meet.google.com' ? 'meet' : host.startsWith('teams.') ? 'teams' : 'zoom';
}

export function registerCalendarMeetingRoutes(
  app: FastifyInstance,
  deps: CalendarMeetingDeps,
): void {
  const now = deps.now ?? Date.now;

  // The meeting link is left out on purpose: it often carries the passcode, and joining goes
  // through the join route, which reads it on the server.
  app.get('/live-meetings/upcoming', async () => {
    const at = now();
    const calendars = await deps.store.calendarWatch.list();
    const events = (await deps.store.calendarWatch.listEvents()).filter(
      (event) => event.endsAt > at && event.startsAt < at + UPCOMING_HORIZON_MS,
    );
    return {
      upcoming: events.flatMap((event) => {
        const calendar = calendars.find(
          (item) => item.accountId === event.accountId && item.calendarId === event.calendarId,
        );
        if (!calendar) return [];
        return [
          {
            eventKey: event.key,
            title: event.title,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            calendar: calendar.summary,
            provider: provider(event.meetingUrl),
            decision: event.decision,
            meetingId: event.meetingId,
          },
        ];
      }),
    };
  });

  app.post('/live-meetings/calendar/:eventKey/join', async (request, reply) => {
    const { eventKey } = eventParams.parse(request.params);
    const body = joinBody.parse(request.body);
    const event = await deps.store.calendarWatch.getEvent(eventKey);
    if (!event) return reply.code(404).send({ error: new CalendarEventNotFoundError().message });
    if (event.endsAt <= now()) return reply.code(409).send({ error: 'This meeting has ended.' });
    if (event.startsAt - now() > JOIN_EARLY_MS)
      return reply
        .code(409)
        .send({ error: 'This meeting starts later. Join it shortly before it begins.' });
    if (body?.sessionId && !(await deps.store.getSession(body.sessionId)))
      return reply.code(404).send({ error: 'Session not found.' });
    try {
      return await joinCalendarMeeting(deps, eventKey, body?.sessionId ?? null);
    } catch (error) {
      if (error instanceof CalendarEventNotFoundError)
        return reply.code(404).send({ error: error.message });
      if (error instanceof CalendarEventAlreadyJoinedError)
        return reply.code(409).send({
          error: error.message,
          meetingId: (await deps.store.calendarWatch.getEvent(eventKey))?.meetingId ?? null,
        });
      if (error instanceof OnlineMeetingStartError)
        return reply.code(503).send({ error: error.message });
      throw error;
    }
  });

  app.post('/live-meetings/calendar/:eventKey/skip', async (request, reply) => {
    const { eventKey } = eventParams.parse(request.params);
    if (!(await deps.store.calendarWatch.getEvent(eventKey)))
      return reply.code(404).send({ error: new CalendarEventNotFoundError().message });
    if (!(await deps.store.calendarWatch.skip(eventKey)))
      return reply.code(409).send({ error: new CalendarEventAlreadyJoinedError().message });
    return { skipped: true };
  });
}
