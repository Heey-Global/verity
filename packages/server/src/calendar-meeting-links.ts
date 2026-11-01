import type { CalendarEventRecord } from './google-calendar.js';
import { declinedBySelf } from './scheduling-slots.js';

const MEETING_HOSTS = ['meet.google.com', 'teams.microsoft.com', 'teams.live.com', 'zoom.us'];

/** Whether Verity's meeting bot can join this link: HTTPS on Google Meet, Teams or Zoom. */
export function isSupportedMeetingUrl(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    MEETING_HOSTS.some(
      (host) => url.hostname === host || (host === 'zoom.us' && url.hostname.endsWith('.zoom.us')),
    )
  );
}

function supported(candidate: string): string | undefined {
  // Descriptions are often HTML; links there carry entity-encoded query separators.
  const text = candidate.replaceAll('&amp;', '&');
  try {
    return isSupportedMeetingUrl(new URL(text)) ? text : undefined;
  } catch {
    return undefined;
  }
}

function linksIn(text: string | undefined): string[] {
  // A link that ends a sentence must not carry the full stop into the bot's URL.
  return (text?.match(/https:\/\/[^\s"'<>()[\]]+/gu) ?? []).map((link) =>
    link.replace(/[.,;:!?]+$/u, ''),
  );
}

/**
 * The join link of a calendar event, looked up where Google and the common add-ins put it:
 * the Meet link, the conference's video entry point, then links in location and description.
 * Anything not on a supported host is ignored, so an unrelated link never starts a bot.
 */
export function meetingLinkFromEvent(event: CalendarEventRecord): string | undefined {
  const entryPoints = event.conferenceData?.entryPoints ?? [];
  const candidates = [
    ...(event.hangoutLink ? [event.hangoutLink] : []),
    ...entryPoints.filter((entry) => entry.entryPointType === 'video').map((entry) => entry.uri),
    ...entryPoints.filter((entry) => entry.entryPointType !== 'video').map((entry) => entry.uri),
    ...linksIn(event.location),
    ...linksIn(event.description),
  ];
  for (const candidate of candidates) {
    const link = supported(candidate);
    if (link) return link;
  }
  return undefined;
}

/**
 * A meeting the watcher may announce or join: confirmed, timed (not all-day), not declined by
 * the calendar's owner, and with a link the bot can join. `accepted` tells whether the owner
 * said yes or organizes it; only such meetings are joined without asking.
 */
export function joinableMeeting(
  event: CalendarEventRecord,
): { link: string; start: number; end: number; accepted: boolean } | undefined {
  if (event.status !== 'confirmed' || declinedBySelf(event)) return undefined;
  const start = Date.parse(event.start.dateTime ?? '');
  const end = Date.parse(event.end.dateTime ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  const link = meetingLinkFromEvent(event);
  const self = event.attendees?.find((attendee) => attendee.self);
  const accepted = !self || self.organizer === true || self.responseStatus === 'accepted';
  return link ? { link, start, end, accepted } : undefined;
}
