// Watches the chosen Google calendars for online meetings (docs/live-meeting-calendar.md).
// Five minutes before a joinable meeting it asks every administrator whether Verity should
// join; for a calendar set to join automatically it joins at the start time instead. Meetings
// joined this way start unassigned: a calendar carries no project. Durable markers in
// calendar_watch_events keep a restart from repeating a notification or joining twice.
import type { CalendarWatchEvent, EventStore } from '@verity/store';
import type { AttendeeMeetings } from './attendee-meetings.js';
import { joinableMeeting } from './calendar-meeting-links.js';
import { listCalendarEventsInRange } from './google-calendar.js';
import type { GoogleFetch } from './google-drive.js';
import type { PushNotification, PushSender } from './push-sender.js';

const MINUTE_MS = 60_000;
export const CALENDAR_WATCH_INTERVAL_MS = MINUTE_MS;
/** Events are read from shortly before now, so a meeting that just started is still offered. */
const LOOK_BACK_MS = 15 * MINUTE_MS;
const LOOK_AHEAD_MS = 24 * 60 * MINUTE_MS;
export const UPCOMING_NOTICE_MS = 5 * MINUTE_MS;
/** Past this point after the start, a meeting is no longer announced or joined on its own. */
export const LATE_JOIN_MS = 10 * MINUTE_MS;

export const MEETING_UPCOMING_CATEGORY = 'MEETING_UPCOMING';
export const MEETING_STARTED_CATEGORY = 'MEETING_STARTED';

export class CalendarEventAlreadyJoinedError extends Error {
  constructor() {
    super('Verity already joined this meeting.');
    this.name = 'CalendarEventAlreadyJoinedError';
  }
}

export class CalendarEventNotFoundError extends Error {
  constructor() {
    super('This calendar meeting is no longer available.');
    this.name = 'CalendarEventNotFoundError';
  }
}

export interface CalendarMeetingDeps {
  store: Pick<
    EventStore,
    'calendarWatch' | 'listActiveAdministratorIds' | 'listDevicePushTokensForUsers' | 'getSession'
  >;
  meetings: Pick<AttendeeMeetings, 'start' | 'runningFor'>;
  sender?: Pick<PushSender, 'send'> | undefined;
  googleAccessToken: (accountId?: string) => Promise<string | undefined>;
  fetch?: GoogleFetch;
  warn: (obj: unknown, msg?: string) => void;
  now?: () => number;
}

/** Sends to every active administrator's devices. True when the notification is settled:
 * delivered, or nobody could receive it. A transport failure leaves it for the next pass. */
async function notifyAdministrators(
  deps: CalendarMeetingDeps,
  notification: PushNotification,
): Promise<boolean> {
  if (!deps.sender) return true;
  const targets = await deps.store.listDevicePushTokensForUsers(
    await deps.store.listActiveAdministratorIds(),
  );
  if (targets.length === 0) return true;
  const result = await deps.sender.send(notification, targets);
  return result.ticketsAccepted > 0 || result.transportErrors === 0;
}

const titleOf = (event: Pick<CalendarWatchEvent, 'title'>) => event.title?.trim() || 'Meeting';

/**
 * Joins a calendar meeting: into `sessionId` when started from a session's meeting screen,
 * otherwise unassigned, which is announced with Open / Discard.
 */
export async function joinCalendarMeeting(
  deps: CalendarMeetingDeps,
  key: string,
  sessionId: string | null,
  options: { automatic?: boolean } = {},
): Promise<{ meetingId: string }> {
  const watch = deps.store.calendarWatch;
  const event = await watch.getEvent(key);
  if (!event) throw new CalendarEventNotFoundError();
  if (!(await watch.claimJoin(key, { automatic: options.automatic === true })))
    throw new CalendarEventAlreadyJoinedError();
  let meetingId: string;
  try {
    // The same call in a second watched calendar, or again after watching was switched off
    // and on, already has a bot; a second one would transcribe it twice.
    const running = await deps.meetings.runningFor(event.meetingUrl);
    if (running !== undefined) {
      await watch.setJoinResult(key, { meetingId: running });
      if (options.automatic) return { meetingId: running };
      throw new CalendarEventAlreadyJoinedError();
    }
    ({ meetingId } = await deps.meetings.start(sessionId, event.meetingUrl, true, titleOf(event)));
  } catch (error) {
    if (error instanceof CalendarEventAlreadyJoinedError) throw error;
    // An automatic join is not retried behind the operator's back; a join someone asked for
    // gives the meeting back, so the next tap or the scheduled join can try again.
    if (options.automatic) await watch.setJoinResult(key, { failed: true });
    else await watch.releaseJoin(key);
    throw error;
  }
  await watch.setJoinResult(key, { meetingId });
  if (sessionId === null) {
    try {
      const sent = await notifyAdministrators(deps, {
        title: `Verity joined ${titleOf(event)}`,
        body: "Not in a project yet. Assign it to see the transcript and Verity's help.",
        categoryId: MEETING_STARTED_CATEGORY,
        data: { kind: 'meeting-started', meetingId, eventKey: key },
        priority: 'high',
        sound: 'default',
      });
      if (sent) await watch.markStartedNotified(key);
    } catch (err) {
      // The meeting runs either way; the overlay shows it on the next app open.
      deps.warn({ err, eventKey: key }, 'calendar meeting started notification failed');
    }
  }
  return { meetingId };
}

export function startCalendarMeetingWatcher(deps: CalendarMeetingDeps) {
  const now = deps.now ?? Date.now;
  const watch = deps.store.calendarWatch;
  let stopped = false;
  let active: Promise<void> | undefined;

  const refresh = async (at: number) => {
    const window = { from: at - LOOK_BACK_MS, to: at + LOOK_AHEAD_MS };
    for (const calendar of await watch.list()) {
      try {
        const token = await deps.googleAccessToken(calendar.accountId);
        // A sealed store or a revoked account: keep what is known and try again next pass.
        if (!token) continue;
        const events = await listCalendarEventsInRange(
          token,
          {
            calendarId: calendar.calendarId,
            timeMin: new Date(window.from).toISOString(),
            timeMax: new Date(window.to).toISOString(),
          },
          deps.fetch,
        );
        await watch.syncEvents(
          calendar.accountId,
          calendar.calendarId,
          window,
          events.flatMap((event) => {
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
      } catch (err) {
        deps.warn(
          { err, accountId: calendar.accountId, calendarId: calendar.calendarId },
          'calendar meeting watch failed',
        );
      }
    }
    await watch.pruneEvents(at - 24 * 60 * MINUTE_MS);
  };

  const act = async (at: number) => {
    const calendars = await watch.list();
    for (const event of await watch.listEvents()) {
      if (event.decision !== null) continue;
      const calendar = calendars.find(
        (item) => item.accountId === event.accountId && item.calendarId === event.calendarId,
      );
      if (!calendar) continue;
      const lastChance = Math.min(event.endsAt, event.startsAt + LATE_JOIN_MS);
      if (at >= lastChance) continue;
      try {
        // An invitation not yet accepted is asked about even on an automatic calendar.
        if (calendar.autoJoin && event.accepted) {
          if (at >= event.startsAt)
            await joinCalendarMeeting(deps, event.key, null, { automatic: true });
        } else if (event.notifiedAt === null && at >= event.startsAt - UPCOMING_NOTICE_MS) {
          const minutes = Math.round((event.startsAt - at) / MINUTE_MS);
          const sent = await notifyAdministrators(deps, {
            title:
              minutes > 0
                ? `${titleOf(event)} starts in ${String(minutes)} min`
                : `${titleOf(event)} has started`,
            body: 'Join with Verity? You pick the project afterwards.',
            categoryId: MEETING_UPCOMING_CATEGORY,
            data: { kind: 'meeting-upcoming', eventKey: event.key, startsAt: event.startsAt },
            priority: 'high',
            sound: 'default',
            ttl: Math.max(60, Math.round((lastChance - at) / 1000)),
          });
          if (sent) await watch.markNotified(event.key);
        }
      } catch (err) {
        deps.warn({ err, eventKey: event.key }, 'calendar meeting action failed');
      }
    }
  };

  const runOnce = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (active) return active;
    active = (async () => {
      const at = now();
      await refresh(at);
      await act(now());
    })()
      .catch((err: unknown) => deps.warn({ err }, 'calendar meeting watcher failed'))
      .finally(() => {
        active = undefined;
      });
    return active;
  };
  const timer = setInterval(() => void runOnce(), CALENDAR_WATCH_INTERVAL_MS);
  timer.unref();
  void runOnce();
  return {
    runOnce,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
