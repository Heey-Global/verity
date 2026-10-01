import { sql, type Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';

import { migrationProvider } from './migrations.js';
import { ensureProjectKnowledgeSpace } from './knowledge-spaces.js';
import type { Database } from './schema.js';
import { createRawDb } from './testing.js';

async function snapshot(db: Kysely<Database>): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (
      table.name.startsWith('kysely_') ||
      table.name.startsWith('knowledge_maintenance_') ||
      table.name === 'knowledge_wiki_jobs'
    )
      continue;
    const columns = table.columns
      .filter(
        (column) => !['legacy_memory', 'reconcile_due_at', 'knowledge_model'].includes(column.name),
      )
      .map((column) => column.name);
    const result = await sql`select ${sql.join(columns.map((column) => sql.ref(column)))}
      from ${sql.table(table.name)}`.execute(db);
    rows[table.name] = result.rows.sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  }
  return rows;
}

it('removes retired maintenance state while preserving existing installation records', async () => {
  const { db, close } = createRawDb();
  try {
    const keys = Object.keys(await migrationProvider.getMigrations()).sort();
    const cleanup = keys.find((key) => key.endsWith('_remove_retired_knowledge_state'));
    expect(cleanup).toBeDefined();
    const previous = keys[keys.indexOf(cleanup!) - 1];
    expect(previous).toBeDefined();
    const migrator = new Migrator({ db, provider: migrationProvider });
    expect((await migrator.migrateTo(previous!)).error).toBeUndefined();
    await sql`insert into projects (id, owner, repo, container_name, state, overview_visible)
      values ('kept-project', 'test', 'kept', 'kept-container', 'absent', true)`.execute(db);
    await sql`insert into sessions (session_id, worktree, model, project_id)
      values ('kept-session', '/kept-worktree', 'kept-model', 'kept-project')`.execute(db);
    await sql`insert into events (session_id, type, payload)
      values ('kept-session', 'text', '{"text":"Keep session history"}'::jsonb)`.execute(db);
    await sql`insert into project_settings (project_id, memory)
      values ('kept-project', 'Keep project guidance')`.execute(db);
    await sql`insert into verity_settings (id, git_user_name, knowledge_model)
      values ('global', 'Keep configuration', 'retired-model')`.execute(db);
    await sql`insert into knowledge_folders (id, name) values ('kept-folder', 'Kept sources')`.execute(
      db,
    );
    await sql`insert into knowledge_documents (id, folder_id, title)
      values ('kept-document', 'kept-folder', 'Kept source')`.execute(db);
    await sql`insert into knowledge_document_revisions
      (id, document_id, title, body_markdown, author_identity)
      values ('kept-revision', 'kept-document', 'Kept source', 'Keep source content', 'test')`.execute(
      db,
    );
    await sql`update knowledge_documents set current_revision_id = 'kept-revision'
      where id = 'kept-document'`.execute(db);
    await sql`insert into knowledge_maintenance_queue (project_id, source_document_id, due_at)
      values ('kept-project', 'kept-document', now())`.execute(db);
    await sql`insert into auth_tokens (id, token_hash, label)
      values ('kept-device', 'test-pairing-hash', 'Keep paired device')`.execute(db);
    await sql`insert into transcript_lines (session_id, line)
      values ('kept-session', '{"text":"Keep resume history"}')`.execute(db);
    await sql`insert into knowledge_provenance (revision_id, job_id, source_revisions)
      values ('kept-revision', 'retired-job', '[]')`.execute(db);
    await sql`insert into knowledge_source_revisions
      (revision_id, filename, media_type, bytes, sha256, processing_state, processing_note, locators, previews)
      values ('kept-revision', 'source.md', 'text/markdown', ${Buffer.from('Keep source bytes')},
        ${'a'.repeat(64)}, 'ready', '', '[]'::jsonb, '[]'::jsonb)`.execute(db);
    await db.transaction().execute(async (tx) => {
      await ensureProjectKnowledgeSpace(tx, 'kept-project', 'Kept project');
    });
    const space = await db
      .selectFrom('project_knowledge_spaces')
      .selectAll()
      .where('project_id', '=', 'kept-project')
      .executeTakeFirstOrThrow();
    await sql`insert into knowledge_documents (id, folder_id, title)
      values ('kept-overview', ${space.wiki_folder_id}, 'Project overview')`.execute(db);
    await sql`insert into knowledge_document_revisions
      (id, document_id, title, body_markdown, author_identity)
      values ('kept-overview-revision', 'kept-overview', 'Project overview', 'Keep pinned guidance', 'test')`.execute(
      db,
    );
    await sql`update knowledge_documents set current_revision_id = 'kept-overview-revision'
      where id = 'kept-overview'`.execute(db);
    await db
      .updateTable('project_knowledge_spaces')
      .set({
        overview_document_id: 'kept-overview',
        overview_revision_id: 'kept-overview-revision',
      })
      .where('project_id', '=', 'kept-project')
      .execute();
    // Empty fixtures cannot catch an accidental truncate of real installation data.
    const before = await snapshot(db);
    expect((await migrator.migrateTo(cleanup!)).error).toBeUndefined();
    expect(await snapshot(db)).toEqual(before);
    expect((await db.introspection.getTables()).map((table) => table.name)).not.toContain(
      'knowledge_wiki_jobs',
    );
    expect((await db.introspection.getTables()).map((table) => table.name)).not.toContain(
      'knowledge_maintenance_queue',
    );
    expect((await migrator.migrateTo(cleanup!)).error).toBeUndefined();
    expect(await snapshot(db)).toEqual(before);
    expect((await migrator.migrateDown()).error).toBeUndefined();
    expect(await snapshot(db)).toEqual(before);
    expect((await migrator.migrateTo(cleanup!)).error).toBeUndefined();
    expect(await snapshot(db)).toEqual(before);
  } finally {
    await close();
  }
});
