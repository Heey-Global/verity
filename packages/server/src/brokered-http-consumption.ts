import type { Database } from '@verity/store';
import type { Kysely } from 'kysely';

/** Durable at-most-once fence committed before an approved HTTP request reaches the network. */
export function createBrokeredHttpConsumptionStore(db: Kysely<Database>) {
  return {
    async consume(input: {
      projectId: string;
      sessionId: string;
      turnId: string;
      callId: string;
      requestHash: string;
    }): Promise<boolean> {
      const inserted = await db
        .insertInto('brokered_http_consumptions')
        .values({
          project_id: input.projectId,
          session_id: input.sessionId,
          turn_id: input.turnId,
          call_id: input.callId,
          request_hash: input.requestHash,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning('call_id')
        .executeTakeFirst();
      return inserted !== undefined;
    },
  };
}
