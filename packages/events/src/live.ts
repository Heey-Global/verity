import { z } from 'zod';
import { agentEventSchema } from './events.js';

/**
 * The app-wide live connection (`WS /live`): one socket per paired device and
 * server. It multiplexes the per-session event streams, carries content-free
 * overview hints that tell the app which list rows to refetch, and doubles as the
 * device's foreground presence, which push routing reads to decide whether a
 * notification goes to this device as an in-app alert, or to the user's other
 * devices as a push.
 *
 * Authentication is a one-use ticket from `POST /live/ticket`, offered as the
 * {@link LIVE_TICKET_PROTOCOL_PREFIX} subprotocol — never in the URL, where proxies
 * and logs would keep it.
 */
export const LIVE_PROTOCOL_VERSION = 1;
export const LIVE_TICKET_PROTOCOL_PREFIX = 'verity-live-ticket.';

/** Concurrent session subscriptions per connection. The app subscribes to the
 * sessions it shows, not to everything it could read; a client that runs into the
 * limit is told so with an `ended` frame rather than silently starved. */
export const LIVE_MAX_SESSION_SUBSCRIPTIONS = 8;

/** Server keepalive: a protocol ping every interval, and the connection is
 * dropped once a pong has been outstanding for the timeout. A phone that left
 * the network without closing its socket would otherwise keep counting as the
 * foreground device, and keep every push away from the user's other devices. */
export const LIVE_PING_INTERVAL_MS = 20_000;
export const LIVE_PONG_TIMEOUT_MS = 45_000;

const sessionId = z.string().min(1).max(200);
const seq = z.number().int().nonnegative();

/** Frames the app sends. A plain union: `sub` and `unsub` each come in two
 * shapes, distinguished by their channel, which a single discriminator cannot. */
export const liveClientFrameSchema = z.union([
  /** Whether the app is in front of the user: an active iOS app, a visible and
   * focused browser tab. Only a foreground connection receives in-app alerts in
   * place of a push. */
  z.object({ k: z.literal('state'), foreground: z.boolean() }),
  z.object({ k: z.literal('sub'), ch: z.literal('overview') }),
  z.object({
    k: z.literal('sub'),
    ch: z.literal('session'),
    id: sessionId,
    sinceSeq: seq.optional(),
    /** The session is on screen. A viewed session raises no notification for
     * its viewer's user at all — they are already looking at it. */
    view: z.boolean().optional(),
  }),
  z.object({ k: z.literal('view'), id: sessionId, view: z.boolean() }),
  z.object({ k: z.literal('unsub'), ch: z.literal('overview') }),
  z.object({ k: z.literal('unsub'), ch: z.literal('session'), id: sessionId }),
  z.object({ k: z.literal('ping'), n: z.number().int().nonnegative() }),
]);
export type LiveClientFrame = z.infer<typeof liveClientFrameSchema>;

export const LIVE_ENDED_REASONS = ['forbidden', 'not_found', 'overflow', 'limit', 'error'] as const;
export type LiveEndedReason = (typeof LIVE_ENDED_REASONS)[number];

/** What changed about a session, without the change itself. The overview hint
 * never carries content: a member who may read a project learns which session to
 * refetch, and the refetch goes through the same authorization as every read. */
export const LIVE_HINT_TOPICS = ['events', 'status', 'permission', 'activity', 'session'] as const;
export type LiveHintTopic = (typeof LIVE_HINT_TOPICS)[number];

export const liveHintSchema = z.object({
  sessionId,
  projectId: z.string().optional(),
  topics: z.array(z.enum(LIVE_HINT_TOPICS)).min(1),
  /** The session no longer exists. */
  deleted: z.boolean().optional(),
});
export type LiveHint = z.infer<typeof liveHintSchema>;

export const LIVE_ALERT_KINDS = ['permission', 'question'] as const;
export type LiveAlertKind = (typeof LIVE_ALERT_KINDS)[number];

/** Notification categories with interactive actions are only usable in-app
 * when the labels are short enough for a notification button. */
export const LIVE_ALERT_MAX_CHOICES = 4;

/** Something the user has to act on, delivered to a foreground device instead
 * of a push. The app presents it as a local notification with the same category
 * — and therefore the same quick actions — as the push it replaces. */
export const liveAlertSchema = z.object({
  sessionId,
  kind: z.enum(LIVE_ALERT_KINDS),
  categoryId: z.string().min(1),
  toolUseId: z.string().min(1).optional(),
  /** Option labels of an agent question that offered fixed choices. */
  choices: z.array(z.string().min(1).max(200)).max(LIVE_ALERT_MAX_CHOICES).optional(),
  title: z.string(),
  body: z.string(),
});
export type LiveAlert = z.infer<typeof liveAlertSchema>;

/** Frames the server sends. */
export const liveServerFrameSchema = z.discriminatedUnion('k', [
  z.object({
    k: z.literal('ready'),
    v: z.number().int().positive(),
    maxSessions: z.number().int().positive(),
  }),
  z.object({
    k: z.literal('event'),
    id: sessionId,
    seq,
    ts: z.number().int().nonnegative().optional(),
    event: agentEventSchema,
  }),
  z.object({ k: z.literal('caught_up'), id: sessionId, seq }),
  z.object({ k: z.literal('ended'), id: sessionId, reason: z.enum(LIVE_ENDED_REASONS) }),
  z.object({ k: z.literal('hint'), hints: z.array(liveHintSchema).min(1) }),
  z.object({ k: z.literal('alert'), alert: liveAlertSchema }),
  z.object({ k: z.literal('pong'), n: z.number().int().nonnegative() }),
  z.object({ k: z.literal('error'), message: z.string() }),
]);
export type LiveServerFrame = z.infer<typeof liveServerFrameSchema>;

export type LiveDecodeResult<T> = { ok: true; frame: T } | { ok: false; error: string };

function decode<T>(schema: z.ZodType<T>, raw: string): LiveDecodeResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, frame: parsed.data }
    : { ok: false, error: parsed.error.message };
}

/** Decode a frame from the app. Never throws: a malformed frame is answered, not
 * fatal to the connection. */
export function decodeLiveClientFrame(raw: string): LiveDecodeResult<LiveClientFrame> {
  return decode(liveClientFrameSchema, raw);
}

/** Decode a frame from the server. Never throws: one frame the app does not
 * understand must not tear down every subscription riding on the socket. */
export function decodeLiveServerFrame(raw: string): LiveDecodeResult<LiveServerFrame> {
  return decode(liveServerFrameSchema, raw);
}
