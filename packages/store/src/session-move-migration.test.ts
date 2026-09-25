import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';
import { migrationProvider } from './migrations.js';
import { createRawDb } from './testing.js';

it('upgrades an existing database without reordering the released migrations', async () => {
  const ctx = createRawDb();
  try {
    // Every migration but the newest one is already on installed Servers.
    const released = Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).slice(0, -1),
    );
    const before = await new Migrator({
      db: ctx.db,
      provider: { getMigrations: async () => released },
    }).migrateToLatest();
    expect(before.error).toBeUndefined();
    // A newest migration that sorts before an applied one breaks every upgrade.
    const after = await new Migrator({ db: ctx.db, provider: migrationProvider }).migrateToLatest();
    expect(after.error).toBeUndefined();
    expect(after.results?.filter((result) => result.status === 'Success')).toHaveLength(1);
    for (const table of [
      'session_moves',
      'session_links',
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
