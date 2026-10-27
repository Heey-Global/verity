import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { beginDatabaseExport, importDatabaseExport } from './database.js';

const adminUrl = process.env.VERITY_TEST_SHARED_POSTGRES_URL;
const names: string[] = [];
afterEach(async () => {
  if (!adminUrl) return;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    for (const name of names.splice(0)) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await admin.end();
  }
});
function databaseUrl(admin: string, database: string): string {
  const url = new URL(admin);
  url.pathname = '/' + database;
  return url.toString();
}
const SCHEMA = `CREATE TABLE z_parent (id integer PRIMARY KEY, payload bytea NOT NULL, nullable text, document jsonb);
CREATE TABLE a_child (id serial PRIMARY KEY, parent integer NOT NULL REFERENCES z_parent(id), value text NOT NULL);
CREATE TABLE no_key (value text, n integer);
CREATE TABLE a_membership (parent integer PRIMARY KEY);
CREATE FUNCTION add_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO a_membership VALUES (NEW.id); RETURN NEW; END $$;
CREATE TRIGGER create_membership AFTER INSERT ON z_parent FOR EACH ROW EXECUTE FUNCTION add_membership();
CREATE FUNCTION passthrough() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER always_trigger BEFORE INSERT ON z_parent FOR EACH ROW EXECUTE FUNCTION passthrough();
ALTER TABLE z_parent ENABLE ALWAYS TRIGGER always_trigger;
CREATE TRIGGER replica_trigger BEFORE INSERT ON z_parent FOR EACH ROW EXECUTE FUNCTION passthrough();
ALTER TABLE z_parent ENABLE REPLICA TRIGGER replica_trigger;
CREATE TRIGGER disabled_trigger BEFORE INSERT ON z_parent FOR EACH ROW EXECUTE FUNCTION passthrough();
ALTER TABLE z_parent DISABLE TRIGGER disabled_trigger;`;

describe.skipIf(!adminUrl)('real PostgreSQL backup COPY round trip', () => {
  it('preserves data, sequences, foreign keys and trigger modes without replaying trigger side effects', async () => {
    const admin = new pg.Pool({ connectionString: adminUrl!, max: 1 });
    const suffix = randomBytes(16).toString('hex');
    const original = 'verity_source_' + suffix;
    const target = 'verity_restore_' + suffix;
    for (const name of [original, target]) {
      await admin.query(`CREATE DATABASE "${name}"`);
      names.push(name);
    }
    await admin.end();
    const source = new pg.Pool({ connectionString: databaseUrl(adminUrl!, original), max: 1 });
    const restored = new pg.Pool({ connectionString: databaseUrl(adminUrl!, target), max: 1 });
    try {
      await source.query(SCHEMA);
      await restored.query(SCHEMA);
      await source.query('INSERT INTO z_parent VALUES ($1,$2,$3,$4)', [
        1,
        Buffer.from([0, 1, 255]),
        null,
        { nested: ['value'] },
      ]);
      await source.query('INSERT INTO a_child(parent,value) VALUES (1,$1)', [
        'tabs\tand\nnewlines\\and unicode ä',
      ]);
      await source.query("INSERT INTO no_key VALUES ('second',2),('first',1),('first',1)");
      const client = await source.connect();
      const exporter = await beginDatabaseExport(client);
      const captured = new Map<string, Buffer>();
      try {
        for await (const file of exporter.files) {
          const chunks: Uint8Array[] = [];
          for await (const chunk of typeof file.source === 'function'
            ? file.source(0)
            : file.source)
            chunks.push(chunk);
          captured.set(file.path, Buffer.concat(chunks));
        }
      } finally {
        await exporter.close();
      }
      const writer = await restored.connect();
      try {
        await importDatabaseExport(writer, exporter.catalog, (path) =>
          (async function* () {
            const bytes = captured.get(path);
            if (!bytes) throw new Error('missing table');
            yield bytes;
          })(),
        );
      } finally {
        writer.release();
      }
      const abandoned = await beginDatabaseExport(await source.connect());
      await abandoned.files.next(); // Catalog does not start a COPY stream.
      await abandoned.files.next(); // Open COPY, then cancel without draining it.
      await abandoned.close();
      await abandoned.files.return(undefined);
      expect((await source.query('SELECT 1 AS healthy')).rows[0].healthy).toBe(1);
      expect((await restored.query('SELECT * FROM z_parent')).rows).toEqual(
        (await source.query('SELECT * FROM z_parent')).rows,
      );
      expect((await restored.query('SELECT * FROM a_child')).rows).toEqual(
        (await source.query('SELECT * FROM a_child')).rows,
      );
      expect((await restored.query('SELECT * FROM no_key ORDER BY n')).rows).toEqual(
        (await source.query('SELECT * FROM no_key ORDER BY n')).rows,
      );
      expect(
        (await restored.query("INSERT INTO a_child(parent,value) VALUES (1,'next') RETURNING id"))
          .rows[0].id,
      ).toBe(2);
      expect((await restored.query('SELECT * FROM a_membership')).rows).toEqual([{ parent: 1 }]);
      const triggers =
        'SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname';
      expect((await restored.query(triggers)).rows).toEqual((await source.query(triggers)).rows);
      await restored.query('INSERT INTO z_parent(id,payload) VALUES (2,$1)', [Buffer.from('next')]);
      expect(
        (await restored.query('SELECT parent FROM a_membership ORDER BY parent')).rows,
      ).toEqual([{ parent: 1 }, { parent: 2 }]);
      await expect(
        restored.query("INSERT INTO a_child(parent,value) VALUES (999,'invalid')"),
      ).rejects.toThrow();
    } finally {
      await source.end();
      await restored.end();
    }
  });
});

it.skipIf(!adminUrl)('rolls back a COPY interrupted by a probe cancellation', async () => {
  const admin = new pg.Pool({ connectionString: adminUrl!, max: 1 });
  const name = 'verity_probe_' + randomBytes(16).toString('hex');
  await admin.query(`CREATE DATABASE "${name}"`);
  names.push(name);
  await admin.end();
  const pool = new pg.Pool({ connectionString: databaseUrl(adminUrl!, name), max: 1 });
  try {
    await pool.query(
      `CREATE TABLE test_data(id integer PRIMARY KEY); INSERT INTO test_data VALUES (42);
       CREATE FUNCTION cancellation_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
       CREATE TRIGGER keep_enabled BEFORE INSERT ON test_data FOR EACH ROW EXECUTE FUNCTION cancellation_trigger();`,
    );
    const exported = await beginDatabaseExport(await pool.connect());
    const catalog = exported.catalog;
    await exported.close();
    const controller = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const writer = await pool.connect();
    try {
      const importing = importDatabaseExport(
        writer,
        catalog,
        () =>
          (async function* () {
            started();
            await new Promise<void>((resolve) =>
              controller.signal.addEventListener('abort', () => resolve(), { once: true }),
            );
            controller.signal.throwIfAborted();
            yield Buffer.from('1\n');
          })(),
        controller.signal,
      );
      const failed = expect(importing).rejects.toThrow();
      await entered;
      controller.abort();
      await failed;
      expect((await writer.query('SELECT id FROM test_data')).rows).toEqual([{ id: 42 }]);
      expect(
        (await writer.query("SELECT tgenabled FROM pg_trigger WHERE tgname='keep_enabled'")).rows,
      ).toEqual([{ tgenabled: 'O' }]);
    } finally {
      writer.release();
    }
  } finally {
    await pool.end();
  }
});
