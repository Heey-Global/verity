import { sql, type Transaction } from 'kysely';
import type { Database } from './schema.js';

import { sessionMessageEvent0236 } from './session-message-recency-migration.js';

interface ActivityFacts {
  eventCount: number;
  lastEventSeq: number;
  lastActivityAt: number | null;
  lastMessageAt: number | null;
}

/** Read counters and conversation recency in the projection's shared snapshot. */
export async function readSessionProjectionActivity(
  tx: Transaction<Database>,
  ids: readonly string[],
  facts: Map<string, ActivityFacts>,
): Promise<void> {
  const totals = await tx
    .selectFrom('session_event_stats')
    .select(['session_id', 'event_count', 'last_event_seq', 'last_activity_at'])
    .where('session_id', 'in', ids)
    .execute();
  for (const row of totals) {
    const entry = facts.get(row.session_id);
    if (entry === undefined) continue;
    entry.eventCount = Number(row.event_count);
    entry.lastEventSeq = Number(row.last_event_seq);
    entry.lastActivityAt = row.last_activity_at?.getTime() ?? null;
  }

  const messages = await sql<{ session_id: string; last_message_at: Date | null }>`
    select requested.session_id, latest.created_at as last_message_at
    from unnest(${ids}::text[]) as requested(session_id)
    left join lateral (
      select created_at from events
      where session_id = requested.session_id and ${sessionMessageEvent0236}
      order by id desc limit 1
    ) latest on true
  `.execute(tx);
  for (const row of messages.rows) {
    const entry = facts.get(row.session_id);
    if (entry !== undefined) entry.lastMessageAt = row.last_message_at?.getTime() ?? null;
  }
}
