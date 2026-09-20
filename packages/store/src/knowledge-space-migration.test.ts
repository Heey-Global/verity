import { expect, it } from 'vitest';
import { Migrator } from 'kysely/migration';
import { sql } from 'kysely';
import { createRawDb } from './testing.js';
import { migrationProvider } from './migrations.js';
import { EventStore } from './store.js';
it('backfills stable spaces and preserves legacy memory without adopting a user General folder', async () => {
  const ctx = createRawDb();
  try {
    const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
    const before = await migrator.migrateTo('0099_managed_knowledge');
    if (before.error) throw new Error('Migration failed', { cause: before.error });
    await sql`insert into projects(id,owner,repo,container_name,state) values('existing','test','existing','existing','absent')`.execute(
      ctx.db,
    );
    await sql`insert into project_settings(project_id,memory) values('existing','Preserve this legacy note')`.execute(
      ctx.db,
    );
    await sql`insert into knowledge_folders(id,name) values('user-general','General')`.execute(
      ctx.db,
    );
    const result = await migrator.migrateToLatest();
    if (result.error) throw new Error('Migration failed', { cause: result.error });
    const store = new EventStore(ctx.db);
    const space = await store.knowledge.getProjectSpace('existing');
    expect(space).not.toBeNull();
    expect(space?.generalFolderId).not.toBe('user-general');
    expect(
      await ctx.db
        .selectFrom('project_knowledge_spaces')
        .select('legacy_memory')
        .where('project_id', '=', 'existing')
        .executeTakeFirst(),
    ).toEqual({ legacy_memory: 'Preserve this legacy note' });
    expect((await store.knowledge.listFolders()).find((f) => f.id === 'user-general')).toEqual({
      id: 'user-general',
      name: 'General',
      parentId: null,
    });
    await migrator.migrateToLatest();
    expect(await store.knowledge.getProjectSpace('existing')).toEqual(space);
    const down = await migrator.migrateDown();
    if (down.error) throw new Error('Migration rollback failed', { cause: down.error });
    const reapplied = await migrator.migrateToLatest();
    if (reapplied.error) throw new Error('Migration reapply failed', { cause: reapplied.error });
    expect((await store.knowledge.getProjectSpace('existing'))?.generalFolderId).toBe(
      'managed-general',
    );
  } finally {
    await ctx.close();
  }
});
