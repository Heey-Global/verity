import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';
import { migrationProvider } from './migrations.js';
import { createRawDb } from './testing.js';

it('upgrades an existing database without reordering the released migrations', async () => {
  const ctx = createRawDb();
  try {
    const migrations = await migrationProvider.getMigrations();
    const released = Object.fromEntries(
      Object.entries(migrations).filter(([name]) => !name.endsWith('_session_project_moves')),
    );
    const before = await new Migrator({
      db: ctx.db,
      provider: { getMigrations: async () => released },
    }).migrateToLatest();
    expect(before.error).toBeUndefined();
    // Inserting the feature migration before already-applied main migrations breaks upgrades.
    const after = await new Migrator({ db: ctx.db, provider: migrationProvider }).migrateToLatest();
    expect(after.error).toBeUndefined();
    expect(after.results?.filter((result) => result.status === 'Success')).toHaveLength(1);
    for (const table of [
      'session_moves',
      'session_gmail_connections',
      'integration_accounts',
      'matrix_connector_config',
    ]) {
      await expect(
        sql`select * from ${sql.table(table)} limit 0`.execute(ctx.db),
      ).resolves.toMatchObject({ rows: [] });
    }
  } finally {
    await ctx.close();
  }
});
