import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { migrateToLatest } from './db.js';
import { executedSchemaGeneration, migrationProvider } from './migrations.js';
import { createRawDb } from './testing.js';

it('preserves legacy slide writes across the 0098 forward schema promise', async () => {
  const { db, close } = createRawDb();
  const target = '0098_google_workspace_files';
  const migrations = await migrationProvider.getMigrations();
  expect(migrations[target]).toBeDefined();
  const predecessor = {
    getMigrations: () =>
      Promise.resolve(
        Object.fromEntries(Object.entries(migrations).filter(([key]) => key < target)),
      ),
  };
  const candidate = {
    getMigrations: () =>
      Promise.resolve(
        Object.fromEntries(Object.entries(migrations).filter(([key]) => key <= target)),
      ),
  };
  // Defaults are the rollback contract: the old build never supplies `kind`.
  const assign = async (fileId: string) => {
    await sql`insert into session_slide_decks (session_id, file_id, name, web_view_link)
      values ('bridge-session', ${fileId}, 'Deck', 'https://example.test/deck')
      on conflict (session_id) do update set file_id = excluded.file_id`.execute(db);
    await sql`insert into recent_google_slide_decks (file_id) values (${fileId})
      on conflict (file_id) do update set last_assigned_at = now()`.execute(db);
  };
  try {
    await migrateToLatest(db, predecessor);
    await sql`insert into sessions (session_id, worktree, model)
      values ('bridge-session', '/bridge', 'test')`.execute(db);
    await assign('existing-deck');
    await migrateToLatest(db, candidate);
    await expect(migrateToLatest(db, predecessor)).rejects.toThrow('maximum readable');
    await migrateToLatest(db, predecessor, { forwardMax: target });
    expect(await executedSchemaGeneration(db)).toBe(target);
    expect(
      (await sql<{ kind: string }>`select kind from session_slide_decks`.execute(db)).rows,
    ).toEqual([{ kind: 'slides' }]);
    await assign('new-deck');
    await assign('new-deck');
    expect(
      (
        await sql<{
          kind: string;
        }>`select kind from recent_google_slide_decks order by file_id`.execute(db)
      ).rows,
    ).toEqual([{ kind: 'slides' }, { kind: 'slides' }]);
    await sql`delete from session_slide_decks where session_id = 'bridge-session'`.execute(db);
    await assign('fresh-assignment');
    expect(
      (await sql<{ kind: string }>`select kind from session_slide_decks`.execute(db)).rows,
    ).toEqual([{ kind: 'slides' }]);
  } finally {
    await close();
  }
});
