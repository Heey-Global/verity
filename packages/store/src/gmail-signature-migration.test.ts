import { Migrator } from 'kysely/migration';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { migrationProvider } from './migrations.js';
import { createRawDb } from './testing.js';

it('requires existing Gmail connections to authorize signature access once', async () => {
  const ctx = createRawDb();
  try {
    const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
    const before = await migrator.migrateTo('0106_gmail_connections');
    if (before.error) throw new Error('Migration failed', { cause: before.error });
    await sql`insert into verity_settings (id, gmail_authorized) values ('global', true)`.execute(
      ctx.db,
    );
    await sql`insert into projects(id,owner,repo,container_name,state,overview_visible)
      values('p1','test','repo','container','absent',true)`.execute(ctx.db);
    await sql`insert into sessions(session_id,worktree,model,project_id)
      values('s1','/tmp/work','default','p1')`.execute(ctx.db);
    await sql`insert into session_gmail_connections (session_id, account_email)
      values ('s1', 'me@example.test')`.execute(ctx.db);

    const after = await migrator.migrateToLatest();
    if (after.error) throw new Error('Migration failed', { cause: after.error });

    await expect(
      sql`select gmail_authorized from verity_settings where id = 'global'`.execute(ctx.db),
    ).resolves.toMatchObject({ rows: [{ gmail_authorized: false }] });
    await expect(
      sql`select session_id from session_gmail_connections`.execute(ctx.db),
    ).resolves.toMatchObject({ rows: [] });
  } finally {
    await ctx.close();
  }
});
