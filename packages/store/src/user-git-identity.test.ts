import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { migrationProvider } from './migrations.js';
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
    .values({ id: 'lena', role: 'member', status: 'active' })
    .execute();
});

it("keeps each person's git identity separate and changes only the given fields", async () => {
  const identities = ctx.store.userGitIdentities;
  await identities.set('lena', { authorName: 'Lena', authorEmail: 'lena@example.org' });
  await identities.set('lena', {
    sshPrivateKey: 'lena-key',
    sshPublicKey: 'ssh-ed25519 AAAA lena',
  });
  await expect(identities.get('lena')).resolves.toEqual({
    userId: 'lena',
    authorName: 'Lena',
    authorEmail: 'lena@example.org',
    sshPrivateKey: 'lena-key',
    sshPublicKey: 'ssh-ed25519 AAAA lena',
  });
  // Another person's identity is untouched and absent until set.
  await expect(identities.get(ADMIN)).resolves.toBeUndefined();
  await identities.set('lena', { sshPrivateKey: null });
  expect((await identities.get('lena'))?.sshPrivateKey).toBeNull();
  expect((await identities.get('lena'))?.authorName).toBe('Lena');
});

// The installation's git identity was the administrator's; losing it on upgrade
// would leave their commits unsigned, giving it to anyone else would let them
// sign as the administrator.
it("makes the existing instance identity the administrator's own on upgrade", async () => {
  const raw = createRawDb();
  try {
    const migrator = new Migrator({ db: raw.db, provider: migrationProvider });
    const before = await migrator.migrateTo('0206_google_account_owners');
    if (before.error) throw new Error('Migration failed', { cause: before.error });
    await sql`insert into verity_settings (id, git_user_name, git_user_email, git_ssh_private_key, git_ssh_public_key)
      values ('global', 'Holger', 'holger@example.org', 'enc:instance-key', 'ssh-ed25519 AAAA holger')
      on conflict (id) do update set git_user_name = excluded.git_user_name,
        git_user_email = excluded.git_user_email, git_ssh_private_key = excluded.git_ssh_private_key,
        git_ssh_public_key = excluded.git_ssh_public_key`.execute(raw.db);
    await sql`insert into users (id, role, status) values ('lena', 'member', 'active')`.execute(
      raw.db,
    );
    const after = await migrator.migrateToLatest();
    if (after.error) throw new Error('Migration failed', { cause: after.error });
    const rows = await sql<{
      user_id: string;
      author_name: string;
      author_email: string;
      ssh_private_key: string;
      ssh_public_key: string;
    }>`select user_id, author_name, author_email, ssh_private_key, ssh_public_key
      from user_git_identities`.execute(raw.db);
    expect(rows.rows).toEqual([
      {
        user_id: ADMIN,
        author_name: 'Holger',
        author_email: 'holger@example.org',
        // The encrypted envelope is copied verbatim, so the migration runs sealed.
        ssh_private_key: 'enc:instance-key',
        ssh_public_key: 'ssh-ed25519 AAAA holger',
      },
    ]);
  } finally {
    await raw.close();
  }
});
