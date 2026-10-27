import type { PoolClient } from 'pg';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CaptureFile } from './repository.js';

export interface BackupDatabaseTable {
  name: string;
  columns: { name: string; type: string; generated: string }[];
  primaryKey: string[];
}
export interface BackupDatabaseCatalog {
  format: 1;
  snapshot: string;
  capturedAt: string;
  tables: BackupDatabaseTable[];
  sequences: { name: string; value: string; called: boolean }[];
}
const identifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const tablePath = (index: number): string =>
  `database/tables/${String(index).padStart(6, '0')}.copy`;
const SETTINGS =
  "SET LOCAL DateStyle = 'ISO'; SET LOCAL IntervalStyle = 'postgres'; SET LOCAL TimeZone = 'UTC'; SET LOCAL bytea_output = 'hex'; SET LOCAL extra_float_digits = 3";

async function tableCatalog(client: PoolClient): Promise<BackupDatabaseTable[]> {
  const tables = await client.query<{ name: string }>(
    "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid) ORDER BY c.relname COLLATE \"C\"",
  );
  const result: BackupDatabaseTable[] = [];
  if (tables.rows.length > 10000) throw new Error('Backup database table count exceeds limit');
  for (const { name } of tables.rows) {
    const columns = await client.query<{ name: string; type: string; generated: string }>(
      'SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, a.attgenerated AS generated FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum',
      [`public.${identifier(name)}`],
    );
    const key = await client.query<{ name: string }>(
      'SELECT a.attname AS name FROM pg_index i JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ordinal) ON true JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY k.ordinal',
      [`public.${identifier(name)}`],
    );
    result.push({ name, columns: columns.rows, primaryKey: key.rows.map((row) => row.name) });
  }
  return result;
}

/** Call under the lifecycle barrier; consumes a dedicated pool client until close. */
export async function beginDatabaseExport(client: PoolClient): Promise<{
  catalog: BackupDatabaseCatalog;
  files: AsyncGenerator<CaptureFile>;
  close: () => Promise<void>;
}> {
  let closed = false;
  let activeStream: Readable | undefined;
  const close = (): Promise<void> => {
    if (!closed) {
      closed = true;
      activeStream?.destroy();
      // COPY TO cannot be safely interrupted by queueing ROLLBACK behind its own backpressure.
      // Discard the dedicated connection; PostgreSQL rolls its read-only transaction back.
      client.release(true);
    }
    return Promise.resolve();
  };
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(SETTINGS);
    const snapshot = await client.query<{ snapshot: string; captured_at: Date }>(
      'SELECT pg_export_snapshot() AS snapshot, transaction_timestamp() AS captured_at',
    );
    const tables = await tableCatalog(client);
    if (tables.length) {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(
        `LOCK TABLE ${tables.map((table) => `public.${identifier(table.name)}`).join(',')} IN ACCESS SHARE MODE`,
      );
      if (JSON.stringify(await tableCatalog(client)) !== JSON.stringify(tables))
        throw new Error('Database schema changed while opening backup snapshot');
    }
    const sequences = await client.query<{ name: string }>(
      'SELECT sequencename AS name FROM pg_sequences WHERE schemaname=\'public\' ORDER BY sequencename COLLATE "C"',
    );
    const catalog: BackupDatabaseCatalog = {
      format: 1,
      snapshot: snapshot.rows[0]!.snapshot,
      capturedAt: snapshot.rows[0]!.captured_at.toISOString(),
      tables,
      sequences: [],
    };
    for (const { name } of sequences.rows) {
      const state = await client.query<{ value: string; called: boolean }>(
        `SELECT last_value::text AS value, is_called AS called FROM public.${identifier(name)}`,
      );
      catalog.sequences.push({ name, ...state.rows[0]! });
    }
    async function* files(): AsyncGenerator<CaptureFile> {
      if (closed) throw new Error('Backup database snapshot already closed');
      try {
        yield {
          path: 'database/catalog.json',
          mode: 0o600,
          source: Readable.from([Buffer.from(JSON.stringify(catalog))]) as AsyncIterable<Buffer>,
        };
        for (const [index, table] of tables.entries()) {
          const columns = table.columns
            .filter((column) => !column.generated)
            .map((column) => identifier(column.name))
            .join(',');
          const order = table.primaryKey.length
            ? table.primaryKey.map(identifier).join(',')
            : 'row_to_json(t)::text COLLATE "C"';
          const stream = client.query(
            copyTo(
              `COPY (SELECT ${columns} FROM public.${identifier(table.name)} t ORDER BY ${order}) TO STDOUT WITH (FORMAT text, ENCODING 'UTF8')`,
            ),
          );
          activeStream = stream;
          stream.on('error', () => undefined);
          // No concurrent query on this dedicated connection until its current COPY is fully consumed.
          try {
            yield { path: tablePath(index), mode: 0o600, source: stream as AsyncIterable<Buffer> };
          } finally {
            if (!stream.readableEnded) stream.destroy();
            activeStream = undefined;
          }
        }
      } finally {
        await close();
      }
    }
    return { catalog, files: files(), close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The caller creates an EMPTY database with the pinned release's migrations before importing. */
export async function importDatabaseExport(
  client: PoolClient,
  catalog: BackupDatabaseCatalog,
  source: (path: string) => AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (catalog.format !== 1 || catalog.tables.length > 10000 || catalog.sequences.length > 10000)
    throw new Error('Unsupported backup database catalog');
  const database = await client.query<{ name: string }>('SELECT current_database() AS name');
  if (!/^verity_(restore|probe)_[0-9a-f]{32}$/.test(database.rows[0]?.name ?? ''))
    throw new Error('Backup import requires a disposable staging database');
  const current = await tableCatalog(client);
  if (JSON.stringify(current) !== JSON.stringify(catalog.tables))
    throw new Error('Backup schema does not match the pinned migrated database');
  await client.query('BEGIN');
  try {
    await client.query(SETTINGS);
    const names = catalog.tables.map((table) => `public.${identifier(table.name)}`);
    // Migrations may seed rows. Clear the entire application schema atomically before COPY.
    if (names.length) await client.query(`TRUNCATE ${names.join(',')} RESTART IDENTITY`);
    // Non-deferrable and cyclic foreign keys cannot be satisfied in table-order COPY.
    // Recreate their exact pinned-schema definitions after loading, forcing validation.
    const foreignKeys = await client.query<{ table: string; name: string; definition: string }>(
      "SELECT c.conrelid::regclass::text AS table, c.conname AS name, pg_get_constraintdef(c.oid, true) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='f' ORDER BY c.oid",
    );
    for (const constraint of foreignKeys.rows)
      await client.query(
        `ALTER TABLE ${constraint.table} DROP CONSTRAINT ${identifier(constraint.name)}`,
      );
    for (const [index, table] of catalog.tables.entries()) {
      const columns = table.columns
        .filter((column) => !column.generated)
        .map((column) => identifier(column.name))
        .join(',');
      const target = client.query(
        copyFrom(
          `COPY public.${identifier(table.name)} (${columns}) FROM STDIN WITH (FORMAT text, ENCODING 'UTF8')`,
        ),
      );
      await pipeline(
        Readable.from(source(tablePath(index))),
        target,
        ...(signal ? [{ signal }] : []),
      );
    }
    for (const constraint of foreignKeys.rows)
      await client.query(
        `ALTER TABLE ${constraint.table} ADD CONSTRAINT ${identifier(constraint.name)} ${constraint.definition.replace(/\s+NOT VALID$/i, '')}`,
      );
    for (const sequence of catalog.sequences) {
      if (!/^-?[0-9]+$/.test(sequence.value)) throw new Error('Invalid backup sequence value');
      await client.query('SELECT setval($1::regclass, $2::bigint, $3::boolean)', [
        `public.${identifier(sequence.name)}`,
        sequence.value,
        sequence.called,
      ]);
    }
    signal?.throwIfAborted();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
