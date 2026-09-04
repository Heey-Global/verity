import { createHash } from 'node:crypto';

import {
  secretJobTerminalResultSchema,
  type RunGrantClaims,
  type RunGrantRedemption,
  type SecretEnvelope,
  type SecretJobFrame,
} from '@verity/secret-contracts';

import type { GvisorSandboxChannel } from './docker-gvisor-sandbox-channel.js';
import type { ContainerInspect, ContainerSpec, DockerClient } from './docker.js';
import { DockerError } from './docker.js';
import { createDockerGvisorRuntimeVerifier } from './docker-gvisor-runtime-verifier.js';
import type { LaunchedSandbox, SandboxLauncher, SandboxLaunchSpec } from './secret-job-executor.js';

const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024;
const DEFAULT_NANO_CPUS = 1_000_000_000;
const DEFAULT_PIDS_LIMIT = 128;
const DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;

/**
 * Per-job secret binding the launcher hands the channel: the grant claims and a broker `sealEnvelope`
 * handle. Resolved by `jobId` OUTSIDE the secret-free {@link SandboxLaunchSpec}, so no claim, envelope,
 * or capability ever enters a Docker create request. Neither value carries secret bytes — claims are
 * ids/hashes and `sealEnvelope` is an opaque broker function.
 */
export interface SecretJobChannelBinding {
  claims: RunGrantClaims;
  sealEnvelope: (redemption: RunGrantRedemption) => Promise<SecretEnvelope>;
}

export interface DockerGvisorSandboxLauncherOptions {
  docker: DockerClient;
  channel: GvisorSandboxChannel;
  /** Resolves the per-job grant claims + broker seal for the channel, keyed by `jobId`. Kept off the
   * {@link SandboxLaunchSpec} so secret-adjacent bindings never reach a Docker create request. */
  resolveSecretJob: (jobId: string) => Promise<SecretJobChannelBinding>;
  expectedRuntimePath: string;
  expectedRuntimeArgs: readonly string[];
  /** Immutable repository prefix; the request supplies only the sha256 digest. */
  executorImageRepository: string;
  runtimeName?: string;
  memoryBytes?: number;
  nanoCpus?: number;
  pidsLimit?: number;
  maxRuntimeMs?: number;
  now?: () => Date;
  scheduleDeadline?: (callback: () => void, delayMs: number) => { cancel(): void };
}

function containerName(jobId: string): string {
  const hash = createHash('sha256').update(jobId, 'utf8').digest('hex').slice(0, 24);
  return `verity-secret-job-${hash}`;
}

function imageRef(repository: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('executor image digest must be sha256 hex');
  if (repository.includes('@') || repository.endsWith(':')) {
    throw new Error(
      'executor image repository must not contain a digest or trailing tag separator',
    );
  }
  return `${repository}@sha256:${digest}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof DockerError && error.kind === 'container_not_found';
}

function isConflict(error: unknown): boolean {
  return error instanceof DockerError && error.kind === 'conflict';
}

function launchSpecHash(spec: SandboxLaunchSpec, container: ContainerSpec): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        jobId: spec.jobId,
        profileId: spec.profileId,
        profileVersion: spec.profileVersion,
        policyHash: spec.policyHash,
        snapshotId: spec.snapshotId ?? null,
        absoluteDeadline: spec.absoluteDeadline,
        image: container.image,
        runtime: container.runtime,
        network: container.network,
        readOnlyRootfs: container.readOnlyRootfs,
        tmpfs: container.tmpfs,
        capDrop: container.capDrop,
        securityOpt: container.securityOpt,
        pidsLimit: container.pidsLimit,
        memoryBytes: container.memoryBytes,
        nanoCpus: container.nanoCpus,
        user: container.user,
        entrypoint: container.entrypoint,
        command: container.command,
        openStdin: container.openStdin,
      }),
      'utf8',
    )
    .digest('hex');
}

function assertAdoptable(
  existing: ContainerInspect,
  expected: ContainerSpec,
  specHash: string,
  runtimeName: string,
): void {
  if (
    existing.image !== expected.image ||
    existing.runtime !== runtimeName ||
    existing.labels?.['verity.job-id'] !== expected.labels?.['verity.job-id'] ||
    existing.labels?.['verity.launch-spec-hash'] !== specHash ||
    existing.networkMode !== expected.network ||
    existing.readOnlyRootfs !== expected.readOnlyRootfs ||
    JSON.stringify(existing.tmpfs) !== JSON.stringify(expected.tmpfs) ||
    JSON.stringify(existing.capDrop) !== JSON.stringify(expected.capDrop) ||
    JSON.stringify(existing.securityOpt) !== JSON.stringify(expected.securityOpt) ||
    existing.pidsLimit !== expected.pidsLimit ||
    existing.memoryBytes !== expected.memoryBytes ||
    existing.nanoCpus !== expected.nanoCpus ||
    JSON.stringify(existing.env) !== JSON.stringify(expected.env) ||
    existing.mountCount !== 0 ||
    existing.privileged !== false ||
    JSON.stringify(existing.capAdd ?? []) !== JSON.stringify(expected.capAdd ?? []) ||
    existing.deviceCount !== 0 ||
    existing.restartPolicy !== expected.restartPolicy ||
    existing.user !== expected.user ||
    JSON.stringify(existing.entrypoint) !== JSON.stringify(expected.entrypoint) ||
    JSON.stringify(existing.command) !== JSON.stringify(expected.command) ||
    existing.openStdin !== expected.openStdin ||
    existing.init !== true
  ) {
    throw new Error('existing secret-job container does not match the requested launch spec');
  }
}

function defaultScheduleDeadline(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

class DeadlineExceededError extends Error {}

interface DeadlineGuard {
  interrupt: Promise<never>;
  result: Promise<Awaited<LaunchedSandbox['result']>>;
  cancel(): void;
}

function deadlineTerminalResult(spec: SandboxLaunchSpec): Awaited<LaunchedSandbox['result']> {
  return secretJobTerminalResultSchema.parse({
    protocolVersion: 1,
    jobId: spec.jobId,
    outcome: 'deadline_exceeded',
    finishedAt: new Date(spec.absoluteDeadline).toISOString(),
  });
}

function createDeadlineGuard(
  spec: SandboxLaunchSpec,
  containerId: string,
  options: DockerGvisorSandboxLauncherOptions,
  abortSession: () => void,
): DeadlineGuard {
  const now = options.now ?? (() => new Date());
  const schedule = options.scheduleDeadline ?? defaultScheduleDeadline;
  let resolveDeadline!: (result: Awaited<LaunchedSandbox['result']>) => void;
  let rejectInterrupt!: (error: unknown) => void;
  const result = new Promise<Awaited<LaunchedSandbox['result']>>((resolve) => {
    resolveDeadline = resolve;
  });
  const interrupt = new Promise<never>((_resolve, reject) => {
    rejectInterrupt = reject;
  });
  const timer = schedule(
    () => {
      // Publish the deadline outcome BEFORE awaiting Docker. A slow daemon must never let a late
      // worker result win the race; normal executor reaping retries removal if this attempt fails.
      resolveDeadline(deadlineTerminalResult(spec));
      rejectInterrupt(new DeadlineExceededError('secret-job absolute deadline exceeded'));
      // Abort the channel session so the driver tears down the attach and revokes its challenge; the
      // worker cannot outlive its deadline waiting on a hung daemon removal.
      abortSession();
      void options.docker.removeContainer(containerId).catch(() => undefined);
    },
    Math.max(0, Date.parse(spec.absoluteDeadline) - now().getTime()),
  );
  return { interrupt, result, cancel: () => timer.cancel() };
}

function enforceDeadline(sandbox: LaunchedSandbox, guard: DeadlineGuard): LaunchedSandbox {
  let framesDone = false;
  let resultDone = false;
  const cancelWhenComplete = (): void => {
    if (framesDone && resultDone) guard.cancel();
  };
  const frames: AsyncIterable<SecretJobFrame> = {
    async *[Symbol.asyncIterator]() {
      const iterator = sandbox.frames[Symbol.asyncIterator]();
      const deadlineDone = guard.result.then(() => ({ done: true as const, value: undefined }));
      try {
        while (true) {
          const next = await Promise.race([iterator.next(), deadlineDone]);
          if (next.done) return;
          yield next.value;
        }
      } finally {
        framesDone = true;
        cancelWhenComplete();
        // Do not let a non-cooperative worker's iterator.return() hold deadline completion open.
        void iterator.return?.().catch(() => undefined);
      }
    },
  };
  const workerResult = sandbox.result.then(
    (result) => {
      resultDone = true;
      cancelWhenComplete();
      return result;
    },
    (error: unknown) => {
      resultDone = true;
      cancelWhenComplete();
      throw error;
    },
  );
  return {
    ...sandbox,
    frames,
    result: Promise.race([workerResult, guard.result]),
  };
}

/**
 * Docker implementation of the Phase-1 gVisor isolation boundary. It creates exactly one hardened,
 * networkless container per job and explicitly selects runsc. The create spec is secret-free; the
 * authenticated channel handles the post-start workload protocol out of band.
 */
export function createDockerGvisorSandboxLauncher(
  options: DockerGvisorSandboxLauncherOptions,
): SandboxLauncher {
  const runtimeName = options.runtimeName ?? 'runsc';
  if (runtimeName !== 'runsc') throw new Error('gVisor launcher runtime must be runsc');
  const runtimeVerifier = createDockerGvisorRuntimeVerifier({
    docker: options.docker,
    runtimeName,
    expectedPath: options.expectedRuntimePath,
    expectedArgs: options.expectedRuntimeArgs,
  });

  return {
    async launch(spec: SandboxLaunchSpec): Promise<LaunchedSandbox> {
      if (spec.runtime !== 'docker-gvisor') {
        throw new Error(`Docker gVisor launcher cannot launch runtime ${spec.runtime}`);
      }
      const now = options.now ?? (() => new Date());
      const runtimeMs = Date.parse(spec.absoluteDeadline) - now().getTime();
      if (runtimeMs <= 0 || runtimeMs > (options.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS)) {
        throw new Error('secret-job absolute deadline is outside the allowed runtime window');
      }
      await runtimeVerifier.verify(runtimeName);

      const container: ContainerSpec = {
        image: imageRef(options.executorImageRepository, spec.executorImageDigest),
        name: containerName(spec.jobId),
        labels: {
          'verity.component': 'secret-job-executor',
          'verity.job-id': spec.jobId,
          'verity.profile-id': spec.profileId,
          'verity.profile-version': String(spec.profileVersion),
          'verity.policy-hash': spec.policyHash,
          'verity.absolute-deadline': spec.absoluteDeadline,
        },
        env: [],
        user: '65532:65532',
        entrypoint: ['/usr/local/bin/verity-secret-job-worker'],
        command: [],
        // Docker starts the worker before the authenticated attach is opened. Without OpenStdin,
        // PID 1 observes EOF immediately and exits fail-closed before it can receive a challenge.
        openStdin: true,
        network: 'none',
        runtime: runtimeName,
        readOnlyRootfs: true,
        tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=67108864' },
        restartPolicy: 'no',
        capDrop: ['ALL'],
        securityOpt: ['no-new-privileges:true'],
        pidsLimit: options.pidsLimit ?? DEFAULT_PIDS_LIMIT,
        memoryBytes: options.memoryBytes ?? DEFAULT_MEMORY_BYTES,
        nanoCpus: options.nanoCpus ?? DEFAULT_NANO_CPUS,
      };
      const specHash = launchSpecHash(spec, container);
      container.labels = { ...container.labels, 'verity.launch-spec-hash': specHash };

      let containerId: string;
      let alreadyRunning = false;
      try {
        containerId = (await options.docker.createContainer(container)).id;
      } catch (error) {
        if (!isConflict(error)) throw error;
        const existing = await options.docker.inspectContainer(container.name);
        assertAdoptable(existing, container, specHash, runtimeName);
        if (!existing.running && existing.status !== 'created') {
          throw new Error('existing secret-job container is terminal and cannot be restarted', {
            cause: error,
          });
        }
        containerId = existing.id;
        alreadyRunning = existing.running;
      }

      // Runtime verification and Docker create/inspect may themselves consume the remaining
      // budget. Re-check synchronously before start: scheduling a zero-delay timer is insufficient
      // because startContainer would run in the current microtask first.
      if (Date.parse(spec.absoluteDeadline) <= now().getTime()) {
        void options.docker.removeContainer(containerId).catch(() => undefined);
        throw new DeadlineExceededError('secret-job absolute deadline exceeded before start');
      }

      // The session controller aborts the channel/driver on deadline or launch failure, so the
      // worker never outlives its lifecycle. The driver owns challenge issuance + proof verification;
      // the launcher no longer authenticates itself.
      const sessionAbort = new AbortController();
      const deadline = createDeadlineGuard(spec, containerId, options, () => sessionAbort.abort());
      try {
        const attach = (async () => {
          if (!alreadyRunning) await options.docker.startContainer(containerId);
          const binding = await options.resolveSecretJob(spec.jobId);
          const run = await options.channel.run({
            jobId: spec.jobId,
            containerId,
            absoluteDeadline: spec.absoluteDeadline,
            claims: binding.claims,
            sealEnvelope: binding.sealEnvelope,
            signal: sessionAbort.signal,
          });
          return { workload: run.workload, frames: run.frames, result: run.result };
        })();
        const sandbox = await Promise.race([attach, deadline.interrupt]);
        return enforceDeadline(sandbox, deadline);
      } catch (error) {
        sessionAbort.abort();
        deadline.cancel();
        // The deadline callback already initiated force-removal. Never make the caller wait on a
        // second potentially hung daemon request before observing the absolute deadline.
        if (error instanceof DeadlineExceededError) throw error;
        try {
          await options.docker.removeContainer(containerId);
        } catch (cleanupError) {
          if (!isNotFound(cleanupError)) {
            throw new AggregateError([error, cleanupError], 'launch and cleanup failed', {
              cause: cleanupError,
            });
          }
        }
        throw error;
      }
    },

    async teardown(jobId: string): Promise<'reaped' | 'already_reaped'> {
      const name = containerName(jobId);
      try {
        // Docker's remove endpoint is called with force=true by DockerClient. This handles both a
        // running worker and one that already exited; a separate stop would make an exited
        // container runtime-dependent (some daemons return 304) and weaken idempotency.
        await options.docker.removeContainer(name);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        return 'already_reaped';
      }
      return 'reaped';
    },
  };
}
