import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import type { DockerClient } from '../docker.js';
import { readBundledPostgresImage } from '../self-update/postgres-image.js';
import { runPinnedProbeMigration } from './probe-worker.js';
import { checkProbeDatabaseSpace } from './probe-space.js';
import { writeDurable } from './repository.js';
import type { RestoreJob } from './restore-job.js';
import type { RestoreStagingDependencies } from './restore-staging.js';

export function restoreDatabaseResources(job: Pick<RestoreJob, 'id'>) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(job.id))
    throw new Error('Invalid restore resource owner');
  const suffix = job.id.replaceAll('-', '');
  return {
    prefix: `verity-restore-${suffix}`,
    container: `verity-restore-${suffix}-postgres`,
    volume: `verity-restore-${suffix}-postgres`,
    database: `verity_restore_${suffix}`,
    labels: { 'verity.restore-job': job.id },
  };
}

/** Delete only resources with both the reserved job name and its durable ownership label. */
export async function removeRestoreDatabase(
  docker: DockerClient,
  job: Pick<RestoreJob, 'id'>,
  scope: 'database' | 'staging' = 'database',
) {
  if (!docker.listContainers || !docker.listVolumes || !docker.removeVolume)
    throw new Error('Docker restore ownership inspection unavailable');
  const resources = restoreDatabaseResources(job);
  const containers = (await docker.listContainers()).filter((container) =>
    container.names?.some((name) =>
      [
        resources.container,
        resources.prefix + '-migrate',
        resources.prefix + '-space',
        resources.prefix + '-trial',
        ...(scope === 'staging' ? [resources.prefix + '-load', resources.prefix + '-copy'] : []),
      ].includes(name),
    ),
  );
  const names = [
    resources.volume,
    ...(scope === 'staging' ? [resources.prefix + '-data', resources.prefix + '-managed'] : []),
  ];
  const volumes = (await docker.listVolumes()).filter((volume) => names.includes(volume.name));
  // Validate the entire cleanup set before removing anything.
  if (
    [...containers, ...volumes].some(
      (resource) => resource.labels?.['verity.restore-job'] !== job.id,
    )
  )
    throw new Error('Restore resource ownership mismatch');
  for (const container of containers) await docker.removeContainer(container.id);
  for (const volume of volumes) await docker.removeVolume(volume.name);
}

/** The isolated database persists through trial. A staging retry starts from an empty owned volume. */
export function createRestoreDatabase(options: {
  docker: DockerClient;
  root: string;
  network: string;
  hostNetworking?: boolean;
}): RestoreStagingDependencies['withFreshDatabase'] {
  return async (job, manifest, bytes, run, signal) => {
    const { docker } = options;
    if (!job.verified || !docker.ensureVolume || !docker.listVolumes || !docker.pullImage)
      throw new Error('Verified restore and persistent Docker volumes required');
    const resources = restoreDatabaseResources(job);
    signal?.throwIfAborted();
    const bundled = await readBundledPostgresImage(docker, job.verified.image);
    if (bundled.kind !== 'image') throw new Error('Restore release has no PostgreSQL pin');
    if (bytes < 0n) throw new Error('Invalid restore database size');
    if (!docker.imageExists || !(await docker.imageExists(bundled.image)))
      await docker.pullImage(bundled.image, signal ? { signal } : {});
    await removeRestoreDatabase(docker, job);
    await checkProbeDatabaseSpace({
      docker,
      image: bundled.image,
      architecture: job.verified.architecture,
      requiredBytes: bytes + 256n * 1024n * 1024n,
      resourcePrefix: resources.prefix,
      resourceLabels: resources.labels,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    const password = randomBytes(32).toString('hex');
    const root = join(options.root, job.id);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeDurable(
      join(root, 'database'),
      Buffer.from(
        JSON.stringify({
          jobId: job.id,
          ...resources,
          password,
          image: bundled.image,
          network: options.network,
        }),
      ),
      false,
    );
    await docker.ensureVolume(resources.volume, { labels: resources.labels });
    const volume = (await docker.listVolumes()).find((volume) => volume.name === resources.volume);
    if (volume?.labels['verity.restore-job'] !== job.id)
      throw new Error('Restore volume ownership mismatch');
    signal?.throwIfAborted();
    const container = await docker.createContainer({
      image: bundled.image,
      name: resources.container,
      labels: resources.labels,
      network: options.network,
      platform: `linux/${job.verified.architecture}`,
      env: [
        'POSTGRES_USER=restore',
        `POSTGRES_PASSWORD=${password}`,
        `POSTGRES_DB=${resources.database}`,
        'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
      ],
      volumeMounts: [{ volume: resources.volume, target: '/var/lib/postgresql' }],
      command: ['postgres', '-c', 'max_connections=8', '-c', 'shared_buffers=16MB'],
      restartPolicy: 'no',
      cpuShares: 2,
      pidsLimit: 64,
    });
    signal?.throwIfAborted();
    await docker.startContainer(container.id);
    let hostname = resources.container;
    if (options.hostNetworking) {
      const current = await docker.inspectContainer(container.id);
      const address = current.networks?.[options.network]?.ipAddress;
      if (current.labels?.['verity.restore-job'] !== job.id || !address || !isIP(address))
        throw new Error('Restore database network authority mismatch');
      hostname = isIP(address) === 6 ? `[${address}]` : address;
    }
    const connectionString = `postgres://restore:${password}@${hostname}:5432/${resources.database}`;
    const pool = new pg.Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 1000,
      statement_timeout: 60000,
      query_timeout: 65000,
    });
    let idleError: Error | undefined;
    pool.on('error', (error) => {
      idleError = error;
    });
    try {
      signal?.throwIfAborted();
      const deadline = Date.now() + 30000;
      for (;;) {
        signal?.throwIfAborted();
        try {
          await pool.query('SELECT 1');
          break;
        } catch {
          if (Date.now() >= deadline) throw new Error('Restore PostgreSQL did not become ready');
          await delay(250, undefined, signal ? { signal } : {});
        }
      }
      await runPinnedProbeMigration({
        docker,
        manifest,
        architecture: job.verified.architecture,
        databaseUrl: connectionString,
        network: options.network,
        resourcePrefix: resources.prefix,
        resourceLabels: resources.labels,
        ...(signal ? { signal } : {}),
      });
      if (idleError) throw new Error('Restore database connection failed');
      const client = await pool.connect();
      let released = false;
      const abort = () => {
        if (!released) {
          released = true;
          client.release(true);
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        await run(client);
        signal?.throwIfAborted();
        if (idleError) throw new Error('Restore database connection failed');
      } finally {
        signal?.removeEventListener('abort', abort);
        if (!released) client.release();
      }
    } finally {
      await pool.end();
    }
  };
}
