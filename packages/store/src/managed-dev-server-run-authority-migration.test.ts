import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';

import { migrationProvider } from './migrations.js';
import { createRawDb } from './testing.js';

// Dropping the handoff pointer would strand the previous sandbox's process, with
// its injected secrets, under a version that no longer knows it exists.
it('refuses to downgrade while a managed dev server handoff is unfinished', async () => {
  const raw = createRawDb();
  try {
    const migrator = new Migrator({ db: raw.db, provider: migrationProvider });
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    await sql`insert into projects (id, owner, repo, container_name, kind, state, overview_visible)
      values ('p1', 'acme', 'p1', 'dev-acme-p1', 'local', 'active', true)`.execute(raw.db);
    await sql`insert into sessions (session_id, worktree, model, project_id)
      values ('s1', '/wt/s1', 'test', 'p1')`.execute(raw.db);
    await sql`insert into managed_dev_servers (id, project_id, name, name_key, command)
      values ('server', 'p1', 'Web', 'web', 'npm run dev')`.execute(raw.db);
    await sql`insert into managed_dev_server_instances
        (id, server_id, project_id, session_id, sandbox_port, previous_run_sandbox_user_id)
      values ('instance', 'server', 'p1', 's1', 4100, 'lena')`.execute(raw.db);

    const blocked = await migrator.migrateTo('0242_doppler_connections');
    expect(blocked.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining('Cannot downgrade') }),
    );

    await sql`update managed_dev_server_instances set previous_run_sandbox_user_id = null`.execute(
      raw.db,
    );
    expect((await migrator.migrateTo('0242_doppler_connections')).error).toBeUndefined();
  } finally {
    await raw.close();
  }
});
