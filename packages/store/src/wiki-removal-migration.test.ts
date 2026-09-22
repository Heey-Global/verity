import { expect, it } from 'vitest';
import { Migrator } from 'kysely/migration';
import { sql } from 'kysely';
import { migrationProvider } from './migrations.js';
import { createRawDb } from './testing.js';
import { EventStore } from './store.js';

it('removes legacy Wiki jobs and their maintenance sessions', async () => {
  const ctx = createRawDb();
  try {
    const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
    const before = await migrator.migrateTo('0100_project_sandbox_sleep');
    if (before.error) throw new Error('Migration failed', { cause: before.error });
    await sql`insert into projects(id,owner,repo,container_name,state,overview_visible) values('project','test','repo','container','absent',true)`.execute(
      ctx.db,
    );
    const withWiki = await migrator.migrateTo('0102_automatic_knowledge_maintenance');
    if (withWiki.error) throw new Error('Migration failed', { cause: withWiki.error });
    await sql`insert into sessions(session_id,worktree,model,project_id) values('wiki-session','/tmp/wiki','default','project')`.execute(
      ctx.db,
    );
    await sql`insert into sessions(session_id,worktree,model,project_id,name) values('ordinary-session','/tmp/work','default','project','Check Wiki')`.execute(
      ctx.db,
    );
    await sql`insert into sessions(session_id,worktree,model,project_id,name) values('orphan-wiki-session','/tmp/knowledge-orphan-wiki-session','default','project','Incorporate into Wiki')`.execute(
      ctx.db,
    );
    await sql`insert into knowledge_wiki_jobs(id,project_id,session_id,kind,status,source_revisions) values('job','project','wiki-session','check','failed','[]')`.execute(
      ctx.db,
    );
    // Every maintenance session that ever ran left a durable log behind, and
    // `events`/`transcript_lines` reference `sessions` under `on delete restrict`.
    // Without these rows the cleanup deletes sessions no database would refuse,
    // and the migration passes against the very defect it has to survive.
    for (const sessionId of ['wiki-session', 'orphan-wiki-session', 'ordinary-session']) {
      await sql`insert into events(session_id,type,payload) values(${sessionId},'prompt','{}')`.execute(
        ctx.db,
      );
      await sql`insert into transcript_lines(session_id,line) values(${sessionId},'logged')`.execute(
        ctx.db,
      );
    }
    const store = new EventStore(ctx.db);
    const space = (await store.knowledge.getProjectSpace('project'))!;
    const source = await store.knowledge.createDocument({
      folderId: space.sourcesFolderId,
      title: 'Source',
      bodyMarkdown: 'Preserved source',
    });
    const wikiDocument = await store.knowledge.createDocument({
      folderId: space.wikiFolderId,
      title: 'Retired page',
      bodyMarkdown: 'Preserved document',
    });
    await sql`insert into knowledge_maintenance_queue(project_id,source_document_id,due_at) values('project',${source.id},now()) on conflict do nothing`.execute(
      ctx.db,
    );
    await sql`insert into knowledge_provenance(revision_id,job_id,source_revisions) values(${wikiDocument.currentRevisionId},'job','[]')`.execute(
      ctx.db,
    );
    await store.updateVeritySettings({ knowledgeModel: 'codex/default' });

    const firstRemoval = await migrator.migrateTo('0103_remove_wiki_maintenance');
    if (firstRemoval.error) throw new Error('Migration failed', { cause: firstRemoval.error });

    // A retiring pre-0103 Server can finish one debounce after the first cleanup.
    // This is the silent upgrade race the follow-up migration must close.
    await sql`insert into sessions(session_id,worktree,model,project_id) values('late-wiki-session','/tmp/late-wiki','default','project')`.execute(
      ctx.db,
    );
    await sql`insert into knowledge_wiki_jobs(id,project_id,session_id,kind,status,source_revisions) values('late-job','project','late-wiki-session','check','failed','[]')`.execute(
      ctx.db,
    );
    await sql`insert into sessions(session_id,worktree,model,project_id,name) values('late-orphan-wiki-session','/tmp/knowledge-late-orphan-wiki-session','default','project','Incorporate into Wiki')`.execute(
      ctx.db,
    );
    for (const sessionId of ['late-wiki-session', 'late-orphan-wiki-session']) {
      await sql`insert into events(session_id,type,payload) values(${sessionId},'prompt','{}')`.execute(
        ctx.db,
      );
      await sql`insert into transcript_lines(session_id,line) values(${sessionId},'logged')`.execute(
        ctx.db,
      );
    }

    const result = await migrator.migrateToLatest();
    if (result.error) throw new Error('Migration failed', { cause: result.error });

    expect(
      await sql`select session_id from sessions where session_id = 'wiki-session'`.execute(ctx.db),
    ).toMatchObject({ rows: [] });
    expect(await sql`select id from knowledge_wiki_jobs`.execute(ctx.db)).toMatchObject({
      rows: [],
    });
    expect(
      await sql`select session_id from sessions where session_id = 'late-wiki-session'`.execute(
        ctx.db,
      ),
    ).toMatchObject({ rows: [] });
    expect(
      await sql`select session_id from sessions where session_id = 'late-orphan-wiki-session'`.execute(
        ctx.db,
      ),
    ).toMatchObject({ rows: [] });
    expect(
      await sql`select session_id from sessions where session_id = 'ordinary-session'`.execute(
        ctx.db,
      ),
    ).toMatchObject({ rows: [{ session_id: 'ordinary-session' }] });
    expect(
      await sql`select session_id from sessions where session_id = 'orphan-wiki-session'`.execute(
        ctx.db,
      ),
    ).toMatchObject({ rows: [] });
    // The log rows leave with their session and only with their session: a
    // cleanup that spared them could not have deleted the session at all, and one
    // that took the surviving session's log would be destroying operator history.
    expect(
      await sql`select session_id from events order by session_id`.execute(ctx.db),
    ).toMatchObject({
      rows: [{ session_id: 'ordinary-session' }],
    });
    expect(
      await sql`select session_id from transcript_lines order by session_id`.execute(ctx.db),
    ).toMatchObject({ rows: [{ session_id: 'ordinary-session' }] });
    expect(
      await sql`select project_id from knowledge_maintenance_queue`.execute(ctx.db),
    ).toMatchObject({ rows: [] });
    expect(await sql`select revision_id from knowledge_provenance`.execute(ctx.db)).toMatchObject({
      rows: [],
    });
    expect(
      await sql`select knowledge_model from verity_settings where id = 'global'`.execute(ctx.db),
    ).toMatchObject({ rows: [{ knowledge_model: null }] });
    expect(await store.knowledge.getDocument(source.id)).toMatchObject({
      bodyMarkdown: 'Preserved source',
    });
    expect(await store.knowledge.getDocument(wikiDocument.id)).toMatchObject({
      bodyMarkdown: 'Preserved document',
    });
    await sql`insert into sessions(session_id,worktree,model,project_id) values('rejected-wiki-session','/tmp/rejected-wiki','default','project')`.execute(
      ctx.db,
    );
    await expect(
      sql`insert into knowledge_wiki_jobs(id,project_id,session_id,kind,status,source_revisions) values('rejected-job','project','rejected-wiki-session','check','pending','[]')`.execute(
        ctx.db,
      ),
    ).rejects.toThrow();
  } finally {
    await ctx.close();
  }
});

it('keeps the cleanup aware of every foreign key that refuses a session delete', async () => {
  const ctx = createRawDb();
  try {
    const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
    const result = await migrator.migrateToLatest();
    if (result.error) throw new Error('Migration failed', { cause: result.error });

    // Everything the cleanup destroys: the session row, the two logs it clears by
    // hand, and whatever `cascade` drags along behind those — transitively, since
    // a cascade child's own children go too. A `restrict` or `no action` edge
    // anywhere in that closure refuses the delete and aborts the migration, and
    // migrations run before the Server listens, so a new one wedges the next
    // self-update at its readiness probe with nothing in its own diff to point
    // back here. Clear the new table in `deleteLegacyWikiSessions` before this
    // list grows. (`set null`/`set default` children keep their row, so their own
    // children are not reached and are not walked.)
    expect(
      await sql<{ child: string; parent: string }>`
        with recursive destroyed(table_oid) as (
          select unnest(array['sessions', 'events', 'transcript_lines']::regclass[])
          union
          select c.conrelid
          from pg_constraint c
          join destroyed d on c.confrelid = d.table_oid
          where c.contype = 'f' and c.confdeltype = 'c'
        )
        select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
        from pg_constraint c
        join destroyed d on c.confrelid = d.table_oid
        where c.contype = 'f' and c.confdeltype in ('a', 'r')
        order by parent, child`.execute(ctx.db),
    ).toMatchObject({
      rows: [
        { child: 'events', parent: 'sessions' },
        { child: 'transcript_lines', parent: 'sessions' },
      ],
    });
  } finally {
    await ctx.close();
  }
});
