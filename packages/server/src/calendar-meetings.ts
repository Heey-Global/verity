// Upcoming meetings of the watched calendars and joining one of them
// (docs/live-meeting-calendar.md). The start screen's routes and the Verity assistant both
// go through here, so a meeting the assistant offers or joins follows the same rules as a
// tap on the start screen.
import { calendarEventKey } from '@verity/store';
import { listCalendarEventsInRange } from './google-calendar.js';
import { declinedBySelf } from './scheduling-slots.js';
import { joinableMeeting, meetingLinkFromEvent } from './calendar-meeting-links.js';
import {
  CalendarEventNotFoundError,
  joinCalendarMeeting,
  type CalendarMeetingDeps,
} from './calendar-meeting-watcher.js';

/** How far ahead the start screen lists meetings. */
const UPCOMING_HORIZON_MS = 12 * 60 * 60 * 1000;

type MeetingProvider = 'meet' | 'teams' | 'zoom';

/** One meeting ahead. The link is left out on purpose: it often carries the passcode, and
 *  joining reads it on the server. `provider` is null for a meeting without a call link. */
export interface UpcomingMeeting {
  eventKey: string;
  title: string | null;
  startsAt: number;
  endsAt: number;
  calendar: string;
  provider: MeetingProvider | null;
  decision: string | null;
  meetingId: string | null;
}

/** The calendar could not be read; the message is safe to show. */
export class CalendarUnavailableError extends Error {}

/** A join refused by the join window; the message is safe to show. */
export class CalendarJoinWindowError extends Error {}

function provider(url: string): MeetingProvider {
  const host = new URL(url).hostname;
  return host === 'meet.google.com' ? 'meet' : host.startsWith('teams.') ? 'teams' : 'zoom';
}

/**
 * The meetings of the next hours in the watched calendars, soonest first. Without
 * `includeInPerson` only meetings with a call link are listed, from the watcher's cache;
 * with it the calendars are read live, so meetings without a link appear as well.
 */
export async function listUpcomingMeetings(
  deps: CalendarMeetingDeps,
  options: { includeInPerson: boolean },
): Promise<UpcomingMeeting[]> {
  const at = (deps.now ?? Date.now)();
  const calendars = await deps.store.calendarWatch.list();
  const events = (await deps.store.calendarWatch.listEvents()).filter(
    (event) => event.endsAt > at && event.startsAt < at + UPCOMING_HORIZON_MS,
  );
  let upcoming: UpcomingMeeting[] = events.flatMap((event) => {
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
  });
  if (options.includeInPerson) {
    for (const calendar of calendars) {
      try {
        const token = await deps.googleAccessToken(calendar.accountId);
        if (!token)
          throw new CalendarUnavailableError(
            'Calendar access is unavailable. Reconnect your Google account.',
          );
        const entries = await listCalendarEventsInRange(
          token,
          {
            calendarId: calendar.calendarId,
            timeMin: new Date(at - 15 * 60_000).toISOString(),
            timeMax: new Date(at + UPCOMING_HORIZON_MS).toISOString(),
          },
          deps.fetch,
        );
        // Refresh only the event cache; reading the picker never starts a bot.
        await deps.store.calendarWatch.syncEvents(
          calendar.accountId,
          calendar.calendarId,
          {
            from: at - 15 * 60_000,
            to: at + UPCOMING_HORIZON_MS,
          },
          entries.flatMap((event) => {
            const meeting = joinableMeeting(event);
            return meeting
              ? [
                  {
                    eventId: event.id,
                    title: event.summary ?? null,
                    meetingUrl: meeting.link,
                    startsAt: meeting.start,
                    endsAt: meeting.end,
                    accepted: meeting.accepted,
                  },
                ]
              : [];
          }),
        );
        const cached = (await deps.store.calendarWatch.listEvents()).filter(
          (event) =>
            event.accountId === calendar.accountId && event.calendarId === calendar.calendarId,
        );
        const previousKeys = new Set(
          events
            .filter(
              (event) =>
                event.accountId === calendar.accountId && event.calendarId === calendar.calendarId,
            )
            .map((event) => event.key),
        );
        upcoming = upcoming.filter((event) => !previousKeys.has(event.eventKey));
        for (const event of entries) {
          const startsAt = Date.parse(event.start?.dateTime ?? '');
          const endsAt = Date.parse(event.end?.dateTime ?? '');
          if (
            event.status !== 'confirmed' ||
            declinedBySelf(event) ||
            !Number.isFinite(startsAt) ||
            !Number.isFinite(endsAt) ||
            endsAt <= at ||
            startsAt >= at + UPCOMING_HORIZON_MS
          )
            continue;
          const eventKey = calendarEventKey(calendar.accountId, calendar.calendarId, event.id);
          const link = meetingLinkFromEvent(event);
          const state = cached.find((item) => item.key === eventKey);
          upcoming.push({
            eventKey,
            title: event.summary ?? null,
            startsAt,
            endsAt,
            calendar: calendar.summary,
            provider: link ? provider(link) : null,
            decision: state?.decision ?? null,
            meetingId: state?.meetingId ?? null,
          });
        }
      } catch (error) {
        if (error instanceof CalendarUnavailableError) throw error;
        throw new CalendarUnavailableError(
          'Could not load calendar events. Check calendar access and retry.',
        );
      }
    }
  }
  return upcoming.sort((a, b) => a.startsAt - b.startsAt);
}

/** Whether a listed meeting can be joined now: it has a call link, nobody joined it
 *  yet, and it has not ended. */
export function canJoinNow(meeting: UpcomingMeeting, at: number): boolean {
  return meeting.provider !== null && meeting.meetingId === null && meeting.endsAt > at;
}

/**
 * Sends Verity into a watched calendar's meeting for `sessionId`, including before its scheduled start.
 * Throws {@link CalendarEventNotFoundError}, {@link CalendarJoinWindowError},
 * `CalendarEventAlreadyJoinedError` or the start's own error.
 */
export async function joinWatchedMeeting(
  deps: CalendarMeetingDeps,
  eventKey: string,
  sessionId: string | null,
): Promise<{ meetingId: string }> {
  const now = deps.now ?? Date.now;
  const event = await deps.store.calendarWatch.getEvent(eventKey);
  if (!event) throw new CalendarEventNotFoundError();
  if (event.endsAt <= now()) throw new CalendarJoinWindowError('This meeting has ended.');
  return joinCalendarMeeting(deps, eventKey, sessionId);
}
