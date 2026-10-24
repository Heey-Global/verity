import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';
import { migrationProvider } from './migrations.js';
import { createRawDb } from './testing.js';

it('upgrades an existing schema and removes retained frames on rollback', async () => {
  const ctx = createRawDb();
  try {
    const migrations = await migrationProvider.getMigrations();
    const entries = Object.entries(migrations);
    const index = entries.findIndex(([key]) => key.endsWith('_trusted_cli_outputs'));
    expect(index).toBeGreaterThan(0);
    const [key, migration] = entries[index]!;
    // Fresh databases conceal an out-of-order migration that existing installations reject.
    // Later migrations cannot exist in the installation being upgraded to this generation.
    const prior = Object.fromEntries(entries.slice(0, index));
    const previous = new Migrator({ db: ctx.db, provider: { getMigrations: async () => prior } });
    expect((await previous.migrateToLatest()).error).toBeUndefined();
    const current = new Migrator({ db: ctx.db, provider: migrationProvider });
    expect((await current.migrateTo(key)).error).toBeUndefined();
    await sql`insert into trusted_cli_outputs (id, project_id, session_id, expires_at, next_sequence) values ('retained', 'project', 'session', now(), 1)`.execute(
      ctx.db,
    );
    await sql`insert into secret_job_frames (job_id, sequence, protocol_version, stream, encoding, payload, byte_length, emitted_at, created_at) values ('retained', 0, 1, 'stdout', 'utf8', 'synthetic', 9, now(), now())`.execute(
      ctx.db,
    );
    await migration.down!(ctx.db);
    expect(
      (await sql`select * from secret_job_frames where job_id = 'retained'`.execute(ctx.db)).rows,
    ).toHaveLength(0);
  } finally {
    await ctx.close();
  }
});
