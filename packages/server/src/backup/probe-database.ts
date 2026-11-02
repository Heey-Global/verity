import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import type { DockerClient } from '../docker.js';
import { readBundledPostgresImage } from '../self-update/postgres-image.js';
import type { BackupProbeOptions } from './probe.js';
import { captureMetadataSchema } from './capture-metadata.js';
import { runPinnedProbeMigration } from './probe-worker.js';
import { checkProbeDatabaseSpace } from './probe-space.js';

export interface ProbeDatabaseOptions {
  docker: Pick<
    DockerClient,
    | 'createContainer'
    | 'startContainer'
    | 'waitContainer'
    | 'removeContainer'
    | 'inspectImageLabels'
    | 'imageExists'
    | 'pullImage'
  >;
  /** Existing private network reachable from the caller and the migration worker. */
  network: string;
  architecture: 'amd64' | 'arm64';
  /** Prove space on the Docker data filesystem, not the caller's staging filesystem. */
  checkSpace?: (requiredBytes: bigint) => Promise<void>;
  signal?: AbortSignal;
  resourcePrefix?: string;
}

/** Disposable PostgreSQL cluster; no credentials, volumes or writes from the live database. */
export function createProbeDatabase(
  options: ProbeDatabaseOptions,
): BackupProbeOptions['withDatabase'] {
  return async (manifest, estimatedBytes, run) => {
    options.signal?.throwIfAborted();
    const capture = captureMetadataSchema.parse(manifest.capture);
    if (capture.architecture !== options.architecture || typeof manifest.schema !== 'string')
      throw new Error('Restore probe requires a native image and named schema');
    if (estimatedBytes < 0n) throw new Error('Invalid restore probe size');
    const bundled = await readBundledPostgresImage(options.docker, capture.image);
    if (bundled.kind !== 'image') throw new Error('Snapshot image has no valid PostgreSQL pin');
    if (
      options.docker.pullImage &&
      (!options.docker.imageExists || !(await options.docker.imageExists(bundled.image)))
    )
      await options.docker.pullImage(
        bundled.image,
        options.signal ? { signal: options.signal } : {},
      );
    options.signal?.throwIfAborted();
    const requiredBytes = estimatedBytes + 256n * 1024n * 1024n;
    if (options.checkSpace) await options.checkSpace(requiredBytes);
    else
      await checkProbeDatabaseSpace({
        docker: options.docker,
        image: bundled.image,
        architecture: options.architecture,
        requiredBytes,
        ...(options.resourcePrefix ? { resourcePrefix: options.resourcePrefix } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    options.signal?.throwIfAborted();
    const suffix = randomBytes(16).toString('hex');
    const name = options.resourcePrefix
      ? options.resourcePrefix + '-postgres'
      : 'verity-probe-postgres-' + suffix;
    const database = 'verity_probe_' + suffix;
    const password = randomBytes(32).toString('hex');
    const container = await options.docker.createContainer({
      image: bundled.image,
      name,
      network: options.network,
      platform: `linux/${options.architecture}`,
      env: [
        `POSTGRES_USER=probe`,
        `POSTGRES_PASSWORD=${password}`,
        `POSTGRES_DB=${database}`,
        'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
      ],
      command: ['postgres', '-c', 'max_connections=8', '-c', 'shared_buffers=16MB'],
      restartPolicy: 'no',
      cpuShares: 2,
      pidsLimit: 64,
    });
    let pool: pg.Pool | undefined;
    try {
      options.signal?.throwIfAborted();
      await options.docker.startContainer(container.id);
      const url = `postgres://probe:${password}@${name}:5432/${database}`;
      pool = new pg.Pool({
        connectionString: url,
        max: 1,
        connectionTimeoutMillis: 1000,
        statement_timeout: 60000,
        query_timeout: 65000,
      });
      // A failed idle connection must fail this probe, never crash the serving process.
      let idleError: Error | undefined;
      pool.on('error', (error: Error) => {
        idleError = error;
      });
      const deadline = Date.now() + 30000;
      for (;;) {
        options.signal?.throwIfAborted();
        try {
          await pool.query('SELECT 1');
          break;
        } catch {
          if (Date.now() >= deadline)
            throw new Error('Restore probe PostgreSQL did not become ready');
          await delay(250, undefined, options.signal ? { signal: options.signal } : {});
        }
      }
      await runPinnedProbeMigration({
        docker: options.docker,
        manifest,
        architecture: options.architecture,
        databaseUrl: url,
        network: options.network,
        ...(options.resourcePrefix ? { resourcePrefix: options.resourcePrefix } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      options.signal?.throwIfAborted();
      if (idleError) throw new Error('Restore probe PostgreSQL connection failed');
      const client = await pool.connect();
      let released = false;
      const abort = () => {
        if (!released) {
          released = true;
          client.release(true);
        }
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        options.signal?.throwIfAborted();
        await run(client);
        options.signal?.throwIfAborted();
        if (idleError) throw new Error('Restore probe PostgreSQL connection failed');
      } finally {
        options.signal?.removeEventListener('abort', abort);
        if (!released) client.release();
      }
    } finally {
      try {
        await pool?.end();
      } finally {
        await options.docker.removeContainer(container.id);
      }
    }
  };
}
