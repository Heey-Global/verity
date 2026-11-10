import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MANAGED_DEPLOYMENT_ROOT,
  PROJECT_EGRESS_MOUNTS,
  MANAGED_STAGING_ASSESSMENT_FILE,
  readManagedDeployment,
  readDurableManagedUpdateChannel,
  markManagedStagingAssessment,
} from './managed-deployment.js';
import { readUpdateJournal, withUpdateJournalLease } from './update-journal.js';
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
  managedRoot?: string;
  onSkip?: (reason: 'target_contract_missing' | 'installed_contract_missing') => void;
}): Promise<boolean> {
  const { docker, journal, spec } = options;
  if (!(await projectEgressProvisionSupported(docker, journal, spec, options.onSkip))) return false;
  return runProjectEgressProvision({
    ...options,
    request: {
      deploymentId: journal.deploymentId,
      operationId: journal.updateId,
      installedDigest: journal.previousDigest,
      targetDigest: journal.targetDigest,
    },
  });
}

interface ProvisionRequest {
  readonly deploymentId: string;
  readonly operationId: string;
  readonly installedDigest: string;
  readonly targetDigest: string;
}

interface ProvisionOptions {
  docker: ProvisionDocker;
  request: ProvisionRequest;
  spec: ServerDeploymentSpec;
  environment: NodeJS.ProcessEnv;
  readFile?: (path: string) => Promise<string>;
  managedRoot?: string;
}

async function assessmentGrant(options: ProvisionOptions, operation: string) {
  if (
    options.managedRoot === undefined ||
    (await readDurableManagedUpdateChannel(options.managedRoot)) !== 'staging'
  )
    return undefined;
  const summaries = (await options.docker.listContainers?.()) ?? [];
  const updaters = summaries.filter(
    (item) => item.labels?.['com.docker.compose.service'] === 'verity-updater',
  );
  const running = [];
  for (const candidate of updaters) {
    const inspected = await options.docker.inspectContainer(candidate.id);
    if (inspected.running) running.push(inspected);
  }
  if (running.length !== 1) throw new Error('Staging assessment requires one installed Updater');
  const updater = running[0]!;
  if (!updater.running || updater.image !== options.spec.image || updater.user !== '0:0')
    throw new Error('Staging assessment Updater identity changed');
  const roots =
    updater.mounts?.filter((mount) => mount.destination === MANAGED_DEPLOYMENT_ROOT) ?? [];
  const root = roots[0];
  if (
    roots.length !== 1 ||
    root?.type !== 'volume' ||
    root.name !== 'verity-managed-deployment' ||
    root.readWrite !== true ||
    root.subpath !== undefined ||
    !root.source ||
    !safeHostPath(root.source)
  )
    throw new Error('Staging assessment requires the installed private managed volume');
  await markManagedStagingAssessment(options.managedRoot, options.spec.image, operation);
  return { volume: root.name, channelPath: join(root.source, 'update-channel.json') };
}

async function runProjectEgressProvision(options: ProvisionOptions): Promise<boolean> {
  const { docker, request, spec } = options;
  const state = spec.mounts.find((mount) => mount.target === '/run/verity-pairing');
  if (state?.source.kind !== 'bind' || !safeHostPath(state.source.path))
    throw new Error('Project egress provisioning requires installer state authority');
  const key = createHash('sha256')
    .update(`${request.deploymentId}\0${request.operationId}\0${request.targetDigest}`)
    .digest('hex')
    .slice(0, 24);
  const base = (stage: string, image: string): ContainerSpec => ({
    image,
    name: `verity-egress-${stage}-${key}`,
    user: '0:0',
    runtime: 'runc',
    labels: {
      'verity.managed-deployment-id': request.deploymentId,
      'verity.managed-role': 'egress-provisioning',
      'verity.update-id': request.operationId,
      'verity.target-digest': request.targetDigest,
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
    ...base('verify', request.installedDigest),
    network: 'bridge',
    binds: [],
    entrypoint: ['timeout', '--kill-after=5s', '120s', '/usr/local/bin/cosign'],
    command: [
      'verify',
      '--certificate-oidc-issuer',
      SERVER_IMAGE_SIGNING_ISSUER,
      '--certificate-identity',
      SERVER_IMAGE_SIGNING_IDENTITY,
      request.targetDigest,
    ],
    env: ['HOME=/tmp', 'TUF_ROOT=/tmp/tuf'],
  });
  // Signature verification is complete; later failures must not pin the installed image.
  await docker.removeContainer(verification);
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
  const targetEnv = (await docker.inspectImageEnv?.(request.targetDigest)) ?? [];
  const relay = targetEnv
    .find((entry) => entry.startsWith('VERITY_BUNDLED_PROJECT_RELAY_IMAGE='))
    ?.slice('VERITY_BUNDLED_PROJECT_RELAY_IMAGE='.length);
  if (!relay) throw new Error('Target image does not declare its project relay');
  const assessment = await assessmentGrant(options, key);
  const installation = await runHostRenewalJob(docker, {
    ...base('install', request.targetDigest),
    ...(assessment === undefined
      ? {}
      : {
          volumeMounts: [
            {
              volume: assessment.volume,
              target: '/run/verity-egress-updater-state',
              readOnly: true,
            },
          ],
        }),
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
      ...(assessment === undefined
        ? []
        : [
            `VERITY_EGRESS_ASSESSMENT_CHANNEL_PATH=${assessment.channelPath}`,
            `VERITY_EGRESS_ASSESSMENT_DEPLOYMENT_ID=${request.deploymentId}`,
            `VERITY_EGRESS_ASSESSMENT_INSTALLED_DIGEST=${request.installedDigest}`,
            `VERITY_EGRESS_ASSESSMENT_TARGET_DIGEST=${request.targetDigest}`,
            `VERITY_EGRESS_ASSESSMENT_OPERATION_ID=${key}`,
            'VERITY_EGRESS_ASSESSMENT_CHANNEL_OWNER_UID=0',
          ]),
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
  if (assessment !== undefined)
    await markManagedStagingAssessment(options.managedRoot!, spec.image, key, true);
  await docker.removeContainer(installation);
  return true;
}

/** The successor completes pending host provisioning from its own installed
 * authority, not by fabricating an update journal for the predecessor's hook. */
export async function reconcileInstalledProjectEgressHost(options: {
  docker: ProvisionDocker;
  managedRoot: string;
  environment?: NodeJS.ProcessEnv;
  readFile?: (path: string) => Promise<string>;
}): Promise<
  'attempted' | 'not-staging' | 'operation-pending' | 'mounts-pending' | 'already-attempted'
> {
  return withUpdateJournalLease(options.managedRoot, async () => {
    const state = await readManagedDeployment(options.managedRoot);
    if (!state.managed)
      throw new Error('Installed staging assessment requires a sealed deployment');
    if ((await readDurableManagedUpdateChannel(options.managedRoot)) !== 'staging')
      return 'not-staging';
    const journal = await readUpdateJournal(options.managedRoot);
    if (journal !== null && journal.phase !== 'completed') return 'operation-pending';
    const installed = state.spec.image;
    if (!/^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/u.test(installed))
      throw new Error('Installed staging assessment requires an official sealed image');
    const labels = await options.docker.inspectImageLabels?.(installed);
    if (
      labels?.[PROJECT_EGRESS_PROVISION_LABEL] !== '1' ||
      labels['org.verity.project-egress-deployment'] !== '1'
    )
      throw new Error('Installed image cannot admit staging assessment');
    if (
      !PROJECT_EGRESS_MOUNTS.every((expected) =>
        state.spec.mounts.some((mount) => JSON.stringify(mount) === JSON.stringify(expected)),
      )
    )
      return 'mounts-pending';
    try {
      const marker: unknown = JSON.parse(
        await readFile(join(options.managedRoot, MANAGED_STAGING_ASSESSMENT_FILE), 'utf8'),
      );
      if (
        typeof marker === 'object' &&
        marker !== null &&
        'image' in marker &&
        marker.image === installed &&
        'completed' in marker &&
        marker.completed === true &&
        'completionVersion' in marker &&
        marker.completionVersion === 2
      )
        return 'already-attempted';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const operationId = createHash('sha256')
      .update(`${state.spec.deploymentId}\0installed-staging-assessment-v2\0${installed}`)
      .digest('hex')
      .slice(0, 24);
    await runProjectEgressProvision({
      ...options,
      spec: state.spec,
      environment: options.environment ?? process.env,
      request: {
        deploymentId: state.spec.deploymentId,
        operationId,
        installedDigest: installed,
        targetDigest: installed,
      },
    });
    return 'attempted';
  });
}
