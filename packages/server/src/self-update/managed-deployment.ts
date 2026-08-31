import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  parseServerDeploymentSpec,
  sealDeploymentSpec,
  type ServerDeploymentSpec,
  type ServerDeploymentSpecBody,
} from './deployment-spec.js';

export const MANAGED_DEPLOYMENT_MARKER_VERSION = 1 as const;
export const MANAGED_DEPLOYMENT_SPEC_FILE = 'server-deployment.json';
export const MANAGED_DEPLOYMENT_MARKER_FILE = 'managed-deployment.json';

export interface ManagedDeploymentMarker {
  readonly schemaVersion: typeof MANAGED_DEPLOYMENT_MARKER_VERSION;
  readonly deploymentId: string;
}

export type ManagedDeploymentState =
  | { readonly managed: false; readonly reason: string }
  | {
      readonly managed: true;
      readonly marker: ManagedDeploymentMarker;
      readonly spec: ServerDeploymentSpec;
    };

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

function parseMarker(value: unknown): ManagedDeploymentMarker | null {
  if (
    !plainObject(value) ||
    Object.keys(value).length !== 2 ||
    value.schemaVersion !== MANAGED_DEPLOYMENT_MARKER_VERSION ||
    typeof value.deploymentId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value.deploymentId)
  )
    return null;
  return { schemaVersion: 1, deploymentId: value.deploymentId };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return null;
  }
}

/** Read the updater-owned bootstrap authority. Partial, corrupt, or mismatched
 * state is deliberately unsupported instead of being repaired implicitly. */
async function readManagedDeploymentFiles(root: string): Promise<ManagedDeploymentState> {
  const markerValue = await readJson(join(root, MANAGED_DEPLOYMENT_MARKER_FILE));
  const specValue = await readJson(join(root, MANAGED_DEPLOYMENT_SPEC_FILE));
  if (markerValue === undefined && specValue === undefined)
    return { managed: false, reason: 'managed deployment has not been initialized' };
  const marker = parseMarker(markerValue);
  if (marker === null) return { managed: false, reason: 'managed deployment marker is invalid' };
  const spec = parseServerDeploymentSpec(specValue);
  if (spec === null) return { managed: false, reason: 'managed deployment spec is invalid' };
  if (marker.deploymentId !== spec.deploymentId)
    return { managed: false, reason: 'managed deployment identity does not match its spec' };
  return { managed: true, marker, spec };
}

export async function readManagedDeployment(root: string): Promise<ManagedDeploymentState> {
  const directory = await openUpdaterOwnedRoot(root);
  try {
    return await readManagedDeploymentFiles(`/proc/self/fd/${directory.fd}`);
  } finally {
    await directory.close();
  }
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Replace a file in the updater-owned root in one step.
 *
 * Data is durable before the rename and the directory entry is durable after
 * it, so a crash leaves either the whole previous document or the whole new
 * one — never a half-written spec, which `readManagedDeployment` would report
 * as invalid and which would strand the deployment.
 */
async function writeAtomic(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `${name}.tmp`);
  await rm(temporary, { force: true });
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, join(directory, name));
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface AdvanceManagedDeploymentImageOptions {
  readonly root: string;
  /** Identity the caller believes it is updating; a mismatch is refused. */
  readonly deploymentId: string;
  /** Image the caller believes is sealed right now. */
  readonly fromImage: string;
  readonly toImage: string;
}

const CONTROL_RUNNER_ENVIRONMENT = [
  'VERITY_CONTROL_PLANE_RUNNER',
  'VERITY_CONTROL_PLANE_RUNNER_IDENTITY_DIR',
  // ADR 0006 Amendment 1's kill switch has to be sealed here too, not only into
  // the Compose overlay. A managed Server resolves its environment from the
  // sealed spec, so a spec written before the switch existed simply omits the
  // name — and the switch defaults ON. An operator on an already-sealed host
  // would set it to 0, see no error, and keep the socket. A switch that cannot
  // be turned off on the topology it ships to is the same defect as one that
  // reports a denial it is not delivering.
  'VERITY_CONTROL_PLANE_RUNNER_DOCKER',
] as const;

const CONTROL_RUNNER_MOUNTS: ServerDeploymentSpecBody['mounts'] = [
  {
    source: { kind: 'volume', name: 'verity-control-runner-runtime' },
    target: '/srv/verity/runners/verity-control',
    readOnly: false,
  },
  {
    source: { kind: 'volume', name: 'verity-control-runner-identity' },
    target: '/run/verity-control-identity',
    readOnly: false,
  },
];

/**
 * Upgrade an authority sealed before the dedicated control-plane Runner mounts
 * existed. The migration is deliberately narrow: the deployment must already
 * opt into the Runner supervisor, carry its CHOWN capability and runtime group,
 * and the Updater must explicitly enable the dedicated Runner. Anything else is
 * left unchanged rather than gaining mounts or environment authority implicitly.
 */
export async function migrateManagedControlPlaneRunner(
  rootPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<ManagedDeploymentState> {
  const enabled =
    environment.VERITY_RUNNER_SUPERVISOR === '1' &&
    (environment.VERITY_CONTROL_PLANE_RUNNER === '1' ||
      environment.VERITY_CONTROL_PLANE_RUNNER === 'true');
  const root = await openUpdaterOwnedRoot(rootPath);
  try {
    const pinnedRoot = `/proc/self/fd/${root.fd}`;
    const existing = await readManagedDeploymentFiles(pinnedRoot);
    if (!existing.managed || !enabled) return existing;

    const mountNames = new Set(
      existing.spec.mounts.flatMap((mount) =>
        mount.source.kind === 'volume' ? [mount.source.name] : [],
      ),
    );
    const mountCount = CONTROL_RUNNER_MOUNTS.filter(
      (mount) => mount.source.kind === 'volume' && mountNames.has(mount.source.name),
    ).length;
    if (mountCount !== 0 && mountCount !== CONTROL_RUNNER_MOUNTS.length)
      throw new Error('managed control-plane Runner authority is only partially configured');

    const runtimeGid = environment.VERITY_RUNNER_RUNTIME_GID?.trim() || '1101';
    if (!/^[1-9][0-9]{0,9}$/.test(runtimeGid))
      throw new Error('VERITY_RUNNER_RUNTIME_GID must be a positive group ID');
    if (
      !existing.spec.environment.some(
        (entry) => entry.name === 'VERITY_RUNNER_SUPERVISOR' && entry.source.kind === 'env',
      ) ||
      !existing.spec.security.capAdd.includes('CHOWN') ||
      !existing.spec.user.supplementaryGids.includes(Number(runtimeGid))
    )
      throw new Error('managed deployment is not eligible for control-plane Runner migration');

    const existingEnvironment = new Map(
      existing.spec.environment.map((entry) => [entry.name, entry]),
    );
    for (const name of CONTROL_RUNNER_ENVIRONMENT) {
      const entry = existingEnvironment.get(name);
      if (entry !== undefined && (entry.source.kind !== 'env' || entry.source.name !== name))
        throw new Error(`managed deployment has an incompatible ${name} source`);
    }
    const missingEnvironment = CONTROL_RUNNER_ENVIRONMENT.filter(
      (name) => !existingEnvironment.has(name),
    );
    if (mountCount === CONTROL_RUNNER_MOUNTS.length && missingEnvironment.length === 0)
      return existing;
    const body: ServerDeploymentSpecBody = {
      schemaVersion: existing.spec.schemaVersion,
      deploymentId: existing.spec.deploymentId,
      image: existing.spec.image,
      environment: [
        ...existing.spec.environment,
        ...missingEnvironment.map((name) => ({
          name,
          source: { kind: 'env' as const, name },
        })),
      ].sort((left, right) => left.name.localeCompare(right.name)),
      mounts:
        mountCount === CONTROL_RUNNER_MOUNTS.length
          ? existing.spec.mounts
          : [...existing.spec.mounts, ...CONTROL_RUNNER_MOUNTS],
      user: existing.spec.user,
      restart: existing.spec.restart,
      network: existing.spec.network,
      platform: existing.spec.platform,
      security: existing.spec.security,
      // Carried, never introduced. Re-sealing is the only way an existing
      // deployment's spec changes shape, and adding a field an older Server
      // cannot parse would make a rollback below this release unable to read its
      // own authority. A spec without limits keeps getting the identical Compose
      // defaults from `managedServerContainerSpec`, so there is nothing to gain.
      ...(existing.spec.resources === undefined ? {} : { resources: existing.spec.resources }),
    };
    const validated = parseServerDeploymentSpec(sealDeploymentSpec(body));
    if (validated === null)
      throw new Error('migrated control-plane Runner deployment spec is not allowlisted');
    await writeAtomic(pinnedRoot, MANAGED_DEPLOYMENT_SPEC_FILE, validated);
    return { managed: true, marker: existing.marker, spec: validated };
  } finally {
    await root.close();
  }
}

/**
 * Move the sealed authority to a new image, changing nothing else.
 *
 * This is the only supported mutation of an adopted spec, and it is what makes
 * an update durable: once this returns, a reconcile — after a crash, after a
 * host reboot, from any Updater — rebuilds the Server on the new image without
 * needing the journal to tell it so.
 *
 * Idempotent and fenced. Already being at `toImage` is success, so a retry
 * after a crash between the write and the journal advance is harmless; being at
 * any third image means someone else moved the authority and the caller's view
 * is stale, which is refused rather than overwritten.
 */
export async function advanceManagedDeploymentImage(
  options: AdvanceManagedDeploymentImageOptions,
): Promise<ManagedDeploymentState> {
  const root = await openUpdaterOwnedRoot(options.root);
  try {
    const pinnedRoot = `/proc/self/fd/${root.fd}`;
    const existing = await readManagedDeploymentFiles(pinnedRoot);
    if (!existing.managed) throw new Error(existing.reason);
    if (existing.marker.deploymentId !== options.deploymentId)
      throw new Error('managed deployment identity does not match the requested deployment');
    if (existing.spec.image === options.toImage) return existing;
    if (existing.spec.image !== options.fromImage)
      throw new Error('managed deployment image has moved since it was read');
    // Field by field rather than by spread: the spread of a sealed spec would
    // carry its old `checksum` into the hash input, and a new REQUIRED field added
    // to the body would silently go unsealed. Written out, tsc flags both. An
    // OPTIONAL one it cannot flag — `resources` below is covered by
    // "preserves the sealed resource limits across an image advance" instead.
    const body: ServerDeploymentSpecBody = {
      schemaVersion: existing.spec.schemaVersion,
      deploymentId: existing.spec.deploymentId,
      image: options.toImage,
      environment: existing.spec.environment,
      mounts: existing.spec.mounts,
      user: existing.spec.user,
      restart: existing.spec.restart,
      network: existing.spec.network,
      platform: existing.spec.platform,
      security: existing.spec.security,
      // Losing this would silently un-limit the control plane on the first
      // self-update after it was sealed — the exact drift the field exists to stop.
      ...(existing.spec.resources === undefined ? {} : { resources: existing.spec.resources }),
    };
    const validated = parseServerDeploymentSpec(sealDeploymentSpec(body));
    if (validated === null) throw new Error('managed deployment target spec is not allowlisted');
    await writeAtomic(pinnedRoot, MANAGED_DEPLOYMENT_SPEC_FILE, validated);
    return { managed: true, marker: existing.marker, spec: validated };
  } finally {
    await root.close();
  }
}

export interface InitializeManagedDeploymentOptions {
  readonly root: string;
  readonly spec: Omit<ServerDeploymentSpecBody, 'schemaVersion' | 'deploymentId'>;
  readonly deploymentId?: string;
}

async function openUpdaterOwnedRoot(root: string, prepare: boolean = false): Promise<FileHandle> {
  const directory = await open(root, 'r');
  let metadata = await directory.stat();
  const resolved = await realpath(`/proc/self/fd/${directory.fd}`);
  const effectiveUid = process.geteuid?.();
  if (
    resolved !== root ||
    !metadata.isDirectory() ||
    effectiveUid === undefined ||
    metadata.uid !== effectiveUid ||
    (prepare ? (metadata.mode & 0o022) !== 0 : (metadata.mode & 0o077) !== 0)
  ) {
    await directory.close();
    throw new Error('managed deployment root must be a private updater-owned directory');
  }
  if (prepare && (metadata.mode & 0o077) !== 0) {
    await directory.chmod(0o700);
    metadata = await directory.stat();
    if ((metadata.mode & 0o077) !== 0) {
      await directory.close();
      throw new Error('managed deployment root could not be made private');
    }
  }
  return directory;
}

/** Explicit one-time adoption. The strict deployment-spec parser is the image,
 * mount, environment, network, and capability allowlist. Existing or partial
 * state is never overwritten. */
export async function initializeManagedDeployment(
  options: InitializeManagedDeploymentOptions,
): Promise<ManagedDeploymentState> {
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const root = await openUpdaterOwnedRoot(options.root, true);
  try {
    const pinnedRoot = `/proc/self/fd/${root.fd}`;
    const existing = await readManagedDeploymentFiles(pinnedRoot);
    if (existing.managed) {
      if (
        options.deploymentId !== undefined &&
        existing.marker.deploymentId !== options.deploymentId
      ) {
        throw new Error('managed deployment identity does not match the requested deployment');
      }
      return existing;
    }
    if (existing.reason !== 'managed deployment has not been initialized') {
      throw new Error(existing.reason);
    }
    const deploymentId = options.deploymentId ?? `verity-${randomUUID()}`;
    const candidate = sealDeploymentSpec({
      ...options.spec,
      schemaVersion: 2,
      deploymentId,
    });
    const validated = parseServerDeploymentSpec(candidate);
    if (validated === null) throw new Error('managed deployment adoption spec is not allowlisted');
    const marker: ManagedDeploymentMarker = { schemaVersion: 1, deploymentId };
    // Exclusive spec creation is the one-time authority claim. A concurrent
    // initializer cannot overwrite it; a crash remains a visible fail-closed
    // partial state that requires explicit host recovery.
    try {
      await writeExclusive(join(pinnedRoot, MANAGED_DEPLOYMENT_SPEC_FILE), validated);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('managed deployment initialization is already in progress', {
          cause: error,
        });
      }
      throw error;
    }
    await writeExclusive(join(pinnedRoot, MANAGED_DEPLOYMENT_MARKER_FILE), marker);
    return { managed: true, marker, spec: validated };
  } finally {
    await root.close();
  }
}
