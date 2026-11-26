import type { SessionEventStats } from './session-projection.js';
import { sql, type Kysely } from 'kysely';
import { parseAgentEvent, type AgentEvent } from '@verity/events';
import type { Database } from './schema.js';

/** A persisted event tagged with its monotonic sequence (the bigserial id) and
 * its real persist time. `seq` orders + keys the event; `ts` is the row's
 * `created_at` as epoch milliseconds — store/transport metadata alongside `seq`,
 * NOT part of the canonical {@link AgentEvent} payload. Surfaced so the client can
 * show real wall-clock times instead of using `seq` as a `createdAt` proxy (#32). */
export interface SequencedEvent {
  seq: number;
  /** The row's `created_at` as epoch milliseconds (non-decreasing with `seq`). */
  ts: number;
  event: AgentEvent;
}

/**
 * One event row as the projections consume it.
 *
 * Same contract as {@link EventHistoryStore.getEventsAfter}: a payload that does not
 * parse is a corrupted log, not a row to skip past. Events are validated on the
 * way IN, so a row that fails on the way out means the database no longer holds
 * what the server wrote, and a badge quietly rendered from the surviving rows
 * would hide it.
 */
export function sequencedEvent(
  sessionId: string,
  id: string | number,
  payload: unknown,
  createdAt: Date,
): SequencedEvent {
  const parsed = parseAgentEvent(payload);
  if (!parsed.success) {
    throw new Error(`corrupt event payload in session ${sessionId}: ${parsed.error.message}`);
  }
  return { seq: Number(id), ts: createdAt.getTime(), event: parsed.data };
}

export class EventHistoryStore {
  constructor(private readonly getDb: () => Kysely<Database>) {}

  /**
   * Read a backward page of history: the newest `limit` events with `seq <
   * beforeSeq`, returned in ascending `seq` order (ready to prepend to the
   * transcript). Omit `beforeSeq` (or pass a value past the head) for the most
   * recent page. Lets a long session open with only its tail and fetch older
   * turns on scroll-up, instead of replaying the whole log. `hasMore` tells the
   * caller whether still-older events exist before the page.
   */
  async getEventsBeforeSeq(
    sessionId: string,
    limit: number,
    beforeSeq?: number,
  ): Promise<{ events: SequencedEvent[]; hasMore: boolean }> {
    let q = this.getDb()
      .selectFrom('events')
      .select(['id', 'payload', 'created_at'])
      .where('session_id', '=', sessionId);
    if (beforeSeq !== undefined) q = q.where('id', '<', beforeSeq);
    // One extra row probes whether an older page exists, then is dropped.
    const rows = await q
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const hasMore = rows.length > limit;
    const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
    const events = page.map((row) =>
      sequencedEvent(sessionId, row.id, row.payload, row.created_at),
    );
    return { events, hasMore };
  }

  /**
   * Read events with `seq > afterSeq` (the bigserial id) in order, each tagged
   * with its `seq`. `afterSeq = 0` returns the full log. The cursor lets a WS
   * client page a backlog and resume after a reconnect without re-sending it.
   */
  async getEventsAfter(
    sessionId: string,
    afterSeq: number,
    limit?: number,
  ): Promise<SequencedEvent[]> {
    let query = this.getDb()
      .selectFrom('events')
      .select(['id', 'payload', 'created_at'])
      .where('session_id', '=', sessionId)
      .where('id', '>', afterSeq)
      .orderBy('id', 'asc');
    // Paged readers (the live replay) bound each read; recovery reads stay whole.
    if (limit !== undefined) query = query.limit(limit);
    const rows = await query.execute();
    return rows.map((row) => sequencedEvent(sessionId, row.id, row.payload, row.created_at));
  }

  async getSessionEventStats(sessionId: string): Promise<SessionEventStats | undefined> {
    const row = await this.getDb()
      .selectFrom('session_event_stats')
      .selectAll()
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      eventCount: Number(row.event_count),
      lastEventSeq: Number(row.last_event_seq),
      lastActivityAt: row.last_activity_at?.getTime() ?? null,
      revision: String(row.revision),
    };
  }

  async latestEventSeq(sessionId: string): Promise<number> {
    const row = await this.getDb()
      .selectFrom('events')
      .select((eb) => eb.fn.max('id').as('seq'))
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return Number(row?.seq ?? 0);
  }

  async latestPromptInitiator(sessionId: string): Promise<{ userId: string } | undefined> {
    const row = await this.getDb()
      .selectFrom('events')
      .select(sql<string>`payload->'initiatedBy'->>'userId'`.as('userId'))
      .where('session_id', '=', sessionId)
      .where(sql<boolean>`payload->>'t' = 'prompt'`)
      .where(sql<boolean>`payload->'initiatedBy'->>'userId' is not null`)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.userId ? { userId: row.userId } : undefined;
  }

  async promptInitiatorAt(sessionId: string, seq: number): Promise<{ userId: string } | undefined> {
    const row = await this.getDb()
      .selectFrom('events')
      .select(sql<string>`payload->'initiatedBy'->>'userId'`.as('userId'))
      .where('session_id', '=', sessionId)
      .where('id', '=', seq)
      .where(sql<boolean>`payload->>'t' = 'prompt'`)
      .executeTakeFirst();
    return row?.userId ? { userId: row.userId } : undefined;
  }
}
