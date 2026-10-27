import { isIP } from 'node:net';
import { join } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import type { DockerClient } from '../docker.js';
import type { RestoreJob } from './restore-job.js';
import { readBounded, writeDurable } from './repository.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';
import { assertRestoreDatabaseAuthority } from './restore-database-authority.js';
import { recheckRestoreDevices } from './restore-final-review.js';

/** Prepare the isolated volume for the normal deployment's fixed verity database/user contract. */
export async function canonicalizeRestoreDatabase(options: {
  docker: DockerClient;
  root: string;
  network: string;
  job: RestoreJob;
  recoveryKey: string;
  masterPassword: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { docker, job, signal } = options;
  if (!job.verified || !docker.listContainers)
    throw new Error('Verified restore and Docker inspection required');
  const resources = restoreDatabaseResources(job);
  const root = join(options.root, job.id);
  const credentials = z
    .object({
      jobId: z.literal(job.id),
      container: z.literal(resources.container),
      volume: z.literal(resources.volume),
      database: z.literal(resources.database),
      network: z.literal(options.network),
      password: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(JSON.parse((await readBounded(join(root, 'database'), 16384)).toString()));
  const backupPassword = (
    await readBounded(join(root, 'host/backup-postgres-password'), 128)
  ).toString();
  if (!/^[a-f0-9]{64}$/.test(backupPassword))
    throw new Error('Restore backup database credential invalid');
  const inspection = await docker.inspectContainer(resources.container);
  const address = inspection.networks?.[options.network]?.ipAddress;
  if (
    inspection.labels?.['verity.restore-job'] !== job.id ||
    !inspection.running ||
    !inspection.mounts?.some(
      (mount) =>
        mount.type === 'volume' &&
        mount.name === resources.volume &&
        mount.destination === '/var/lib/postgresql' &&
        mount.readWrite,
    ) ||
    !address ||
    !isIP(address)
  )
    throw new Error('Restore PostgreSQL ownership or network mismatch');
  const trial = (await docker.listContainers()).filter((container) =>
    container.names?.includes(resources.prefix + '-trial'),
  );
  if (trial.some((container) => container.labels?.['verity.restore-job'] !== job.id))
    throw new Error('Restore trial ownership mismatch');
  signal?.throwIfAborted();
  for (const container of trial) await docker.removeContainer(container.id);
  const hostname = isIP(address) === 6 ? `[${address}]` : address;
  const open = async (user: 'restore' | 'verity', database: string) => {
    const pool = new pg.Pool({
      connectionString: `postgres://${user}:${credentials.password}@${hostname}:5432/${database}`,
      max: 1,
      connectionTimeoutMillis: 3000,
      statement_timeout: 30000,
      query_timeout: 35000,
    });
    pool.on('error', () => {});
    try {
      await pool.query('SELECT 1');
      return pool;
    } catch {
      await pool.end();
      throw new Error('Restore PostgreSQL connection unavailable');
    }
  };
  let maintenance: pg.Pool;
  let user: 'restore' | 'verity' = 'verity';
  try {
    maintenance = await open('verity', 'postgres');
  } catch {
    user = 'restore';
    maintenance = await open('restore', 'postgres');
  }
  try {
    const names = await maintenance.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = ANY($1::text[])',
      [[resources.database, 'verity']],
    );
    if (names.rows.length !== 1) throw new Error('Restore database naming state is ambiguous');
    const database = names.rows[0]!.datname;
    const target = await open(user, database);
    try {
      const client = await target.connect();
      try {
        await assertRestoreDatabaseAuthority(client, job);
        await recheckRestoreDevices({
          ...options,
          client,
          target: database === 'verity' ? 'canonical' : 'staging',
        });
        await client.query(
          "UPDATE verity_restore_authority.installation SET phase = 'canonicalizing' WHERE singleton",
        );
      } finally {
        client.release();
      }
    } finally {
      await target.end();
    }
    signal?.throwIfAborted();
    await maintenance.query("SELECT set_config('verity.restore_password', $1, false)", [
      credentials.password,
    ]);
    await maintenance.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verity') THEN CREATE ROLE verity LOGIN SUPERUSER; END IF;
      EXECUTE format('ALTER ROLE verity LOGIN SUPERUSER PASSWORD %L', current_setting('verity.restore_password'));
    END $$`);
    if (database === resources.database)
      await maintenance.query(`ALTER DATABASE "${resources.database}" RENAME TO verity`);
    await maintenance.query('ALTER DATABASE verity OWNER TO verity');
    const canonical = await open('verity', 'verity');
    try {
      await assertRestoreDatabaseAuthority(canonical, job);
      await canonical.query('REASSIGN OWNED BY restore TO verity');
      await canonical.query("SELECT set_config('verity.backup_password', $1, false)", [
        backupPassword,
      ]);
      await canonical.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verity_backup') THEN CREATE ROLE verity_backup LOGIN; END IF;
        EXECUTE format('ALTER ROLE verity_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', current_setting('verity.backup_password'));
      END $$`);
      await canonical.query(`ALTER ROLE verity_backup SET default_transaction_read_only = on;
        GRANT CONNECT ON DATABASE verity TO verity_backup;
        GRANT USAGE ON SCHEMA public TO verity_backup;
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO verity_backup;
        GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO verity_backup;
        ALTER DEFAULT PRIVILEGES FOR ROLE verity IN SCHEMA public GRANT SELECT ON TABLES TO verity_backup;
        ALTER DEFAULT PRIVILEGES FOR ROLE verity IN SCHEMA public GRANT SELECT ON SEQUENCES TO verity_backup;
        ALTER ROLE restore NOLOGIN;
        UPDATE verity_restore_authority.installation SET phase = 'canonical' WHERE singleton`);
      signal?.throwIfAborted();
      await writeDurable(
        join(root, 'database-canonicalized'),
        Buffer.from(JSON.stringify({ jobId: job.id, manifestHash: job.verified.manifestHash })),
        false,
      );
    } finally {
      await canonical.end();
    }
  } finally {
    await maintenance.end();
  }
}
