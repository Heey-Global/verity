import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { ContainerSpec, DockerClient } from '../docker.js';
import type { UpdateJournal } from './update-journal.js';
import { readAgentSeedStamp } from './agent-seed-stamp.js';
import { reconcileManagedControlPlaneRunner } from './managed-control-plane-runner.js';
import {
  MANAGED_GATEWAY_CONTROL_SOCKET,
  waitForManagedGatewayStatus,
} from './managed-gateway-control.js';
import { MANAGED_DEPLOYMENT_LABEL, MANAGED_ROLE_LABEL } from './managed-server-owner.js';

const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const GATEWAY_SERVICE = 'verity-managed-gateway';
const AGENT_GATEWAY_SERVICE = 'verity-agent-gateway';
const UPDATER_SERVICE = 'verity-updater';
const GATEWAY_ROLE = 'gateway';
const AGENT_GATEWAY_ROLE = 'agent-gateway';
const UPDATER_ROLE = 'updater';
const HANDOFF_ROLE = 'companion-handoff';
const AGENT_SEED_SOURCE = '/opt/verity-features/verity-sandbox-toolkit/agent-seed';
const AGENT_SEED_PARENT = '/opt/agent-seed-host-parent';
const AGENT_SEED_CURRENT = '.current';
const REQUIRED_AGENT_SEED_FILES = [
  'README.md',
  'code-review-prompt.md',
  'bin/verity-code-review',
  'bin/verity-gh-cred',
  'bin/verity-gh-token',
  'bin/verity-git-sign',
  'bin/verity-memory',
  'bin/verity-secret-scan',
  'bin/verity-tasks',
  'bin/gh',
  'bin/git',
  'hooks/pre-commit',
  'hooks/pre-push',
] as const;
const EXECUTABLE_AGENT_SEED_FILES = REQUIRED_AGENT_SEED_FILES.filter(
  (path) => path.startsWith('bin/') || path.startsWith('hooks/'),
);

export function agentSeedPublicationKey(image: string, version?: string): string {
  const digest = image.match(/@sha256:([a-f0-9]{64})$/)?.[1];
  return (
    digest ??
    createHash('sha256')
      .update(`${image}\0${version ?? ''}`)
      .digest('hex')
  );
}

type CompanionDocker = Pick<
  DockerClient,
  | 'createContainer'
  | 'inspectContainer'
  | 'listContainers'
  | 'pullImage'
  | 'removeContainer'
  | 'replaceContainerImage'
  | 'startContainer'
  | 'stopContainer'
  | 'waitContainer'
>;

export interface ReconcileManagedCompanionsOptions {
  readonly managedRoot: string;
  readonly docker: CompanionDocker;
  readonly environment?: NodeJS.ProcessEnv;
  /** Injectable clock for the health settle loop (tests drive it instantly). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly journal: UpdateJournal;
  readonly waitForHandoff?: () => Promise<void>;
  readonly reconcileRunner?: () => Promise<void>;
}

/*
 * COMPANION RECONCILIATION IS THE UPDATER'S, AND ONLY THE UPDATER'S.
 *
 * A Server-side bridge used to live here: the promoted target Server polled the
 * update journal once a second so it could drive the handoff itself if a legacy
 * Updater stopped at `committed` without knowing the companion protocol. It ran
 * on every managed Server and succeeded on none of them, because the Server
 * cannot reach the journal — and cannot be made to. Two independent invariants,
 * both deliberate, say so:
 *
 *   1. The journal lives on `verity-managed-deployment`, and the sealed
 *      deployment spec pins an allowlist of exactly which volume may appear at
 *      which target (`deployment-spec.ts`). That volume is not on it, and
 *      `initialize` is create-only, so no existing deployment could re-seal
 *      itself to add one.
 *   2. `openRoot` in `update-journal.ts` requires the root to be owned by the
 *      reading process's own euid and be mode 0700. The root is the Updater's,
 *      created root-owned; the Server runs as an unprivileged uid. Even a
 *      mounted journal would be refused.
 *
 * So the poll could only ever throw ENOENT, log, and sleep — forever, at 1 Hz,
 * for the life of every managed Server. Nothing was lost by deleting it: the
 * Updater resumes `committed` and `reconciling-companions` from its own startup
 * path (`update-runner.ts`), in the one process that owns the journal, can read
 * it, and is allowed to advance it.
 *
 * THE BOUNDARY THIS LEAVES EXPLICIT. An Updater older than v13.2.0 — the release
 * that introduced companion reconciliation and the `reconciling-companions`
 * phase together — has no code that replaces the companions or itself. Such a
 * deployment cannot self-update its own companions and has to be migrated by the
 * operator, through `managed-bootstrap`, rather than in-place. That was already
 * true: the bridge is what LOOKED like the migration path, and it was not one,
 * on any host, ever. Stating the boundary is the honest version of what a poll
 * that never once succeeded was implying.
 */

const oneService = async (
  docker: CompanionDocker,
  summaries: Awaited<ReturnType<NonNullable<DockerClient['listContainers']>>>,
  service: string,
  role: string,
  deploymentId: string,
  composeProject?: string,
) => {
  const matches = [];
  for (const item of summaries) {
    const managed =
      item.labels?.[MANAGED_ROLE_LABEL] === role &&
      item.labels?.[MANAGED_DEPLOYMENT_LABEL] === deploymentId;
    if (!managed && item.labels?.[COMPOSE_SERVICE_LABEL] !== service) continue;
    const inspect = await docker.inspectContainer(item.id);
    const compose =
      (composeProject !== undefined && item.labels?.[COMPOSE_PROJECT_LABEL] === composeProject) ||
      inspect.env?.includes(`VERITY_MANAGED_DEPLOYMENT_ID=${deploymentId}`) === true;
    if (managed || compose) matches.push({ item, inspect });
  }
  if (matches.length === 2) {
    const ids = new Set(matches.map((match) => match.item.id));
    const replacement = matches.find((match) => {
      const predecessor = match.item.labels?.['verity.replacement-for'];
      return predecessor !== undefined && ids.has(predecessor);
    });
    if (replacement !== undefined) {
      const predecessor = replacement.item.labels?.['verity.replacement-for'];
      return matches.find((match) => match.item.id === predecessor)!;
    }
  }
  if (matches.length !== 1)
    throw new Error(`managed companion service ${service} must have exactly one container`);
  return matches[0]!;
};

const handoffName = (generation: number): string =>
  `verity-managed-companion-handoff-g${String(generation)}`;

const HEALTH_SAMPLE_MS = 500;
/** The ceiling has to outlast the container's OWN verdict, or this declares a
 *  failure while the healthcheck it is reading is still running. The Gateways
 *  carry `start period 10s, interval 10s, retries 5`: a slow start legitimately
 *  spends around a minute in `starting` before Docker commits either way, and on
 *  a loaded host that is the normal case rather than the exception. The previous
 *  30s fitted two probes — one slow start was enough to roll a perfectly healthy
 *  replacement back and strand the update at `reconciling-companions`. Matches
 *  the companion handoff budget. */
const HEALTH_SETTLE_TIMEOUT_MS = 120_000;

async function ensureRunning(
  docker: CompanionDocker,
  id: string,
  label: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  let state = await docker.inspectContainer(id);
  if (!state.running) {
    await docker.startContainer(id);
    state = await docker.inspectContainer(id);
  }
  const samples = Math.ceil(HEALTH_SETTLE_TIMEOUT_MS / HEALTH_SAMPLE_MS);
  for (let sample = 0; sample < samples; sample += 1) {
    if (!state.running) throw new Error(`${label} exited during startup`);
    // No healthcheck at all: a few samples of staying up is the only signal there
    // is, and waiting the full ceiling for one would stall every reconcile.
    if (state.healthStatus === 'healthy' || (state.healthStatus === undefined && sample >= 3))
      return;
    if (state.healthStatus === 'unhealthy') throw new Error(`${label} is unhealthy`);
    await sleep(HEALTH_SAMPLE_MS);
    state = await docker.inspectContainer(id);
  }
  // The inspection taken at the deadline is a reading like any other — throwing
  // without looking at it would discard a transition that already happened.
  if (!state.running) throw new Error(`${label} exited during startup`);
  if (state.healthStatus === 'healthy') return;
  if (state.healthStatus === 'unhealthy') throw new Error(`${label} is unhealthy`);
  throw new Error(`${label} did not become healthy`);
}

async function waitForHandoffOrFailure(
  docker: CompanionDocker,
  helperId: string,
  timeoutMs = 120_000,
): Promise<void> {
  if (docker.waitContainer === undefined)
    throw new Error('companion handoff requires container wait support');
  // Cleared on BOTH exits, like the same race in `managed-control-plane-runner`
  // and `withDeadline` in `docker-in-place-cutover`. This one did not, and inside
  // the Updater — a process that outlives any single update — nothing could
  // notice: the timer simply fired later against a promise already settled.
  //
  // The live self-update smoke is where it became visible, because there every
  // stage is its own short-lived process. Six `companion-handoff` stages each sat
  // on the unspent remainder of this budget AFTER printing their result, ~119s
  // apiece — about half that job's wall clock, and invisible in the log because
  // the time landed between two lines rather than inside any one stage.
  //
  // `try`/`finally` around the whole race rather than `.finally` on it, so the
  // clear also covers a `waitContainer` that throws synchronously — that happens
  // while the race's argument list is evaluated, which is after the timer is
  // already armed but before anything could be attached to the race.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const result = await Promise.race([docker.waitContainer(helperId), timeout]);
    if (result !== 'timeout') {
      if (result !== 0) throw new Error(`companion handoff helper exited ${String(result)}`);
      return;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  await docker.stopContainer(helperId).catch(() => undefined);
  await docker.removeContainer(helperId).catch(() => undefined);
  throw new Error('companion handoff helper timed out');
}

/**
 * Finish the second half of a Server update without introducing another host
 * daemon. The old Updater replaces the stable Gateway, then launches a tiny
 * target-image helper. That helper replaces the Updater process itself. The
 * successor Updater enters through this same function, reconciles the Runner,
 * and is the only process allowed to mark the journal complete.
 */
export async function reconcileManagedCompanions(
  options: ReconcileManagedCompanionsOptions,
): Promise<void> {
  if (options.docker.listContainers === undefined)
    throw new Error('managed companion reconciliation requires container listing');
  if (options.docker.replaceContainerImage === undefined)
    throw new Error('managed companion reconciliation requires atomic image replacement');
  const summaries = await options.docker.listContainers();
  const updater = await oneService(
    options.docker,
    summaries,
    UPDATER_SERVICE,
    UPDATER_ROLE,
    options.journal.deploymentId,
  );
  const composeProject = updater.item.labels?.[COMPOSE_PROJECT_LABEL];
  const gateway = await oneService(
    options.docker,
    summaries,
    GATEWAY_SERVICE,
    GATEWAY_ROLE,
    options.journal.deploymentId,
    composeProject,
  );
  const agentGateway = await oneService(
    options.docker,
    summaries,
    AGENT_GATEWAY_SERVICE,
    AGENT_GATEWAY_ROLE,
    options.journal.deploymentId,
    composeProject,
  );
  const gatewayInspect = gateway.inspect;
  const agentGatewayInspect = agentGateway.inspect;
  const updaterInspect = updater.inspect;

  if (agentGatewayInspect.image !== options.journal.targetDigest) {
    const replacement = await options.docker.replaceContainerImage(
      agentGateway.item.id,
      options.journal.targetDigest,
    );
    await ensureRunning(options.docker, replacement, 'replacement Agent Gateway', options.sleep);
  } else await ensureRunning(options.docker, agentGateway.item.id, 'Agent Gateway', options.sleep);

  if (gatewayInspect.image !== options.journal.targetDigest) {
    const replacement = await options.docker.replaceContainerImage(
      gateway.item.id,
      options.journal.targetDigest,
    );
    await ensureRunning(options.docker, replacement, 'replacement managed Gateway', options.sleep);
  } else await ensureRunning(options.docker, gateway.item.id, 'managed Gateway', options.sleep);
  if (options.environment !== undefined)
    // Three stable running samples are not proof that a container without a
    // healthcheck has bound its socket. Keep a short final grace for that race.
    await waitForManagedGatewayStatus(
      options.environment.VERITY_MANAGED_GATEWAY_CONTROL_SOCKET ?? MANAGED_GATEWAY_CONTROL_SOCKET,
      { timeoutMs: 5_000, ...(options.sleep === undefined ? {} : { sleep: options.sleep }) },
    );

  if (updaterInspect.image !== options.journal.targetDigest) {
    const socketPath = options.environment?.VERITY_DOCKER_SOCKET_PATH ?? '/var/run/docker.sock';
    const seedMount = updaterInspect.mounts?.find(
      (mount) =>
        mount.type === 'bind' &&
        mount.destination === '/opt/agent-seed' &&
        mount.readWrite === false &&
        typeof mount.source === 'string',
    );
    if (seedMount?.source === undefined)
      throw new Error('managed Updater has no read-only agent-seed host mount');
    const seedName = basename(seedMount.source);
    if (!/^[a-zA-Z0-9._-]+$/.test(seedName))
      throw new Error('managed Updater agent-seed mount has an invalid directory name');
    const seedTarget = join(AGENT_SEED_PARENT, seedName);
    const expectedEnv = [
      `VERITY_HANDOFF_UPDATER_ID=${updater.item.id}`,
      `VERITY_HANDOFF_TARGET_IMAGE=${options.journal.targetDigest}`,
      `VERITY_HANDOFF_DEPLOYMENT_ID=${options.journal.deploymentId}`,
      `VERITY_DOCKER_SOCKET_PATH=${socketPath}`,
      `VERITY_HANDOFF_AGENT_SEED_TARGET=${seedTarget}`,
    ];
    const expectedMounts = new Set([
      `${socketPath}\0/var/run/docker.sock`,
      `${dirname(seedMount.source)}\0${AGENT_SEED_PARENT}`,
    ]);
    let existing = summaries.find(
      (item) =>
        item.names?.includes(handoffName(options.journal.generation)) &&
        item.labels?.[MANAGED_DEPLOYMENT_LABEL] === options.journal.deploymentId,
    );
    if (existing !== undefined) {
      const state = await options.docker.inspectContainer(existing.id);
      const exact =
        state.image === options.journal.targetDigest &&
        state.labels?.[MANAGED_DEPLOYMENT_LABEL] === options.journal.deploymentId &&
        state.labels?.[MANAGED_ROLE_LABEL] === HANDOFF_ROLE &&
        state.labels?.['verity.update-generation'] === String(options.journal.generation) &&
        state.command?.length === 1 &&
        state.command[0] === 'managed-companion-handoff' &&
        state.env?.length === expectedEnv.length &&
        expectedEnv.every((entry) => state.env?.includes(entry)) &&
        state.user === '0:0' &&
        state.networkMode === 'none' &&
        state.restartPolicy === 'on-failure' &&
        state.securityOpt?.includes('no-new-privileges:true') === true &&
        state.mounts?.length === expectedMounts.size &&
        state.mounts.every(
          (mount) =>
            mount.type === 'bind' &&
            mount.readWrite === true &&
            typeof mount.source === 'string' &&
            typeof mount.destination === 'string' &&
            expectedMounts.has(`${mount.source}\0${mount.destination}`),
        );
      if (!exact || !state.running) {
        if (state.running) await options.docker.stopContainer(existing.id);
        await options.docker.removeContainer(existing.id);
        existing = undefined;
      }
    }
    let helperId = existing?.id;
    if (existing === undefined) {
      const spec: ContainerSpec = {
        image: options.journal.targetDigest,
        name: handoffName(options.journal.generation),
        labels: {
          [MANAGED_DEPLOYMENT_LABEL]: options.journal.deploymentId,
          [MANAGED_ROLE_LABEL]: HANDOFF_ROLE,
          'verity.update-generation': String(options.journal.generation),
        },
        command: ['managed-companion-handoff'],
        env: expectedEnv,
        binds: [
          `${socketPath}:/var/run/docker.sock`,
          `${dirname(seedMount.source)}:${AGENT_SEED_PARENT}`,
        ],
        user: '0:0',
        network: 'none',
        restartPolicy: 'on-failure',
        securityOpt: ['no-new-privileges:true'],
      };
      try {
        const created = await options.docker.createContainer(spec);
        helperId = created.id;
        await options.docker.startContainer(created.id);
      } catch (error) {
        if ((error as { kind?: unknown }).kind !== 'image_not_found') throw error;
        if (options.docker.pullImage === undefined) throw error;
        await options.docker.pullImage(options.journal.targetDigest);
        const created = await options.docker.createContainer(spec);
        helperId = created.id;
        await options.docker.startContainer(created.id);
      }
    }
    if (options.waitForHandoff !== undefined) await options.waitForHandoff();
    else {
      if (helperId === undefined) throw new Error('companion handoff helper identity is missing');
      await waitForHandoffOrFailure(options.docker, helperId);
    }
  }

  if (options.reconcileRunner !== undefined) await options.reconcileRunner();
  else
    await reconcileManagedControlPlaneRunner({
      managedRoot: options.managedRoot,
      docker: options.docker,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    });

  const refreshed = await options.docker.listContainers();
  for (const item of refreshed.filter(
    (entry) =>
      entry.labels?.[MANAGED_ROLE_LABEL] === HANDOFF_ROLE &&
      entry.labels?.[MANAGED_DEPLOYMENT_LABEL] === options.journal.deploymentId,
  )) {
    await options.docker.removeContainer(item.id);
  }
}

export async function runManagedCompanionHandoff(
  docker: Pick<DockerClient, 'replaceContainerImage'>,
  environment: NodeJS.ProcessEnv = process.env,
  options: { readonly publishAgentSeed?: () => Promise<void> } = {},
): Promise<void> {
  const updaterId = environment.VERITY_HANDOFF_UPDATER_ID;
  const targetImage = environment.VERITY_HANDOFF_TARGET_IMAGE;
  const deploymentId = environment.VERITY_HANDOFF_DEPLOYMENT_ID;
  if (updaterId === undefined || !/^[a-f0-9]{12,64}$/.test(updaterId))
    throw new Error('companion handoff requires a valid Updater container id');
  if (
    targetImage === undefined ||
    !/^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/.test(targetImage)
  )
    throw new Error('companion handoff requires an official digest-pinned target image');
  if (docker.replaceContainerImage === undefined)
    throw new Error('companion handoff requires atomic image replacement');
  if (deploymentId === undefined || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(deploymentId))
    throw new Error('companion handoff requires a valid deployment id');
  const seedTarget = environment.VERITY_HANDOFF_AGENT_SEED_TARGET;
  if (
    seedTarget === undefined ||
    dirname(seedTarget) !== AGENT_SEED_PARENT ||
    !/^[a-zA-Z0-9._-]+$/.test(basename(seedTarget))
  )
    throw new Error('companion handoff requires an agent-seed target in the fixed parent');
  if (options.publishAgentSeed !== undefined) await options.publishAgentSeed();
  else
    await publishAgentSeedAtomically(
      AGENT_SEED_SOURCE,
      seedTarget,
      targetImage,
      environment.VERITY_SERVER_VERSION ?? '0.0.0-dev',
      undefined,
      undefined,
      true,
    );
  await docker.replaceContainerImage(updaterId, targetImage);
}

export async function publishAgentSeedAtomically(
  source: string,
  seedTarget: string,
  targetImage: string,
  version: string,
  now: () => Date = () => new Date(),
  verifySelection: ((directory: string) => Promise<void>) | undefined = undefined,
  requireExistingSelection = false,
): Promise<void> {
  if (targetImage === '' || targetImage.length > 1024 || /[\r\n]/.test(targetImage))
    throw new Error('agent-seed publication requires a valid source image reference');
  await mkdir(seedTarget, { recursive: true, mode: 0o755 });
  const key = agentSeedPublicationKey(targetImage, version);
  const versions = join(seedTarget, '.versions');
  const published = join(versions, key);
  const staging = `${published}.next`;
  await mkdir(versions, { recursive: true, mode: 0o755 });
  const exists = await lstat(published).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
  if (!exists) {
    await rm(staging, { recursive: true, force: true });
    await cp(source, staging, { recursive: true, force: true });
    const temporary = join(staging, '.verity-agent-seed.next');
    await writeFile(
      temporary,
      `schema=1\nimage=${targetImage}\nversion=${version}\npublished=${now().toISOString()}\n`,
      { mode: 0o644 },
    );
    await rename(temporary, join(staging, '.verity-agent-seed'));
    await validatePublishedAgentSeed(staging, targetImage, version);
    await rename(staging, published);
  }
  await validatePublishedAgentSeed(published, targetImage, version);

  const current = join(seedTarget, AGENT_SEED_CURRENT);
  const previous = await readlink(current).catch(() => null);
  if (requireExistingSelection && previous === null) {
    const legacy = await readAgentSeedStamp(seedTarget);
    if (legacy === null)
      throw new Error(
        'managed agent-seed publication requires a complete bootstrap or legacy selection',
      );
    await validatePublishedAgentSeed(seedTarget, legacy.image, legacy.version);
  }
  const currentNext = join(seedTarget, `.current.${key}.next`);
  await rm(currentNext, { force: true });
  await symlink(join('.versions', key), currentNext);
  await rename(currentNext, current);
  try {
    await verifySelection?.(current);
    if ((await readPublishedAgentSeedDigest(seedTarget)) !== key)
      throw new Error('agent-seed promotion did not select the target digest');
    await validatePublishedAgentSeed(current, targetImage, version);
  } catch (error) {
    if (previous !== null) {
      await rm(currentNext, { force: true });
      await symlink(previous, currentNext);
      await rename(currentNext, current);
    } else await rm(current, { force: true });
    throw error;
  }
}

/** Validate the complete immutable tree before the sole visible pointer moves. */
export async function validatePublishedAgentSeed(
  directory: string,
  targetImage: string,
  version: string,
): Promise<void> {
  for (const path of REQUIRED_AGENT_SEED_FILES) {
    const entry = await lstat(join(directory, path)).catch(() => null);
    if (entry === null || !entry.isFile())
      throw new Error(`agent-seed validation failed: required file is missing: ${path}`);
    if (entry.isSymbolicLink())
      throw new Error(`agent-seed validation failed: required file is a symlink: ${path}`);
  }
  for (const path of EXECUTABLE_AGENT_SEED_FILES) {
    const handle = await open(join(directory, path), 'r');
    try {
      const stat = await handle.stat();
      if ((stat.mode & 0o111) === 0)
        throw new Error(`agent-seed validation failed: required file is not executable: ${path}`);
    } finally {
      await handle.close();
    }
  }
  const stamp = await lstat(join(directory, '.verity-agent-seed')).catch(() => null);
  if (stamp === null || !stamp.isFile() || stamp.isSymbolicLink())
    throw new Error('agent-seed validation failed: provenance stamp is missing');
  const fields = new Map<string, string>();
  const contents = await readFile(join(directory, '.verity-agent-seed'), 'utf8');
  for (const line of contents.trimEnd().split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0)
      throw new Error('agent-seed validation failed: provenance stamp is invalid');
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  if (
    fields.size !== 4 ||
    fields.get('schema') !== '1' ||
    fields.get('image') !== targetImage ||
    fields.get('version') !== version ||
    Number.isNaN(Date.parse(fields.get('published') ?? ''))
  )
    throw new Error('agent-seed validation failed: provenance stamp does not match target');
}

export async function readPublishedAgentSeedDigest(seedTarget: string): Promise<string | null> {
  const link = await readlink(join(seedTarget, AGENT_SEED_CURRENT)).catch(() => null);
  if (link === null) return null;
  const prefix = '.versions/';
  const key = link.startsWith(prefix) ? link.slice(prefix.length) : '';
  return /^[a-f0-9]{64}$/.test(key) ? key : null;
}
