import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { migrationProvider } from './migrations.js';
import { EventStore } from './store.js';
import { createRawDb, createTestDb, truncateAll, type TestDb } from './testing.js';

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

it("records each person's sandbox once and keeps one project default", async () => {
  const sandboxes = ctx.store.projectSandboxes;
  expect(await sandboxes.ensureProjectDefault('p1', ADMIN)).toEqual({
    projectId: 'p1',
    userId: ADMIN,
    projectDefault: true,
  });
  expect(await sandboxes.ensure('p1', 'lena')).toEqual({
    projectId: 'p1',
    userId: 'lena',
    projectDefault: false,
  });
  await sandboxes.ensure('p1', 'lena');
  // A second default for someone else is refused by the database, not recorded.
  expect((await sandboxes.ensureProjectDefault('p1', 'lena')).userId).toBe(ADMIN);
  expect((await sandboxes.list('p1')).map((s) => [s.userId, s.projectDefault])).toEqual([
    [ADMIN, true],
    ['lena', false],
  ]);
});

// The existing container was the administrator's; it becomes their sandbox under
// its current names, so the upgrade recreates nothing.
it("makes each existing project's container the administrator's sandbox on upgrade", async () => {
  const raw = createRawDb();
  try {
    const migrator = new Migrator({ db: raw.db, provider: migrationProvider });
    const before = await migrator.migrateTo('0211_per_person_brokered_grants');
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
    const after = await migrator.migrateToLatest();
    if (after.error) throw new Error('Migration failed', { cause: after.error });
    expect(await new EventStore(raw.db).projectSandboxes.list('p1')).toEqual([
      { projectId: 'p1', userId: ADMIN, projectDefault: true },
    ]);
  } finally {
    await raw.close();
  }
});
