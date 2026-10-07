import { Migrator } from 'kysely/migration';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { migrationProvider } from './migrations.js';
import { createRawDb } from './testing.js';

it('does not promote existing session access into project authorization or change Google consent', async () => {
  const ctx = createRawDb();
  try {
    const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
    expect((await migrator.migrateTo('0127_public_preview_pin_lock')).error).toBeUndefined();
    await sql`insert into projects(id,owner,repo,container_name,state,overview_visible) values('p1','test','repo','container','absent',true)`.execute(
      ctx.db,
    );
    await sql`insert into sessions(session_id,worktree,model,project_id) values('s1','/tmp/work','default','p1')`.execute(
      ctx.db,
    );
    await sql`insert into session_gmail_connections(session_id,account_email) values('s1','me@example.test')`.execute(
      ctx.db,
    );
    await sql`insert into verity_settings(id,google_granted_scopes) values('global','["https://www.googleapis.com/auth/gmail.readonly"]'::jsonb)`.execute(
      ctx.db,
    );
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    expect((await sql`select * from project_google_connections`.execute(ctx.db)).rows).toEqual([]);
    expect(
      (await sql`select account_email from session_gmail_connections`.execute(ctx.db)).rows,
    ).toEqual([{ account_email: 'me@example.test' }]);
    expect(
      (await sql`select google_granted_scopes from verity_settings`.execute(ctx.db)).rows,
    ).toEqual([{ google_granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }]);
  } finally {
    await ctx.close();
  }
});
