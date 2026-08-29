import { createHash, randomBytes } from 'node:crypto';

import {
  approvalRecordSchema,
  canonicalJson,
  executionProfileRecordSchema,
  runGrantClaimsSchema,
  secretAliasRecordSchema,
  secretCatalogResponseSchema,
  secretContractIdSchema,
  secretToolInvocationSchema,
  sha256HexSchema,
  type ApprovalRecord,
  type ExecutionProfileRecord,
  type RunGrantClaims,
  type SecretAliasRecord,
  type SecretCatalogResponse,
  type SecretToolInvocation,
} from '@verity/secret-contracts';
import type { Database } from '@verity/store';
import { sql, type Kysely } from 'kysely';

import type { SecretAuditRecorder } from './secret-audit-recorder.js';
import type { SecretAuditTxn } from './secret-audit-log.js';
import type { SecretGrantIssueRecorder } from './secret-grant-broker.js';

export type FakeRestrictedCatalogEntry = {
  profile: ExecutionProfileRecord;
  aliases: readonly SecretAliasRecord[];
};

type PendingApproval = {
  id: string;
  projectId: string;
  sessionId: string;
  toolCallId: string;
  claims: RunGrantClaims;
};
type DecidedApproval = { approval: ApprovalRecord; claims: RunGrantClaims };

/**
 * Hook the store invokes, inside the decision's transaction and ONLY on a fresh decision (never an
 * idempotent replay), to co-commit an audit event. `txn` is the store's transaction (undefined for
 * the in-memory store); a throw here rolls the decision back.
 */
export type SecretDecisionRecorder = (
  txn: SecretAuditTxn | undefined,
  decided: DecidedApproval,
) => Promise<void>;
export type AuthenticatedApprovalActor = { actorId: string; authorizationHash: string };

export interface SecretApprovalStore {
  /**
   * Insert a pending approval, or return the existing approval for the same trusted tool-call
   * identity when its canonical request hash matches. A mismatched replay fails closed.
   */
  insert(
    pending: PendingApproval,
    requesterAuthorizationHash: string,
  ): Promise<{ approvalId: string }>;
  decide(
    id: string,
    actorId: string,
    authorizationHash: string,
    approved: boolean,
    decidedAt: string | (() => string),
    recordInTx?: SecretDecisionRecorder,
    finalizeClaims?: (
      claims: RunGrantClaims,
      approved: boolean,
      decidedAt: string,
    ) => RunGrantClaims,
  ): Promise<DecidedApproval>;
  reserveGrantIssue(id: string, transaction?: SecretAuditTxn): Promise<void>;
}

export interface SecretGrantIssuer {
  /**
   * Insert exactly one grant and invoke `commit` exactly once inside the same transaction.
   * Returning without invoking it violates the issuer contract: approval reservation and grant
   * persistence are one atomic boundary.
   */
  issue(
    claims: RunGrantClaims,
    commit: SecretGrantIssueRecorder,
  ): Promise<{ capability: string; claims: RunGrantClaims }>;
}

export class SecretAuthorizationRejectedError extends Error {}

function sha256(preimage: string): string {
  return createHash('sha256').update(preimage).digest('hex');
}

function requestHash(invocation: SecretToolInvocation): string {
  return sha256(`verity.secret-tool-request.v1\0${canonicalJson(invocation)}`);
}

function makeApproval(
  record: PendingApproval,
  actorId: string,
  authorizationHash: string,
  approved: boolean,
  decidedAt: string,
): ApprovalRecord {
  const decision = approved ? 'approved' : 'denied';
  return approvalRecordSchema.parse({
    id: record.id,
    projectId: record.projectId,
    sessionId: record.sessionId,
    toolCallId: record.toolCallId,
    actorId,
    decision,
    decidedAt,
    decisionHash: sha256(
      `verity.secret-approval.v1\0${canonicalJson({
        id: record.id,
        actorId,
        authorizationHash,
        decision,
        decidedAt,
        grantClaims: record.claims,
      })}`,
    ),
  });
}

function validatePendingContext(record: PendingApproval): void {
  if (
    record.projectId !== record.claims.projectId ||
    record.sessionId !== record.claims.sessionId ||
    record.toolCallId !== record.claims.toolCallId
  ) {
    throw new SecretAuthorizationRejectedError('approval context does not match claims');
  }
}

export function createInMemorySecretApprovalStore(): SecretApprovalStore {
  type BoundPendingApproval = PendingApproval & { requesterAuthorizationHash: string };
  const pending = new Map<string, BoundPendingApproval>();
  const decided = new Map<
    string,
    DecidedApproval & { grantIssueReserved: boolean; requesterAuthorizationHash: string }
  >();
  return {
    insert(record, requesterAuthorizationHash) {
      validatePendingContext(record);
      const validatedRequesterHash = sha256HexSchema.parse(requesterAuthorizationHash);
      const existing = [...pending.values()].find(
        (candidate) =>
          candidate.projectId === record.projectId &&
          candidate.sessionId === record.sessionId &&
          candidate.toolCallId === record.toolCallId &&
          candidate.claims.turnId === record.claims.turnId,
      );
      if (existing !== undefined) {
        if (
          existing.claims.requestHash !== record.claims.requestHash ||
          existing.requesterAuthorizationHash !== validatedRequesterHash
        ) {
          return Promise.reject(
            new SecretAuthorizationRejectedError('tool call approval replay does not match'),
          );
        }
        return Promise.resolve({ approvalId: existing.id });
      }
      const decidedExisting = [...decided.values()].find(
        (candidate) =>
          candidate.claims.projectId === record.projectId &&
          candidate.claims.sessionId === record.sessionId &&
          candidate.claims.toolCallId === record.toolCallId &&
          candidate.claims.turnId === record.claims.turnId,
      );
      if (decidedExisting !== undefined) {
        if (
          decidedExisting.claims.requestHash !== record.claims.requestHash ||
          decidedExisting.requesterAuthorizationHash !== validatedRequesterHash
        ) {
          return Promise.reject(
            new SecretAuthorizationRejectedError('tool call approval replay does not match'),
          );
        }
        return Promise.resolve({ approvalId: decidedExisting.approval.id });
      }
      if (pending.has(record.id) || decided.has(record.id)) {
        return Promise.reject(new Error('duplicate approval'));
      }
      pending.set(
        record.id,
        structuredClone({ ...record, requesterAuthorizationHash: validatedRequesterHash }),
      );
      return Promise.resolve({ approvalId: record.id });
    },
    async decide(id, actorId, authorizationHash, approved, decidedAt, recordInTx, finalizeClaims) {
      const record = pending.get(id);
      if (record === undefined) {
        const prior = decided.get(id);
        if (
          prior !== undefined &&
          !prior.grantIssueReserved &&
          prior.approval.actorId === actorId &&
          prior.approval.decision === (approved ? 'approved' : 'denied')
        ) {
          // Idempotent replay: the decision (and its audit event) already happened — do not re-emit.
          return structuredClone(prior);
        }
        throw new SecretAuthorizationRejectedError('unknown or decided approval');
      }
      const resolvedDecidedAt = typeof decidedAt === 'function' ? decidedAt() : decidedAt;
      const finalizedClaims =
        finalizeClaims !== undefined
          ? runGrantClaimsSchema.parse(finalizeClaims(record.claims, approved, resolvedDecidedAt))
          : record.claims;
      const finalized = { ...record, claims: finalizedClaims };
      validatePendingContext(finalized);
      pending.delete(id);
      const approval = makeApproval(
        finalized,
        actorId,
        authorizationHash,
        approved,
        resolvedDecidedAt,
      );
      const terminal = {
        approval,
        claims: finalizedClaims,
        grantIssueReserved: false,
        requesterAuthorizationHash: record.requesterAuthorizationHash,
      };
      decided.set(id, terminal);
      // No transaction in memory; pass undefined so the recorder appends best-effort. This store is
      // non-durable/test-only and NOT atomic: the maps above are already mutated, so a hook that
      // rejected would leave the decision applied. Only the Postgres store gives the co-commit
      // rollback guarantee; production always pairs this with the best-effort (undefined-txn) recorder.
      if (recordInTx !== undefined) {
        await recordInTx(undefined, { approval, claims: finalizedClaims });
      }
      return structuredClone(terminal);
    },
    reserveGrantIssue(id) {
      const record = decided.get(id);
      if (
        record === undefined ||
        record.approval.decision !== 'approved' ||
        record.grantIssueReserved
      ) {
        return Promise.reject(new SecretAuthorizationRejectedError('grant issue is not available'));
      }
      record.grantIssueReserved = true;
      return Promise.resolve();
    },
  };
}

export function createPostgresSecretApprovalStore(db: Kysely<Database>): SecretApprovalStore {
  return {
    async insert(record, requesterAuthorizationHash) {
      validatePendingContext(record);
      const validatedRequesterHash = sha256HexSchema.parse(requesterAuthorizationHash);
      return db.transaction().execute(async (trx) => {
        const identity = canonicalJson({
          projectId: record.projectId,
          sessionId: record.sessionId,
          turnId: record.claims.turnId,
          toolCallId: record.toolCallId,
        });
        await sql`select pg_advisory_xact_lock(hashtextextended(${identity}, 0))`.execute(trx);
        const candidates = await trx
          .selectFrom('secret_approvals')
          .select(['id', 'claims_json', 'state', 'requester_authorization_hash'])
          .where('project_id', '=', record.projectId)
          .where('session_id', '=', record.sessionId)
          .where('tool_call_id', '=', record.toolCallId)
          .orderBy('created_at', 'asc')
          .execute();
        let existing = candidates
          .map((candidate) => ({
            ...candidate,
            claims: runGrantClaimsSchema.parse(JSON.parse(candidate.claims_json) as unknown),
          }))
          .find((candidate) => candidate.claims.turnId === record.claims.turnId);
        if (existing !== undefined) {
          if (existing.requester_authorization_hash === null && existing.state === 'pending') {
            await trx
              .updateTable('secret_approvals')
              .set({ requester_authorization_hash: validatedRequesterHash })
              .where('id', '=', existing.id)
              .where('state', '=', 'pending')
              .where('requester_authorization_hash', 'is', null)
              .execute();
            existing = {
              ...existing,
              requester_authorization_hash: validatedRequesterHash,
            };
          }
          if (
            existing.claims.requestHash !== record.claims.requestHash ||
            existing.requester_authorization_hash !== validatedRequesterHash
          ) {
            throw new SecretAuthorizationRejectedError('tool call approval replay does not match');
          }
          return { approvalId: existing.id };
        }
        await trx
          .insertInto('secret_approvals')
          .values({
            id: record.id,
            project_id: record.projectId,
            session_id: record.sessionId,
            tool_call_id: record.toolCallId,
            claims_json: JSON.stringify(record.claims),
            state: 'pending',
            actor_id: null,
            requester_authorization_hash: validatedRequesterHash,
            authorization_hash: null,
            decision_hash: null,
            decided_at: null,
          })
          .execute();
        return { approvalId: record.id };
      });
    },
    async decide(id, actorId, authorizationHash, approved, decidedAt, recordInTx, finalizeClaims) {
      return db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('secret_approvals')
          .selectAll()
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) {
          throw new SecretAuthorizationRejectedError('unknown or decided approval');
        }
        const claims = runGrantClaimsSchema.parse(JSON.parse(row.claims_json) as unknown);
        const pending: PendingApproval = {
          id: row.id,
          projectId: row.project_id,
          sessionId: row.session_id,
          toolCallId: row.tool_call_id,
          claims,
        };
        validatePendingContext(pending);
        if (!['pending', 'approved', 'denied', 'issue_reserved'].includes(row.state)) {
          throw new SecretAuthorizationRejectedError('invalid persisted approval state');
        }
        const expectedDecision = approved ? 'approved' : 'denied';
        if (row.state !== 'pending') {
          if (
            row.state === expectedDecision &&
            row.actor_id === actorId &&
            row.authorization_hash === authorizationHash &&
            row.decision_hash !== null &&
            row.decided_at !== null
          ) {
            const approval = makeApproval(
              pending,
              actorId,
              authorizationHash,
              approved,
              row.decided_at.toISOString(),
            );
            if (approval.decisionHash !== row.decision_hash) {
              throw new SecretAuthorizationRejectedError('persisted approval hash mismatch');
            }
            return { approval, claims };
          }
          throw new SecretAuthorizationRejectedError('unknown or decided approval');
        }
        const resolvedDecidedAt = typeof decidedAt === 'function' ? decidedAt() : decidedAt;
        const finalizedClaims =
          finalizeClaims !== undefined
            ? runGrantClaimsSchema.parse(
                finalizeClaims(pending.claims, approved, resolvedDecidedAt),
              )
            : pending.claims;
        const finalized = { ...pending, claims: finalizedClaims };
        validatePendingContext(finalized);
        const approval = makeApproval(
          finalized,
          actorId,
          authorizationHash,
          approved,
          resolvedDecidedAt,
        );
        await trx
          .updateTable('secret_approvals')
          .set({
            state: approval.decision,
            actor_id: actorId,
            authorization_hash: authorizationHash,
            decision_hash: approval.decisionHash,
            decided_at: resolvedDecidedAt,
            claims_json: JSON.stringify(finalizedClaims),
          })
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        // Co-commit the audit event in this transaction: if it throws, the decision rolls back with
        // it. Only on the fresh decision — an idempotent replay above returns without re-emitting.
        if (recordInTx !== undefined) {
          await recordInTx(trx, { approval, claims: finalizedClaims });
        }
        return { approval, claims: finalizedClaims };
      });
    },
    async reserveGrantIssue(id, transaction) {
      if (transaction === undefined) {
        throw new SecretAuthorizationRejectedError(
          'durable grant reservation requires a shared transaction',
        );
      }
      const row = await transaction
        .updateTable('secret_approvals')
        .set({ state: 'issue_reserved' })
        .where('id', '=', id)
        .where('state', '=', 'approved')
        .returning('id')
        .executeTakeFirst();
      if (row === undefined) {
        throw new SecretAuthorizationRejectedError('grant issue is not available');
      }
    },
  };
}

export function createFakeSecretAuthorization(options: {
  projectId: string;
  catalogVersion: number;
  entries: readonly FakeRestrictedCatalogEntry[];
  approvals: SecretApprovalStore;
  grants: SecretGrantIssuer;
  authorizeApproval: (approvalId: string, actor: AuthenticatedApprovalActor) => Promise<boolean>;
  authorizeCurrentClaims: (claims: RunGrantClaims) => Promise<boolean>;
  validateParameters: (profileId: string, parameters: Readonly<Record<string, unknown>>) => boolean;
  /** Optional provenance recorder; when present, approval decisions and issuance are audited. */
  recorder?: SecretAuditRecorder;
  now?: () => Date;
  grantTtlMs?: number;
}) {
  const now = options.now ?? (() => new Date());
  const grantTtlMs = options.grantTtlMs ?? 60_000;
  const validatedEntries = options.entries.map((entry) => ({
    profile: executionProfileRecordSchema.parse(entry.profile),
    aliases: entry.aliases.map((alias) => secretAliasRecordSchema.parse(alias)),
  }));
  for (const entry of validatedEntries) {
    if (entry.profile.projectId !== options.projectId || entry.profile.trustMode !== 'restricted') {
      throw new SecretAuthorizationRejectedError('catalog profile is outside restricted project');
    }
    for (const alias of entry.aliases) {
      if (
        alias.projectId !== options.projectId ||
        alias.state !== 'active' ||
        alias.profile.id !== entry.profile.id ||
        alias.profile.version !== entry.profile.version ||
        alias.profile.policyHash !== entry.profile.policyHash
      ) {
        throw new SecretAuthorizationRejectedError('catalog alias does not match its profile');
      }
    }
  }
  const entries = new Map(validatedEntries.map((entry) => [entry.profile.id, entry]));
  if (entries.size !== validatedEntries.length) {
    throw new SecretAuthorizationRejectedError('duplicate catalog profile identity');
  }
  const aliasIdentities = new Set<string>();
  const aliasNames = new Set<string>();
  for (const entry of validatedEntries) {
    for (const alias of entry.aliases) {
      const identity = `${alias.id}:${alias.version}`;
      if (aliasIdentities.has(identity) || aliasNames.has(alias.name)) {
        throw new SecretAuthorizationRejectedError('duplicate catalog alias identity');
      }
      aliasIdentities.add(identity);
      aliasNames.add(alias.name);
    }
  }

  return {
    catalog(): SecretCatalogResponse {
      return secretCatalogResponseSchema.parse({
        protocolVersion: 1,
        catalogVersion: options.catalogVersion,
        items: validatedEntries.flatMap((entry) =>
          entry.aliases.map((alias) => ({
            alias: { id: alias.id, version: alias.version },
            name: alias.name,
            description: alias.description,
            injection: alias.injection,
            profile: alias.profile,
            trustMode: entry.profile.trustMode,
            requiresApproval: entry.profile.requiresApproval,
          })),
        ),
      });
    },

    async request(
      unparsed: SecretToolInvocation,
      requesterAuthorizationHash = requestHash(unparsed),
    ): Promise<{ approvalId: string }> {
      const invocation = secretToolInvocationSchema.parse(unparsed);
      const validatedRequesterHash = sha256HexSchema.parse(requesterAuthorizationHash);
      if (
        invocation.context.projectId !== options.projectId ||
        invocation.request.kind !== 'restricted'
      ) {
        throw new SecretAuthorizationRejectedError('invocation is outside fake restricted catalog');
      }
      const entry = entries.get(invocation.request.profile.id);
      if (
        entry === undefined ||
        entry.profile.projectId !== options.projectId ||
        entry.profile.state !== 'active' ||
        entry.profile.trustMode !== 'restricted' ||
        entry.profile.version !== invocation.request.profile.version ||
        entry.profile.policyHash !== invocation.request.profile.policyHash
      ) {
        throw new SecretAuthorizationRejectedError('profile is not an exact active catalog match');
      }
      if (!options.validateParameters(entry.profile.id, invocation.request.parameters)) {
        throw new SecretAuthorizationRejectedError('parameters rejected');
      }
      const instant = now();
      const approvalId = `approval-${randomBytes(16).toString('hex')}`;
      const pending = {
        id: approvalId,
        projectId: options.projectId,
        sessionId: invocation.context.sessionId,
        toolCallId: invocation.context.toolCallId,
      };
      const claims: RunGrantClaims = {
        protocolVersion: 1,
        grantId: `grant-${randomBytes(16).toString('hex')}`,
        requestHash: requestHash(invocation),
        projectId: options.projectId,
        sessionId: invocation.context.sessionId,
        turnId: invocation.context.turnId,
        toolCallId: invocation.context.toolCallId,
        profile: invocation.request.profile,
        executorImageDigest: entry.profile.imageDigest,
        aliases: entry.aliases.map((alias) => ({ id: alias.id, version: alias.version })),
        providerBindings: [
          ...new Map(
            entry.aliases.map((alias) => [
              `${alias.binding.id}:${alias.binding.version}`,
              alias.binding,
            ]),
          ).values(),
        ],
        snapshotId: invocation.request.snapshotId,
        audience: 'verity-secret-job-executor',
        issuedAt: instant.toISOString(),
        expiresAt: new Date(instant.getTime() + grantTtlMs).toISOString(),
        nonce: randomBytes(24).toString('base64url'),
      };
      return options.approvals.insert({ ...pending, claims }, validatedRequesterHash);
    },

    async decide(approvalId: string, actor: AuthenticatedApprovalActor, approved: boolean) {
      const validatedApprovalId = secretContractIdSchema.parse(approvalId);
      const validatedActor = {
        actorId: secretContractIdSchema.parse(actor.actorId),
        authorizationHash: sha256HexSchema.parse(actor.authorizationHash),
      };
      if (!(await options.authorizeApproval(validatedApprovalId, validatedActor))) {
        throw new SecretAuthorizationRejectedError('approval actor is not authorized');
      }
      const decidedAt = now().toISOString();
      const recorder = options.recorder;
      // Co-commit the audit event with the decision (same transaction, fresh decision only), so the
      // decision never commits without its event and an idempotent retry never re-emits it. actorHash
      // is the actor's authorization hash, never a raw id.
      const pending = await options.approvals.decide(
        validatedApprovalId,
        validatedActor.actorId,
        validatedActor.authorizationHash,
        approved,
        decidedAt,
        recorder === undefined
          ? undefined
          : (txn, decided) =>
              recorder.approvalDecided(
                {
                  claims: decided.claims,
                  approvalId: validatedApprovalId,
                  actorHash: validatedActor.authorizationHash,
                  approved,
                  at: decidedAt,
                },
                txn,
              ),
      );
      if (!approved) return { decision: 'denied' as const };
      if (!(await options.authorizeCurrentClaims(pending.claims))) {
        throw new SecretAuthorizationRejectedError('approved claims are no longer active');
      }
      if (Date.parse(pending.claims.expiresAt) <= now().getTime()) {
        throw new SecretAuthorizationRejectedError('approved claims are expired');
      }
      const approvedEntry = entries.get(pending.claims.profile.id);
      if (
        approvedEntry === undefined ||
        approvedEntry.profile.trustMode !== 'restricted' ||
        approvedEntry.profile.version !== pending.claims.profile.version ||
        approvedEntry.profile.policyHash !== pending.claims.profile.policyHash ||
        approvedEntry.profile.imageDigest !== pending.claims.executorImageDigest
      ) {
        throw new SecretAuthorizationRejectedError('approved profile is no longer available');
      }
      const claims = {
        ...pending.claims,
        approval: {
          id: pending.approval.id,
          actorId: pending.approval.actorId,
          decisionHash: pending.approval.decisionHash,
        },
      };
      const issuedAt = now().toISOString();
      let commitCompleted = false;
      const grant = await options.grants.issue(claims, async (txn) => {
        if (commitCompleted) {
          throw new SecretAuthorizationRejectedError('grant commit callback was repeated');
        }
        await recorder?.grantIssued({ claims, approvalId: validatedApprovalId, at: issuedAt }, txn);
        await options.approvals.reserveGrantIssue(validatedApprovalId, txn);
        commitCompleted = true;
      });
      if (!commitCompleted) {
        throw new SecretAuthorizationRejectedError('grant issuer skipped atomic commit');
      }
      return {
        decision: 'approved' as const,
        ...grant,
        claims: {
          ...grant.claims,
          executorImageDigest: pending.claims.executorImageDigest,
        },
      };
    },
  };
}
