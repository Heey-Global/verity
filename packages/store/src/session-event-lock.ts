import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

/**
 * Transaction-scoped lock every append to one session's log takes first, so appends
 * from overlapping Server generations cannot interleave either. Taken BEFORE a
 * per-turn frame lock wherever both are held, so the two never deadlock.
 */
export async function sessionEventAppendLock(
  tx: Kysely<Database>,
  sessionId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${sessionEventAppendLockKey(sessionId)}))`.execute(
    tx,
  );
}

/** The one string every event-append lock hashes, transaction-scoped or inline. */
export function sessionEventAppendLockKey(sessionId: string): string {
  return `events:${sessionId}`;
}
