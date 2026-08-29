import { createHash, randomBytes } from 'node:crypto';

import {
  runGrantClaimsSchema,
  runGrantRedemptionSchema,
  secretEnvelopeSchema,
  canonicalJson,
  type RunGrantClaims,
  type RunGrantRedemption,
  type SecretEnvelope,
} from '@verity/secret-contracts';
import type { Database } from '@verity/store';
import type { Kysely } from 'kysely';

import type { SecretAuditRecorder } from './secret-audit-recorder.js';
import type { SecretAuditTxn } from './secret-audit-log.js';

const GRANT_CAPABILITY_BYTES = 32;

/**
 * Hook the grant store invokes INSIDE the insert's transaction to co-commit an audit event with the
 * grant row. `txn` is the store's transaction (undefined for the in-memory store); a throw rolls the
 * insert back, so a grant row never exists without its `grant_issued` event.
 */
export type SecretGrantIssueRecorder = (txn: SecretAuditTxn | undefined) => Promise<void>;

export type GrantCapabilityRecord = {
  capabilityHash: string;
  claims: RunGrantClaims;
  consumedAt?: string;
};

/** Atomic persistence boundary. Production implementations must use one conditional DB update. */
export interface SecretGrantStore {
  insert(record: GrantCapabilityRecord, recordInTx?: SecretGrantIssueRecorder): Promise<void>;
  consume(capabilityHash: string, consumedAt: string): Promise<GrantCapabilityRecord | undefined>;
  purgeExpired(before: string): Promise<number>;
}

export type SecretGrantIssue = { capability: string; claims: RunGrantClaims };

export type ResolvedSecrets = ReadonlyMap<string, Uint8Array> & {
  /**
   * Releases resolver-owned plaintext after sealing. Resolvers that return cached/shared buffers
   * must omit this hook; the broker never mutates an ordinary map supplied by a collaborator.
   */
  dispose?: () => void;
};
export type SecretResolver = (claims: RunGrantClaims) => Promise<ResolvedSecrets>;
export type SecretEnvelopeSealer = (
  claims: RunGrantClaims,
  redemption: RunGrantRedemption,
  secrets: ReadonlyMap<string, Uint8Array>,
) => Promise<SecretEnvelope>;
export type WorkloadAuthorizer = (
  claims: RunGrantClaims,
  redemption: RunGrantRedemption,
) => Promise<boolean>;

export class SecretGrantRejectedError extends Error {}

function hashCapability(capability: string): string {
  return createHash('sha256')
    .update(`verity.secret-grant-capability.v1\0${capability}`)
    .digest('hex');
}

/**
 * Canonical additional-authenticated-data (AAD) pre-image for a sealed envelope.
 * This exact byte string is fed to AES-256-GCM as associated data by the real
 * envelope sealer, so the GCM tag cryptographically binds the full grant/job
 * context — not merely its hash. {@link secretEnvelopeAadHash} is the SHA-256 of
 * this pre-image; the envelope carries only the hash for cheap comparison, while
 * the recipient reconstructs this pre-image from the claims it already holds to
 * both authenticate and decrypt. Domain-separated and versioned so the encoding
 * can rotate without colliding with any other hash input.
 */
export function secretEnvelopeAad(claims: RunGrantClaims, redemption: RunGrantRedemption): string {
  return `verity.secret-envelope-aad.v1\0${canonicalJson({
    grantId: claims.grantId,
    requestHash: claims.requestHash,
    projectId: claims.projectId,
    profile: claims.profile,
    aliases: claims.aliases,
    providerBindings: claims.providerBindings,
    snapshotId: claims.snapshotId ?? null,
    // The grant's authoritative expiry is authenticated by the GCM tag so a recipient cannot
    // extend an envelope's life by editing its (unauthenticated) wire copy of expiresAt.
    expiresAt: claims.expiresAt,
    jobId: redemption.jobId,
    workload: redemption.workload,
  })}`;
}

export function secretEnvelopeAadHash(
  claims: RunGrantClaims,
  redemption: RunGrantRedemption,
): string {
  return createHash('sha256').update(secretEnvelopeAad(claims, redemption)).digest('hex');
}

export function createInMemorySecretGrantStore(): SecretGrantStore {
  const records = new Map<string, GrantCapabilityRecord>();
  return {
    async insert(record, recordInTx) {
      if (records.has(record.capabilityHash)) {
        throw new Error('duplicate grant capability');
      }
      records.set(record.capabilityHash, structuredClone(record));
      // No transaction in memory (non-durable/test-only): pass undefined so the recorder appends
      // best-effort. Only the Postgres store gives the co-commit rollback guarantee.
      if (recordInTx !== undefined) {
        try {
          await recordInTx(undefined);
        } catch (error) {
          records.delete(record.capabilityHash);
          throw error;
        }
      }
    },
    consume(capabilityHash, consumedAt) {
      const record = records.get(capabilityHash);
      if (record === undefined || record.consumedAt !== undefined) {
        return Promise.resolve(undefined);
      }
      record.consumedAt = consumedAt;
      return Promise.resolve(structuredClone(record));
    },
    purgeExpired(before) {
      let removed = 0;
      for (const [hash, record] of records) {
        if (Date.parse(record.claims.expiresAt) <= Date.parse(before)) {
          records.delete(hash);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
  };
}

export function createPostgresSecretGrantStore(db: Kysely<Database>): SecretGrantStore {
  return {
    async insert(record, recordInTx) {
      const runInsert = async (exec: Kysely<Database>): Promise<void> => {
        await exec
          .insertInto('secret_run_grants')
          .values({
            capability_hash: record.capabilityHash,
            grant_id: record.claims.grantId,
            claims_json: JSON.stringify(record.claims),
            expires_at: record.claims.expiresAt,
            consumed_at: null,
          })
          .execute();
        // Co-commit the audit event with the grant row: a failure rolls the insert back, so a live
        // capability never exists unaudited.
        if (recordInTx !== undefined) await recordInTx(exec);
      };
      // A dedicated transaction only when co-committing an audit event; otherwise a bare insert.
      if (recordInTx !== undefined) {
        await db.transaction().execute(runInsert);
      } else {
        await runInsert(db);
      }
    },
    async consume(capabilityHash, consumedAt) {
      const row = await db
        .updateTable('secret_run_grants')
        .set({ consumed_at: consumedAt })
        .where('capability_hash', '=', capabilityHash)
        .where('consumed_at', 'is', null)
        .returning(['capability_hash', 'claims_json', 'consumed_at'])
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        capabilityHash: row.capability_hash,
        claims: runGrantClaimsSchema.parse(JSON.parse(row.claims_json) as unknown),
        consumedAt,
      };
    },
    async purgeExpired(before) {
      const deleted = await db
        .deleteFrom('secret_run_grants')
        .where('expires_at', '<=', new Date(before))
        .returning('capability_hash')
        .execute();
      return deleted.length;
    },
  };
}

export function createSecretGrantBroker(options: {
  store: SecretGrantStore;
  resolveSecrets: SecretResolver;
  sealEnvelope: SecretEnvelopeSealer;
  authorizeWorkload: WorkloadAuthorizer;
  authorizeCurrentClaims: (claims: RunGrantClaims) => Promise<boolean>;
  /** Final authorization after resolution, immediately before plaintext reaches the sealer. */
  authorizeResolvedClaims?: (claims: RunGrantClaims) => Promise<boolean>;
  /**
   * Optional provenance recorder; when present, each redemption outcome with known claims is
   * audited (grant_redeemed / grant_redemption_refused). An unknown/replayed capability has no
   * claims to project safely and is deliberately left unaudited.
   */
  recorder?: SecretAuditRecorder;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  return {
    async issue(
      unparsedClaims: RunGrantClaims,
      recordInTx?: SecretGrantIssueRecorder,
    ): Promise<SecretGrantIssue> {
      const claims = runGrantClaimsSchema.parse(unparsedClaims);
      const instant = now();
      if (Date.parse(claims.issuedAt) > instant.getTime()) {
        throw new SecretGrantRejectedError('grant issue time is in the future');
      }
      if (Date.parse(claims.expiresAt) <= instant.getTime()) {
        throw new SecretGrantRejectedError('grant is already expired');
      }
      const capability = randomBytes(GRANT_CAPABILITY_BYTES).toString('base64url');
      // The audit event co-commits with the grant insert (see SecretGrantStore.insert).
      await options.store.insert(
        { capabilityHash: hashCapability(capability), claims },
        recordInTx,
      );
      return { capability, claims };
    },

    async redeem(capability: string, unparsedRedemption: RunGrantRedemption) {
      const redemption = runGrantRedemptionSchema.parse(unparsedRedemption);
      const instant = now();
      // Consume first: every presented valid capability gets at most one attempt, including failures.
      const record = await options.store.consume(hashCapability(capability), instant.toISOString());
      // No claims to project safely for an unknown/replayed capability, so this path is unaudited.
      if (record === undefined) throw new SecretGrantRejectedError('unknown or consumed grant');
      const { claims } = record;
      const at = instant.toISOString();
      // The capability is already consumed; record the authoritative outcome once it is known. The
      // The recorder's configured failure mode decides whether audit persistence is best-effort or
      // fail-closed. Every post-consume failure is an authoritative refused redemption, including
      // provider/transport faults: claims are known, the capability is burned, and omitting that
      // attempt would leave a gap in the security audit.
      let envelope: SecretEnvelope;
      try {
        if (Date.parse(claims.expiresAt) <= instant.getTime()) {
          throw new SecretGrantRejectedError('grant expired');
        }
        if (
          redemption.grantId !== claims.grantId ||
          redemption.requestHash !== claims.requestHash ||
          redemption.workload.jobId !== redemption.jobId
        ) {
          throw new SecretGrantRejectedError('redemption context mismatch');
        }
        if (!(await options.authorizeCurrentClaims(claims))) {
          throw new SecretGrantRejectedError('grant claims are revoked');
        }
        if (!(await options.authorizeWorkload(claims, redemption))) {
          throw new SecretGrantRejectedError('workload identity rejected');
        }
        const secrets = await options.resolveSecrets(claims);
        try {
          // This is the one-time-use boundary: provider failures above do not consume a permission,
          // but once plaintext is handed to the trusted sealer it has been used. A sealing failure
          // deliberately does not restore the permission, preventing repeated plaintext delivery
          // to a faulty or compromised sealer.
          if (
            options.authorizeResolvedClaims !== undefined &&
            !(await options.authorizeResolvedClaims(claims))
          ) {
            throw new SecretGrantRejectedError('grant claims are no longer authorized');
          }
          envelope = secretEnvelopeSchema.parse(
            await options.sealEnvelope(claims, redemption, secrets),
          );
        } finally {
          // The resolver explicitly owns disposal. Ordinary maps may contain cached/shared bytes
          // and are never mutated by the broker. Cleanup is best-effort and must not replace the
          // authoritative sealing outcome; resolver implementations must make disposal idempotent.
          try {
            secrets.dispose?.();
          } catch {
            // A cleanup hook has no secret-safe diagnostic surface here.
          }
        }
        if (
          envelope.grantId !== claims.grantId ||
          envelope.jobId !== redemption.jobId ||
          envelope.recipientKeyId !== redemption.workload.publicKeyId ||
          envelope.aadHash !== secretEnvelopeAadHash(claims, redemption) ||
          Date.parse(envelope.expiresAt) <= instant.getTime() ||
          Date.parse(envelope.expiresAt) > Date.parse(claims.expiresAt)
        ) {
          throw new SecretGrantRejectedError('envelope context mismatch');
        }
      } catch (error) {
        await options.recorder?.redemptionRefused({ claims, jobId: redemption.jobId, at });
        throw error;
      }
      // A failed success-audit is not a refused redemption: the envelope was already produced.
      await options.recorder?.redeemed({ claims, jobId: redemption.jobId, at });
      return envelope;
    },
  };
}
