import type {
  ExecutionProfileRef,
  RunGrantClaims,
  SecretAuditEventInput,
  SecretAuditEventKind,
} from '@verity/secret-contracts';

import {
  secretAuditProjectionFromClaims,
  type SecretAuditLog,
  type SecretAuditTxn,
} from './secret-audit-log.js';

/** Context the one-job executor holds (no claims) for a job/cleanup event. */
type JobEventContext = {
  projectId: string;
  requestHash: string;
  grantId: string;
  jobId: string;
  profile?: ExecutionProfileRef;
};

function jobEventInput(
  ctx: JobEventContext,
  kind: SecretAuditEventKind,
  at: string,
): SecretAuditEventInput {
  // Built directly (the executor has no claims): only safe ids/refs. aliases/providerBindings are
  // empty here — the grant that named them was already recorded at issuance/redemption; this event
  // links back by grantId + jobId.
  return {
    projectId: ctx.projectId,
    kind,
    requestHash: ctx.requestHash,
    grantId: ctx.grantId,
    jobId: ctx.jobId,
    ...(ctx.profile !== undefined ? { profile: ctx.profile } : {}),
    aliases: [],
    providerBindings: [],
    recordedAt: at,
  };
}

/**
 * Typed facade that turns Brokered Secrets lifecycle transitions into safe {@link SecretAuditLog}
 * events. Each method derives the non-secret projection from the grant claims and appends exactly
 * one event, so callers never assemble raw audit rows (and can never smuggle a secret into one).
 *
 * The recorder is invoked AFTER the state change it witnesses commits — the append is not enlisted
 * in that change's transaction. Standalone appends are best-effort by default: an append failure can
 * only drop that one event (surfaced via `onError`), never break or roll back the already-committed
 * state change it records. Security-boundary composition may opt into `fail-closed`, which surfaces
 * the failure to the caller even though it cannot roll back that prior change. Grant issuance should
 * instead pass a transaction so the grant and audit event co-commit without an orphan window.
 * The trade-offs of this post-commit design: a crash strictly between the state change and the
 * append drops the event (the same completeness caveat a bare hash chain has for tail truncation;
 * see {@link verifySecretAuditChain}), and an idempotent retry of the state change re-emits a
 * duplicate. Making the append share the state-change transaction is a deliberate follow-up.
 */
export interface SecretAuditRecorder {
  /**
   * Record an approval decision. Pass `txn` to co-commit the event in the SAME transaction as the
   * decision — the append then propagates failures (rolling the decision back) instead of being
   * best-effort, so a decision never commits without its audit event.
   */
  approvalDecided(
    input: {
      claims: RunGrantClaims;
      approvalId: string;
      /** A hash of the deciding actor's authorization — never the raw actor id. */
      actorHash: string;
      approved: boolean;
      at: string;
    },
    txn?: SecretAuditTxn,
  ): Promise<void>;
  /**
   * Record a grant issuance. Pass `txn` to co-commit the event in the SAME transaction as the grant
   * insert — the append then propagates failures (rolling the insert back) instead of being
   * best-effort, so a live capability never exists without its `grant_issued` event.
   */
  grantIssued(
    input: { claims: RunGrantClaims; approvalId?: string; at: string },
    txn?: SecretAuditTxn,
  ): Promise<void>;
  /** A grant was redeemed and a secret envelope released to the workload's isolated job. */
  redeemed(input: { claims: RunGrantClaims; jobId: string; at: string }): Promise<void>;
  /** A redemption was refused (revoked, wrong workload, context/envelope mismatch, expired). */
  redemptionRefused(input: { claims: RunGrantClaims; jobId: string; at: string }): Promise<void>;
  /** A one-job executor's job reached a terminal outcome. */
  jobOutcome(
    input: JobEventContext & {
      outcome: 'succeeded' | 'failed' | 'cancelled' | 'deadline_exceeded';
      at: string;
    },
  ): Promise<void>;
  /** A one-job executor's sandbox was torn down. */
  cleanup(input: JobEventContext & { state: 'complete' | 'attention'; at: string }): Promise<void>;
}

export function createSecretAuditRecorder(
  log: SecretAuditLog,
  options: {
    onError?: (error: unknown) => void;
    /** Propagate a standalone append failure. Use at active security boundaries where continuing
     * without a durable audit receipt is less safe than surfacing the already-committed change. */
    failureMode?: 'best-effort' | 'fail-closed';
  } = {},
): SecretAuditRecorder {
  const onError = options.onError ?? (() => {});
  // A standalone append is best-effort unless the composition explicitly requires fail-closed
  // behavior. The latter surfaces the failure but cannot roll back a state change already committed;
  // callers that own a transaction should pass it below to obtain true atomicity.
  async function record(input: SecretAuditEventInput, txn?: SecretAuditTxn): Promise<void> {
    if (txn !== undefined) {
      // Co-commit: the append shares the caller's transaction, so a failure MUST propagate to roll
      // the state change back (no state change without its audit). Not best-effort here.
      await log.append(input, txn);
      return;
    }
    try {
      await log.append(input);
    } catch (error) {
      onError(error);
      if (options.failureMode === 'fail-closed') throw error;
    }
  }
  return {
    approvalDecided({ claims, approvalId, actorHash, approved, at }, txn) {
      return record(
        {
          ...secretAuditProjectionFromClaims(claims),
          kind: approved ? 'approval_approved' : 'approval_denied',
          approvalId,
          actorHash,
          recordedAt: at,
        },
        txn,
      );
    },
    grantIssued({ claims, approvalId, at }, txn) {
      return record(
        {
          ...secretAuditProjectionFromClaims(claims),
          kind: 'grant_issued',
          ...(approvalId !== undefined ? { approvalId } : {}),
          recordedAt: at,
        },
        txn,
      );
    },
    redeemed({ claims, jobId, at }) {
      return record({
        ...secretAuditProjectionFromClaims(claims),
        kind: 'grant_redeemed',
        jobId,
        recordedAt: at,
      });
    },
    redemptionRefused({ claims, jobId, at }) {
      return record({
        ...secretAuditProjectionFromClaims(claims),
        kind: 'grant_redemption_refused',
        jobId,
        recordedAt: at,
      });
    },
    jobOutcome({ outcome, at, ...ctx }) {
      // A deadline exceedance is audited as a failure — the trail has no separate deadline kind.
      const kind =
        outcome === 'succeeded'
          ? 'job_succeeded'
          : outcome === 'cancelled'
            ? 'job_cancelled'
            : 'job_failed';
      return record(jobEventInput(ctx, kind, at));
    },
    cleanup({ state, at, ...ctx }) {
      return record(
        jobEventInput(ctx, state === 'complete' ? 'cleanup_complete' : 'cleanup_attention', at),
      );
    },
  };
}
