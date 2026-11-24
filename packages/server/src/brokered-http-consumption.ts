import { createHash } from 'node:crypto';
import type { Database } from '@verity/store';
import type { Kysely } from 'kysely';

function claimHash(invocationId: string): string {
  return createHash('sha256').update(invocationId).digest('hex');
}

/** The prefix lets rollback identify claims the previous gateway cannot find. */
export function brokeredExecutionClaimId(invocationId: string): string {
  return `doppler-v2:${claimHash(invocationId)}`;
}

export function brokeredExecutionClaimIds(
  baseInvocationId: string,
  legacySnapshot?: string,
): string[] {
  const ids = [brokeredExecutionClaimId(baseInvocationId)];
  if (legacySnapshot !== undefined) {
    const legacyHash = createHash('sha256').update(legacySnapshot).digest('hex');
    ids.push(claimHash(`${baseInvocationId}:${legacyHash}`));
  }
  return ids;
}

/** Durable at-most-once fence committed before an approved HTTP request reaches the network. */
export function createBrokeredHttpConsumptionStore(db: Kysely<Database>) {
  return {
    async has(
      this: void,
      input: { projectId: string; sessionId: string; turnId: string; callId: string },
    ) {
      const row = await db
        .selectFrom('brokered_http_consumptions')
        .select('call_id')
        .where('project_id', '=', input.projectId)
        .where('session_id', '=', input.sessionId)
        .where('turn_id', '=', input.turnId)
        .where('call_id', '=', input.callId)
        .executeTakeFirst();
      return row !== undefined;
    },
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
