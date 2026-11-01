import { readFile } from 'node:fs/promises';
import { backupProvisionPlan, provisionBackupHost } from './backup-provisioning.js';
import type { ContainerInspect, DockerClient } from '../docker.js';
import { DEVCONTAINER_BUILDER_SOCKET_DIRECTORY } from './deployment-spec.js';
import {
  readDevcontainerBuilderCapability,
  reconcileDevcontainerBuilder,
} from './devcontainer-builder.js';
import {
  migrateManagedControlPlaneRunner,
  migrateManagedDevcontainerBuilder,
  migrateManagedHostDiagnostics,
  migrateManagedBackupMounts,
  readManagedDeployment,
} from './managed-deployment.js';
import { readHostDiagnosticsCapability } from './host-diagnostics.js';
import {
  MANAGED_DEPLOYMENT_LABEL,
  MANAGED_ROLE_LABEL,
  managedContainerMatchesSpec,
  managedServerContainerSpec,
  specImageEnvironment,
} from './managed-server-owner.js';
import { reconcileHostRuntimes, readTargetHostRuntimes } from './host-runtimes.js';
import { readBundledPostgresImage } from './postgres-image.js';
import { pullWithRetry } from './pull-retry.js';
import type { StandbyCandidate, UpdatePreparationDeps } from './update-preparation.js';
import type { UpdateJournal } from './update-journal.js';

const UPDATE_ID_LABEL = 'verity.update-id';
const GENERATION_LABEL = 'verity.generation';
const PREFLIGHT_ROLE = 'preflight';
const STANDBY_ROLE = 'server';
const SERVER_VERSION_ENV = 'VERITY_SERVER_VERSION';

export const generationOperationId = (generation: number): string =>
  `generation-${String(generation)}`;

export class CandidatePreflightError extends Error {
  readonly diagnostics: string;
  constructor(exitCode: number, diagnostics: string) {
    super(`candidate preflight failed with exit code ${String(exitCode)}`);
    this.name = 'CandidatePreflightError';
    this.diagnostics = diagnostics;
  }
}

export type UpdatePreparationDocker = Pick<
  DockerClient,
  | 'containerLogs'
  | 'createContainer'
  | 'inspectContainer'
  | 'inspectImageEnv'
  | 'inspectImageLabels'
  | 'inspectRuntime'
  | 'listContainers'
  | 'pullImage'
  | 'removeContainer'
  | 'startContainer'
  | 'waitContainer'
>;

export interface DockerUpdatePreparationOptions {
  readonly managedRoot: string;
  readonly docker: UpdatePreparationDocker;
  readonly environment?: NodeJS.ProcessEnv;
  readonly readFile?: (path: string) => Promise<string>;
  /** Revalidate the signed release metadata that authorized this exact digest. */
  readonly verifyImage: (journal: UpdateJournal) => Promise<void>;
  /** The host runtime request directory as the Updater sees it; tests only. */
  readonly hostRuntimeDir?: string;
  readonly log?: (message: string) => void;
  /** Waits between attempts of the target-image pull; tests only. */
  readonly pullRetryDelaysMs?: readonly number[];
  /** Sleep used for those waits; tests only. */
  readonly pullRetrySleep?: (ms: number) => Promise<unknown>;
}

function candidateName(journal: UpdateJournal, role: string): string {
  if (role === STANDBY_ROLE) return `verity-managed-server-g${String(journal.generation)}`;
  return `verity-managed-${role}-g${String(journal.generation)}`;
}

function activationEnvironment(
  base: readonly string[],
  imageEnvironment: readonly string[],
  journal: UpdateJournal,
  name: string,
): string[] {
  const overrides = new Map<string, string>([
    ['VERITY_CONTROL_PLANE_HOLDER_ID', name],
    ['VERITY_CONTROL_PLANE_WAIT_FOR_ACTIVATION', '1'],
    ['VERITY_UPDATE_ID', generationOperationId(journal.generation)],
  ]);
  const targetVersion = imageEnvironment.find((entry) =>
    entry.startsWith(`${SERVER_VERSION_ENV}=`),
  );
  if (targetVersion === undefined)
    throw new Error('target Server image does not declare its version');
  // The sealed deployment environment describes the currently running Server.
  // In particular, its VERITY_SERVER_VERSION source still names the outgoing
  // image after a cutover. Replace it explicitly with the target image's value:
  // relying on an omitted Docker create Env entry to restore an image default
  // proved unsafe across old managed specifications and updater generations.
  const result = base.filter((entry) => {
    const name = entry.slice(0, entry.indexOf('='));
    return name !== SERVER_VERSION_ENV && !overrides.has(name);
  });
  result.push(targetVersion);
  for (const [key, value] of overrides) result.push(`${key}=${value}`);
  return result;
}

function labels(journal: UpdateJournal, role: string): Record<string, string> {
  return {
    [MANAGED_DEPLOYMENT_LABEL]: journal.deploymentId,
    [MANAGED_ROLE_LABEL]: role,
    [UPDATE_ID_LABEL]: journal.updateId,
    [GENERATION_LABEL]: String(journal.generation),
  };
}

function exactCandidate(inspect: ContainerInspect, journal: UpdateJournal, role: string): boolean {
  return (
    inspect.image === journal.targetDigest &&
    inspect.labels?.[MANAGED_DEPLOYMENT_LABEL] === journal.deploymentId &&
    inspect.labels?.[MANAGED_ROLE_LABEL] === role &&
    inspect.labels?.[UPDATE_ID_LABEL] === journal.updateId &&
    inspect.labels?.[GENERATION_LABEL] === String(journal.generation)
  );
}

function preflightEnvironment(environment: readonly string[] | undefined): string[] {
  const allowed = new Set(['DATABASE_URL', 'VERITY_ROOT', 'HOST', 'PORT', 'VERITY_INTERNAL_PORT']);
  return (environment ?? []).filter((entry) => allowed.has(entry.slice(0, entry.indexOf('='))));
}

/**
 * How a PREPARED container is compared: not promoted, and with its host resource
 * ceilings part of the match.
 *
 * Everything this module adopts by name it also created — from the same sealed
 * spec, within the same operation, before any cutover — so unlike a Server the
 * reconciler merely finds running, a candidate has no pre-limits shape that has
 * to be tolerated. It is also what a cutover promotes into the running control
 * plane, so a standby carrying no ceilings must be refused here rather than
 * routed to and left unbounded until the update after next.
 */
const CANDIDATE_MATCH = [false, 'exact'] as const;

async function findNamed(docker: UpdatePreparationDocker, name: string): Promise<string | null> {
  if (docker.listContainers === undefined)
    throw new Error('update preparation requires container listing');
  const matches = (await docker.listContainers()).filter((item) => item.names?.includes(name));
  if (matches.length > 1) throw new Error(`multiple containers use reserved update name: ${name}`);
  return matches[0]?.id ?? null;
}

/** Build concrete, idempotent Docker actions for the crash-safe preparation journal. */
export async function dockerUpdatePreparation(
  options: DockerUpdatePreparationOptions,
): Promise<UpdatePreparationDeps> {
  const state = await readManagedDeployment(options.managedRoot);
  if (!state.managed) throw new Error(`managed Server authority unavailable: ${state.reason}`);
  const docker = options.docker;
  if (
    docker.pullImage === undefined ||
    docker.waitContainer === undefined ||
    docker.containerLogs === undefined ||
    docker.listContainers === undefined ||
    docker.inspectImageEnv === undefined
  )
    throw new Error('Docker update preparation capabilities are unavailable');
  let base = await managedServerContainerSpec(
    state.spec,
    options.environment ?? process.env,
    options.readFile ?? ((path) => readFile(path, 'utf8')),
  );

  // Pull progress goes where the rest of the Updater's narration goes.
  const progressLog = options.log ?? console.info;
  const pullOptions = { log: progressLog };

  // Every candidate runs the target digest, and preparation pulls it before any
  // container is compared, so the image is on the daemon by the time this runs.
  const candidateImageEnv = (journal: UpdateJournal): Promise<readonly string[]> =>
    specImageEnvironment(docker, journal.targetDigest);

  const ensureStandby = async (journal: UpdateJournal): Promise<StandbyCandidate> => {
    const name = candidateName(journal, STANDBY_ROLE);
    const imageEnvironment = await candidateImageEnv(journal);
    const existingId = await findNamed(docker, name);
    if (existingId !== null) {
      const existing = await docker.inspectContainer(existingId);
      const desired = {
        ...base,
        image: journal.targetDigest,
        name,
        labels: labels(journal, STANDBY_ROLE),
        env: activationEnvironment(base.env ?? [], imageEnvironment, journal, name),
      };
      if (
        !exactCandidate(existing, journal, STANDBY_ROLE) ||
        !managedContainerMatchesSpec(existing, desired, imageEnvironment, ...CANDIDATE_MATCH) ||
        !['created', 'running'].includes(existing.status ?? '')
      )
        throw new Error('reserved standby name is occupied by a conflicting container');
      if (existing.status === 'created') await docker.startContainer(existing.id);
      return { containerId: existing.id, containerName: name };
    }
    const desired = {
      ...base,
      image: journal.targetDigest,
      name,
      labels: labels(journal, STANDBY_ROLE),
      env: activationEnvironment(base.env ?? [], imageEnvironment, journal, name),
    };
    try {
      const created = await docker.createContainer(desired);
      await docker.startContainer(created.id);
      return { containerId: created.id, containerName: name };
    } catch (error) {
      if ((error as { kind?: unknown }).kind !== 'conflict') throw error;
      const winnerId = await findNamed(docker, name);
      if (winnerId === null)
        throw new Error('standby create conflict has no unique owner', { cause: error });
      const winner = await docker.inspectContainer(winnerId);
      if (
        !exactCandidate(winner, journal, STANDBY_ROLE) ||
        !managedContainerMatchesSpec(winner, desired, imageEnvironment, ...CANDIDATE_MATCH) ||
        !['created', 'running'].includes(winner.status ?? '')
      )
        throw new Error('standby create conflict belongs to another operation', { cause: error });
      if (winner.status === 'created') await docker.startContainer(winner.id);
      return { containerId: winner.id, containerName: name };
    }
  };

  const runPreflight = async (journal: UpdateJournal): Promise<void> => {
    const name = candidateName(journal, PREFLIGHT_ROLE);
    const desired = {
      ...base,
      image: journal.targetDigest,
      name,
      labels: labels(journal, PREFLIGHT_ROLE),
      restartPolicy: 'no' as const,
      command: ['preflight'],
      env: [...preflightEnvironment(base.env), 'VERITY_PREFLIGHT_READ_ONLY=1'],
      binds: [],
      volumeMounts: (base.volumeMounts ?? [])
        .filter((mount) => mount.target === '/srv/verity')
        .map((mount) => ({ ...mount, readOnly: true })),
      readOnlyRootfs: true,
      capAdd: [],
      groupAdd: [],
    };
    const occupied = await findNamed(docker, name);
    let containerId: string;
    let status: string | undefined;
    if (occupied === null) {
      try {
        const created = await docker.createContainer(desired);
        containerId = created.id;
        status = 'created';
      } catch (error) {
        if ((error as { kind?: unknown }).kind !== 'conflict') throw error;
        const winnerId = await findNamed(docker, name);
        if (winnerId === null)
          throw new Error('preflight create conflict has no unique owner', { cause: error });
        const winner = await docker.inspectContainer(winnerId);
        if (
          !exactCandidate(winner, journal, PREFLIGHT_ROLE) ||
          !managedContainerMatchesSpec(
            winner,
            desired,
            await candidateImageEnv(journal),
            ...CANDIDATE_MATCH,
          ) ||
          !['created', 'running', 'exited'].includes(winner.status ?? '')
        )
          throw new Error('preflight create conflict belongs to another operation', {
            cause: error,
          });
        containerId = winner.id;
        status = winner.status;
      }
    } else {
      const existing = await docker.inspectContainer(occupied);
      if (
        !exactCandidate(existing, journal, PREFLIGHT_ROLE) ||
        !managedContainerMatchesSpec(
          existing,
          desired,
          await candidateImageEnv(journal),
          ...CANDIDATE_MATCH,
        ) ||
        !['created', 'running', 'exited'].includes(existing.status ?? '')
      )
        throw new Error('reserved preflight name is occupied by a conflicting container');
      containerId = existing.id;
      status = existing.status;
    }
    try {
      if (status === 'created') await docker.startContainer(containerId);
      const exitCode = await docker.waitContainer!(containerId);
      if (exitCode !== 0) {
        const diagnostics = await docker.containerLogs!(containerId, 200);
        throw new CandidatePreflightError(exitCode, diagnostics);
      }
    } finally {
      await docker.removeContainer(containerId);
    }
  };

  return {
    /**
     * Pull the target Server image — and, behind it, the PostgreSQL image that
     * release was built against (ADR 0008 D14).
     *
     * Here, and nowhere later. The database swap happens inside the cutover's
     * maintenance window, and a registry round-trip does not belong in a window
     * whose entire justification is that it costs no downtime that is not
     * already being spent. Preparation runs while the old Server is still
     * serving, so this pull is free.
     *
     * Best-effort ON PURPOSE. A registry that cannot serve a third-party image
     * is not a reason to fail a Server update with nothing else wrong with it;
     * the reconciler checks the image is present and simply declines the swap
     * when it is not, leaving the database where it was until the next update.
     * For the same reason it gets a single attempt: retrying a pull whose
     * failure is swallowed anyway would only delay the update.
     *
     * The Server pull itself is retried ({@link pullWithRetry}) on a stall or a
     * transient network failure, because a failure here is terminal for the
     * operation and the slow, flaky links that cause it are exactly the ones
     * where a second attempt tends to get through.
     *
     * What a retry costs depends on the daemon's image store, and only part of
     * it is established:
     *
     * - Layers a failed attempt finished are kept by both stores and reported
     *   as "Already exists" next time; a retry never fetches those again.
     * - Classic graphdriver store: a partially downloaded layer is NOT carried
     *   across pulls. The daemon resumes it with an HTTP Range request only
     *   within its own per-layer retries inside one pull; the temporary file
     *   belongs to that pull and is removed when it ends (moby
     *   `distribution/pull_v2.go`, `v2LayerDescriptor.Download`/`Close`). A
     *   retry after a stall restarts each unfinished layer from zero.
     * - containerd image store (`io.containerd.snapshotter.v1`): containerd
     *   keeps an unfinished blob as an ingest under a ref derived from its
     *   digest, closes rather than aborts the writer when a fetch fails, and
     *   on the next fetch of the same blob seeks the registry stream to the
     *   ingest's offset (containerd `remotes/handlers.go` `Fetch`,
     *   `content/helpers.go` `Copy`/`seekReader`). So resumption is designed
     *   in. NOT verified: whether moby's pull lease or containerd's garbage
     *   collection removes that ingest between our attempts, and how long an
     *   ingest survives, were not established from code or documentation.
     *   Treat resumption there as likely but unconfirmed.
     *
     * With the idle window in place a steadily progressing pull no longer
     * needs a retry to finish, so none of this decides whether an update
     * completes; it decides how much a stall costs.
     */
    pullImage: async (digest) => {
      await pullWithRetry(digest, () => docker.pullImage!(digest, pullOptions), {
        ...(options.pullRetryDelaysMs === undefined ? {} : { delaysMs: options.pullRetryDelaysMs }),
        ...(options.pullRetrySleep === undefined ? {} : { sleep: options.pullRetrySleep }),
        log: progressLog,
      });
      const bundled = await readBundledPostgresImage(docker, digest);
      if (bundled.kind !== 'image') return;
      await docker.pullImage!(bundled.image, pullOptions).catch(() => undefined);
    },
    verifyImage: async (journal) => {
      if (journal.deploymentId !== state.spec.deploymentId)
        throw new Error('update journal deployment does not match managed authority');
      await options.verifyImage(journal);
    },
    runPreflight,
    reconcileHostRuntimes: async (journal) => {
      // One request id for both calls below: a builder answer already on file for this update
      // is reused rather than installed twice.
      const reconcileBuilder = () =>
        reconcileDevcontainerBuilder({
          docker,
          image: journal.targetDigest,
          requestId: journal.updateId,
          ...(options.hostRuntimeDir === undefined ? {} : { requestDir: options.hostRuntimeDir }),
        }).catch((error: unknown) => ({
          state: 'failed' as const,
          message: error instanceof Error ? error.message : String(error),
        }));
      const requirements = await readTargetHostRuntimes(docker, journal.targetDigest);
      if (requirements !== undefined) {
        await reconcileHostRuntimes({
          docker,
          requirements,
          requestId: journal.updateId,
          ...(options.hostRuntimeDir === undefined ? {} : { requestDir: options.hostRuntimeDir }),
          // A host whose runtime service predates archive pins gets the target's through the
          // builder first: its bundle registers the runtimes and replaces that service.
          refreshHostComponents: async () => {
            const refreshed = await reconcileBuilder();
            if (refreshed.state === 'reconciled') return undefined;
            const detail = refreshed.state === 'skipped' ? refreshed.reason : refreshed.message;
            (options.log ?? console.warn)(
              `Host components not refreshed through the devcontainer builder. ${detail}`,
            );
            return detail;
          },
        });
      }
      // After the runtimes: the builder runs its steps on the runsc they register.
      // Nothing about the builder may fail the update, an unexpected error included.
      const builder = await reconcileBuilder();
      if (builder.state === 'failed')
        (options.log ?? console.warn)(
          `Devcontainer builder not updated; the previous builder keeps running. ${builder.message}`,
        );
    },
    prepareStandby: async (journal) => {
      // A legacy Server cannot be reconciled in place after gaining these
      // mounts. Delay the authority migration until preflight succeeds, then
      // rebuild the candidate template so the standby is the first Server made
      // from the expanded spec. A crash is safe: the journal resumes from
      // `preflight` or `creating-standby` and this operation is idempotent.
      let migrated = await migrateManagedControlPlaneRunner(
        options.managedRoot,
        options.environment ?? process.env,
      );
      if (!migrated.managed)
        throw new Error(`managed Server authority unavailable: ${migrated.reason}`);
      const backup = await backupProvisionPlan(docker, migrated.spec, journal.targetDigest);
      if (backup) {
        await provisionBackupHost(docker, migrated.spec, journal.targetDigest, backup);
        const standby = await findNamed(docker, candidateName(journal, STANDBY_ROLE));
        const hasMounts = ['/run/verity-backups', '/run/verity-backup-identity'].every(
          (target) =>
            migrated.managed && migrated.spec.mounts.some((mount) => mount.target === target),
        );
        if (standby && !hasMounts) throw new Error('Existing standby predates backup mounts');
        migrated = await migrateManagedBackupMounts({
          root: options.managedRoot,
          deploymentId: migrated.spec.deploymentId,
          image: migrated.spec.image,
          backupPath: backup.backupPath,
          identityPath: backup.identityPath,
        });
        if (!migrated.managed) throw new Error(migrated.reason);
      }
      const diagnostics = await readHostDiagnosticsCapability(options.hostRuntimeDir);
      if (diagnostics.state === 'available') {
        const sealedDiagnosticMount = migrated.spec.mounts.find(
          (mount) => mount.target === '/run/verity-host-diagnostics',
        );
        if (sealedDiagnosticMount === undefined) {
          // A crash after Docker create but before the standby journal write
          // must not change that generation's spec when the timer refreshes.
          const existingStandby = await findNamed(docker, candidateName(journal, STANDBY_ROLE));
          if (existingStandby === null) {
            migrated = await migrateManagedHostDiagnostics({
              root: options.managedRoot,
              deploymentId: migrated.spec.deploymentId,
              image: migrated.spec.image,
              hostPath: diagnostics.hostPath,
            });
            if (!migrated.managed) throw new Error(migrated.reason);
          } else {
            (options.log ?? console.warn)(
              'Host diagnostic mount migration deferred until the next update; this standby already exists',
            );
          }
        } else if (
          sealedDiagnosticMount.source.kind === 'bind' &&
          sealedDiagnosticMount.source.path !== diagnostics.hostPath
        ) {
          (options.log ?? console.warn)(
            'Host diagnostic exporter path differs from sealed authority; retaining the existing mount',
          );
        }
        if (Object.values(diagnostics.snapshot.sources).some((source) => source !== 'available'))
          (options.log ?? console.warn)('Host diagnostic journals have incomplete source coverage');
      } else {
        (options.log ?? console.warn)(
          `Host diagnostics ${diagnostics.state}; automatic mount migration deferred. ` +
            (diagnostics.state === 'unsupported'
              ? 'Rerun the verified installer once to provision host diagnostics.'
              : 'Check the host diagnostics exporter and timer.'),
        );
      }
      // Same shape as the diagnostic bind: only an installer-verified builder
      // adds the socket, and never to a generation whose standby already exists.
      const builder = await readDevcontainerBuilderCapability(options.hostRuntimeDir);
      if (
        builder.state === 'available' &&
        !migrated.spec.mounts.some(
          (mount) => mount.target === DEVCONTAINER_BUILDER_SOCKET_DIRECTORY && !mount.readOnly,
        )
      ) {
        if ((await findNamed(docker, candidateName(journal, STANDBY_ROLE))) === null) {
          migrated = await migrateManagedDevcontainerBuilder({
            root: options.managedRoot,
            deploymentId: migrated.spec.deploymentId,
            image: migrated.spec.image,
            gid: builder.gid,
          });
          if (!migrated.managed) throw new Error(migrated.reason);
        } else {
          (options.log ?? console.warn)(
            'Devcontainer builder migration deferred until the next update; this standby already exists',
          );
        }
      } else if (builder.state === 'invalid') {
        (options.log ?? console.warn)(
          'Devcontainer builder receipt is invalid; rerun the verified installer to repair it',
        );
      }
      base = await managedServerContainerSpec(
        migrated.spec,
        options.environment ?? process.env,
        options.readFile ?? ((path) => readFile(path, 'utf8')),
      );
    },
    ensureStandby,
  };
}
