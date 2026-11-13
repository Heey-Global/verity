import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { createSecretCipher } from './crypto.js';
import { migrationProvider } from './migrations.js';
import { EventStore } from './store.js';
import { createRawDb, createTestDb, truncateAll, type TestDb } from './testing.js';
import { UserProviderConnectionStore } from './user-provider-connections.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.db
    .insertInto('users')
    .values([
      { id: ADMIN, role: 'administrator', status: 'active' },
      { id: 'lena', role: 'member', status: 'active' },
    ])
    .onConflict((conflict) => conflict.column('id').doNothing())
    .execute();
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'acme',
    repo: 'app',
    containerName: 'verity-acme--app',
    state: 'active',
  });
});

// One person's provider account must never answer for another, and the stored
// value must not be readable without the key.
it("keeps each person's provider accounts to themselves, encrypted at rest", async () => {
  const connections = new UserProviderConnectionStore(ctx.db, createSecretCipher('cd'.repeat(32)));
  await connections.set('lena', 'codex', { credential: '{"tokens":"lena"}' });
  await connections.set(ADMIN, 'codex', { credential: '{"tokens":"admin"}' });
  await connections.set('lena', 'opencode', {
    credential: 'sk-lena',
    baseUrl: 'https://llm.example/v1',
    models: '["m1"]',
  });

  expect((await connections.get('lena', 'codex'))?.credential).toBe('{"tokens":"lena"}');
  expect(await connections.get('lena', 'claude')).toBeUndefined();
  expect((await connections.status('lena')).map((s) => s.provider)).toEqual(['codex', 'opencode']);
  expect((await connections.listByProvider('codex')).map((c) => c.userId).sort()).toEqual([
    ADMIN,
    'lena',
  ]);
  const raw = await ctx.db.selectFrom('user_provider_connections').select('credential').execute();
  expect(raw.map((row) => row.credential).join()).not.toMatch(/lena|admin|sk-/u);

  await connections.delete('lena', 'codex');
  expect(await connections.get('lena', 'codex')).toBeUndefined();
  expect((await connections.get(ADMIN, 'codex'))?.credential).toBe('{"tokens":"admin"}');
});

it('keeps a default model per person and project', async () => {
  const connections = ctx.store.userProviderConnections;
  await connections.setProjectDefaultModel('lena', 'p1', 'gpt-5.5');
  expect(await connections.projectDefaultModel('lena', 'p1')).toBe('gpt-5.5');
  expect(await connections.projectDefaultModel(ADMIN, 'p1')).toBeNull();
  // The last model is kept beside the default without replacing it.
  await connections.setLastModel('lena', 'p1', 'claude-opus');
  expect(await connections.lastModel('lena', 'p1')).toBe('claude-opus');
  expect(await connections.projectDefaultModel('lena', 'p1')).toBe('gpt-5.5');
  expect(await connections.lastModel(ADMIN, 'p1')).toBeNull();
});

// The project's default model so far was set by the administrator; it becomes
// theirs, and nobody else inherits it.
it("makes the existing project default model the administrator's own on upgrade", async () => {
  const raw = createRawDb();
  try {
    const migrator = new Migrator({ db: raw.db, provider: migrationProvider });
    const before = await migrator.migrateTo('0214_project_sandbox_state');
    if (before.error) throw new Error('Migration failed', { cause: before.error });
    await sql`insert into users (id, role, status) values (${ADMIN}, 'administrator', 'active')
      on conflict (id) do nothing`.execute(raw.db);
    await new EventStore(raw.db).upsertProject({
      id: 'p1',
      owner: 'acme',
      repo: 'app',
      containerName: 'verity-acme--app',
      state: 'active',
    });
    await sql`insert into project_settings (project_id, default_model) values ('p1', 'claude-opus')
      on conflict (project_id) do update set default_model = excluded.default_model`.execute(
      raw.db,
    );
    const after = await migrator.migrateToLatest();
    if (after.error) throw new Error('Migration failed', { cause: after.error });
    const rows = await sql<{ user_id: string; default_model: string }>`
      select user_id, default_model from user_project_preferences`.execute(raw.db);
    expect(rows.rows).toEqual([{ user_id: ADMIN, default_model: 'claude-opus' }]);
    // Left on the project, it would keep choosing a model for everyone else.
    const project = await sql<{ default_model: string | null }>`
      select default_model from project_settings where project_id = 'p1'`.execute(raw.db);
    expect(project.rows).toEqual([{ default_model: null }]);
  } finally {
    await raw.close();
  }
});
