import type { AgentEvent } from '@verity/events';
import type { SessionEventStats, SessionProjectionFacts } from '@verity/store';
import {
  currentTurnPermissionRequests,
  requestInitiatorFromProjection,
  unansweredChoicesFromProjection,
  type OpenChoices,
  type PendingPermissionRequest,
} from './session-inbox-facts.js';
import {
  deriveSessionStatusFromProjection,
  permissionEventAwaitsInput,
  sessionHasOpenTasks,
  type SessionStatus,
} from './status.js';

/**
 * What a session summary takes from one state of the session's log, and from
 * nothing else. Conductor state, caches and the viewer are applied on top of it
 * at every read, so a projection can be reused for as long as the log is
 * unchanged without freezing anything live.
 */
export interface SessionLogProjection {
  /** `deriveSessionStatusFromProjection`, before the conductor's busy state. */
  readonly status: SessionStatus;
  readonly awaitsPermission: boolean;
  readonly openTasks: boolean;
  /** The current turn's unanswered choices, before live status decides they are open. */
  readonly choices: OpenChoices | undefined;
  readonly requestInitiator: string | undefined;
  /** Every permission the current turn raised; the conductor picks the open ones. */
  readonly permissionRequests: ReadonlyMap<string, PendingPermissionRequest>;
}

export function projectSessionLog(
  events: readonly AgentEvent[],
  facts: Pick<SessionProjectionFacts, 'lastEventSeq'>,
): SessionLogProjection {
  return {
    // Unread counts include only agent text; the seq still identifies a nonempty log.
    status: deriveSessionStatusFromProjection(events, facts.lastEventSeq === 0 ? 0 : 1),
    awaitsPermission: permissionEventAwaitsInput(events),
    openTasks: sessionHasOpenTasks(events),
    choices: unansweredChoicesFromProjection(events),
    requestInitiator: requestInitiatorFromProjection(events),
    permissionRequests: currentTurnPermissionRequests(events),
  };
}

/** The log facts a summary reads, without the event tail it was derived from. */
export type SummaryLogFacts = Omit<SessionProjectionFacts, 'events' | 'eventsTruncated'>;

interface CachedLog {
  revision: string;
  lastEventSeq: number;
  lastActivityAt: number | null;
  facts: SummaryLogFacts;
  projection: SessionLogProjection;
}

/**
 * Permission requests are the one part of an entry that can be large: each
 * carries up to `PERMISSION_INPUT_MAX_BYTES` of tool input, and an idle session
 * keeps its last turn's requests. The cache as a whole holds at most this many,
 * about 2 MiB of input, evicting least recently used sessions to stay within it;
 * a single projection with more than {@link MAX_SESSION_PERMISSION_REQUESTS} is
 * not kept at all and is simply read again.
 */
const MAX_CACHED_PERMISSION_REQUESTS = 512;
const MAX_SESSION_PERMISSION_REQUESTS = 64;

/** Apart from permission requests an entry holds a handful of small derived
 *  values; this bound keeps sessions that no longer exist from accumulating. */
export const LOG_PROJECTION_CACHE_MAX_SESSIONS = 2_048;

/**
 * Projections of unchanged session logs, so the overview reads and derives only
 * the logs that moved since it last looked.
 *
 * `GET /sessions` summarizes every session on each read, and the live hub reads
 * it again after every session invalidation. Most of those logs have not changed
 * in between, yet each read fetched and parsed their projection tails, and for a
 * tail that does not reach its turn's opening prompt, the whole projected log.
 *
 * The key is the log's `session_event_stats` revision and last seq, exactly as
 * for the activity route's cache: the trigger advances the revision on every
 * insert, update and delete of an event, including ones below the last seq, and
 * the seq separates a deleted and recreated session whose revision starts over.
 * The newest event's time is part of it too: when the event table is emptied
 * with its identity restarted, as test fixtures do between cases, revision and
 * seq both start over and a reused session id could otherwise match.
 * Only log-derived values are kept, never the event tail. Besides permission
 * requests (budgeted below) an entry holds small values: the newest rate-limit
 * state per provider window, the token totals and at most one choices block.
 * Least recently used sessions leave first.
 */
export class SessionLogProjectionCache {
  private readonly entries = new Map<string, CachedLog>();
  private permissionRequests = 0;

  constructor(private readonly maxSessions: number) {}

  private delete(sessionId: string): void {
    const cached = this.entries.get(sessionId);
    if (cached === undefined) return;
    this.permissionRequests -= cached.projection.permissionRequests.size;
    this.entries.delete(sessionId);
  }

  get(
    sessionId: string,
    stats: Pick<SessionEventStats, 'revision' | 'lastEventSeq' | 'lastActivityAt'> | undefined,
  ): { facts: SummaryLogFacts; projection: SessionLogProjection } | undefined {
    const cached = this.entries.get(sessionId);
    if (cached === undefined) return undefined;
    if (
      stats === undefined ||
      cached.revision !== stats.revision ||
      cached.lastEventSeq !== stats.lastEventSeq ||
      cached.lastActivityAt !== stats.lastActivityAt
    ) {
      this.delete(sessionId);
      return undefined;
    }
    this.entries.delete(sessionId);
    this.entries.set(sessionId, cached);
    return cached;
  }

  set(sessionId: string, facts: SessionProjectionFacts, projection: SessionLogProjection): void {
    this.delete(sessionId);
    // A session without a log has no revision to recognise it by.
    if (facts.revision === '') return;
    if (projection.permissionRequests.size > MAX_SESSION_PERMISSION_REQUESTS) return;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-omit
    const { events, eventsTruncated, ...summaryFacts } = facts;
    this.entries.set(sessionId, {
      revision: facts.revision,
      lastEventSeq: facts.lastEventSeq,
      lastActivityAt: facts.lastActivityAt,
      facts: summaryFacts,
      projection,
    });
    this.permissionRequests += projection.permissionRequests.size;
    while (
      this.entries.size > this.maxSessions ||
      this.permissionRequests > MAX_CACHED_PERMISSION_REQUESTS
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  /** How many permission requests the cache holds, for tests. */
  get heldPermissionRequests(): number {
    return this.permissionRequests;
  }
}
