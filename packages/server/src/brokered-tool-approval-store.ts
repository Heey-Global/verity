import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database } from '@verity/store';

export const APPROVAL_REDEMPTION_TTL_MS = 5 * 60_000;

export interface BrokeredToolApprovalInput {
  projectId: string;
  sessionId: string;
  invocationId: string;
  toolName: 'verity_http_request' | 'verity_secret_run';
  canonicalInput: string;
  requestMac: string;
  macKeyId: string;
  authorizationSnapshot: string;
}
export interface BrokeredToolApprovalRecord extends BrokeredToolApprovalInput {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed';
  scope: 'once' | 'session' | 'project' | null;
  decidedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
  consumedInvocationId?: string | null;
}
export type BrokeredToolApprovalBinding = Pick<
  BrokeredToolApprovalInput,
  'projectId' | 'sessionId' | 'toolName' | 'canonicalInput' | 'authorizationSnapshot'
>;
type ApprovalRow = Selectable<Database['brokered_tool_approvals']>;

const bindingDigest = (input: BrokeredToolApprovalBinding): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        input.projectId,
        input.sessionId,
        input.toolName,
        input.canonicalInput,
        input.authorizationSnapshot,
      ]),
    )
    .digest('hex');
const record = (row: ApprovalRow): BrokeredToolApprovalRecord => ({
  id: row.id,
  projectId: row.project_id,
  sessionId: row.session_id,
  invocationId: row.invocation_id,
  consumedInvocationId: row.consumed_invocation_id,
  toolName: row.tool_name,
  canonicalInput: row.canonical_input,
  requestMac: row.request_mac,
  macKeyId: row.mac_key_id,
  authorizationSnapshot: row.authorization_snapshot,
  status: row.status,
  scope: row.scope,
  decidedBy: row.decided_by,
  createdAt: row.created_at.toISOString(),
  decidedAt: row.decided_at?.toISOString() ?? null,
});

/** Durable consent only. Callers must revalidate authority and the provider snapshot
 * before dispatch; creating or deciding a record never executes an operation. */
export function createBrokeredToolApprovalStore(db: Kysely<Database>, now = Date.now) {
  return {
    async createOrFindPending(
      input: BrokeredToolApprovalInput,
    ): Promise<BrokeredToolApprovalRecord> {
      return db.transaction().execute(async (tx) => {
        // Serialize receipt creation with consumption so a transport retry cannot
        // create a fresh card while its earlier identical action is being dispatched.
        await tx
          .selectFrom('sessions')
          .select('session_id')
          .where('session_id', '=', input.sessionId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const digest = bindingDigest(input);
        const consumed = await tx
          .selectFrom('brokered_tool_approvals')
          .selectAll()
          .where('binding_digest', '=', digest)
          .where('status', '=', 'consumed')
          .where('consumed_invocation_id', '=', input.invocationId)
          .executeTakeFirst();
        if (consumed) return record(consumed);
        // A retry has a new invocation/MAC but must find the original unanswered consent.
        const result = await sql<ApprovalRow>`insert into brokered_tool_approvals (
          id, project_id, session_id, invocation_id, consumed_invocation_id, tool_name, canonical_input,
          request_mac, mac_key_id, authorization_snapshot, binding_digest, status,
          scope, decided_by, created_at, decided_at
        ) values (
          ${randomUUID()}, ${input.projectId}, ${input.sessionId}, ${input.invocationId}, null,
          ${input.toolName}, ${input.canonicalInput}, ${input.requestMac}, ${input.macKeyId},
          ${input.authorizationSnapshot}, ${digest}, 'pending', null, null, ${new Date(now())}, null
        ) on conflict (binding_digest) where status <> 'consumed'
          do update set binding_digest = excluded.binding_digest returning *`.execute(tx);
        return record(result.rows[0]!);
      });
    },
    async get(id: string, sessionId: string): Promise<BrokeredToolApprovalRecord | undefined> {
      const row = await db
        .selectFrom('brokered_tool_approvals')
        .selectAll()
        .where('id', '=', id)
        .where('session_id', '=', sessionId)
        .executeTakeFirst();
      return row && record(row);
    },
    async listPending(sessionId: string): Promise<BrokeredToolApprovalRecord[]> {
      const rows = await db
        .selectFrom('brokered_tool_approvals')
        .selectAll()
        .where('session_id', '=', sessionId)
        .where('status', '=', 'pending')
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return rows.map(record);
    },
    async listApproved(sessionId: string): Promise<BrokeredToolApprovalRecord[]> {
      const rows = await db
        .selectFrom('brokered_tool_approvals')
        .selectAll()
        .where('session_id', '=', sessionId)
        .where((eb) =>
          eb.or([
            eb('status', '=', 'approved'),
            eb.and([
              eb('status', '=', 'consumed'),
              eb('consumed_invocation_id', 'is', null),
              eb('scope', 'in', ['session', 'project']),
            ]),
          ]),
        )
        .where('decided_at', '>', new Date(now() - APPROVAL_REDEMPTION_TTL_MS))
        .orderBy('decided_at')
        .orderBy('id')
        .execute();
      return rows.map(record);
    },
    async listReopenable(sessionId: string): Promise<BrokeredToolApprovalRecord[]> {
      const rows = await db
        .selectFrom('brokered_tool_approvals')
        .selectAll()
        .where('session_id', '=', sessionId)
        .where((eb) =>
          eb.or([
            eb('status', '=', 'denied'),
            eb.and([
              eb('status', '=', 'approved'),
              eb('decided_at', '<=', new Date(now() - APPROVAL_REDEMPTION_TTL_MS)),
            ]),
          ]),
        )
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return rows.map(record);
    },
    async reopen(id: string, sessionId: string): Promise<BrokeredToolApprovalRecord | undefined> {
      return db.transaction().execute(async (tx) => {
        const session = await tx
          .selectFrom('sessions')
          .select('session_id')
          .where('session_id', '=', sessionId)
          .forUpdate()
          .executeTakeFirst();
        if (!session) return undefined;
        const retired = await tx
          .updateTable('brokered_tool_approvals')
          .set({ status: 'consumed', scope: null })
          .where('id', '=', id)
          .where('session_id', '=', sessionId)
          .where((eb) =>
            eb.or([
              eb('status', '=', 'denied'),
              eb.and([
                eb('status', '=', 'approved'),
                eb('decided_at', '<=', new Date(now() - APPROVAL_REDEMPTION_TTL_MS)),
              ]),
            ]),
          )
          .returningAll()
          .executeTakeFirst();
        if (!retired) return undefined;
        // A fresh identity keeps settled UI cards and continuation idempotency keys
        // retired. The request and provider binding remain exactly the same.
        const row = await tx
          .insertInto('brokered_tool_approvals')
          .values({
            ...retired,
            id: randomUUID(),
            status: 'pending',
            scope: null,
            decided_by: null,
            decided_at: null,
            consumed_invocation_id: null,
            created_at: new Date(now()),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return record(row);
      });
    },
    async failScoped(
      id: string,
      sessionId: string,
    ): Promise<BrokeredToolApprovalRecord | undefined> {
      const row = await db
        .updateTable('brokered_tool_approvals')
        .set({ status: 'denied', scope: null })
        .where('id', '=', id)
        .where('session_id', '=', sessionId)
        .where('status', '=', 'consumed')
        .where('consumed_invocation_id', 'is', null)
        .where('scope', 'in', ['session', 'project'])
        .returningAll()
        .executeTakeFirst();
      return row && record(row);
    },
    async decide(
      id: string,
      sessionId: string,
      allow: boolean,
      actorId: string,
      scope: 'once' | 'session' | 'project' = 'once',
    ): Promise<BrokeredToolApprovalRecord | undefined> {
      const row = await db
        .updateTable('brokered_tool_approvals')
        .set({
          status: allow ? 'approved' : 'denied',
          scope: allow ? scope : null,
          decided_by: actorId,
          decided_at: new Date(now()),
        })
        .where('id', '=', id)
        .where('session_id', '=', sessionId)
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst();
      return row && record(row);
    },
    async consume(
      id: string,
      expected: BrokeredToolApprovalBinding,
      invocationId?: string,
    ): Promise<BrokeredToolApprovalRecord | undefined> {
      return db.transaction().execute(async (tx) => {
        const session = await tx
          .selectFrom('sessions')
          .select('session_id')
          .where('session_id', '=', expected.sessionId)
          .forUpdate()
          .executeTakeFirst();
        if (!session) return undefined;
        const row = await tx
          .updateTable('brokered_tool_approvals')
          .set({ status: 'consumed', consumed_invocation_id: invocationId ?? null })
          .where('id', '=', id)
          .where('status', '=', 'approved')
          .where('decided_at', '>', new Date(now() - APPROVAL_REDEMPTION_TTL_MS))
          .where('project_id', '=', expected.projectId)
          .where('session_id', '=', expected.sessionId)
          .where('tool_name', '=', expected.toolName)
          .where('canonical_input', '=', expected.canonicalInput)
          .where('authorization_snapshot', '=', expected.authorizationSnapshot)
          .where('binding_digest', '=', bindingDigest(expected))
          .returningAll()
          .executeTakeFirst();
        return row && record(row);
      });
    },
  };
}
export type BrokeredToolApprovalStore = ReturnType<typeof createBrokeredToolApprovalStore>;
