import { randomBytes } from 'node:crypto';

import {
  secretContractIdSchema,
  secretJobStartRequestSchema,
  sha256HexSchema,
  type SecretJobState,
  type SecretJobTerminalResult,
  type SecretToolInvocation,
} from '@verity/secret-contracts';

import type { BrokeredSecretJobExecutor } from './brokered-secret-job-executor.js';
import type { AuthenticatedApprovalActor } from './secret-authorization.js';
import type { SecretJobFrameSpool, SecretJobFrameSpoolPage } from './secret-job-frame-spool.js';
import type { SecretJobGrant } from './secret-job-grant-resolver.js';
import { createInMemorySecretJobStore, type SecretJobStore } from './secret-job-store.js';

export interface SecretJobAuthorization {
  request(
    invocation: SecretToolInvocation,
    requesterAuthorizationHash: string,
  ): Promise<{ approvalId: string }>;
  decide(
    approvalId: string,
    actor: AuthenticatedApprovalActor,
    approved: boolean,
  ): Promise<
    | { decision: 'denied' }
    | {
        decision: 'approved';
        capability: string;
        claims: SecretJobGrant['claims'] & { executorImageDigest: string };
      }
  >;
}

export type SecretJobLaunchInput =
  | { approvalId: string; actor: AuthenticatedApprovalActor; approved: false }
  | {
      approvalId: string;
      actor: AuthenticatedApprovalActor;
      approved: true;
      jobId: string;
      absoluteDeadline: string;
    };

export type SecretJobLaunchResponse =
  | { decision: 'denied' }
  | {
      decision: 'approved';
      jobId: string;
      state: 'pending' | 'running';
    };

export interface SecretJobStatus {
  jobId: string;
  state: SecretJobState;
  result?: SecretJobTerminalResult;
}

export class SecretJobServiceRejectedError extends Error {}

/**
 * Approval-to-execution boundary for restricted Secret Jobs.
 *
 * The capability returned by authorization is handed directly to the executor and is never
 * returned to a transport caller. Every launch field that overlaps the grant is derived from the
 * approved profile and signed claims; callers control only the fresh job id and a deadline no later
 * than the grant expiry. In particular, image selection is owned by authorization and cannot be
 * substituted by the approval transport.
 */
export function createSecretJobService(options: {
  authorization: SecretJobAuthorization;
  executor: BrokeredSecretJobExecutor;
  frames: SecretJobFrameSpool;
  store?: SecretJobStore;
  authorizeInvocation?: (
    actor: AuthenticatedApprovalActor,
    invocation: SecretToolInvocation,
  ) => Promise<boolean>;
  randomId?: () => string;
  now?: () => Date;
  /** Must exceed the longest permitted executor runtime; protects rolling-start overlap. */
  recoveryStaleAfterMs?: number;
  onExecutorError?: (jobId: string, error: unknown) => void;
}) {
  const randomId = options.randomId ?? (() => randomBytes(16).toString('hex'));
  const now = options.now ?? (() => new Date());
  const store = options.store ?? createInMemorySecretJobStore();
  const activeRuns = new Map<string, Promise<void>>();
  const recoveryInstant = now();
  const recoveryStaleAfterMs = options.recoveryStaleAfterMs ?? 3_600_000;
  const ready = store.recoverInterrupted(
    recoveryInstant.toISOString(),
    new Date(recoveryInstant.getTime() - recoveryStaleAfterMs).toISOString(),
  );
  const recoverStale = (): Promise<number> => {
    const instant = now();
    return store.recoverInterrupted(
      instant.toISOString(),
      new Date(instant.getTime() - recoveryStaleAfterMs).toISOString(),
    );
  };
  // Reconsider jobs that were deliberately protected during rolling-start overlap. `unref` keeps
  // this safety sweep from extending process shutdown; access paths also run the same recovery.
  const recoveryTimer = setTimeout(
    () => void recoverStale().catch((error: unknown) => reportError('startup-recovery', error)),
    recoveryStaleAfterMs,
  );
  recoveryTimer.unref();
  const reportError = (jobId: string, error: unknown): void => {
    try {
      options.onExecutorError?.(jobId, error);
    } catch {
      // Observability hooks must never turn an already handled executor failure into a process-wide
      // unhandled rejection.
    }
  };

  return {
    async request(
      invocation: SecretToolInvocation,
      actor: AuthenticatedApprovalActor,
    ): Promise<{ approvalId: string }> {
      await ready;
      if (
        options.authorizeInvocation !== undefined &&
        !(await options.authorizeInvocation(actor, invocation))
      ) {
        throw new SecretJobServiceRejectedError('secret job invocation rejected');
      }
      return options.authorization.request(invocation, actor.authorizationHash);
    },

    async decideAndStart(unparsed: SecretJobLaunchInput): Promise<SecretJobLaunchResponse> {
      await ready;
      const approvalId = secretContractIdSchema.parse(unparsed.approvalId);
      if (!unparsed.approved) {
        const decision = await options.authorization.decide(approvalId, unparsed.actor, false);
        if (decision.decision !== 'denied') {
          throw new SecretJobServiceRejectedError('denial produced an approved grant');
        }
        return decision;
      }
      const jobId = secretContractIdSchema.parse(unparsed.jobId);
      const deadlineMs = Date.parse(unparsed.absoluteDeadline);
      if (!Number.isFinite(deadlineMs)) {
        throw new SecretJobServiceRejectedError('invalid absolute deadline');
      }
      if (deadlineMs <= now().getTime()) {
        throw new SecretJobServiceRejectedError('job deadline already elapsed');
      }
      if (!(await store.reserve(jobId, unparsed.actor))) {
        throw new SecretJobServiceRejectedError('job id already exists');
      }
      let decision: Awaited<ReturnType<SecretJobAuthorization['decide']>>;
      try {
        decision = await options.authorization.decide(approvalId, unparsed.actor, true);
      } catch (error) {
        await store.delete(jobId);
        throw error;
      }
      if (decision.decision === 'denied') {
        await store.delete(jobId);
        return decision;
      }
      const absoluteDeadline = new Date(
        Math.min(deadlineMs, Date.parse(decision.claims.expiresAt)),
      ).toISOString();
      if (Date.parse(absoluteDeadline) <= now().getTime()) {
        await store.delete(jobId);
        throw new SecretJobServiceRejectedError('job deadline elapsed during approval');
      }

      let request;
      try {
        request = secretJobStartRequestSchema.parse({
          protocolVersion: 1,
          requestId: `request-${randomId()}`,
          projectId: decision.claims.projectId,
          requestHash: decision.claims.requestHash,
          jobId,
          grantId: decision.claims.grantId,
          profile: decision.claims.profile,
          ...(decision.claims.snapshotId !== undefined
            ? { snapshotId: decision.claims.snapshotId }
            : {}),
          executorImageDigest: sha256HexSchema.parse(decision.claims.executorImageDigest),
          absoluteDeadline,
        });
      } catch (error) {
        await store.delete(jobId);
        throw error;
      }
      const grant: SecretJobGrant = {
        capability: decision.capability,
        claims: decision.claims,
      };
      // Persist the accepted launch state before the executor can complete. Terminal updates are
      // therefore monotonic and can never be overwritten by a late pending/running write.
      // Approval/capability issuance is already single-use. If this write fails, preserve the
      // durable `authorizing` reservation so stale recovery can terminalize it; deleting it would
      // erase provenance and falsely make the consumed launch look retryable.
      await store.update(jobId, 'pending');
      const execution = Promise.resolve().then(() => options.executor.runJob(grant, request));
      const run = execution
        .then(
          (result) =>
            store.update(jobId, 'reaped', result).catch((error: unknown) => {
              // A persistence failure must not rewrite a known successful executor outcome as a
              // failed job. Leave the prior state for stale recovery and report the store failure.
              reportError(`${jobId}:terminal-persistence`, error);
            }),
          async (error: unknown) => {
            reportError(jobId, error);
            await store.update(jobId, 'reaped', {
              protocolVersion: 1,
              jobId,
              outcome: 'failed',
              finishedAt: now().toISOString(),
            });
          },
        )
        .catch((error: unknown) => {
          reportError(`${jobId}:failure-persistence`, error);
        })
        .finally(() => {
          activeRuns.delete(jobId);
        });
      activeRuns.set(jobId, run);
      return {
        decision: 'approved',
        jobId,
        state: 'pending',
      };
    },

    async status(
      unparsedJobId: string,
      actor: AuthenticatedApprovalActor,
    ): Promise<SecretJobStatus | undefined> {
      await ready;
      await recoverStale();
      const jobId = secretContractIdSchema.parse(unparsedJobId);
      const record = await store.get(jobId);
      if (
        record === undefined ||
        record.state === 'authorizing' ||
        record.actorId !== actor.actorId ||
        record.authorizationHash !== actor.authorizationHash
      ) {
        return undefined;
      }
      const state = options.executor.jobState(jobId) ?? record.state;
      return {
        jobId,
        state,
        ...(record.result !== undefined ? { result: record.result } : {}),
      };
    },

    async readFrames(
      jobId: string,
      actor: AuthenticatedApprovalActor,
      nextSequence?: number,
    ): Promise<SecretJobFrameSpoolPage> {
      await ready;
      await recoverStale();
      const validatedJobId = secretContractIdSchema.parse(jobId);
      const record = await store.get(validatedJobId);
      if (
        record === undefined ||
        record.state === 'authorizing' ||
        record.actorId !== actor.actorId ||
        record.authorizationHash !== actor.authorizationHash
      ) {
        return Promise.reject(new SecretJobServiceRejectedError('secret job not found'));
      }
      return options.frames.readPage(validatedJobId, nextSequence);
    },

    async cleanup(jobId: string, actor: AuthenticatedApprovalActor) {
      await ready;
      await recoverStale();
      const validatedJobId = secretContractIdSchema.parse(jobId);
      const record = await store.get(validatedJobId);
      if (
        record === undefined ||
        record.state === 'authorizing' ||
        record.actorId !== actor.actorId ||
        record.authorizationHash !== actor.authorizationHash
      ) {
        throw new SecretJobServiceRejectedError('secret job not found');
      }
      const response = await options.executor.cleanup(validatedJobId);
      if (record !== undefined && response.disposition !== 'retry') {
        await store.update(validatedJobId, 'reaped', record.result);
      }
      return response;
    },

    /** Test/supervision helper; transport handlers should use status polling instead. */
    async settle(
      jobId: string,
      actor: AuthenticatedApprovalActor,
    ): Promise<SecretJobStatus | undefined> {
      await ready;
      const validatedJobId = secretContractIdSchema.parse(jobId);
      await activeRuns.get(validatedJobId);
      return this.status(validatedJobId, actor);
    },

    close(): void {
      clearTimeout(recoveryTimer);
    },
  };
}

export type SecretJobService = ReturnType<typeof createSecretJobService>;

// Keep the public frame type discoverable beside the replay method without widening its payload.
