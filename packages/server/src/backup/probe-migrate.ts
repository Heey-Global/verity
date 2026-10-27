import { CompiledQuery } from 'kysely';
import { createPostgresDb, executedSchemaGeneration, migrateToLatest } from '@verity/store';
import { SERVER_COMPAT } from '../self-update/compat.js';

/** One-shot entrypoint for a disposable probe DB; never builds the control plane. */
export async function migrateProbeDatabase(environment: NodeJS.ProcessEnv): Promise<void> {
  const connectionString = environment['VERITY_BACKUP_PROBE_DATABASE_URL'];
  const expected = environment['VERITY_BACKUP_PROBE_SCHEMA'];
  if (!connectionString || expected !== SERVER_COMPAT.schema.current)
    throw new Error('Restore probe requires this image’s exact schema');
  const url = new URL(connectionString);
  const name = url.pathname.slice(1);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !/^verity_probe_[a-f0-9]{32}$/.test(name)
  )
    throw new Error('Restore probe requires a disposable database');
  // Query parameters can override the URL database and redirect a destructive migration.
  for (const key of url.searchParams.keys())
    if (!['host', 'port', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert'].includes(key))
      throw new Error('Unsupported restore probe connection parameter');
  const db = createPostgresDb(connectionString);
  try {
    const target = await db.executeQuery<{ name: string; objects: string }>(
      CompiledQuery.raw(`
      SELECT current_database() AS name, count(*)::text AS objects
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
    `),
    );
    if (target.rows[0]?.name !== name || target.rows[0]?.objects !== '0')
      throw new Error('Restore probe database must be empty and match the requested name');
    await migrateToLatest(db);
    if ((await executedSchemaGeneration(db)) !== expected)
      throw new Error('Restore probe migration produced an unexpected schema');
  } finally {
    await db.destroy();
  }
}
