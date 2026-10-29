import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { expect, it } from 'vitest';
import { beginDatabaseExport } from './database.js';

const adminUrl = process.env.VERITY_TEST_SHARED_POSTGRES_URL;

it.skipIf(!adminUrl)(
  'exports a stable snapshot using the actual installer read-only grants',
  async () => {
    const suffix = randomBytes(12).toString('hex');
    const name = `verity_export_${suffix}`;
    const role = `backup_${suffix}`;
    const admin = new pg.Pool({ connectionString: adminUrl!, max: 1 });
    const url = new URL(adminUrl!);
    url.pathname = '/' + name;
    const source = new pg.Pool({ connectionString: url.toString(), max: 1 });
    const readerUrl = new URL(url);
    readerUrl.username = role;
    readerUrl.password = 'a'.repeat(64);
    readerUrl.searchParams.delete('user');
    readerUrl.searchParams.delete('password');
    const reader = new pg.Pool({ connectionString: readerUrl.toString(), max: 1 });
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      await source.query(`CREATE TABLE records(id serial PRIMARY KEY, encrypted bytea NOT NULL);
      INSERT INTO records(encrypted) VALUES ('\\x0001ff');`);
      const script = await readFile(
        new URL('../../../../deploy/host/verity-backup-prerequisites', import.meta.url),
        'utf8',
      );
      const template = script.match(/<<SQL\n([\s\S]*?)^SQL$/m)?.[1];
      expect(template).toBeDefined();
      // Only fixture identifiers change; privileges and transaction defaults come from the installer.
      const sql = template!
        .replaceAll('\\$', '$')
        .replaceAll('verity_backup', role)
        .replaceAll('$password', 'a'.repeat(64))
        .replaceAll('ON DATABASE verity ', `ON DATABASE "${name}" `)
        .replaceAll(
          'FOR ROLE verity ',
          `FOR ROLE "${(await source.query('SELECT current_user AS name')).rows[0].name}" `,
        );
      await source.query(sql);
      expect(
        (await reader.query('SHOW default_transaction_read_only')).rows[0]
          .default_transaction_read_only,
      ).toBe('on');
      // The login can override its session default; ACLs must still prevent writes.
      await reader.query('SET default_transaction_read_only = off');
      expect(
        (await reader.query('SHOW default_transaction_read_only')).rows[0]
          .default_transaction_read_only,
      ).toBe('off');
      expect(
        (
          await reader.query(
            "SELECT has_table_privilege(current_user, 'records', 'INSERT') AS insertable, has_table_privilege(current_user, 'records', 'UPDATE') AS updatable, has_table_privilege(current_user, 'records', 'DELETE') AS deletable",
          )
        ).rows,
      ).toEqual([{ insertable: false, updatable: false, deletable: false }]);

      for (const statement of [
        "INSERT INTO records(encrypted) VALUES ('\\x02')",
        "UPDATE records SET encrypted='\\x02'",
        'DELETE FROM records',
        "SELECT nextval('records_id_seq')",
        'CREATE TABLE unauthorized(id integer)',
      ])
        await expect(reader.query(statement)).rejects.toThrow();
      const snapshotClient = await reader.connect();
      const exporting = await beginDatabaseExport(snapshotClient);
      try {
        expect(
          (await snapshotClient.query('SHOW transaction_read_only')).rows[0].transaction_read_only,
        ).toBe('on');
        expect(
          (await snapshotClient.query('SHOW transaction_isolation')).rows[0].transaction_isolation,
        ).toBe('repeatable read');
        expect(exporting.catalog.tables.map((table) => table.name)).toEqual(['records']);
        expect(exporting.catalog.sequences).toEqual([
          { name: 'records_id_seq', value: '1', called: true },
        ]);
        await source.query(
          "UPDATE records SET encrypted='\\x02'; INSERT INTO records(encrypted) VALUES ('\\x03')",
        );
        const captured = new Map<string, Buffer>();
        for await (const file of exporting.files) {
          const chunks: Uint8Array[] = [];
          for await (const chunk of typeof file.source === 'function'
            ? file.source(0)
            : file.source)
            chunks.push(chunk);
          captured.set(file.path, Buffer.concat(chunks));
        }
        expect(captured.get('database/tables/000000.copy')!.toString()).toBe('1\t\\\\x0001ff\n');
        expect((await source.query('SELECT count(*)::int AS n FROM records')).rows[0].n).toBe(2);
      } finally {
        await exporting.close();
      }
    } finally {
      await reader.end();
      await source.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  },
);
