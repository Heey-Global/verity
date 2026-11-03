import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ContainerSpec, DockerClient } from '../docker.js';
import { safeHostPath } from '../backup/host-plan.js';
import type { ServerDeploymentSpec } from './deployment-spec.js';
import { findControlPlanePostgres } from './postgres-image.js';

export const BACKUP_PROVISION_LABEL = 'org.verity.backup-provisioning';
const role = 'backup-provisioning';
type ProvisionDocker = Pick<
  DockerClient,
  | 'inspectImageLabels'
  | 'createContainer'
  | 'startContainer'
  | 'waitContainer'
  | 'containerLogs'
  | 'removeContainer'
  | 'listContainers'
  | 'inspectContainer'
>;
const planSchema = z
  .object({
    version: z.literal(1),
    statePath: z.string(),
    backupPath: z.string(),
    identityPath: z.string(),
    provisioned: z.boolean(),
  })
  .strict();
export type BackupProvisionPlan = z.infer<typeof planSchema>;

function bindSource(spec: ServerDeploymentSpec, target: string): string | undefined {
  const mount = spec.mounts.find((entry) => entry.target === target);
  if (!mount) return undefined;
  if (mount.source.kind !== 'bind' || !safeHostPath(mount.source.path))
    throw new Error(`Backup provisioning requires a sealed host bind for ${target}`);
  return mount.source.path;
}

async function job(docker: ProvisionDocker, spec: ContainerSpec): Promise<string> {
  if (!docker.waitContainer || !docker.containerLogs)
    throw new Error('Backup provisioning requires job lifecycle support');
  const created = await docker.createContainer(spec);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await docker.startContainer(created.id);
    const status = await Promise.race([
      docker.waitContainer(created.id),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Backup host provisioning timed out')), 120_000);
      }),
    ]);
    // Never include arbitrary helper output in errors: database credentials are private.
    if (status !== 0)
      throw new Error('Backup host provisioning failed; previous Server remains active');
    const output = await docker.containerLogs(created.id, 32);
    if (output.length > 4096) throw new Error('Invalid backup provisioning response');
    return output;
  } finally {
    if (timer) clearTimeout(timer);
    await docker.removeContainer(created.id);
  }
}

/** A crashed Updater may leave a stopped daemon-owned one-shot behind. */
async function cleanStoppedJobs(docker: ProvisionDocker, deploymentId: string): Promise<void> {
  for (const container of (await docker.listContainers?.()) ?? []) {
    if (
      container.labels?.['verity.managed-deployment-id'] !== deploymentId ||
      container.labels?.['verity.managed-role'] !== role
    )
      continue;
    if (!(await docker.inspectContainer(container.id)).running)
      await docker.removeContainer(container.id);
  }
}

function base(image: string, deploymentId: string): ContainerSpec {
  if (!/^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error('Backup provisioning requires an official digest');
  return {
    image,
    name: `verity-backup-provision-${randomUUID()}`,
    labels: { 'verity.managed-deployment-id': deploymentId, 'verity.managed-role': role },
    user: '0:0',
    network: 'none',
    restartPolicy: 'no',
    readOnlyRootfs: true,
    securityOpt: ['no-new-privileges=true'],
    tmpfs: { '/tmp': 'rw,nosuid,nodev,size=16m' },
    capDrop: ['ALL'],
    pidsLimit: 64,
    memoryBytes: 256 * 1024 * 1024,
  };
}

/** Called only after the target image passes the update verifier and read-only preflight. */
export async function backupProvisionPlan(
  docker: ProvisionDocker,
  spec: ServerDeploymentSpec,
  image: string,
): Promise<BackupProvisionPlan | undefined> {
  const contract = (await docker.inspectImageLabels?.(image))?.[BACKUP_PROVISION_LABEL];
  if (contract === undefined || contract === '') return undefined;
  if (contract !== '1') throw new Error('Unsupported backup provisioning contract');
  const statePath = bindSource(spec, '/run/verity-pairing');
  // Hand-assembled deployments have no installer authority to migrate. They
  // keep updating; the administrator status explains the missing prerequisites.
  if (!statePath) return undefined;
  const identityPath =
    bindSource(spec, '/run/verity-backup-identity') ?? '/var/lib/verity/backup-identity';
  const result = planSchema.parse(
    JSON.parse(
      await job(docker, {
        ...base(image, spec.deploymentId),
        binds: [`${statePath}:${statePath}:ro`],
        entrypoint: ['node'],
        command: ['/app/packages/server/dist/backup/host-plan-cli.js'],
        env: [`VERITY_STATE_DIR=${statePath}`, `VERITY_BACKUP_IDENTITY_DIR=${identityPath}`],
      }),
    ),
  );
  if (
    result.statePath !== statePath ||
    result.identityPath !== identityPath ||
    !safeHostPath(result.backupPath)
  )
    throw new Error('Backup host plan differs from sealed authority');
  const existing = bindSource(spec, '/run/verity-backups');
  if (existing && existing !== result.backupPath)
    throw new Error('Backup destination differs from sealed authority');
  return result;
}

export async function provisionBackupHost(
  docker: ProvisionDocker,
  spec: ServerDeploymentSpec,
  image: string,
  plan: BackupProvisionPlan,
): Promise<void> {
  await cleanStoppedJobs(docker, spec.deploymentId);
  const socket = bindSource(spec, '/var/run/docker.sock');
  if (!socket) throw new Error('Backup provisioning requires the sealed Docker socket');
  const postgres = await findControlPlanePostgres(docker, 'postgres', spec.network);
  if (!postgres)
    throw new Error('Backup provisioning requires the unique running control-plane PostgreSQL');
  await job(docker, {
    ...base(image, spec.deploymentId),
    // These fixed host locations are used only by this release-owned one-shot helper.
    binds: [
      `${plan.statePath}:${plan.statePath}`,
      `${plan.backupPath}:${plan.backupPath}`,
      `${plan.identityPath}:${plan.identityPath}`,
      `${socket}:/var/run/docker.sock`,
      '/usr/local/libexec/verity:/usr/local/libexec/verity',
      '/etc/systemd/system:/etc/systemd/system',
      '/run/systemd:/run/systemd',
    ],
    capAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
    // systemctl checks SO_PEERCRED on the host's private manager socket. In a
    // child PID namespace the host manager has PID 0, rejected as ENODATA.
    // Only this bounded host-writing job needs visibility of the manager PID.
    pidMode: 'host',
    // The daemon-owned helper remains bounded even if the Updater dies.
    entrypoint: ['timeout', '--kill-after=5s', '110s', 'bash'],
    command: ['/opt/verity-install/deploy/host/verity-backup-provision'],
    env: [
      // The helper targets the mounted host manager, not an offline container
      // root. With host PIDs, systemctl otherwise mistakes that root for chroot.
      'SYSTEMD_IGNORE_CHROOT=1',
      `VERITY_STATE_DIR=${plan.statePath}`,
      `VERITY_BACKUP_DIR=${plan.backupPath}`,
      `VERITY_BACKUP_IDENTITY_DIR=${plan.identityPath}`,
      `VERITY_BACKUP_IMAGE=${image}`,
      `VERITY_BACKUP_POSTGRES=${postgres.id}`,
      `VERITY_SERVER_UID=${spec.user.uid}`,
      `VERITY_SERVER_GID=${spec.user.gid}`,
    ],
  });
  // Prove the mounted paths are writable as the future Server, without creating
  // a recipient request, repository or recovery key.
  await job(docker, {
    ...base(image, spec.deploymentId),
    user: `${spec.user.uid}:${spec.user.gid}`,
    binds: [`${plan.backupPath}:/backup`, `${plan.identityPath}:/identity`],
    entrypoint: ['node'],
    command: [
      '--input-type=module',
      '-e',
      "import {open,unlink} from 'node:fs/promises'; import {randomUUID} from 'node:crypto'; for(const root of ['/backup','/identity']) { const path=root+'/.verity-write-probe-'+randomUUID(); const file=await open(path,'wx',0o600); try { await file.sync(); } finally { await file.close(); await unlink(path); } }",
    ],
  });
  const after = await backupProvisionPlan(docker, spec, image);
  if (!after?.provisioned) throw new Error('Backup host provisioning was not verified');
}
