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
 * A turn can raise an unbounded run of permissions. Each carries at most
 * `PERMISSION_INPUT_MAX_BYTES` of input, but a projection holding hundreds of
 * them is not worth keeping: such a session is simply read again.
 */
const MAX_CACHED_PERMISSION_REQUESTS = 64;

/** Entries hold a few derived values each; the bound only keeps sessions that
 *  no longer exist from accumulating on a long-lived server. */
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
 * Only log-derived values are kept, never event payload arrays. Least recently
 * used sessions leave first.
 */
export class SessionLogProjectionCache {
  private readonly entries = new Map<string, CachedLog>();

  constructor(private readonly maxSessions: number) {}

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
      this.entries.delete(sessionId);
      return undefined;
    }
    this.entries.delete(sessionId);
    this.entries.set(sessionId, cached);
    return cached;
  }

  set(sessionId: string, facts: SessionProjectionFacts, projection: SessionLogProjection): void {
    this.entries.delete(sessionId);
    // A session without a log has no revision to recognise it by.
    if (facts.revision === '') return;
    if (projection.permissionRequests.size > MAX_CACHED_PERMISSION_REQUESTS) return;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-omit
    const { events, eventsTruncated, ...summaryFacts } = facts;
    this.entries.set(sessionId, {
      revision: facts.revision,
      lastEventSeq: facts.lastEventSeq,
      lastActivityAt: facts.lastActivityAt,
      facts: summaryFacts,
      projection,
    });
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
