import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPostgresDb, migrateToLatest } from '@verity/store';
import { expect, it } from 'vitest';

const adminUrl = process.env.VERITY_TEST_SHARED_POSTGRES_URL;
it.skipIf(!adminUrl)(
  'executes installer rotation revocations transactionally against the current schema',
  async () => {
    const source = await readFile(
      new URL('../../../../deploy/bin/verity-rotate-identity', import.meta.url),
      'utf8',
    );
    // Execute the installer's actual SQL, so stale table/column names cannot pass a shell-only fake.
    const sql = source.match(/<<'SQL'[^\n]*\n([\s\S]*?)^SQL$/m)?.[1];
    expect(sql).toBeDefined();
    const admin = new pg.Pool({ connectionString: adminUrl!, max: 1 });
    const name = 'verity_restore_' + randomBytes(16).toString('hex');
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(adminUrl!);
    url.pathname = '/' + name;
    const database = createPostgresDb(url.toString());
    const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
    try {
      await migrateToLatest(database);
      await pool.query(
        `INSERT INTO auth_tokens(id,token_hash) VALUES ('old-device','old-hash'),('old-enrollment','enrollment-hash'); UPDATE backup_policy SET journal_enabled=true;`,
      );
      await pool.query(sql!);
      expect((await pool.query('SELECT id FROM auth_tokens')).rows).toEqual([]);
      expect(
        (await pool.query('SELECT device_id FROM backup_revocation_outbox ORDER BY device_id'))
          .rows,
      ).toEqual([{ device_id: 'old-device' }, { device_id: 'old-enrollment' }]);
      await pool.query(sql!);
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM backup_revocation_outbox')).rows[0].n,
      ).toBe(2);
      await pool.query(`INSERT INTO auth_tokens(id,token_hash) VALUES ('new-device','new-hash');`);
      // A journal failure must not commit credential deletion or partial outbox changes.
      await pool.query(
        `CREATE FUNCTION deny_revocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic journal failure'; END $$; CREATE TRIGGER deny_revocation BEFORE INSERT ON backup_revocation_outbox FOR EACH ROW EXECUTE FUNCTION deny_revocation();`,
      );
      await expect(pool.query(sql!)).rejects.toThrow('synthetic journal failure');
      await pool.query('ROLLBACK');
      expect((await pool.query('SELECT id FROM auth_tokens')).rows).toEqual([{ id: 'new-device' }]);
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM backup_revocation_outbox')).rows[0].n,
      ).toBe(2);
    } finally {
      await pool.end();
      await database.destroy();
      // Pool shutdown can resolve before PostgreSQL has processed every disconnect.
      // FORCE would terminate a closing client and surface an uncaught idle error.
      await expect
        .poll(
          async () =>
            (
              await admin.query<{ n: number }>(
                'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
                [name],
              )
            ).rows[0]!.n,
          { timeout: 5000, interval: 20 },
        )
        .toBe(0);
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  },
);
