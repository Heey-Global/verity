import { statfs } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
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
  | 'insufficient-space'
  | 'unverified-space';

/** Where the PostgreSQL image keeps its data (`deploy/docker-compose.yml`). */
const DATA_MOUNT = '/var/lib/postgresql';
/** `replaceContainerImage` keeps its predecessor as `<name>-predecessor-<12 hex>`. */
const PREDECESSOR = /-predecessor-[0-9a-f]{12}$/u;

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
 * - it exited on its own with a code from 1 to 127. A deliberate `docker stop`
 *   ends PostgreSQL with 0, and one that ran out of time kills it with a signal
 *   (128 and above, as does the OOM killer); neither is overruled;
 * - it has been down past {@link POSTGRES_RECOVERY_GRACE_MS};
 * - the disk holding its data volume has at least
 *   {@link POSTGRES_RECOVERY_MIN_FREE_BYTES} free, as far as `freeBytesFor` can
 *   verify for that volume; when it cannot, nothing is started.
 */
export async function recoverStoppedControlPlanePostgres(options: {
  readonly docker: Pick<DockerClient, 'inspectContainer' | 'listContainers' | 'startContainer'>;
  readonly network: string;
  /** Free bytes on the filesystem behind the database's data volume, given its
   *  host source path, or undefined when that cannot be verified. */
  readonly freeBytesFor: (dataSource: string) => Promise<number | undefined>;
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
    if (names.some((name) => PREDECESSOR.test(name))) continue;
    candidates.push(container);
  }
  if (candidates.length === 0) return 'absent';
  if (candidates.length > 1) return 'ambiguous';
  const [container] = candidates;
  if (!container || !['exited', 'dead'].includes(container.status ?? '')) return 'ambiguous';
  const exitCode = container.exitCode ?? 0;
  if (exitCode < 1 || exitCode > 127) return 'stopped-deliberately';
  const finished = Date.parse(container.finishedAt ?? '');
  if (!Number.isFinite(finished) || now() - finished < POSTGRES_RECOVERY_GRACE_MS)
    return 'within-grace';
  const data = container.mounts?.find((mount) => mount.destination === DATA_MOUNT);
  if (data?.type !== 'volume' || !data.source) return 'unverified-space';
  const free = await options.freeBytesFor(data.source);
  if (free === undefined) return 'unverified-space';
  if (free < POSTGRES_RECOVERY_MIN_FREE_BYTES) return 'insufficient-space';
  await docker.startContainer(container.id);
  return 'started';
}

/**
 * Free bytes for a volume the Updater cannot mount itself, measured on one it
 * has mounted (`measured`, with host source `measuredSource`). Both must be
 * named volumes of the same Docker volume directory, which the default local
 * driver keeps on one filesystem; otherwise the answer is undefined.
 */
export async function freeBytesBesideVolume(
  dataSource: string,
  measured: string,
  measuredSource: string | undefined,
): Promise<number | undefined> {
  const volumesDirectory = (source: string) => dirname(dirname(source));
  if (
    measuredSource === undefined ||
    basename(dataSource) !== '_data' ||
    basename(measuredSource) !== '_data' ||
    volumesDirectory(dataSource) !== volumesDirectory(measuredSource)
  )
    return undefined;
  const stats = await statfs(measured);
  return stats.bavail * stats.bsize;
}
