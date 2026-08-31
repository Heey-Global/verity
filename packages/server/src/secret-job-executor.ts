import {
  StreamingSecretRedactor,
  RedactionCollisionError,
  RedactionLimitError,
  secretJobStartRequestSchema,
  secretJobStartResponseSchema,
  secretJobTerminalResultSchema,
  secretJobTransitionSchema,
  secretJobCleanupResponseSchema,
  secretJobFrameSchema,
  type ExecutionProfileRef,
  type ExecutorWorkloadIdentity,
  type RunGrantClaims,
  type RunGrantRedemption,
  type SecretEnvelope,
  type SecretJobFrame,
  type SecretJobStartRequest,
  type SecretJobStartResponse,
  type SecretJobState,
  type SecretJobTerminalResult,
  type SecretJobCleanupResponse,
  type StreamingRedactorProfile,
} from '@verity/secret-contracts';

import { SecretEnvelopeOpenError, openSecretEnvelope } from './secret-envelope-crypto.js';
import type { SecretAuditRecorder } from './secret-audit-recorder.js';

/**
 * Brokered Secrets one-job executor (concept §"dedizierte kurzlebige Job-Instanz", ADR 0009).
 *
 * This module splits the Phase-1 executor into the two boundaries that matter for the security
 * argument, both fully testable in-process without a real sandbox runtime:
 *
 *  - {@link runSandboxWorkload} is the code that runs INSIDE the isolated one-job sandbox. It is the
 *    only place a plaintext secret ever materializes: it redeems the single-use grant, opens the
 *    envelope with the sandbox's own key, runs the job body with the injected secrets, and streams
 *    output through the frozen streaming redactor. Only redacted {@link SecretJobFrame}s and a
 *    terminal result cross its boundary — never the capability, envelope, or any raw secret byte.
 *
 *  - {@link createSecretJobExecutor} is the orchestrator OUTSIDE the sandbox. It launches exactly one
 *    sandbox per job from a pinned image via a secret-free {@link SandboxLaunchSpec}, enforces the
 *    absolute deadline and single-use-per-job, records the terminal result, and drives the frozen
 *    job state machine to a deterministic reap. It never touches secret material.
 *
 * The gVisor/runsc (or Firecracker) isolation itself lives behind {@link SandboxLauncher}: production
 * wires the real runtime; tests inject an in-process fake that runs {@link runSandboxWorkload}. Fake
 * secrets only — no provider, attestation verification, or real runtime wiring in this slice.
 */

const MAX_FRAME_PAYLOAD_BYTES = 48_000;

export type SandboxRuntime = 'docker-gvisor' | 'kubernetes-gvisor' | 'firecracker';

/**
 * The ONLY data that crosses from the orchestrator to the sandbox launcher. It is deliberately free
 * of every secret-adjacent value: no capability, no envelope, no recipient key, no secret bytes —
 * so a secret can never appear in a pod/container spec, argv, or orchestrator environment. A test
 * asserts this by scanning the serialized spec.
 */
export interface SandboxLaunchSpec {
  jobId: string;
  runtime: SandboxRuntime;
  executorImageDigest: string;
  profileId: string;
  profileVersion: number;
  policyHash: string;
  snapshotId?: string;
  absoluteDeadline: string;
}

/** A launched, running one-job sandbox. Frames are already redacted; the result is terminal. */
export interface LaunchedSandbox {
  readonly workload: ExecutorWorkloadIdentity;
  readonly frames: AsyncIterable<SecretJobFrame>;
  readonly result: Promise<SecretJobTerminalResult>;
}

/** Isolation boundary. Production implements this over runsc; tests run {@link runSandboxWorkload}. */
export interface SandboxLauncher {
  launch(spec: SandboxLaunchSpec): Promise<LaunchedSandbox>;
  /** Deterministic, idempotent teardown. `already_reaped` when the instance is already gone. */
  teardown(jobId: string): Promise<'reaped' | 'already_reaped'>;
}

/** One raw output chunk from the job body, before redaction. */
export interface RawJobChunk {
  stream: 'stdout' | 'stderr';
  chunk: Uint8Array;
}

export interface SandboxWorkloadContext {
  jobId: string;
  claims: RunGrantClaims;
  capability: string;
  workload: ExecutorWorkloadIdentity;
  recipientPrivateKey: Uint8Array;
  redactorProfile: StreamingRedactorProfile;
  redeem: (capability: string, redemption: RunGrantRedemption) => Promise<SecretEnvelope>;
  runJob: (secrets: ReadonlyMap<string, Uint8Array>) => Promise<{
    chunks: readonly RawJobChunk[];
    exitCode: number;
  }>;
  now?: () => Date;
}

export interface SandboxWorkloadOutput {
  frames: SecretJobFrame[];
  result: SecretJobTerminalResult;
}

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function buildRedemption(context: SandboxWorkloadContext): RunGrantRedemption {
  return {
    protocolVersion: 1,
    grantId: context.claims.grantId,
    jobId: context.jobId,
    requestHash: context.claims.requestHash,
    workload: context.workload,
  };
}

function framePayloads(redacted: Uint8Array): Uint8Array[] {
  if (redacted.length === 0) return [];
  const pages: Uint8Array[] = [];
  for (let offset = 0; offset < redacted.length; offset += MAX_FRAME_PAYLOAD_BYTES) {
    pages.push(redacted.subarray(offset, offset + MAX_FRAME_PAYLOAD_BYTES));
  }
  return pages;
}

function zeroize(secrets: ReadonlyMap<string, Uint8Array>): void {
  for (const value of secrets.values()) value.fill(0);
}

/**
 * Run the in-sandbox secret-bearing workload. This is the single trust-critical routine of the
 * executor: it redeems the grant EXACTLY ONCE (the broker enforces single-use; a failure here still
 * consumes the capability), opens the envelope fail-closed with the sandbox key, then pipes every
 * job output chunk through the streaming redactor before it becomes a frame. If redaction hits a
 * collision or a resource limit the job fails closed with no further output. Raw secrets are
 * best-effort zeroized before returning; only redacted frames and a terminal result escape.
 */
export async function runSandboxWorkload(
  context: SandboxWorkloadContext,
): Promise<SandboxWorkloadOutput> {
  const now = context.now ?? (() => new Date());
  const redemption = buildRedemption(context);
  const envelope = await context.redeem(context.capability, redemption);

  let secrets: Map<string, Uint8Array>;
  try {
    secrets = openSecretEnvelope(envelope, {
      claims: context.claims,
      redemption,
      recipientPrivateKey: context.recipientPrivateKey,
      now,
    });
  } catch (error) {
    if (error instanceof SecretEnvelopeOpenError) {
      return {
        frames: [],
        result: secretJobTerminalResultSchema.parse({
          protocolVersion: 1,
          jobId: context.jobId,
          outcome: 'failed',
          finishedAt: isoNow(now),
        }),
      };
    }
    throw error;
  }

  const frames: SecretJobFrame[] = [];
  let sequence = 0;
  const emit = (stream: SecretJobFrame['stream'], redacted: Uint8Array): void => {
    for (const page of framePayloads(redacted)) {
      frames.push(
        secretJobFrameSchema.parse({
          protocolVersion: 1,
          jobId: context.jobId,
          sequence: sequence++,
          stream,
          encoding: 'base64',
          payload: Buffer.from(page).toString('base64'),
          emittedAt: isoNow(now),
        }),
      );
    }
  };

  // One redactor PER stream: the redactor retains up to maximumSecretBytes-1 bytes across pushes,
  // so a shared instance would relabel one stream's tail bytes as the other's. Declared before the
  // try so the finally can dispose (zeroize) them on every exit path — including a construction
  // failure or a non-terminal throw that never reaches flush/abort.
  let stdoutRedactor: StreamingSecretRedactor | undefined;
  let stderrRedactor: StreamingSecretRedactor | undefined;

  try {
    // Constructed eagerly so profile/secret-length validation still fails closed before the job
    // body runs; any construction failure is covered by the finally below.
    stdoutRedactor = new StreamingSecretRedactor(context.redactorProfile, [...secrets.values()]);
    stderrRedactor = new StreamingSecretRedactor(context.redactorProfile, [...secrets.values()]);
    const redactorFor = (stream: SecretJobFrame['stream']): StreamingSecretRedactor =>
      stream === 'stdout' ? stdoutRedactor! : stderrRedactor!;

    const { chunks, exitCode } = await context.runJob(secrets);
    try {
      for (const { stream, chunk } of chunks) {
        emit(stream, redactorFor(stream).push(chunk));
      }
      emit('stdout', stdoutRedactor.flush());
      emit('stderr', stderrRedactor.flush());
    } catch (error) {
      if (error instanceof RedactionCollisionError || error instanceof RedactionLimitError) {
        // The redactors are already terminal after a collision/limit; the finally disposes them,
        // which drops their buffered bytes and zeroizes the private secret copies.
        return {
          frames,
          result: secretJobTerminalResultSchema.parse({
            protocolVersion: 1,
            jobId: context.jobId,
            outcome: 'failed',
            finalSequence: sequence > 0 ? sequence - 1 : undefined,
            finishedAt: isoNow(now),
          }),
        };
      }
      throw error;
    }

    return {
      frames,
      result: secretJobTerminalResultSchema.parse({
        protocolVersion: 1,
        jobId: context.jobId,
        outcome: exitCode === 0 ? 'succeeded' : 'failed',
        exitCode,
        finalSequence: sequence > 0 ? sequence - 1 : undefined,
        finishedAt: isoNow(now),
      }),
    };
  } finally {
    // dispose() is idempotent: on the success/flush and redaction-error paths the redactors are
    // already terminal and self-zeroized; on any non-terminal throw (a non-redaction runJob error)
    // this is the only place their private secret copies get wiped. Guarded for a construction
    // failure above. Then zeroize the opened plaintext secrets themselves.
    stdoutRedactor?.dispose();
    stderrRedactor?.dispose();
    zeroize(secrets);
  }
}

export class SecretJobRejectedError extends Error {}

type JobRecord = {
  jobId: string;
  requestId: string;
  projectId: string;
  requestHash: string;
  grantId: string;
  profile: ExecutionProfileRef;
  absoluteDeadline: string;
  state: SecretJobState;
  cleanupAttempts: number;
  workload?: ExecutorWorkloadIdentity;
  terminalResult?: SecretJobTerminalResult;
  driver?: Promise<void>;
};

export interface SecretJobFrameSink {
  persist(frame: SecretJobFrame): Promise<void> | void;
}

/**
 * The out-of-sandbox orchestrator. Launches exactly one sandbox per job from a pinned image,
 * enforces the deadline and single-use-per-job, streams the sandbox's (already redacted) frames to
 * a sink, records the terminal result, and drives the frozen job state machine to a deterministic
 * reap. Holds no secret material.
 */
export function createSecretJobExecutor(options: {
  launcher: SandboxLauncher;
  frames: SecretJobFrameSink;
  runtime: SandboxRuntime;
  /** Optional provenance recorder; when present, job terminal outcomes and reaps are audited. */
  recorder?: SecretAuditRecorder;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const jobs = new Map<string, JobRecord>();

  /** The safe, non-secret context an audit event for this job carries. */
  function auditContext(record: JobRecord): {
    projectId: string;
    requestHash: string;
    grantId: string;
    jobId: string;
    profile: ExecutionProfileRef;
  } {
    return {
      projectId: record.projectId,
      requestHash: record.requestHash,
      grantId: record.grantId,
      jobId: record.jobId,
      profile: record.profile,
    };
  }

  function transition(record: JobRecord, to: SecretJobState): void {
    secretJobTransitionSchema.parse({
      protocolVersion: 1,
      jobId: record.jobId,
      from: record.state,
      to,
      transitionId: `${record.jobId}:${record.state}:${to}`,
      observedAt: isoNow(now),
    });
    record.state = to;
  }

  // Idempotent, defensive teardown. Callable from `terminal` (normal), `reaping` (retry after a
  // failed teardown), or `reaped` (already gone) without ever attempting an invalid transition, so
  // a concurrent drive-reap and cleanup can never double-transition.
  async function reap(record: JobRecord): Promise<void> {
    if (record.state === 'terminal') transition(record, 'reaping');
    await options.launcher.teardown(record.jobId);
    if (record.state === 'reaping') {
      transition(record, 'reaped');
      // The reaping→reaped transition happens exactly once per job, so this records cleanup once
      // even though reap() is idempotent and callable from both drive and cleanup.
      await options.recorder?.cleanup({
        ...auditContext(record),
        state: 'complete',
        at: isoNow(now),
      });
    }
  }

  async function drive(record: JobRecord, sandbox: LaunchedSandbox): Promise<void> {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      const remaining = Date.parse(record.absoluteDeadline) - now().getTime();
      deadlineTimer = setTimeout(
        () => reject(new SecretJobRejectedError('job absolute deadline elapsed')),
        Math.max(0, remaining),
      );
      deadlineTimer.unref?.();
    });
    try {
      const iterator = sandbox.frames[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([iterator.next(), deadline]);
        if (next.done) break;
        const frame = next.value;
        if (frame.jobId !== record.jobId) {
          throw new SecretJobRejectedError('sandbox emitted a foreign job frame');
        }
        await options.frames.persist(secretJobFrameSchema.parse(frame));
      }
      const terminalResult = secretJobTerminalResultSchema.parse(
        await Promise.race([sandbox.result, deadline]),
      );
      if (terminalResult.jobId !== record.jobId) {
        throw new SecretJobRejectedError('sandbox emitted a foreign terminal result');
      }
      record.terminalResult = terminalResult;
      transition(record, 'terminal');
    } catch {
      // Any failure driving a secret-bearing sandbox must still tear it down: a sandbox that just
      // held plaintext must never be left running. Record a fail-closed terminal result and fall
      // through to the reap below rather than leaving the record stuck in `running`.
      if (record.terminalResult === undefined) {
        record.terminalResult = secretJobTerminalResultSchema.parse({
          protocolVersion: 1,
          jobId: record.jobId,
          outcome: 'failed',
          finishedAt: isoNow(now),
        });
      }
      if (record.state === 'pending' || record.state === 'running') {
        transition(record, 'terminal');
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
    if (record.state === 'terminal') {
      // drive() runs once per job, so the terminal outcome is recorded exactly once, before reap.
      // The reap is in `finally`: even a (contract-violating) throwing recorder must never leave a
      // sandbox that just held plaintext un-reaped — teardown is the higher invariant.
      try {
        if (record.terminalResult !== undefined) {
          await options.recorder?.jobOutcome({
            ...auditContext(record),
            outcome: record.terminalResult.outcome,
            at: isoNow(now),
          });
        }
      } finally {
        await reap(record);
      }
    }
  }

  return {
    async start(unparsed: SecretJobStartRequest): Promise<SecretJobStartResponse> {
      const request = secretJobStartRequestSchema.parse(unparsed);
      const instant = now();
      if (Date.parse(request.absoluteDeadline) <= instant.getTime()) {
        throw new SecretJobRejectedError('job deadline already elapsed');
      }

      const existing = jobs.get(request.jobId);
      if (existing !== undefined) {
        // Idempotent replay of the same start is safe; anything else is a single-use violation or a
        // context conflict and is rejected fail-closed.
        if (
          existing.requestId !== request.requestId ||
          existing.requestHash !== request.requestHash
        ) {
          throw new SecretJobRejectedError('job id already bound to a different request');
        }
        if (existing.state !== 'pending' && existing.state !== 'running') {
          throw new SecretJobRejectedError('job already consumed');
        }
        return secretJobStartResponseSchema.parse({
          protocolVersion: 1,
          requestId: request.requestId,
          requestHash: request.requestHash,
          jobId: request.jobId,
          disposition: 'existing',
          state: existing.state === 'running' ? 'running' : 'pending',
          executorInstanceId: existing.workload?.executorInstanceId ?? request.jobId,
          acceptedAt: isoNow(now),
        });
      }

      const record: JobRecord = {
        jobId: request.jobId,
        requestId: request.requestId,
        projectId: request.projectId,
        requestHash: request.requestHash,
        grantId: request.grantId,
        profile: request.profile,
        absoluteDeadline: request.absoluteDeadline,
        state: 'pending',
        cleanupAttempts: 0,
      };
      jobs.set(request.jobId, record);

      const spec: SandboxLaunchSpec = {
        jobId: request.jobId,
        runtime: options.runtime,
        executorImageDigest: request.executorImageDigest,
        profileId: request.profile.id,
        profileVersion: request.profile.version,
        policyHash: request.profile.policyHash,
        absoluteDeadline: request.absoluteDeadline,
        ...(request.snapshotId !== undefined ? { snapshotId: request.snapshotId } : {}),
      };
      let sandbox: LaunchedSandbox;
      const launch = options.launcher.launch(spec);
      const remainingMs = Date.parse(request.absoluteDeadline) - now().getTime();
      let launchTimer: ReturnType<typeof setTimeout> | undefined;
      let launchTimedOut = false;
      try {
        sandbox = await Promise.race([
          launch,
          new Promise<never>((_resolve, reject) => {
            launchTimer = setTimeout(
              () => {
                launchTimedOut = true;
                reject(new SecretJobRejectedError('job deadline elapsed during launch'));
              },
              Math.max(0, remainingMs),
            );
            launchTimer.unref?.();
          }),
        ]);
      } catch (error) {
        // The launch is secret-free and happens before the sandbox redeems the capability, so a
        // failed launch consumed nothing. Drop the record so the failure is observable and an
        // idempotent replay re-launches cleanly instead of returning a masked, never-started job.
        if (launchTimedOut) {
          // The launcher contract is keyed by job id. Keep that id consumed so a
          // late resolution can never tear down a retry's replacement sandbox.
          // Teardown immediately as well: a launcher stuck after allocating its
          // resources may never resolve its promise at all.
          record.terminalResult = secretJobTerminalResultSchema.parse({
            protocolVersion: 1,
            jobId: request.jobId,
            outcome: 'failed',
            finishedAt: isoNow(now),
          });
          transition(record, 'terminal');
          const cleanup = options.launcher.teardown(request.jobId);
          record.driver = cleanup.then(() => {
            if (record.state === 'terminal') transition(record, 'reaping');
            if (record.state === 'reaping') transition(record, 'reaped');
          });
          void record.driver.catch(() => undefined);
          void launch.then(() => options.launcher.teardown(request.jobId)).catch(() => undefined);
        } else {
          jobs.delete(request.jobId);
          void launch.then(() => options.launcher.teardown(request.jobId)).catch(() => undefined);
        }
        throw error;
      } finally {
        if (launchTimer !== undefined) clearTimeout(launchTimer);
      }
      record.workload = sandbox.workload;
      transition(record, 'running');
      // Drive the sandbox to completion and reap. Surfaced to the caller so a test can await the
      // full lifecycle; production would supervise this independently of the start ack.
      record.driver = drive(record, sandbox);
      // Production start returns before the lifecycle settles. Attach a handler
      // immediately so a recorder/cleanup failure cannot become a process-level
      // unhandled rejection; `settle()` still observes the original promise.
      void record.driver.catch(() => undefined);

      return secretJobStartResponseSchema.parse({
        protocolVersion: 1,
        requestId: request.requestId,
        requestHash: request.requestHash,
        jobId: request.jobId,
        disposition: 'created',
        state: 'running',
        executorInstanceId: sandbox.workload.executorInstanceId,
        acceptedAt: isoNow(now),
      });
    },

    /** Await the full drive-to-reap lifecycle for a job (test/supervision helper). */
    async settle(jobId: string): Promise<SecretJobTerminalResult> {
      const record = jobs.get(jobId);
      if (record === undefined) throw new SecretJobRejectedError('unknown job');
      await record.driver;
      if (record.terminalResult === undefined) {
        throw new SecretJobRejectedError('job has no terminal result');
      }
      return record.terminalResult;
    },

    /** Idempotent cleanup: reap once, then report the job already reaped. */
    async cleanup(jobId: string): Promise<SecretJobCleanupResponse> {
      const record = jobs.get(jobId);
      if (record === undefined) throw new SecretJobRejectedError('unknown job');
      record.cleanupAttempts += 1;
      if (record.state === 'reaped') {
        // Already reaped by the normal drive path or a prior cleanup. Do not call
        // the external teardown again: idempotency is this boundary's guarantee,
        // not an assumption imposed on every launcher implementation.
        return secretJobCleanupResponseSchema.parse({
          protocolVersion: 1,
          jobId,
          cleanupId: `${jobId}:cleanup:${record.cleanupAttempts}`,
          disposition: 'already_reaped',
          completedAt: isoNow(now),
        });
      }
      if (record.state !== 'terminal' && record.state !== 'reaping') {
        // Still pending/running: the drive path owns teardown and will reach it. Cleanup only
        // forces the reap once the job is terminal, or resumes one stuck in `reaping` after an
        // earlier teardown rejected — reap() is idempotent and re-callable from `reaping`.
        return secretJobCleanupResponseSchema.parse({
          protocolVersion: 1,
          jobId,
          cleanupId: `${jobId}:cleanup:${record.cleanupAttempts}`,
          disposition: 'retry',
          retryAfterSeconds: 1,
        });
      }
      await reap(record);
      return secretJobCleanupResponseSchema.parse({
        protocolVersion: 1,
        jobId,
        cleanupId: `${jobId}:cleanup:${record.cleanupAttempts}`,
        disposition: 'reaped',
        completedAt: isoNow(now),
      });
    },

    jobState(jobId: string): SecretJobState | undefined {
      return jobs.get(jobId)?.state;
    },
  };
}
