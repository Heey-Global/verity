import { createHash } from 'node:crypto';
import type { ContainerSpec, DockerClient } from '../docker.js';
import { safeHostPath } from '../backup/host-plan.js';
import { managedContainerMatchesSpec } from './managed-server-owner.js';
import {
  SERVER_IMAGE_SIGNING_IDENTITY,
  SERVER_IMAGE_SIGNING_ISSUER,
} from './server-image-verify.js';
import type { UpdateJournal } from './update-journal.js';

export const HOST_RUNTIME_SERVICE_LABEL = 'org.verity.host-runtime-service';
export interface RuntimeServiceRequirements {
  readonly revision: number;
  readonly renewalProtocol: number;
  readonly features: readonly string[];
}
export function parseRuntimeServiceRequirements(value: unknown): RuntimeServiceRequirements | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'features,renewalProtocol,revision' ||
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 1 ||
    !Number.isSafeInteger(record.renewalProtocol) ||
    (record.renewalProtocol as number) < 1 ||
    !Array.isArray(record.features) ||
    record.features.length > 32 ||
    !record.features.every(
      (feature) => typeof feature === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(feature),
    )
  )
    return null;
  return record as unknown as RuntimeServiceRequirements;
}

type RenewalDocker = Pick<
  DockerClient,
  | 'createContainer'
  | 'startContainer'
  | 'waitContainer'
  | 'inspectContainer'
  | 'inspectImageEnv'
  | 'listContainers'
  | 'removeContainer'
  | 'containerLogs'
>;
const official = /^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/u;

export class HostRuntimeRenewalError extends Error {
  constructor(readonly recovery: 'unchanged' | 'restored' | 'recovery-required') {
    super(
      recovery === 'unchanged'
        ? 'Host runtime preparation failed; no host changes were made.'
        : recovery === 'restored'
          ? 'Host runtime renewal failed; the previous service was restored. Retry the update.'
          : 'Host runtime renewal needs recovery; restoration could not be verified. Inspect the host runtime service journal or re-run the Verity installer.',
    );
    this.name = 'HostRuntimeRenewalError';
  }
}

function renewalKey(journal: UpdateJournal): string {
  return createHash('sha256')
    .update(`${journal.deploymentId}\0${journal.updateId}\0${journal.targetDigest}`)
    .digest('hex')
    .slice(0, 24);
}

/** Inventory failures cannot prove that a previously disconnected host writer never started. */
export async function runtimeRenewalMayHaveStarted(
  docker: Pick<RenewalDocker, 'listContainers' | 'inspectContainer'>,
  journal: UpdateJournal,
): Promise<boolean> {
  if (docker.listContainers === undefined)
    throw new Error('Runtime renewal requires Docker job inventory');
  const jobs = (await docker.listContainers()).filter(
    (item) =>
      item.names?.includes(`verity-runtime-install-${renewalKey(journal)}`) ||
      (item.labels?.['verity.managed-role'] === 'runtime-renewal' &&
        item.labels?.['verity.managed-deployment-id'] === journal.deploymentId &&
        item.labels?.['verity.update-id'] === journal.updateId &&
        item.labels?.['verity.target-digest'] === journal.targetDigest &&
        item.labels?.['verity.renewal-stage'] === 'install'),
  );
  if (jobs.length === 0) return false;
  if (jobs.length !== 1) return true;
  const inspect = await docker.inspectContainer(jobs[0]!.id);
  return inspect.status !== 'created' || inspect.running;
}

/** Adopt only our exact, bounded daemon-owned job. A lost connection never kills host work. */
export async function runHostRenewalJob(
  docker: RenewalDocker,
  spec: ContainerSpec,
  onInstallationState: (mayHaveStarted: boolean) => void = () => undefined,
  replaceCreated = true,
): Promise<string> {
  if (!docker.listContainers || !docker.waitContainer || !docker.inspectImageEnv)
    throw new Error('Runtime renewal requires Docker job lifecycle support');
  const matches = (await docker.listContainers()).filter((item) => item.names?.includes(spec.name));
  if (matches.length > 1) throw new Error('Runtime renewal job ownership is ambiguous');
  let id = matches[0]?.id;
  let createdHere = false;
  if (id === undefined) {
    try {
      id = (await docker.createContainer(spec)).id;
      createdHere = true;
    } catch (error) {
      // Another recovering updater may have won create. Only a unique exact job is adoptable.
      const winners = (await docker.listContainers()).filter((item) =>
        item.names?.includes(spec.name),
      );
      if (winners.length !== 1) throw error;
      id = winners[0]!.id;
    }
  }
  // Until inspection succeeds an existing install job may already be writing.
  if (!createdHere) onInstallationState(true);
  const inspect = await docker.inspectContainer(id);
  onInstallationState(inspect.status !== 'created');
  const imageEnv = (await docker.inspectImageEnv(spec.image)) ?? [];
  // Docker may report tmpfs in Mounts as well as HostConfig.Tmpfs. The shared Server
  // matcher handles binds/volumes only; validate the tmpfs view before excluding it.
  const tmpfsMounts = (inspect.mounts ?? []).filter((mount) => mount.type === 'tmpfs');
  const expectedTmpfs = Object.keys(spec.tmpfs ?? {}).sort();
  const tmpfsMatches =
    tmpfsMounts.length === 0 ||
    (JSON.stringify(tmpfsMounts.map((mount) => mount.destination).sort()) ===
      JSON.stringify(expectedTmpfs) &&
      tmpfsMounts.every(
        (mount) => mount.readWrite === true && (mount.source === undefined || mount.source === ''),
      ));
  const comparable = {
    ...inspect,
    mounts: (inspect.mounts ?? []).filter((mount) => mount.type !== 'tmpfs'),
  };
  if (
    !tmpfsMatches ||
    !managedContainerMatchesSpec(comparable, spec, imageEnv, false, 'exact') ||
    inspect.runtime !== 'runc' ||
    (inspect.pidMode ?? '') !== (spec.pidMode ?? '') ||
    JSON.stringify(inspect.tmpfs ?? {}) !== JSON.stringify(spec.tmpfs ?? {}) ||
    inspect.privileged !== false ||
    (inspect.deviceCount ?? 0) !== 0 ||
    JSON.stringify([...(inspect.capDrop ?? [])].sort()) !== JSON.stringify(spec.capDrop) ||
    Object.entries(spec.labels ?? {}).some(([key, value]) => inspect.labels?.[key] !== value)
  ) {
    // Never remove a started job, or infer ownership from its name alone.
    if (
      replaceCreated &&
      inspect.status === 'created' &&
      !inspect.running &&
      Object.entries(spec.labels ?? {}).every(([key, value]) => inspect.labels?.[key] === value)
    ) {
      await docker.removeContainer(id);
      return runHostRenewalJob(docker, spec, onInstallationState, false);
    }
    throw new Error('Runtime renewal job differs from its authorized configuration');
  }
  if (inspect.status === 'created') {
    // A transport failure can happen after Docker accepted start.
    onInstallationState(true);
    await docker.startContainer(id);
  } else if (!['running', 'exited'].includes(inspect.status ?? ''))
    throw new Error('Runtime renewal job has an unsupported lifecycle state');
  // Both stages have their own timeout inside Docker. Retain a running job if wait disconnects.
  // The HTTP wait must outlive the helper's own timeout and forced-kill grace.
  // A shorter transport budget reports failure while the owned host job continues.
  const seconds =
    spec.entrypoint?.[0] === 'timeout' && spec.entrypoint[1] === '--kill-after=5s'
      ? /^(\d+)s$/u.exec(spec.entrypoint[2] ?? '')
      : null;
  const waitTimeoutMs = Math.max(
    300_000,
    seconds === null ? 0 : Number(seconds[1]) * 1000 + 30_000,
  );
  const status = await docker.waitContainer(id, { timeoutMs: waitTimeoutMs });
  if (status !== 0) {
    let recovery: 'unchanged' | 'restored' | 'recovery-required' =
      spec.labels?.['verity.renewal-stage'] === 'verify' ? 'unchanged' : 'recovery-required';
    if (recovery !== 'unchanged' && docker.containerLogs !== undefined) {
      const logs = await docker.containerLogs(id, 1).catch(() => '');
      if (logs.length <= 4096) {
        try {
          const result = JSON.parse(logs.trim()) as Record<string, unknown>;
          if (
            result.version === 1 &&
            result.updateId === spec.labels?.['verity.update-id'] &&
            result.targetDigest === spec.labels?.['verity.target-digest'] &&
            result.outcome === 'restored'
          )
            recovery = 'restored';
        } catch {
          /* An interrupted helper may not have published a recovery disposition. */
        }
      }
    }
    await docker.removeContainer(id);
    throw new HostRuntimeRenewalError(recovery);
  }
  return id;
}

async function renewHostRuntimeServiceImpl(
  options: {
    docker: RenewalDocker;
    journal: UpdateJournal;
    runtimeHostPath: string;
    installerStatePath: string;
    verifyInstalled: () => Promise<void>;
  },
  onInstallationState: (mayHaveStarted: boolean) => void,
): Promise<void> {
  const { docker, journal } = options;
  if (!official.test(journal.previousDigest) || !official.test(journal.targetDigest))
    throw new Error('Runtime renewal requires official immutable image digests');
  if (!safeHostPath(options.runtimeHostPath) || !safeHostPath(options.installerStatePath))
    throw new Error('Runtime renewal requires canonical sealed host paths');
  const key = renewalKey(journal);
  const base = (stage: string, image: string): ContainerSpec => ({
    image,
    name: `verity-runtime-${stage}-${key}`,
    user: '0:0',
    runtime: 'runc',
    labels: {
      'verity.managed-deployment-id': journal.deploymentId,
      'verity.managed-role': 'runtime-renewal',
      'verity.update-id': journal.updateId,
      'verity.target-digest': journal.targetDigest,
      'verity.renewal-stage': stage,
    },
    network: 'none',
    restartPolicy: 'no',
    readOnlyRootfs: true,
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges=true'],
    tmpfs: { '/tmp': 'rw,nosuid,nodev,size=32m' },
    pidsLimit: 64,
    memoryBytes: 256 * 1024 * 1024,
    memorySwapBytes: 256 * 1024 * 1024,
  });
  // A resumed attempt can fail verification while an earlier install is still running.
  // Do not report that the host is unchanged merely because this attempt never started it.
  onInstallationState(true);
  onInstallationState(await runtimeRenewalMayHaveStarted(docker, journal));
  // Trust starts in the already-installed image, never in target code verifying itself.
  const verificationId = await runHostRenewalJob(docker, {
    ...base('verify', journal.previousDigest),
    network: 'bridge',
    binds: [],
    entrypoint: ['timeout', '--kill-after=5s', '120s', '/usr/local/bin/cosign'],
    command: [
      'verify',
      '--certificate-oidc-issuer',
      SERVER_IMAGE_SIGNING_ISSUER,
      '--certificate-identity',
      SERVER_IMAGE_SIGNING_IDENTITY,
      journal.targetDigest,
    ],
    env: ['HOME=/tmp', 'TUF_ROOT=/tmp/tuf'],
  });
  const installationId = await runHostRenewalJob(
    docker,
    {
      ...base('install', journal.targetDigest),
      pidMode: 'host',
      // Docker derives this for host PID namespaces; authorize it explicitly.
      securityOpt: ['no-new-privileges=true', 'label=disable'],
      capAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
      binds: [
        `${options.runtimeHostPath}:/var/lib/verity/host-runtime`,
        '/var/lib/verity/host-runtime-private:/var/lib/verity/host-runtime-private',
        `${options.installerStatePath}/.verity-install.lock:/run/verity-install.lock`,
        '/usr/local/libexec/verity:/usr/local/libexec/verity',
        '/etc/systemd/system:/etc/systemd/system',
        '/run/systemd:/run/systemd',
      ],
      entrypoint: ['timeout', '--kill-after=5s', '110s', 'bash'],
      command: ['/opt/verity-install/deploy/host/verity-runtime-renew'],
      env: [
        'SYSTEMD_IGNORE_CHROOT=1',
        'VERITY_INSTALL_LOCK=/run/verity-install.lock',
        `VERITY_RENEW_DEPLOYMENT=${journal.deploymentId}`,
        `VERITY_RENEW_ID=${journal.updateId}`,
        `VERITY_RENEW_IMAGE=${journal.targetDigest}`,
      ],
    },
    onInstallationState,
  );
  await options.verifyInstalled();
  await docker.removeContainer(installationId);
  await docker.removeContainer(verificationId);
}

/** Preserve the host-write boundary even when Docker fails before returning a job result. */
export async function renewHostRuntimeService(
  options: Parameters<typeof renewHostRuntimeServiceImpl>[0],
): Promise<void> {
  let mayHaveStarted = false;
  try {
    await renewHostRuntimeServiceImpl(options, (value) => {
      mayHaveStarted = value;
    });
  } catch (error) {
    if (
      error instanceof HostRuntimeRenewalError &&
      (error.recovery !== 'unchanged' || !mayHaveStarted)
    )
      throw error;
    const failure = new HostRuntimeRenewalError(mayHaveStarted ? 'recovery-required' : 'unchanged');
    failure.cause = error;
    if (error instanceof Error) failure.message += ` ${error.message}`;
    throw failure;
  }
}
