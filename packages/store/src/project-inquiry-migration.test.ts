import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';
import { migrationProvider } from './migrations.js';
import { EventStore } from './store.js';
import { createRawDb } from './testing.js';

it('keeps undecided legacy changes available for approval after upgrading', async () => {
  const raw = createRawDb();
  try {
    const migrator = new Migrator({ db: raw.db, provider: migrationProvider });
    const before = await migrator.migrateTo('0230_brokered_tool_approvals');
    if (before.error) throw new Error('Could not prepare legacy schema', { cause: before.error });
    const store = new EventStore(raw.db);
    for (const [projectId, sessionId] of [
      ['a', 'source'],
      ['b', 'target'],
    ] as const) {
      await store.createProject({
        id: projectId,
        owner: 'team',
        repo: projectId,
        containerName: projectId,
        state: 'active',
      });
      await store.createSession({ sessionId, projectId, worktree: `/${sessionId}`, model: 'test' });
    }
    await sql`insert into project_inquiries
      (id, source_session_id, target_session_id, source_project_id, target_project_id,
       title, body, kind, status)
      values ('waiting', 'source', 'target', 'a', 'b', 'Change', 'Scope', 'change', 'provisioning'),
             ('approved', 'source', 'target', 'a', 'b', 'Change', 'Scope', 'change', 'approved'),
             ('question', 'source', 'target', 'a', 'b', 'Question', 'Scope', 'question', 'provisioning')`.execute(
      raw.db,
    );
    const after = await migrator.migrateToLatest();
    if (after.error) throw new Error('Could not migrate inquiry consent', { cause: after.error });
    const result = await sql<{ id: string; status: string; human_approved: boolean }>`
      select id, status, human_approved from project_inquiries order by id`.execute(raw.db);
    expect(result.rows).toEqual([
      { id: 'approved', status: 'approved', human_approved: true },
      { id: 'question', status: 'provisioning', human_approved: false },
      { id: 'waiting', status: 'pending', human_approved: false },
    ]);
  } finally {
    await raw.close();
  }
});
