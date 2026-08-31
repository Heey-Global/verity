import { readFile } from 'node:fs/promises';
import type { ContainerInspect, DockerClient } from '../docker.js';
import { migrateManagedControlPlaneRunner, readManagedDeployment } from './managed-deployment.js';
import {
  MANAGED_DEPLOYMENT_LABEL,
  MANAGED_ROLE_LABEL,
  managedContainerMatchesSpec,
  managedServerContainerSpec,
  specImageEnvironment,
} from './managed-server-owner.js';
import { readBundledPostgresImage } from './postgres-image.js';
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
     */
    pullImage: async (digest) => {
      await docker.pullImage!(digest);
      const bundled = await readBundledPostgresImage(docker, digest);
      if (bundled.kind !== 'image') return;
      await docker.pullImage!(bundled.image).catch(() => undefined);
    },
    verifyImage: async (journal) => {
      if (journal.deploymentId !== state.spec.deploymentId)
        throw new Error('update journal deployment does not match managed authority');
      await options.verifyImage(journal);
    },
    runPreflight,
    prepareStandby: async () => {
      // A legacy Server cannot be reconciled in place after gaining these
      // mounts. Delay the authority migration until preflight succeeds, then
      // rebuild the candidate template so the standby is the first Server made
      // from the expanded spec. A crash is safe: the journal resumes from
      // `preflight` or `creating-standby` and this operation is idempotent.
      const migrated = await migrateManagedControlPlaneRunner(
        options.managedRoot,
        options.environment ?? process.env,
      );
      if (!migrated.managed)
        throw new Error(`managed Server authority unavailable: ${migrated.reason}`);
      base = await managedServerContainerSpec(
        migrated.spec,
        options.environment ?? process.env,
        options.readFile ?? ((path) => readFile(path, 'utf8')),
      );
    },
    ensureStandby,
  };
}
