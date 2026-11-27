import { z } from 'zod';

/**
 * Domain events on the live connection (ADR 0033). Overview state that several
 * views show — secret requests, Quick Actions, pull request status, sandbox
 * lifecycle — is published on topics as small typed events, so every view of
 * every device applies the same change at once instead of re-reading lists.
 *
 * A topic names whose state it carries:
 * - `user:<id>`    state that belongs to one person;
 * - `project:<id>` project, sandbox and project-wide pull request state;
 * - `session:<id>` overview fields of one session.
 *
 * Authorization is checked when a connection subscribes to a topic, with the
 * same policy the corresponding HTTP read applies, and again when access may
 * have changed. Event payloads therefore never carry fields that read would
 * withhold from a viewer of the topic.
 */

export const DOMAIN_TOPIC_KINDS = ['user', 'project', 'session'] as const;
export type DomainTopicKind = (typeof DOMAIN_TOPIC_KINDS)[number];

/** Topics a connection may hold at once. */
export const LIVE_MAX_TOPIC_SUBSCRIPTIONS = 64;

const TOPIC_PATTERN = /^(user|project|session):[^\s:]{1,200}$/u;
export const domainTopicSchema = z.string().regex(TOPIC_PATTERN);
export type DomainTopic = z.infer<typeof domainTopicSchema>;

export function domainTopic(kind: DomainTopicKind, id: string): DomainTopic {
  return `${kind}:${id}`;
}

/** The kind and id of a topic, or undefined for a malformed one. */
export function parseDomainTopic(topic: string): { kind: DomainTopicKind; id: string } | undefined {
  const match = TOPIC_PATTERN.exec(topic);
  if (match === null) return undefined;
  return { kind: match[1] as DomainTopicKind, id: topic.slice(match[1]!.length + 1) };
}

/** Topic cursors are positions in one server-wide sequence. A cursor from an
 * earlier server process, or one older than what the server still holds,
 * answers with `resync` instead of a replay. */
const cursor = z.number().int().nonnegative();
const id = z.string().min(1).max(200);
/** Increases with every change of one entity; a view applies a patch only when
 * its revision is newer than the one it holds. */
const rev = z.number().int().nonnegative();
/** Changed overview fields. Keys a client does not know are ignored. */
const patch = z.record(z.string(), z.unknown());

/**
 * The overview fields `session.summary` carries: those every viewer sees alike
 * that no other overview event owns. A view replaces exactly these with the
 * event's row and keeps the rest as its list read gave them: what each person
 * sees differently (read marks, dismissed items, favorites, addressing, order)
 * and what `permission.*`, `choices.*` and `pr.status` announce.
 *
 * An allow-list, so a field added to the session row later is published only
 * once it is named here.
 */
export const SESSION_SUMMARY_FIELDS = [
  'name',
  'model',
  'status',
  'planning',
  'planningRevision',
  'planningPresented',
  'mockupReview',
  'automation',
  'usage',
  'rateLimit',
  'rateLimits',
  'resumable',
  'branch',
  'eventCount',
  'eventCountVersion',
  'agentTextCounterVersion',
  'backgroundWorking',
  'lastActivityAt',
  'lastMessageAt',
  'attention',
] as const;

export const domainEventSchema = z.discriminatedUnion('t', [
  /** The session's whole {@link SESSION_SUMMARY_FIELDS} row; a field it
   * lacks is one the session no longer has. */
  z.object({ t: z.literal('session.summary'), sessionId: id, rev, patch }),
  z.object({ t: z.literal('permission.requested'), sessionId: id, toolUseId: id, rev }),
  z.object({
    t: z.literal('permission.decided'),
    sessionId: id,
    toolUseId: id,
    rev,
    outcome: z.enum(['allowed', 'denied', 'retired']),
  }),
  z.object({ t: z.literal('choices.opened'), sessionId: id, rev }),
  z.object({ t: z.literal('choices.answered'), sessionId: id, rev }),
  z.object({ t: z.literal('pr.status'), sessionId: id, rev, pr: patch.nullable() }),
  z.object({ t: z.literal('project.changed'), projectId: id, rev, patch }),
  z.object({
    t: z.literal('sandbox.lifecycle'),
    projectId: id,
    rev,
    state: z.string().min(1).max(64),
    lifecycleState: z.string().min(1).max(64).optional(),
    warning: z.string().max(2_000).nullable().optional(),
  }),
  z.object({
    t: z.literal('sandbox.update'),
    projectId: id,
    rev,
    available: z.boolean(),
    /** The project's whole `sandboxUpdate` as the project routes show it:
     * repairs, deferrals, recovery and the last repair failure included.
     * Absent from servers that announce only availability. */
    update: patch.optional(),
  }),
]);
export type DomainEvent = z.infer<typeof domainEventSchema>;

/** One subscription request: without a cursor the topic starts live from now
 * (the caller reads its snapshot); with one, missed events are replayed. */
export const topicSubscriptionSchema = z.object({
  topic: domainTopicSchema,
  cursor: cursor.optional(),
});
export type TopicSubscription = z.infer<typeof topicSubscriptionSchema>;

export const TOPIC_ENDED_REASONS = ['forbidden', 'limit', 'error'] as const;
export type TopicEndedReason = (typeof TOPIC_ENDED_REASONS)[number];

/** Client frames added by protocol version 2. */
/** @internal Spread into the live frame unions in `live.ts`. */
export const topicClientFrameSchemas = [
  z.object({
    k: z.literal('topics.sub'),
    topics: z.array(topicSubscriptionSchema).min(1).max(LIVE_MAX_TOPIC_SUBSCRIPTIONS),
  }),
  z.object({
    k: z.literal('topics.unsub'),
    topics: z.array(domainTopicSchema).min(1).max(LIVE_MAX_TOPIC_SUBSCRIPTIONS),
  }),
] as const;

/** Server frames added by protocol version 2. */
/** @internal Spread into the live frame unions in `live.ts`. */
export const topicServerFrameSchemas = [
  z.object({ k: z.literal('domain'), topic: domainTopicSchema, cursor, event: domainEventSchema }),
  /** The server cannot replay what the client missed (a restart, a cursor older
   * than its buffer, or a socket that fell behind). The client reads the
   * topic's snapshots again; the subscription continues from `cursor`. */
  z.object({ k: z.literal('resync'), topic: domainTopicSchema, cursor }),
  z.object({
    k: z.literal('topic_ended'),
    topic: domainTopicSchema,
    reason: z.enum(TOPIC_ENDED_REASONS),
  }),
] as const;
