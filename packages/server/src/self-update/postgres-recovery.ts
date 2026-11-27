import { statfs } from 'node:fs/promises';
import type { DockerClient } from '../docker.js';

const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

/** Docker restarts a crashed container itself under `unless-stopped`; this
 *  leaves it that long before stepping in. */
export const POSTGRES_RECOVERY_GRACE_MS = 60_000;
/** Starting PostgreSQL on a full disk only crashes it again. */
export const POSTGRES_RECOVERY_MIN_FREE_BYTES = 2 * 1024 ** 3;

export type PostgresRecoveryOutcome =
  | 'running'
  | 'started'
  | 'absent'
  | 'ambiguous'
  | 'stopped-deliberately'
  | 'within-grace'
  | 'insufficient-space';

/**
 * Starts the deployment's PostgreSQL when it crashed and stayed down.
 *
 * Docker's restart policy gives up when a restart itself fails, which is what
 * a full disk does: the database stopped with `No space left on device`, its
 * single automatic restart failed, and the Server could not resolve the
 * database for as long as nobody started it by hand. Run only through the
 * Updater's exclusive queue, so it never races a cutover that replaces or
 * stops the database on purpose. It starts nothing unless all of these hold:
 *
 * - no container of the service is running on the deployment's network;
 * - exactly one stopped one is there, and it is not a renamed predecessor that
 *   an image replacement keeps for rollback;
 * - it exited with a non-zero code: a deliberate `docker stop` ends PostgreSQL
 *   with 0 and is never overruled;
 * - it has been down past {@link POSTGRES_RECOVERY_GRACE_MS};
 * - the disk holding the deployment has at least
 *   {@link POSTGRES_RECOVERY_MIN_FREE_BYTES} free.
 */
export async function recoverStoppedControlPlanePostgres(options: {
  readonly docker: Pick<DockerClient, 'inspectContainer' | 'listContainers' | 'startContainer'>;
  readonly network: string;
  readonly freeBytes: () => Promise<number>;
  readonly service?: string;
  readonly now?: () => number;
}): Promise<PostgresRecoveryOutcome> {
  const { docker } = options;
  const service = options.service ?? 'postgres';
  const now = options.now ?? Date.now;
  if (!docker.listContainers) return 'absent';
  const candidates = [];
  for (const summary of await docker.listContainers()) {
    if (summary.labels?.[COMPOSE_SERVICE_LABEL] !== service) continue;
    const container = await docker.inspectContainer(summary.id);
    if (container.networks?.[options.network] === undefined) continue;
    if (container.running) return 'running';
    const names = (summary.names ?? []).map((name) => name.replace(/^\//u, ''));
    if (names.some((name) => name.includes('-predecessor-'))) continue;
    candidates.push(container);
  }
  if (candidates.length === 0) return 'absent';
  if (candidates.length > 1) return 'ambiguous';
  const [container] = candidates;
  if (!container || !['exited', 'dead'].includes(container.status ?? '')) return 'ambiguous';
  if (!container.exitCode) return 'stopped-deliberately';
  const finished = Date.parse(container.finishedAt ?? '');
  if (!Number.isFinite(finished) || now() - finished < POSTGRES_RECOVERY_GRACE_MS)
    return 'within-grace';
  if ((await options.freeBytes()) < POSTGRES_RECOVERY_MIN_FREE_BYTES) return 'insufficient-space';
  await docker.startContainer(container.id);
  return 'started';
}

/** Free bytes on the filesystem holding `path`. */
export async function freeBytesAt(path: string): Promise<number> {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize;
}
