// Joining and skipping meetings found in watched calendars (docs/live-meeting-calendar.md).
// The routes stay administrator routes: the calendars belong to the server's Google accounts,
// and a meeting joined without a session is unassigned, which only administrators see.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OnlineMeetingStartError } from './attendee-meetings.js';
import {
  CalendarJoinWindowError,
  CalendarUnavailableError,
  joinWatchedMeeting,
  listUpcomingMeetings,
} from './calendar-meetings.js';
import {
  CalendarEventAlreadyJoinedError,
  CalendarEventNotFoundError,
  type CalendarMeetingDeps,
} from './calendar-meeting-watcher.js';

const eventParams = z.object({ eventKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u) });
const joinBody = z
  .object({ sessionId: z.string().min(1).max(200).optional() })
  .strict()
  .nullish();

export function registerCalendarMeetingRoutes(
  app: FastifyInstance,
  deps: CalendarMeetingDeps,
): void {
  // The meeting link is left out on purpose: it often carries the passcode, and joining goes
  // through the join route, which reads it on the server.
  app.get('/live-meetings/upcoming', async (request, reply) => {
    const { includeInPerson } = z
      .object({ includeInPerson: z.enum(['true', 'false']).optional() })
      .parse(request.query);
    try {
      return {
        upcoming: await listUpcomingMeetings(deps, {
          includeInPerson: includeInPerson === 'true',
        }),
      };
    } catch (error) {
      if (error instanceof CalendarUnavailableError)
        return reply.code(503).send({ error: error.message });
      throw error;
    }
  });

  app.post('/live-meetings/calendar/:eventKey/join', async (request, reply) => {
    const { eventKey } = eventParams.parse(request.params);
    const body = joinBody.parse(request.body);
    if (!(await deps.store.calendarWatch.getEvent(eventKey)))
      return reply.code(404).send({ error: new CalendarEventNotFoundError().message });
    if (body?.sessionId && !(await deps.store.getSession(body.sessionId)))
      return reply.code(404).send({ error: 'Session not found.' });
    try {
      return await joinWatchedMeeting(deps, eventKey, body?.sessionId ?? null);
    } catch (error) {
      if (error instanceof CalendarEventNotFoundError)
        return reply.code(404).send({ error: error.message });
      if (error instanceof CalendarJoinWindowError)
        return reply.code(409).send({ error: error.message });
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
