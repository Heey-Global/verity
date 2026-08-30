import { createHash } from 'node:crypto';

import {
  SECRET_AUDIT_GENESIS_HASH,
  canonicalJson,
  secretAuditEventInputSchema,
  secretAuditEventMatchesQuery,
  secretAuditEventPreimage,
  secretAuditEventSchema,
  secretAuditQuerySchema,
  verifySecretAuditChain,
  type RunGrantClaims,
  type SecretAuditChainHead,
  type SecretAuditChainVerification,
  type SecretAuditEvent,
  type SecretAuditEventInput,
  type SecretAuditQuery,
} from '@verity/secret-contracts';
import type { Database } from '@verity/store';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/** The one hashing primitive the audit chain uses; also handed to the contract-level verifier. */
export function secretAuditSha256Hex(preimage: string): string {
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

/**
 * Persistent, append-only, hash-chained provenance trail for the Brokered Secrets control plane. The
 * log assigns each event its per-project sequence and `prevHash`, computes the `eventHash`, and
 * stores the canonical safe projection. It never persists a secret value — only the projection the
 * {@link secretAuditEventInputSchema} allows. {@link verifyChain} re-derives the whole chain to prove
 * nothing was deleted, reordered, or mutated.
 */
/** A Kysely db handle or an open transaction the append can co-commit within. */
export type SecretAuditTxn = Kysely<Database>;

export interface SecretAuditLog {
  /**
   * Append one event. Pass `txn` (an open transaction) to co-commit the event in the SAME
   * transaction as the state change it records — the append then does NOT open its own transaction,
   * and a failure propagates so the whole transaction rolls back (no state change without its
   * audit). Omit `txn` for a standalone, own-transaction append.
   */
  append(input: SecretAuditEventInput, txn?: SecretAuditTxn): Promise<SecretAuditEvent>;
  /**
   * Index-accelerated filtered read. Returned rows are re-checked against the hash-covered
   * event_json so a tampered index column cannot surface a false-positive match — but a filtered
   * result is NOT a completeness guarantee (a tampered index column could still hide a genuine row
   * from the SQL filter). Use {@link verifyChain}, which reads the full chain and ignores index
   * columns entirely, as the authoritative integrity/completeness read.
   */
  query(filter: SecretAuditQuery): Promise<SecretAuditEvent[]>;
  /**
   * Re-derive the whole chain to prove nothing was deleted, reordered, or mutated. Pass the last
   * head the caller trusts as `expectedHead` to also detect truncation of the newest events.
   */
  verifyChain(
    projectId: string,
    expectedHead?: SecretAuditChainHead,
  ): Promise<SecretAuditChainVerification>;
}

/**
 * Drop keys the caller set to an explicit `undefined`.
 *
 * Zod keeps such a key as present-but-undefined, and the gateway record is the one nested
 * object here — a rejection built as `{ toolName: parsed?.tool }` would otherwise reach
 * `canonicalJson`, which refuses `undefined` outright. Normalizing also keeps the hash
 * independent of whether a caller omitted a field or wrote it as undefined: the same
 * record has to hash the same way, or it stops comparing to itself.
 */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Build the full, hash-covered event from an assigned position and a validated input. */
function buildEvent(
  input: SecretAuditEventInput,
  sequence: number,
  prevHash: string,
): SecretAuditEvent {
  const base = {
    protocolVersion: 1 as const,
    sequence,
    projectId: input.projectId,
    kind: input.kind,
    ...(input.requestHash !== undefined ? { requestHash: input.requestHash } : {}),
    ...(input.grantId !== undefined ? { grantId: input.grantId } : {}),
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    aliases: input.aliases,
    providerBindings: input.providerBindings,
    ...(input.actorHash !== undefined ? { actorHash: input.actorHash } : {}),
    ...(input.gateway !== undefined ? { gateway: withoutUndefined(input.gateway) } : {}),
    recordedAt: input.recordedAt,
    prevHash,
  };
  // Reuse the contract pre-image so recorder and verifier hash identical bytes.
  const eventHash = secretAuditSha256Hex(secretAuditEventPreimage(base));
  return secretAuditEventSchema.parse({ ...base, eventHash });
}

/**
 * Append one event on the given executor (a db handle or an open transaction). Serializes appends
 * per project with an advisory lock so the sequence and hash chain stay strictly monotonic; the lock
 * releases when the enclosing transaction commits or rolls back. Callers that pass a shared
 * transaction get co-commit: if this throws, that transaction rolls back with the state change.
 */
async function appendEventWithin(
  exec: SecretAuditTxn,
  input: SecretAuditEventInput,
): Promise<SecretAuditEvent> {
  await sql`select pg_advisory_xact_lock(hashtext(${`verity.secret-audit:${input.projectId}`}))`.execute(
    exec,
  );
  const previous = await exec
    .selectFrom('secret_audit_events')
    .select(['sequence', 'event_hash'])
    .where('project_id', '=', input.projectId)
    .orderBy('sequence', 'desc')
    .limit(1)
    .executeTakeFirst();
  const event = buildEvent(
    input,
    previous ? previous.sequence + 1 : 0,
    previous ? previous.event_hash : SECRET_AUDIT_GENESIS_HASH,
  );
  await exec
    .insertInto('secret_audit_events')
    .values({
      project_id: event.projectId,
      sequence: event.sequence,
      kind: event.kind,
      request_hash: event.requestHash ?? null,
      // Denormalized for reconciliation reads only; the hash-covered `event_json` stays
      // the authority, and `query` re-applies the predicate to the parsed event.
      request_mac: event.gateway?.requestMac ?? null,
      grant_id: event.grantId ?? null,
      job_id: event.jobId ?? null,
      approval_id: event.approvalId ?? null,
      event_json: canonicalJson(event),
      prev_hash: event.prevHash,
      event_hash: event.eventHash,
      recorded_at: event.recordedAt,
    })
    .execute();
  return event;
}

/** In-memory reference implementation (tests). Not durable; single-process ordering only. */
export function createInMemorySecretAuditLog(): SecretAuditLog {
  const chains = new Map<string, SecretAuditEvent[]>();
  return {
    // The in-memory chain has no transactions; the optional co-commit `txn` is simply not declared
    // here and ignored (a fully in-memory wiring pairs this log with an in-memory state store).
    append(unparsed) {
      const input = secretAuditEventInputSchema.parse(unparsed);
      const chain = chains.get(input.projectId) ?? [];
      const previous = chain.at(-1);
      const event = buildEvent(
        input,
        previous ? previous.sequence + 1 : 0,
        previous ? previous.eventHash : SECRET_AUDIT_GENESIS_HASH,
      );
      chain.push(event);
      chains.set(input.projectId, chain);
      return Promise.resolve(event);
    },
    query(unparsed) {
      // Match the durable implementation's Promise contract even when validation
      // fails. Parsing before constructing the Promise throws synchronously and
      // bypasses callers' ordinary rejection handling.
      return Promise.resolve().then(() => {
        const filter = secretAuditQuerySchema.parse(unparsed);
        const chain = chains.get(filter.projectId) ?? [];
        const matched = chain.filter((event) => secretAuditEventMatchesQuery(event, filter));
        return matched.slice(0, filter.limit);
      });
    },
    verifyChain(projectId, expectedHead) {
      const chain = chains.get(projectId) ?? [];
      return Promise.resolve(verifySecretAuditChain(chain, secretAuditSha256Hex, expectedHead));
    },
  };
}

function rowToEvent(eventJson: string): SecretAuditEvent {
  return secretAuditEventSchema.parse(JSON.parse(eventJson));
}

export function createPostgresSecretAuditLog(db: Kysely<Database>): SecretAuditLog {
  return {
    async append(unparsed, txn) {
      const input = secretAuditEventInputSchema.parse(unparsed);
      // With a caller transaction, append within it (co-commit) — a failure rolls the whole
      // transaction back. Without one, open a dedicated transaction for a standalone append.
      if (txn !== undefined) return appendEventWithin(txn, input);
      return db.transaction().execute((tx) => appendEventWithin(tx, input));
    },
    async query(unparsed) {
      const filter = secretAuditQuerySchema.parse(unparsed);
      // The SQL WHERE only accelerates the read via the denormalized index columns; authority is the
      // hash-covered event_json. Re-apply the predicate to the parsed events so a tampered index
      // column can never surface a row whose true content does not match the filter. Validate before
      // applying the caller's limit: a forged false-positive index row must not consume the page and
      // hide a later authentic match. Read bounded candidate batches until the page is full or the
      // indexed result is exhausted.
      const matched: SecretAuditEvent[] = [];
      let cursor = filter.sinceSequence ?? -1;
      while (matched.length < filter.limit) {
        let statement = db
          .selectFrom('secret_audit_events')
          .select(['sequence', 'event_json'])
          .where('project_id', '=', filter.projectId)
          .where('sequence', '>', cursor);
        if (filter.kind !== undefined) statement = statement.where('kind', '=', filter.kind);
        if (filter.grantId !== undefined)
          statement = statement.where('grant_id', '=', filter.grantId);
        if (filter.jobId !== undefined) statement = statement.where('job_id', '=', filter.jobId);
        if (filter.requestHash !== undefined) {
          statement = statement.where('request_hash', '=', filter.requestHash);
        }
        if (filter.requestMac !== undefined) {
          statement = statement.where('request_mac', '=', filter.requestMac);
        }
        const rows = await statement.orderBy('sequence', 'asc').limit(filter.limit).execute();
        if (rows.length === 0) break;
        for (const row of rows) {
          cursor = row.sequence;
          const event = rowToEvent(row.event_json);
          if (secretAuditEventMatchesQuery(event, filter)) matched.push(event);
          if (matched.length === filter.limit) break;
        }
        if (rows.length < filter.limit) break;
      }
      return matched;
    },
    async verifyChain(projectId, expectedHead) {
      const rows = await db
        .selectFrom('secret_audit_events')
        .select('event_json')
        .where('project_id', '=', projectId)
        .orderBy('sequence', 'asc')
        .execute();
      return verifySecretAuditChain(
        rows.map((row) => rowToEvent(row.event_json)),
        secretAuditSha256Hex,
        expectedHead,
      );
    },
  };
}

/**
 * Extract the safe, non-secret projection every claims-derived audit event shares. Claims already
 * hold only opaque ids, versioned refs, and hashes — never a secret value — so this is a pure
 * narrowing that a caller extends with the event kind, job/approval id, actor hash, and timestamp.
 */
export function secretAuditProjectionFromClaims(
  claims: RunGrantClaims,
): Pick<
  SecretAuditEventInput,
  'projectId' | 'requestHash' | 'grantId' | 'profile' | 'aliases' | 'providerBindings'
> {
  return {
    projectId: claims.projectId,
    requestHash: claims.requestHash,
    grantId: claims.grantId,
    profile: claims.profile,
    aliases: [...claims.aliases],
    providerBindings: [...claims.providerBindings],
  };
}
