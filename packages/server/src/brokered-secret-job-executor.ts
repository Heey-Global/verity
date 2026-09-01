import type {
  RunGrantRedemption,
  SecretEnvelope,
  SecretJobCleanupResponse,
  SecretJobStartRequest,
  SecretJobState,
  SecretJobTerminalResult,
  StreamingRedactorProfile,
} from '@verity/secret-contracts';

import {
  createDockerGvisorSandboxChannel,
  type DockerGvisorSandboxChannelOptions,
} from './docker-gvisor-sandbox-channel.js';
import {
  createDockerGvisorSandboxLauncher,
  type DockerGvisorSandboxLauncherOptions,
} from './docker-gvisor-sandbox-launcher.js';
import type { DockerClient } from './docker.js';
import type { SecretAuditRecorder } from './secret-audit-recorder.js';
import { createSecretJobExecutor, type SecretJobFrameSink } from './secret-job-executor.js';
import { createSecretJobGrantResolver, type SecretJobGrant } from './secret-job-grant-resolver.js';
import type { SecretWorkerRecipientKeyRegistry } from './secret-worker-recipient-key-registry.js';

/**
 * The composition root for the Brokered Secrets execution path (ADR 0009). It is the single place
 * that assembles the previously-isolated pieces into the full server-side chain:
 *
 *   grant issued → {@link runJob} binds it → executor.start → launcher.launch (secret-free spec) →
 *   channel.run → docker attach → authenticate-before-seal → broker.redeem → redacted frame* →
 *   terminal result → reap → unbind.
 *
 * Every secret-adjacent value (capability, claims, sealed envelope) travels ONLY through the grant
 * resolver's `resolve(jobId)`, wired to the launcher's `resolveSecretJob` — never through the
 * secret-free {@link SandboxLaunchSpec} that reaches a Docker create request.
 *
 * `runJob` owns the grant bind/unbind lifecycle so a lost `unbind` can never leak the single-use
 * capability: the binding is dropped in a `finally` on the success path, a launch failure, and a
 * drive failure alike. (The resolver also self-expires bindings at their claims' `expiresAt` as a
 * backstop, but owning unbind here keeps the map tight instead of relying on TTL.)
 */

/** The broker capability redemption the resolver needs: consume a capability, return the sealed
 * envelope bound to the redeeming workload. Structurally the `redeem` of {@link createSecretGrantBroker}. */
interface BrokeredSecretGrantRedeemer {
  redeem: (capability: string, redemption: RunGrantRedemption) => Promise<SecretEnvelope>;
}

export interface BrokeredSecretJobExecutorOptions {
  /** The grant broker; only its `redeem` is used to consume a capability and seal for the workload. */
  broker: BrokeredSecretGrantRedeemer;
  /** Docker client for the launcher: container lifecycle plus pinned-runtime verification. */
  docker: DockerClient;
  /** Docker unix-socket base URL for the channel's raw attach (refuses HTTP proxy URLs). */
  dockerBaseUrl: string;
  /** Sink the executor persists each already-redacted frame into. */
  frames: SecretJobFrameSink;
  /** Frozen policy delivered to workers only through the proof-bound challenge. */
  redactorProfile: StreamingRedactorProfile;
  /** Shared proof→envelope key registry; must also back the broker's envelope sealer. */
  recipientKeys: SecretWorkerRecipientKeyRegistry;
  /** Host-owned runsc pin the launcher enforces; a mismatch rejects with no runc fallback. */
  expectedRuntimePath: string;
  expectedRuntimeArgs: readonly string[];
  /** Immutable executor image repository prefix; the request supplies only the sha256 digest. */
  executorImageRepository: string;
  recorder?: SecretAuditRecorder;
  runtimeName?: string;
  memoryBytes?: number;
  nanoCpus?: number;
  pidsLimit?: number;
  maxRuntimeMs?: number;
  /** Injected clock, threaded into every child. Production omits it (each child uses real wall-clock).
   * If a caller ever injects a FROZEN clock, it must also supply `seams.scheduleDeadline`, or the
   * launcher would compute deadline delays from the frozen clock while the default timer runs on the
   * real clock — a latent skew. Tests always pair the two. */
  now?: () => Date;
  /**
   * Test seams. Production omits these, so the channel/launcher defaults apply (real docker attach,
   * a fresh per-session authenticator, real timers). Tests inject an in-memory attach bridged to a
   * worker runtime, a fixed-clock authenticator, and a controllable deadline scheduler.
   */
  seams?: {
    openAttach?: DockerGvisorSandboxChannelOptions['openAttach'];
    authenticatorOptions?: DockerGvisorSandboxChannelOptions['authenticatorOptions'];
    onTerminalOutcome?: DockerGvisorSandboxChannelOptions['onTerminalOutcome'];
    scheduleDeadline?: DockerGvisorSandboxLauncherOptions['scheduleDeadline'];
  };
}

export interface BrokeredSecretJobExecutor {
  /**
   * Bind a freshly issued grant to its job, drive the job to a terminal result, and always unbind.
   * Rejects if binding fails (a grant is already bound for the job) or the launch fails — the
   * executor deliberately throws (and drops its record) on a launch failure so an idempotent replay
   * re-launches cleanly, and `runJob` propagates that rather than masking it. A failure AFTER a
   * successful launch (driving a secret-bearing sandbox) surfaces as a fail-closed `failed` terminal
   * result via `settle`, not a throw. The binding is dropped on every path.
   */
  runJob(grant: SecretJobGrant, request: SecretJobStartRequest): Promise<SecretJobTerminalResult>;
  /** Idempotent teardown for a job; delegates to the executor's cleanup. */
  cleanup(jobId: string): Promise<SecretJobCleanupResponse>;
  /** Current lifecycle state of a job, or undefined if unknown. */
  jobState(jobId: string): SecretJobState | undefined;
  /** Number of jobs with a live grant binding (observability/bounds helper). */
  boundGrants(): number;
}

export function createBrokeredSecretJobExecutor(
  options: BrokeredSecretJobExecutorOptions,
): BrokeredSecretJobExecutor {
  const grantResolver = createSecretJobGrantResolver({
    redeem: (capability, redemption) => options.broker.redeem(capability, redemption),
    ...(options.now ? { now: options.now } : {}),
  });

  const channel = createDockerGvisorSandboxChannel({
    dockerBaseUrl: options.dockerBaseUrl,
    redactorProfile: options.redactorProfile,
    recipientKeys: options.recipientKeys,
    ...(options.seams?.openAttach ? { openAttach: options.seams.openAttach } : {}),
    ...(options.seams?.authenticatorOptions
      ? { authenticatorOptions: options.seams.authenticatorOptions }
      : {}),
    ...(options.seams?.onTerminalOutcome
      ? { onTerminalOutcome: options.seams.onTerminalOutcome }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  const launcher = createDockerGvisorSandboxLauncher({
    docker: options.docker,
    channel,
    // The only path secret-adjacent bindings take into a launch: resolved by jobId, off the spec.
    resolveSecretJob: (jobId) => grantResolver.resolve(jobId),
    expectedRuntimePath: options.expectedRuntimePath,
    expectedRuntimeArgs: options.expectedRuntimeArgs,
    executorImageRepository: options.executorImageRepository,
    ...(options.runtimeName ? { runtimeName: options.runtimeName } : {}),
    ...(options.memoryBytes !== undefined ? { memoryBytes: options.memoryBytes } : {}),
    ...(options.nanoCpus !== undefined ? { nanoCpus: options.nanoCpus } : {}),
    ...(options.pidsLimit !== undefined ? { pidsLimit: options.pidsLimit } : {}),
    ...(options.maxRuntimeMs !== undefined ? { maxRuntimeMs: options.maxRuntimeMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.seams?.scheduleDeadline
      ? { scheduleDeadline: options.seams.scheduleDeadline }
      : {}),
  });

  const executor = createSecretJobExecutor({
    launcher,
    frames: options.frames,
    runtime: 'docker-gvisor',
    ...(options.recorder ? { recorder: options.recorder } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    async runJob(grant, request) {
      // Bind before start: launch resolves the binding synchronously inside launcher.launch, so the
      // grant must already be associated with the job. A double bind throws fail-closed.
      grantResolver.bind(request.jobId, grant);
      try {
        // start acks after kicking off the drive; settle awaits the full drive-to-reap lifecycle and
        // returns the terminal result (succeeded or fail-closed). A launch failure throws out of
        // start and is caught below so unbind still runs.
        await executor.start(request);
        return await executor.settle(request.jobId);
      } finally {
        // Drop the binding on every path — success, launch failure, or drive failure. By the time
        // settle resolves the capability has already been consumed (or never redeemed on a failed
        // launch), so unbind never races an in-flight seal.
        grantResolver.unbind(request.jobId);
      }
    },
    cleanup(jobId) {
      return executor.cleanup(jobId);
    },
    jobState(jobId) {
      return executor.jobState(jobId);
    },
    boundGrants() {
      return grantResolver.size();
    },
  };
}
