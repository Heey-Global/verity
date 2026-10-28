import { restoreComposeDatabaseVolume } from './restore-compose-volume.js';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { z } from 'zod';
import type { DockerClient } from '../docker.js';
import { readBundledPostgresImage } from '../self-update/postgres-image.js';
import type { RestoreJob } from './restore-job.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';
import { readBounded } from './repository.js';
import { assertRestoreDatabaseAuthority } from './restore-database-authority.js';

interface Options {
  docker: DockerClient;
  root: string;
  network: string;
  job: RestoreJob;
  signal?: AbortSignal;
}

async function credentials(options: Options) {
  const resources = restoreDatabaseResources(options.job);
  return z
    .object({
      jobId: z.literal(options.job.id),
      container: z.literal(resources.container),
      volume: z.literal(resources.volume),
      database: z.literal(resources.database),
      network: z.literal(options.network),
      password: z.string().regex(/^[a-f0-9]{64}$/),
      image: z.string(),
    })
    .parse(
      JSON.parse(
        (await readBounded(join(options.root, options.job.id, 'database'), 16384)).toString(),
      ),
    );
}

/** Root installer worker uses host networking; trial clients remain on the private job network. */
export async function withCanonicalRestoreClient<T>(
  options: Options,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const { docker, job, signal } = options;
  if (!job.verified) throw new Error('Verified canonical restore required');
  const resources = restoreDatabaseResources(job);
  const databaseVolume = await restoreComposeDatabaseVolume(options.root, job);
  const saved = await credentials(options);
  const inspected = await docker.inspectContainer(resources.container);
  const address = inspected.networks?.[options.network]?.ipAddress;
  if (
    inspected.labels?.['verity.restore-job'] !== job.id ||
    !inspected.running ||
    !address ||
    !isIP(address) ||
    !inspected.mounts?.some(
      (mount) =>
        mount.type === 'volume' &&
        mount.name === databaseVolume &&
        mount.destination === '/var/lib/postgresql' &&
        mount.readWrite,
    )
  )
    throw new Error('Canonical restore database ownership mismatch');
  const hostname = isIP(address) === 6 ? `[${address}]` : address;
  const pool = new pg.Pool({
    connectionString: `postgres://verity:${saved.password}@${hostname}:5432/verity`,
    max: 1,
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  pool.on('error', () => {});
  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      signal?.throwIfAborted();
      try {
        await pool.query('SELECT 1');
        break;
      } catch {
        if (Date.now() >= deadline) throw new Error('Canonical restore database unavailable');
        await delay(250, undefined, signal ? { signal } : {});
      }
    }
    const client = await pool.connect();
    try {
      const phase = await assertRestoreDatabaseAuthority(client, job);
      if (phase !== 'canonical') throw new Error('Canonical restore database is not prepared');
      signal?.throwIfAborted();
      return await run(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/** Only the restricted trial opens this cold-copied canonical database before acceptance. */
export async function startCanonicalRestoreDatabase(options: Options): Promise<void> {
  const { docker, job, signal } = options;
  if (!job.verified || !docker.listContainers || !docker.listVolumes)
    throw new Error('Verified canonical restore required');
  const resources = restoreDatabaseResources(job);
  const databaseVolume = await restoreComposeDatabaseVolume(options.root, job);
  if (!(await docker.listVolumes()).some((volume) => volume.name === databaseVolume))
    throw new Error('Published canonical database volume is missing');
  const saved = await credentials(options);
  const bundled = await readBundledPostgresImage(docker, job.verified.image);
  if (bundled.kind !== 'image' || bundled.image !== saved.image)
    throw new Error('Canonical restore PostgreSQL image mismatch');
  const found = (await docker.listContainers()).find((container) =>
    container.names?.includes(resources.container),
  );
  if (found) {
    const inspected = await docker.inspectContainer(found.id);
    if (inspected.labels?.['verity.restore-job'] !== job.id || inspected.image !== saved.image)
      throw new Error('Canonical restore container ownership mismatch');
    if (
      inspected.mounts?.some(
        (mount) =>
          mount.type === 'volume' &&
          mount.name === databaseVolume &&
          mount.destination === '/var/lib/postgresql' &&
          mount.readWrite,
      )
    ) {
      if (!inspected.running) await docker.startContainer(found.id);
      await withCanonicalRestoreClient(options, async () => {});
      return;
    }
    if (
      inspected.running ||
      !inspected.mounts?.some(
        (mount) =>
          mount.type === 'volume' &&
          mount.name === resources.volume &&
          mount.destination === '/var/lib/postgresql',
      )
    )
      throw new Error('Staged restore database is not stopped');
    signal?.throwIfAborted();
    await docker.removeContainer(found.id);
  }
  signal?.throwIfAborted();
  const container = await docker.createContainer({
    image: saved.image,
    name: resources.container,
    labels: resources.labels,
    network: options.network,
    platform: `linux/${job.verified.architecture}`,
    env: [
      'POSTGRES_USER=verity',
      'POSTGRES_DB=verity',
      `POSTGRES_PASSWORD=${saved.password}`,
      'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
    ],
    volumeMounts: [{ volume: databaseVolume, target: '/var/lib/postgresql' }],
    command: ['postgres', '-c', 'max_connections=8', '-c', 'shared_buffers=16MB'],
    restartPolicy: 'no',
    cpuShares: 2,
    pidsLimit: 64,
  });
  await docker.startContainer(container.id);
  await withCanonicalRestoreClient(options, async () => {});
}

export async function stopRestoreTrialRuntime(
  options: Pick<Options, 'docker' | 'job'>,
  database = true,
): Promise<void> {
  const { docker, job } = options;
  if (!docker.listContainers) throw new Error('Restore container inspection unavailable');
  const resources = restoreDatabaseResources(job);
  const names = [resources.prefix + '-trial', ...(database ? [resources.container] : [])];
  const found = (await docker.listContainers()).filter((container) =>
    container.names?.some((name) => names.includes(name)),
  );
  if (found.some((container) => container.labels?.['verity.restore-job'] !== job.id))
    throw new Error('Restore runtime ownership mismatch');
  for (const container of found) {
    if ((await docker.inspectContainer(container.id)).running)
      await docker.stopContainer(container.id);
  }
}
