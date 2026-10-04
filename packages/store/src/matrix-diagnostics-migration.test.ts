import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';
import { migrationProvider } from './migrations.js';
import { createRawDb } from './testing.js';

it('adds Matrix diagnostics when upgrading a database with all released migrations', async () => {
  const ctx = createRawDb();
  try {
    const migrations = await migrationProvider.getMigrations();
    const pending = Object.keys(migrations).find((name) =>
      name.endsWith('_matrix_import_diagnostics'),
    )!;
    const released = Object.fromEntries(
      Object.entries(migrations).filter(
        ([name]) => name !== pending && name <= '0130_session_automations',
      ),
    );
    const before = await new Migrator({
      db: ctx.db,
      provider: { getMigrations: async () => released },
    }).migrateToLatest();
    expect(before.error).toBeUndefined();
    // Pin the deployed generation: later migrations must not become part of this upgrade fixture.
    // Fresh databases hide a migration inserted before the deployed generation.
    const after = await new Migrator({ db: ctx.db, provider: migrationProvider }).migrateTo(
      pending,
    );
    expect(after.error).toBeUndefined();
    expect(after.results?.filter((result) => result.status === 'Success')).toHaveLength(1);
    await expect(
      sql`select import_diagnostics, import_diagnostics_truncated, import_diagnostics_reported_at from integration_sources limit 0`.execute(
        ctx.db,
      ),
    ).resolves.toMatchObject({ rows: [] });
  } finally {
    await ctx.close();
  }
});
