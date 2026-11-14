import { z } from 'zod';

/** How far Verity's meeting bot got into the call, as the app shows it before the meeting. */
export type OnlineJoinStatus = 'joining' | 'waiting' | 'joined' | 'failed' | 'ended';

/** The provider bot as returned by `GET bots/:id`; events are optional for older providers. */
export const attendeeBotSchema = z.object({
  state: z.string(),
  events: z
    .array(
      z.object({
        type: z.string(),
        sub_type: z.string().nullish(),
        created_at: z.string().nullish(),
      }),
    )
    .optional()
    .catch(undefined),
});
export type AttendeeBot = z.infer<typeof attendeeBotSchema>;

const JOINED = new Set([
  'joined_not_recording',
  'joined_recording',
  'joined_recording_paused',
  'joined_recording_permission_denied',
  'joining_breakout_room',
  'leaving_breakout_room',
]);
/** States after which the bot is no longer trying to get in; any other is still joining. */
const DONE = new Set([
  'leaving',
  'post_processing',
  'ended',
  'fatal_error',
  'data_deleted',
  'disconnecting',
]);
const FAILURE_EVENTS = new Set(['could_not_join_meeting', 'fatal_error']);
/** Ending the meeting before the bot got in is a cancellation, not a failure to report. */
const CANCELLED = new Set(['leave_requested_before_bot_joined']);
/** Provider codes are enum identifiers; anything else is never logged or shown. */
const PROVIDER_CODE = /^[a-z0-9_]{1,64}$/u;

export const providerCode = (value: unknown): string | null =>
  typeof value === 'string' && PROVIDER_CODE.test(value) ? value : null;

export interface JoinProgress {
  status: OnlineJoinStatus;
  /** Provider sub-type of the failure (for example `login_required`), when it named one. */
  reason: string | null;
  /** Newest provider event, for diagnostics only. */
  eventType: string | null;
  eventSubType: string | null;
}

/**
 * Derives the join status from the bot's state and event history. Attendee reports the waiting
 * room only where its adapter detects it (Zoom at the time of writing); elsewhere a bot held in
 * the lobby stays `joining`, so `waiting` is shown only when the provider says so.
 */
export function joinProgress(bot: AttendeeBot, joinedBefore: boolean): JoinProgress {
  // By time, not text: the provider omits zero fractions, so `…:30.5Z` sorts before `…:30Z`.
  const at = (value: string | null | undefined) => Date.parse(value ?? '') || 0;
  const events = [...(bot.events ?? [])].sort((a, b) => at(a.created_at) - at(b.created_at));
  const newest = events.at(-1);
  const diagnostics = {
    eventType: providerCode(newest?.type),
    eventSubType: providerCode(newest?.sub_type),
  };
  if (JOINED.has(bot.state)) return { status: 'joined', reason: null, ...diagnostics };
  if (bot.state === 'waiting_room') return { status: 'waiting', reason: null, ...diagnostics };
  // A state added by the provider later reads as still joining rather than as over.
  if (!DONE.has(bot.state)) return { status: 'joining', reason: null, ...diagnostics };
  // The provider's own history counts too: a bot can join and fail between two polls.
  if (joinedBefore || events.some((event) => event.type === 'joined_meeting'))
    return { status: 'ended', reason: null, ...diagnostics };
  const failure = events.findLast((event) => FAILURE_EVENTS.has(event.type));
  const reason = providerCode(failure?.sub_type);
  if (reason !== null && CANCELLED.has(reason))
    return { status: 'ended', reason: null, ...diagnostics };
  if (failure || bot.state === 'fatal_error') return { status: 'failed', reason, ...diagnostics };
  return { status: 'ended', reason: null, ...diagnostics };
}
