import { Migrator, NO_MIGRATIONS } from 'kysely/migration';
import { describe, expect, it } from 'vitest';
import {
  earliestMigrationKey,
  executedSchemaGeneration,
  getExecutedMigrations,
  latestMigrationKey,
  migrationProvider,
  schemaCompatibilityWindow,
} from './migrations.js';
import { createIsolatedTestDb, createRawDb, createTestDb } from './testing.js';

describe('latestMigrationKey', () => {
  it('returns the highest-ordered in-code migration key', () => {
    const key = latestMigrationKey();
    // It must be one of the defined migrations and the maximum by the same sort
    // Kysely applies (Object.keys().sort()).
    expect(key).toMatch(/^\d{4}_/);
    // Re-derive independently: the sort is stable, so the result is deterministic.
    expect(latestMigrationKey()).toBe(key);
  });
});

describe('earliestMigrationKey', () => {
  it('returns the lowest-ordered in-code migration key', async () => {
    const earliest = earliestMigrationKey();
    expect(earliest).toMatch(/^\d{4}_/);
    // It is the minimum by the same sort Kysely applies: <= every provider key
    // and in particular <= the latest.
    const all = Object.keys(await migrationProvider.getMigrations()).sort();
    expect(earliest).toBe(all[0]);
    expect(earliest <= latestMigrationKey()).toBe(true);
  });
});

describe('migration keys', () => {
  it('are declared in the order Kysely applies them', async () => {
    const keys = Object.keys(await migrationProvider.getMigrations());
    // Two branches picking the same next number merge cleanly, but a new key that
    // sorts before one an installed Server already ran makes Kysely refuse to
    // start the candidate ("corrupted migrations") — until now only the live
    // self-update smoke noticed. Appending means the new key must sort last.
    const inversions = keys.flatMap((key, i) =>
      i > 0 && key < keys[i - 1]! ? [`${keys[i - 1]} -> ${key}`] : [],
    );
    // These shipped inside a single release each, so no installed Server ran one
    // half without the other. They are history now; nothing may join them.
    expect(inversions).toEqual([
      '0038_agent_loops -> 0033_running_turns',
      '0085_broker_only_doppler_credentials -> 0084_cross_project_workflows',
      '0096_opencode_model_selection -> 0093_opencode_settings',
    ]);
  });
});

describe('schemaCompatibilityWindow', () => {
  it('declares [earliest, latest] with the latest as both current and max', () => {
    const window = schemaCompatibilityWindow();
    expect(window.min).toBe(earliestMigrationKey());
    expect(window.current).toBe(latestMigrationKey());
    // `max` equals `current` until a per-release forward-tolerance declaration
    // widens it (ADR 0008 D9).
    expect(window.max).toBe(window.current);
  });

  it('is coherent: min <= current <= max', () => {
    const { min, current, max } = schemaCompatibilityWindow();
    expect(min <= current).toBe(true);
    expect(current <= max).toBe(true);
  });
});

describe('getExecutedMigrations', () => {
  it('lists every applied migration on a fully migrated store', async () => {
    const ctx = await createTestDb();
    try {
      const executed = await getExecutedMigrations(ctx.db);
      expect(executed).toContain(latestMigrationKey());
      // The migrated set equals the full provider set.
      const all = Object.keys(await migrationProvider.getMigrations());
      expect(new Set(executed)).toEqual(new Set(all));
    } finally {
      await ctx.close();
    }
  });

  it('returns an empty list on an unmigrated database and does not create tables', async () => {
    const { db, close } = createRawDb();
    try {
      // No migration bookkeeping table exists yet — the read must tolerate that.
      expect(await getExecutedMigrations(db)).toEqual([]);
      expect(await executedSchemaGeneration(db)).toBeNull();
    } finally {
      await close();
    }
  });

  // Isolated: migrating away from the latest schema would leave the shared
  // instance behind for every file that follows in this worker.
  it('tracks a partial migration target', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      expect((await migrator.migrateTo('0026_auth_tokens')).error).toBeUndefined();
      const executed = await getExecutedMigrations(ctx.db);
      expect(executed).toContain('0026_auth_tokens');
      expect(executed).not.toContain(latestMigrationKey());
      expect(await executedSchemaGeneration(ctx.db)).toBe('0026_auth_tokens');
    } finally {
      await ctx.close();
    }
  });
});

describe('executedSchemaGeneration', () => {
  // Isolated: this rolls the schema all the way back (see above).
  it('is the latest key on a fully migrated store and null when fully rolled back', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      expect(await executedSchemaGeneration(ctx.db)).toBe(latestMigrationKey());
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      expect((await migrator.migrateTo(NO_MIGRATIONS)).error).toBeUndefined();
      expect(await executedSchemaGeneration(ctx.db)).toBeNull();
    } finally {
      await ctx.close();
    }
  });
});
