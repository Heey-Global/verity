import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ContainerSpec, DockerClient } from '../docker.js';
import { findControlPlanePostgres, parseControlPlaneDatabaseUrl } from './postgres-image.js';
import { safeHostPath } from '../backup/host-plan.js';
import type { ServerDeploymentSpec } from './deployment-spec.js';
import { managedServerContainerSpec } from './managed-server-owner.js';
import { runHostRenewalJob } from './host-runtime-renewal.js';
import {
  SERVER_IMAGE_SIGNING_IDENTITY,
  SERVER_IMAGE_SIGNING_ISSUER,
} from './server-image-verify.js';
import type { UpdateJournal } from './update-journal.js';

export const PROJECT_EGRESS_PROVISION_LABEL = 'org.verity.project-egress-provisioning';
export const PROJECT_EGRESS_CONTROL_GID = 65531;
type ProvisionDocker = Pick<
  DockerClient,
  | 'createContainer'
  | 'startContainer'
  | 'waitContainer'
  | 'inspectContainer'
  | 'inspectImageEnv'
  | 'inspectImageLabels'
  | 'listContainers'
  | 'removeContainer'
  | 'containerLogs'
>;

/** Exact host destinations only; project-controlled paths never cross this boundary. */
const PROJECT_EGRESS_PROVISION_BINDS = [
  '/etc/verity-egress:/etc/verity-egress',
  '/etc/verity-egress-server:/etc/verity-egress-server',
  '/var/lib/verity-egress:/var/lib/verity-egress',
  '/opt/verity-egress-releases:/opt/verity-egress-releases',
  '/opt/verity-egress-recovery:/opt/verity-egress-recovery',
  '/etc/systemd/system:/etc/systemd/system',
  '/etc/tmpfiles.d:/etc/tmpfiles.d',
  '/run/systemd:/run/systemd',
  '/run/verity-egress:/run/verity-egress',
  '/var/run/docker.sock:/var/run/docker.sock',
  '/etc/resolv.conf:/host/etc/resolv.conf:ro',
] as const;

export async function projectEgressProvisionSupported(
  docker: Pick<ProvisionDocker, 'inspectImageLabels'>,
  journal: UpdateJournal,
  spec: ServerDeploymentSpec,
  onSkip?: (reason: 'target_contract_missing' | 'installed_contract_missing') => void,
): Promise<boolean> {
  const contract = (await docker.inspectImageLabels?.(journal.targetDigest))?.[
    PROJECT_EGRESS_PROVISION_LABEL
  ];
  if (contract === undefined) {
    if (spec.mounts.some((mount) => mount.target === '/run/verity-egress'))
      throw new Error('Target image cannot preserve protected project egress authority');
    onSkip?.('target_contract_missing');
    return false;
  }
  const installed = (await docker.inspectImageLabels?.(journal.previousDigest))?.[
    'org.verity.project-egress-deployment'
  ];
  if (installed !== '1') {
    if (spec.mounts.some((mount) => mount.target === '/run/verity-egress'))
      throw new Error('Previous image cannot recover protected project egress authority');
    onSkip?.('installed_contract_missing');
    return false;
  }
  if (contract !== '1') throw new Error('Unsupported project egress provisioning contract');
  const official = /^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/u;
  if (
    !official.test(journal.previousDigest) ||
    !official.test(journal.targetDigest) ||
    spec.image !== journal.previousDigest ||
    spec.deploymentId !== journal.deploymentId
  )
    throw new Error('Project egress provisioning requires the installed sealed deployment');
  return true;
}

/** Independent admission uses the installed image before target code gains host writes. */
export async function provisionProjectEgressHost(options: {
  docker: ProvisionDocker;
  journal: UpdateJournal;
  spec: ServerDeploymentSpec;
  environment: NodeJS.ProcessEnv;
  readFile?: (path: string) => Promise<string>;
  onSkip?: (reason: 'target_contract_missing' | 'installed_contract_missing') => void;
}): Promise<boolean> {
  const { docker, journal, spec } = options;
  if (!(await projectEgressProvisionSupported(docker, journal, spec, options.onSkip))) return false;
  const state = spec.mounts.find((mount) => mount.target === '/run/verity-pairing');
  if (state?.source.kind !== 'bind' || !safeHostPath(state.source.path))
    throw new Error('Project egress provisioning requires installer state authority');
  const key = createHash('sha256')
    .update(`${journal.deploymentId}\0${journal.updateId}\0${journal.targetDigest}`)
    .digest('hex')
    .slice(0, 24);
  const base = (stage: string, image: string): ContainerSpec => ({
    image,
    name: `verity-egress-${stage}-${key}`,
    user: '0:0',
    runtime: 'runc',
    labels: {
      'verity.managed-deployment-id': journal.deploymentId,
      'verity.managed-role': 'egress-provisioning',
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
  const verification = await runHostRenewalJob(docker, {
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
  const server = await managedServerContainerSpec(
    spec,
    options.environment,
    options.readFile ?? ((path) => readFile(path, 'utf8')),
  );
  const databaseUrl = server.env
    ?.find((entry) => entry.startsWith('DATABASE_URL='))
    ?.slice('DATABASE_URL='.length);
  const database =
    databaseUrl === undefined ? undefined : parseControlPlaneDatabaseUrl(databaseUrl);
  const postgres =
    database === undefined
      ? undefined
      : await findControlPlanePostgres(docker, database.host, spec.network);
  if (postgres === undefined)
    throw new Error('Project egress provisioning requires one control-plane database');
  const targetEnv = (await docker.inspectImageEnv?.(journal.targetDigest)) ?? [];
  const relay = targetEnv
    .find((entry) => entry.startsWith('VERITY_BUNDLED_PROJECT_RELAY_IMAGE='))
    ?.slice('VERITY_BUNDLED_PROJECT_RELAY_IMAGE='.length);
  if (!relay) throw new Error('Target image does not declare its project relay');
  const installation = await runHostRenewalJob(docker, {
    ...base('install', journal.targetDigest),
    pidMode: 'host',
    network: spec.network,
    securityOpt: ['no-new-privileges=true', 'label=disable'],
    capAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
    binds: [
      ...PROJECT_EGRESS_PROVISION_BINDS,
      `${state.source.path}/.verity-install.lock:/run/verity-install.lock`,
    ],
    entrypoint: ['timeout', '--kill-after=5s', '750s', 'bash'],
    command: ['/opt/verity-install/deploy/host/verity-egress-provision'],
    env: [
      ...(server.env ?? []).filter((entry) =>
        /^(DATABASE_URL|VERITY_DATA_VOLUME|VERITY_PROJECT_RELAY_GID|VERITY_MATRIX_|VERITY_OPENCODE_)/u.test(
          entry,
        ),
      ),
      `VERITY_EGRESS_PROVISION_ID=${key}`,
      `VERITY_SERVER_UID=${String(spec.user.uid)}`,
      `VERITY_EGRESS_CONTROL_GID=${String(PROJECT_EGRESS_CONTROL_GID)}`,
      `VERITY_EGRESS_DEPLOYMENT_NETWORK=${spec.network}`,
      `VERITY_EGRESS_DATABASE_CONTAINER=${postgres.id}`,
      `VERITY_PROJECT_RELAY_IMAGE=${relay}`,
      'SYSTEMD_IGNORE_CHROOT=1',
      'VERITY_INSTALL_LOCK=/run/verity-install.lock',
    ],
  });
  await docker.removeContainer(installation);
  await docker.removeContainer(verification);
  return true;
}
