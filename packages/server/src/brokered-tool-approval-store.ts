import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable, type SqlBool } from 'kysely';
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

function matchesInvocation(invocationId: string, legacyPrefix?: string) {
  const column = sql.ref('consumed_invocation_id');
  if (legacyPrefix === undefined) return sql<SqlBool>`${column} = ${invocationId}`;
  // The binding digest already verifies the request and provider. Older rows used
  // a rotating audit MAC after the same JSON-RPC ID, tool, and turn prefix.
  return sql<SqlBool>`(${column} = ${invocationId} or (
    starts_with(${column}, ${legacyPrefix})
    and substring(${column} from char_length(${legacyPrefix}) + 1) ~ '^[0-9a-f]{64}:[0-9a-f]{64}$'
  ))`;
}

function findConsumed(
  db: Kysely<Database>,
  digest: string,
  invocationId: string,
  legacyPrefix?: string,
) {
  return db
    .selectFrom('brokered_tool_approvals')
    .selectAll()
    .where('binding_digest', '=', digest)
    .where('status', '=', 'consumed')
    .where(matchesInvocation(invocationId, legacyPrefix))
    .executeTakeFirst();
}

/** Durable consent only. Callers must revalidate authority and the provider snapshot
 * before dispatch; creating or deciding a record never executes an operation. */
export function createBrokeredToolApprovalStore(db: Kysely<Database>, now = Date.now) {
  return {
    async createOrFindPending(
      input: BrokeredToolApprovalInput,
      legacyPrefix?: string,
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
        const consumed = await findConsumed(tx, digest, input.invocationId, legacyPrefix);
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
        ) on conflict (binding_digest) where status <> 'consumed' or (scope in ('session', 'project')
          and scope_saved = false and consumed_invocation_id is null)
          do update set binding_digest = excluded.binding_digest returning *`.execute(tx);
        return record(result.rows[0]!);
      });
    },
    async findStandingAuthorizationBlock(
      input: BrokeredToolApprovalBinding,
      invocationId: string,
      legacyPrefix?: string,
    ): Promise<BrokeredToolApprovalRecord | undefined> {
      const digest = bindingDigest(input);
      const row = await db
        .selectFrom('brokered_tool_approvals')
        .selectAll()
        .where('binding_digest', '=', digest)
        .where((eb) =>
          eb.or([
            eb('status', 'in', ['pending', 'denied']),
            eb.and([eb('status', '=', 'consumed'), matchesInvocation(invocationId, legacyPrefix)]),
          ]),
        )
        .orderBy(sql`status = 'consumed'`, 'desc')
        .executeTakeFirst();
      return row && record(row);
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
    async listUnrecordedDecisions(sessionId: string): Promise<BrokeredToolApprovalRecord[]> {
      const rows = await sql<ApprovalRow>`
        select approval.*
        from brokered_tool_approvals approval
        where approval.session_id = ${sessionId} and approval.decided_at is not null
          and (approval.status = 'denied' or approval.scope = 'once' or approval.scope_saved)
          and exists (
            select 1 from events
            where session_id = approval.session_id and type = 'permission'
              and payload->>'id' = approval.id and payload ? 'secretSource'
          )
          and not exists (
            select 1 from events
            where session_id = approval.session_id and type = 'notice'
              and payload->'secretApproval'->>'id' = approval.id
          )
        order by approval.decided_at, approval.id
      `.execute(db);
      return rows.rows.map(record);
    },
    async listApproved(sessionId: string): Promise<BrokeredToolApprovalRecord[]> {
      const rows = await db
        .selectFrom('brokered_tool_approvals')
        .selectAll()
        .where('session_id', '=', sessionId)
        .where((eb) =>
          eb.or([
            eb.and([eb('status', '=', 'approved'), eb('scope', '=', 'once')]),
            eb.and([
              eb('status', '=', 'consumed'),
              eb('consumed_invocation_id', 'is', null),
              eb('scope_saved', '=', true),
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
              eb.or([
                eb('status', '=', 'approved'),
                eb.and([
                  eb('status', '=', 'consumed'),
                  eb('scope', 'in', ['session', 'project']),
                  eb('scope_saved', '=', false),
                  eb('consumed_invocation_id', 'is', null),
                ]),
              ]),
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
                eb.or([
                  eb('status', '=', 'approved'),
                  eb.and([
                    eb('status', '=', 'consumed'),
                    eb('scope', 'in', ['session', 'project']),
                    eb('scope_saved', '=', false),
                    eb('consumed_invocation_id', 'is', null),
                  ]),
                ]),
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
    async markScopedSaved(id: string, sessionId: string): Promise<void> {
      await db
        .updateTable('brokered_tool_approvals')
        .set({ scope_saved: true })
        .where('id', '=', id)
        .where('session_id', '=', sessionId)
        .where('status', '=', 'consumed')
        .where('scope', 'in', ['session', 'project'])
        .where('consumed_invocation_id', 'is', null)
        .execute();
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
        .where('scope_saved', '=', false)
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
          .$if(invocationId !== undefined, (query) => query.where('scope', '=', 'once'))
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
