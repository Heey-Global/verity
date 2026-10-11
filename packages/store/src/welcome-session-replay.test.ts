import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { WELCOME_SESSION_MARKER } from '@verity/events';
import { expect, it } from 'vitest';
import { migrationProvider } from './migrations.js';
import { createRawDb } from './testing.js';

it('remembers the existing welcome session on upgrade and retains its id after deletion', async () => {
  const ctx = createRawDb();
  try {
    const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
    expect((await migrator.migrateTo('0148_starter_project')).error).toBeUndefined();
    await sql`insert into projects(id,owner,repo,container_name,state) values('starter','local','getting-started','starter-container','active')`.execute(
      ctx.db,
    );
    await sql`insert into starter_project(singleton,project_id) values(true,'starter')`.execute(
      ctx.db,
    );
    await sql`insert into sessions(session_id,worktree,model,project_id) values('welcome','/tmp/welcome','default','starter')`.execute(
      ctx.db,
    );
    await sql`insert into session_automation_marker(session_id,marker) values('welcome',${WELCOME_SESSION_MARKER})`.execute(
      ctx.db,
    );
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    expect(
      (await sql`select welcome_session_id from starter_project`.execute(ctx.db)).rows,
    ).toEqual([{ welcome_session_id: 'welcome' }]);
    await sql`delete from sessions where session_id = 'welcome'`.execute(ctx.db);
    expect(
      (await sql`select welcome_session_id from starter_project`.execute(ctx.db)).rows,
    ).toEqual([{ welcome_session_id: 'welcome' }]);
  } finally {
    await ctx.close();
  }
});
