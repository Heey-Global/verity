import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Database } from './schema.js';

/** Called inside project creation: a project cannot become visible without its knowledge space. */
export async function ensureProjectKnowledgeSpace(
  tx: Transaction<Database>,
  projectId: string,
  label: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
  const project = await tx
    .selectFrom('projects')
    .select('hidden_at')
    .where('id', '=', projectId)
    .executeTakeFirst();
  if (!project || project.hidden_at !== null) return;
  const general = await tx
    .selectFrom('knowledge_folders')
    .select('id')
    .where('role', '=', 'general')
    .executeTakeFirst();
  if (!general) {
    const id = randomUUID();
    const collision = await tx
      .selectFrom('knowledge_folders')
      .select('id')
      .where('parent_id', 'is', null)
      .where('name', '=', 'General')
      .executeTakeFirst();
    await tx
      .insertInto('knowledge_folders')
      .values({
        id,
        parent_id: null,
        name: collision ? `General (${id})` : 'General',
        role: 'general',
      })
      .execute();
    await tx
      .insertInto('knowledge_folders')
      .values([
        { id: randomUUID(), parent_id: id, name: 'Sources', role: 'sources' },
        { id: randomUUID(), parent_id: id, name: 'Wiki', role: 'wiki' },
      ])
      .execute();
  }
  if (
    await tx
      .selectFrom('project_knowledge_spaces')
      .select('project_id')
      .where('project_id', '=', projectId)
      .executeTakeFirst()
  )
    return;
  const root = randomUUID(),
    sources = randomUUID(),
    wiki = randomUUID();
  const clean =
    label
      .split('')
      .map((c) =>
        c === '/' || c === '\\' || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c,
      )
      .join('')
      .slice(0, 100)
      .trim() || 'Project';
  const collision = await tx
    .selectFrom('knowledge_folders')
    .select('id')
    .where('parent_id', 'is', null)
    .where('name', '=', clean)
    .executeTakeFirst();
  await tx
    .insertInto('knowledge_folders')
    .values({
      id: root,
      parent_id: null,
      name: collision ? `${clean} (${root})` : clean,
      role: 'project',
      project_id: projectId,
    })
    .execute();
  await tx
    .insertInto('knowledge_folders')
    .values([
      { id: sources, parent_id: root, name: 'Sources', role: 'sources', project_id: projectId },
      { id: wiki, parent_id: root, name: 'Wiki', role: 'wiki', project_id: projectId },
    ])
    .execute();
  const settings = await tx
    .selectFrom('project_settings')
    .select('memory')
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  await tx
    .insertInto('project_knowledge_spaces')
    .values({
      project_id: projectId,
      root_folder_id: root,
      sources_folder_id: sources,
      wiki_folder_id: wiki,
      legacy_memory: settings?.memory ?? null,
    })
    .execute();
}
