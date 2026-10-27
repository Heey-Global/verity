import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { SERVER_COMPAT } from '../self-update/compat.js';
import { migrateProbeDatabase } from './probe-migrate.js';

const adminUrl = process.env.VERITY_TEST_SHARED_POSTGRES_URL;
describe.skipIf(!adminUrl)('probe migration on PostgreSQL', () => {
  it('creates the pinned schema once and refuses to migrate existing content', async () => {
    const pool = new pg.Pool({ connectionString: adminUrl!, max: 1 });
    const name = 'verity_probe_' + randomBytes(16).toString('hex');
    await pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(adminUrl!);
    url.pathname = '/' + name;
    const environment = {
      VERITY_BACKUP_PROBE_DATABASE_URL: url.toString(),
      VERITY_BACKUP_PROBE_SCHEMA: SERVER_COMPAT.schema.current,
    };
    try {
      await migrateProbeDatabase(environment);
      const probe = new pg.Pool({ connectionString: url.toString(), max: 1 });
      try {
        expect(
          (await probe.query('SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1'))
            .rows[0].name,
        ).toBe(SERVER_COMPAT.schema.current);
        await expect(migrateProbeDatabase(environment)).rejects.toThrow('must be empty');
        expect(
          (await probe.query('SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1'))
            .rows[0].name,
        ).toBe(SERVER_COMPAT.schema.current);
      } finally {
        await probe.end();
      }
    } finally {
      await pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await pool.end();
    }
  });
});
