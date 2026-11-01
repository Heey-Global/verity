import { z } from 'zod';
import { DEFAULT_ACTION_IDENTIFIER, type PushReplyAction } from './response.js';
import { PUSH_ACTION } from './categories.js';

/**
 * The calendar meeting pushes (`packages/server/src/calendar-meeting-watcher.ts`). Like the
 * server update announcement they belong to no session, so they are recognized here rather
 * than through {@link import('./payload.js').pushPayloadSchema}, whose required `sessionId`
 * keeps every session reply bound to its session.
 */
export const meetingPushSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('meeting-upcoming'),
    eventKey: z.string().min(1).max(64),
    startsAt: z.number().optional(),
    deviceId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('meeting-started'),
    meetingId: z.string().min(1),
    eventKey: z.string().min(1).max(64).optional(),
    deviceId: z.string().min(1).optional(),
  }),
]);
export type MeetingPush = z.infer<typeof meetingPushSchema>;

export function parseMeetingPush(data: unknown): MeetingPush | null {
  const result = meetingPushSchema.safeParse(data);
  return result.success ? result.data : null;
}

/** What a response to a meeting push asks for: a reply for the outbox, or a screen. */
export type MeetingPushIntent =
  | { type: 'reply'; action: PushReplyAction }
  | { type: 'show-upcoming'; eventKey: string }
  | { type: 'show-started'; meetingId: string };

export function resolveMeetingPushResponse(
  actionIdentifier: string,
  push: MeetingPush,
): MeetingPushIntent | null {
  if (push.kind === 'meeting-upcoming') {
    if (actionIdentifier === DEFAULT_ACTION_IDENTIFIER)
      return { type: 'show-upcoming', eventKey: push.eventKey };
    if (actionIdentifier === PUSH_ACTION.joinMeeting)
      return { type: 'reply', action: { type: 'join-calendar-meeting', eventKey: push.eventKey } };
    if (actionIdentifier === PUSH_ACTION.skipMeeting)
      return { type: 'reply', action: { type: 'skip-calendar-meeting', eventKey: push.eventKey } };
    return null;
  }
  if (
    actionIdentifier === DEFAULT_ACTION_IDENTIFIER ||
    actionIdentifier === PUSH_ACTION.openMeeting
  )
    return { type: 'show-started', meetingId: push.meetingId };
  if (actionIdentifier === PUSH_ACTION.discardMeeting)
    return { type: 'reply', action: { type: 'discard-live-meeting', meetingId: push.meetingId } };
  return null;
}
