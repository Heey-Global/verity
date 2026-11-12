import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { createSecretCipher } from './crypto.js';
import { migrationProvider } from './migrations.js';
import { EventStore } from './store.js';
import { UserDopplerConnectionStore } from './user-doppler-connection.js';
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
      { id: 'lena', role: 'member', status: 'active' },
      { id: 'mia', role: 'member', status: 'active' },
    ])
    .execute();
  for (const id of ['p1', 'p2'])
    await ctx.store.upsertProject({
      id,
      owner: 'acme',
      repo: id,
      containerName: `dev-acme-${id}`,
      state: 'active',
    });
});

// One person's token must never answer for another person or another project.
it('keeps each Doppler token to its person and project, encrypted at rest', async () => {
  const connections = new UserDopplerConnectionStore(ctx.db, createSecretCipher('cd'.repeat(32)));
  await connections.set('lena', 'p1', 'dp.st.lena-p1');
  await connections.set('mia', 'p1', 'dp.st.mia-p1');

  expect((await connections.tokenBytes('lena', 'p1'))?.toString()).toBe('dp.st.lena-p1');
  expect((await connections.tokenBytes('mia', 'p1'))?.toString()).toBe('dp.st.mia-p1');
  expect(await connections.tokenBytes('lena', 'p2')).toBeUndefined();
  expect(await connections.status('lena', 'p2')).toBeUndefined();
  expect(await connections.status('lena', 'p1')).toMatchObject({ updatedAt: expect.any(Date) });

  const stored = await ctx.db.selectFrom('user_doppler_connections').select('token').execute();
  expect(stored.map((row) => row.token).join()).not.toContain('dp.st.');

  await connections.set('lena', 'p1', 'dp.st.lena-rotated');
  expect((await connections.tokenBytes('lena', 'p1'))?.toString()).toBe('dp.st.lena-rotated');
  await connections.delete('lena', 'p1');
  expect(await connections.tokenBytes('lena', 'p1')).toBeUndefined();
  expect((await connections.tokenBytes('mia', 'p1'))?.toString()).toBe('dp.st.mia-p1');
});

// Standing grants become one person's consent. The ones that exist were approved
// by the administrator; losing them would re-prompt, giving them to no one would
// silently disable them, and giving them to a member would be wrong.
it('assigns existing brokered-prompt grants to the administrator on upgrade', async () => {
  const raw = createRawDb();
  try {
    const migrator = new Migrator({ db: raw.db, provider: migrationProvider });
    const before = await migrator.migrateTo('0208_user_github_authorizations');
    if (before.error) throw new Error('Migration failed', { cause: before.error });
    await sql`insert into users (id, role, status) values ('lena', 'member', 'active')`.execute(
      raw.db,
    );
    await new EventStore(raw.db).upsertProject({
      id: 'p1',
      owner: 'acme',
      repo: 'p1',
      containerName: 'dev-acme-p1',
      state: 'active',
    });
    await sql`insert into secret_provider_permissions
        (id, project_id, binding_id, binding_version, secret_name, tool_id, scope, granted_by, issuer, state)
      values
        ('g1', 'p1', 'b1', 1, 'API_KEY', 'verity_http_request:x', 'forever', 'operator', 'brokered-prompt-v2', 'active'),
        ('g2', 'p1', 'b1', 1, 'API_KEY', 'catalog:profile', 'forever', 'operator', null, 'active')`.execute(
      raw.db,
    );
    const after = await migrator.migrateToLatest();
    if (after.error) throw new Error('Migration failed', { cause: after.error });
    const rows = await sql<{ id: string; user_id: string | null }>`
      select id, user_id from secret_provider_permissions order by id`.execute(raw.db);
    expect(rows.rows).toEqual([
      { id: 'g1', user_id: ADMIN },
      { id: 'g2', user_id: null },
    ]);
  } finally {
    await raw.close();
  }
});
