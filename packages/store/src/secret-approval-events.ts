import type { AgentEvent } from '@verity/events';
import { sql, type Transaction } from 'kysely';
import type { Database } from './schema.js';

/** Call with the session event append lock held so recovery and live writes share one row. */
export async function findRecordedApprovalDecision(
  tx: Transaction<Database>,
  sessionId: string,
  event: AgentEvent,
) {
  if (event.t !== 'notice' || !event.secretApproval) return undefined;
  return tx
    .selectFrom('events')
    .select(['id', 'created_at'])
    .where('session_id', '=', sessionId)
    .where('type', '=', 'notice')
    .where(sql`payload->'secretApproval'->>'id'`, '=', event.secretApproval.id)
    .executeTakeFirst();
}
