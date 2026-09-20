import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from './schema.js';
import { KnowledgeSourceStore, type KnowledgeSourceInput } from './knowledge-sources.js';

export const KNOWLEDGE_DOCUMENT_MAX_BYTES = 256 * 1024;
export const KNOWLEDGE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const KNOWLEDGE_IMPORT_MAX_DOCUMENTS = 100;
export const KNOWLEDGE_MAX_DEPTH = 16;
export const KNOWLEDGE_MAX_FOLDERS = 1000;
export type KnowledgeMode = 'read' | 'read_write';
export interface KnowledgeActor {
  projectId: string;
  sessionId: string;
  turnId: string;
}
export interface KnowledgeProjectSpace {
  projectId: string;
  rootFolderId: string;
  sourcesFolderId: string;
  wikiFolderId: string;
  generalFolderId: string;
}
export interface KnowledgeWikiJob {
  id: string;
  projectId: string;
  sessionId: string;
  kind: 'ingest' | 'check' | 'reconcile';
  status: 'pending' | 'running' | 'completed' | 'failed';
  sourceRevisions: { documentId: string; revisionId: string }[];
  model: string | null;
  createdAt: Date;
  error: string | null;
}
export interface KnowledgeFolder {
  role?: 'project' | 'general' | 'sources' | 'wiki';
  projectId?: string;
  archived?: boolean;
  id: string;
  parentId: string | null;
  name: string;
}
export interface KnowledgeGrant {
  fixed?: 'project' | 'general';
  folderId: string;
  mode: KnowledgeMode;
}
export interface KnowledgeDocumentSummary {
  stale?: boolean;
  id: string;
  folderId: string;
  title: string;
  currentRevisionId: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface KnowledgeDocument extends KnowledgeDocumentSummary {
  bodyMarkdown: string;
}
export interface KnowledgeRevision {
  id: string;
  documentId: string;
  title: string;
  bodyMarkdown: string;
  authorIdentity: string;
  projectId: string | null;
  sessionId: string | null;
  turnId: string | null;
  createdAt: Date;
}
export interface KnowledgeFile {
  path: string;
  bodyMarkdown: string;
  original?: Omit<import('./knowledge-sources.js').KnowledgeSourceInput, 'bytes'> & {
    base64: string;
    sha256: string;
  };
}
export interface KnowledgeDocumentInput {
  folderId: string;
  title: string;
  bodyMarkdown: string;
}
export interface KnowledgeDocumentEdit {
  expectedRevisionId: string;
  title: string;
  bodyMarkdown: string;
}
export class KnowledgeError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'conflict' | 'invalid',
    message = 'Knowledge operation unavailable',
  ) {
    super(message);
    this.name = 'KnowledgeError';
    this.statusCode = { not_found: 404, forbidden: 403, conflict: 409, invalid: 400 }[code];
  }
}
type Tx = Transaction<Database>;
function name(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 160 ||
    value.trim() !== value ||
    /[\\/]/u.test(value) ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    value === '.' ||
    value === '..'
  ) {
    throw new KnowledgeError(
      'invalid',
      'Names must be 1–160 characters without path separators or control characters',
    );
  }
}
function body(value: string): void {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > KNOWLEDGE_DOCUMENT_MAX_BYTES
  ) {
    throw new KnowledgeError(
      'invalid',
      'Markdown exceeds the 256 KiB document limit or contains NUL',
    );
  }
}

/** Every policy check and mutation shares one database lock, including across server processes. */
export class KnowledgeStore {
  readonly sources: KnowledgeSourceStore;
  constructor(private readonly db: Kysely<Database>) {
    this.sources = new KnowledgeSourceStore(db);
  }
  async getProjectSpace(projectId: string): Promise<KnowledgeProjectSpace | null> {
    return this.transaction(async (tx) => {
      const space = await tx
        .selectFrom('project_knowledge_spaces')
        .selectAll()
        .where('project_id', '=', projectId)
        .executeTakeFirst();
      const general = await tx
        .selectFrom('knowledge_folders')
        .select('id')
        .where('role', '=', 'general')
        .executeTakeFirst();
      return space && general
        ? {
            projectId,
            rootFolderId: space.root_folder_id,
            sourcesFolderId: space.sources_folder_id,
            wikiFolderId: space.wiki_folder_id,
            generalFolderId: general.id,
          }
        : null;
    });
  }
  async getProjectOverview(projectId: string): Promise<{
    documentId: string;
    revisionId: string;
    title: string;
    bodyMarkdown: string;
  } | null> {
    return this.transaction(async (tx) => {
      const space = await tx
        .selectFrom('project_knowledge_spaces')
        .selectAll()
        .where('project_id', '=', projectId)
        .executeTakeFirst();
      if (!space?.overview_document_id || !space.overview_revision_id) return null;
      const doc = await this.document(tx, space.overview_document_id, space.overview_revision_id);
      if (!(await this.access(tx, projectId)).has(doc.folderId)) return null;
      return {
        documentId: doc.id,
        revisionId: doc.currentRevisionId,
        title: doc.title,
        bodyMarkdown: doc.bodyMarkdown,
      };
    });
  }
  async approveProjectOverview(
    projectId: string,
    documentId: string,
    expectedRevisionId: string,
  ): Promise<void> {
    await this.transaction(async (tx) => {
      const space = await tx
        .selectFrom('project_knowledge_spaces')
        .selectAll()
        .where('project_id', '=', projectId)
        .executeTakeFirst();
      if (!space) throw new KnowledgeError('not_found');
      const doc = await this.document(tx, documentId);
      if (
        !this.effective(await this.folders(tx), [
          { folderId: space.wiki_folder_id, mode: 'read' },
        ]).has(doc.folderId)
      )
        throw new KnowledgeError('forbidden', 'Choose an overview from this project’s Wiki');
      if (doc.currentRevisionId !== expectedRevisionId) throw new KnowledgeError('conflict');
      if (doc.bodyMarkdown.length > 8000)
        throw new KnowledgeError('invalid', 'Project overview must fit within 8000 characters');
      const settings = await tx
        .selectFrom('project_settings')
        .select('memory')
        .where('project_id', '=', projectId)
        .executeTakeFirst();
      await tx
        .updateTable('project_knowledge_spaces')
        .set({
          overview_document_id: documentId,
          overview_revision_id: expectedRevisionId,
          ...(!space.overview_revision_id
            ? { legacy_memory: settings?.memory ?? space.legacy_memory }
            : {}),
        })
        .where('project_id', '=', projectId)
        .execute();
    });
  }
  async clearProjectOverview(projectId: string): Promise<void> {
    await this.transaction(async (tx) => {
      // Legacy memory remains in project_settings: clearing the pin explicitly restores its use.
      await tx
        .updateTable('project_knowledge_spaces')
        .set({ overview_document_id: null, overview_revision_id: null })
        .where('project_id', '=', projectId)
        .execute();
    });
  }
  private wikiJob(row: {
    id: string;
    project_id: string;
    session_id: string;
    kind: 'ingest' | 'check' | 'reconcile';
    status: KnowledgeWikiJob['status'];
    source_revisions: string;
    model: string | null;
    created_at: Date;
    error: string | null;
  }): KnowledgeWikiJob {
    return {
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      kind: row.kind,
      status: row.status,
      sourceRevisions: JSON.parse(row.source_revisions) as KnowledgeWikiJob['sourceRevisions'],
      model: row.model,
      createdAt: row.created_at,
      error: row.error,
    };
  }
  async getWikiJob(id: string): Promise<KnowledgeWikiJob | null> {
    const row = await this.db
      .selectFrom('knowledge_wiki_jobs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.wikiJob(row) : null;
  }
  async getWikiJobForSession(sessionId: string): Promise<KnowledgeWikiJob | null> {
    const row = await this.db
      .selectFrom('knowledge_wiki_jobs')
      .selectAll()
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return row ? this.wikiJob(row) : null;
  }
  async listWikiJobs(projectId?: string): Promise<KnowledgeWikiJob[]> {
    let query = this.db.selectFrom('knowledge_wiki_jobs').selectAll();
    if (projectId) query = query.where('project_id', '=', projectId);
    return (await query.orderBy('created_at', 'desc').execute()).map((row) => this.wikiJob(row));
  }
  async recoverWikiJobs(): Promise<number> {
    return this.transaction(async (tx) => {
      const rows = await tx
        .updateTable('knowledge_wiki_jobs')
        .set({
          status: 'failed',
          error: 'Server restarted before this Wiki job finished; start a new job.',
        })
        .where('status', 'in', ['pending', 'running'])
        .returning('id')
        .execute();
      return rows.length;
    });
  }
  async updateWikiJob(
    id: string,
    input: { status: KnowledgeWikiJob['status']; error?: string | null },
  ): Promise<void> {
    await this.transaction(async (tx) => {
      const job = await tx
        .selectFrom('knowledge_wiki_jobs')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!job) throw new KnowledgeError('not_found');
      if ((job.status === 'completed' || job.status === 'failed') && input.status !== job.status)
        throw new KnowledgeError('conflict', 'Wiki job is already finished');
      await tx
        .updateTable('knowledge_wiki_jobs')
        .set({ status: input.status, error: input.error ?? null })
        .where('id', '=', id)
        .execute();
    });
  }
  async createWikiJob(input: {
    projectId: string;
    sessionId: string;
    sourceDocumentIds: string[];
    kind: 'ingest' | 'check' | 'reconcile';
    model?: string;
  }): Promise<KnowledgeWikiJob> {
    return this.transaction(async (tx) => {
      const space = await tx
        .selectFrom('project_knowledge_spaces')
        .selectAll()
        .where('project_id', '=', input.projectId)
        .executeTakeFirst();
      const session = await tx
        .selectFrom('sessions')
        .select('project_id')
        .where('session_id', '=', input.sessionId)
        .executeTakeFirst();
      if (!space || session?.project_id !== input.projectId) throw new KnowledgeError('forbidden');
      if (
        await tx
          .selectFrom('knowledge_access_events')
          .select('id')
          .where('session_id', '=', input.sessionId)
          .executeTakeFirst()
      )
        throw new KnowledgeError('forbidden', 'Wiki jobs require a fresh session');
      const used = await sql<{
        used: boolean;
      }>`select exists(select 1 from events where session_id=${input.sessionId})
        or exists(select 1 from transcript_lines where session_id=${input.sessionId})
        or exists(select 1 from session_backend_state where session_id=${input.sessionId}) as used`.execute(
        tx,
      );
      if (used.rows[0]?.used)
        throw new KnowledgeError(
          'forbidden',
          'Wiki jobs require a fresh session without prior context',
        );
      const sourceAccess = this.effective(await this.folders(tx), [
        { folderId: space.sources_folder_id, mode: 'read' },
      ]);
      const selectedIds = [...new Set(input.sourceDocumentIds)];
      if (selectedIds.length > 100 || (input.kind === 'ingest' && !selectedIds.length))
        throw new KnowledgeError('invalid');
      const wikiFolders = [
        ...this.effective(await this.folders(tx), [
          { folderId: space.wiki_folder_id, mode: 'read' },
        ]).keys(),
      ];
      const lineage = await tx
        .selectFrom('knowledge_documents as d')
        .innerJoin('knowledge_document_revisions as r', 'r.document_id', 'd.id')
        .innerJoin('knowledge_provenance as p', 'p.revision_id', 'r.id')
        .select('p.source_revisions')
        .where('d.folder_id', 'in', wikiFolders)
        .execute();
      // Existing Wiki content is readable only when all of its transitive
      // dependencies still belong to this project's Sources. Existing originals
      // advance to their current revision; moved/deleted dependencies make that
      // page unavailable to ingest jobs without blocking unrelated work.
      const inherited = new Map<string, { documentId: string; revisionId: string }>();
      for (const record of lineage)
        for (const source of JSON.parse(
          record.source_revisions,
        ) as KnowledgeWikiJob['sourceRevisions']) {
          try {
            const doc = await this.document(tx, source.documentId);
            if (!sourceAccess.has(doc.folderId)) continue;
            inherited.set(source.documentId, {
              documentId: source.documentId,
              revisionId: doc.currentRevisionId,
            });
          } catch (error) {
            if (!(error instanceof KnowledgeError) || error.code !== 'not_found') throw error;
            // A deleted dependency makes its derived page stale. Ingest jobs
            // cannot read that page (enforced below), so it must not become a
            // provenance dependency that has no enforceable source audience.
          }
        }
      const selected = new Map<string, { documentId: string; revisionId: string }>();
      for (const id of selectedIds) {
        let doc: KnowledgeDocument;
        try {
          doc = await this.document(tx, id);
        } catch (error) {
          if (
            (input.kind === 'check' || input.kind === 'reconcile') &&
            error instanceof KnowledgeError &&
            error.code === 'not_found'
          )
            continue;
          throw error;
        }
        if (!sourceAccess.has(doc.folderId))
          throw new KnowledgeError('forbidden', 'Wiki jobs may only process their own Sources');
        selected.set(id, { documentId: id, revisionId: doc.currentRevisionId });
      }
      const sourceRevisions = [...inherited.values(), ...selected.values()].filter(
        (source, index, all) =>
          all.findLastIndex((candidate) => candidate.documentId === source.documentId) === index,
      );
      const row = await tx
        .insertInto('knowledge_wiki_jobs')
        .values({
          id: randomUUID(),
          project_id: input.projectId,
          session_id: input.sessionId,
          kind: input.kind,
          status: 'pending',
          source_revisions: JSON.stringify(sourceRevisions),
          model: input.model ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.wikiJob(row);
    });
  }
  async createSourceDocument(
    input: KnowledgeDocumentInput,
    attach: (tx: Tx, document: KnowledgeDocument) => Promise<void>,
    maintenanceProjectId?: string,
  ): Promise<KnowledgeDocument> {
    return this.transaction(async (tx) => {
      const doc = await this.create(tx, input);
      await attach(tx, doc);
      if (maintenanceProjectId)
        await this.queueWikiMaintenanceTx(tx, maintenanceProjectId, [doc.id], new Date(), false);
      return doc;
    });
  }
  async ensureFolder(parentId: string, folderName: string): Promise<KnowledgeFolder> {
    name(folderName);
    return this.transaction(async (tx) => {
      const existing = await tx
        .selectFrom('knowledge_folders')
        .selectAll()
        .where('parent_id', '=', parentId)
        .where('name', '=', folderName)
        .executeTakeFirst();
      if (existing)
        return {
          id: existing.id,
          parentId: existing.parent_id,
          name: existing.name,
          ...(existing.role ? { role: existing.role } : {}),
          ...(existing.project_id ? { projectId: existing.project_id } : {}),
        };
      const parent = await tx
        .selectFrom('knowledge_folders')
        .select(['id', 'project_id'])
        .where('id', '=', parentId)
        .executeTakeFirst();
      if (!parent) throw new KnowledgeError('not_found');
      const row = await tx
        .insertInto('knowledge_folders')
        .values({
          id: randomUUID(),
          parent_id: parentId,
          name: folderName,
          project_id: parent.project_id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { id: row.id, parentId: row.parent_id, name: row.name };
    });
  }
  async createChatSources(
    folderId: string,
    inputs: {
      title: string;
      bodyMarkdown: string;
      source?: KnowledgeSourceInput;
      sha256?: string;
    }[],
    maintenanceProjectId?: string,
  ): Promise<KnowledgeDocument[]> {
    return this.transaction(async (tx) => {
      const documents: KnowledgeDocument[] = [];
      for (const input of inputs) {
        if (input.sha256) {
          const existing = await tx
            .selectFrom('knowledge_documents as d')
            .innerJoin('knowledge_source_revisions as s', 's.revision_id', 'd.current_revision_id')
            .select('d.id')
            .where('d.folder_id', '=', folderId)
            .where('s.sha256', '=', input.sha256)
            .executeTakeFirst();
          if (existing) {
            documents.push(await this.document(tx, existing.id));
            continue;
          }
        }
        const document = await this.create(tx, {
          folderId,
          title: input.title,
          bodyMarkdown: input.bodyMarkdown,
        });
        if (input.source)
          await this.sources.attachRevision(tx, document.currentRevisionId, input.source);
        documents.push(document);
      }
      if (maintenanceProjectId)
        await this.queueWikiMaintenanceTx(
          tx,
          maintenanceProjectId,
          documents.map((document) => document.id),
          new Date(),
          false,
        );
      return documents;
    });
  }
  async queueWikiMaintenance(
    projectId: string,
    sourceDocumentIds: string[],
    dueAt: Date,
    debounceExisting = true,
  ): Promise<void> {
    await this.transaction((tx) =>
      this.queueWikiMaintenanceTx(tx, projectId, sourceDocumentIds, dueAt, debounceExisting),
    );
  }
  private async queueWikiMaintenanceTx(
    tx: Tx,
    projectId: string,
    sourceDocumentIds: string[],
    dueAt: Date,
    debounceExisting: boolean,
  ): Promise<void> {
    if (debounceExisting)
      await tx
        .updateTable('knowledge_maintenance_queue')
        .set({ due_at: dueAt })
        .where('project_id', '=', projectId)
        .execute();
    if (sourceDocumentIds.length)
      await tx
        .insertInto('knowledge_maintenance_queue')
        .values(
          [...new Set(sourceDocumentIds)].map((sourceDocumentId) => ({
            project_id: projectId,
            source_document_id: sourceDocumentId,
            due_at: dueAt,
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(['project_id', 'source_document_id']).doUpdateSet({ due_at: dueAt }),
        )
        .execute();
  }
  private async sourceProject(tx: Tx, folderId: string): Promise<string | undefined> {
    const project = await sql<{ project_id: string }>`with recursive ancestors as (
      select id,parent_id from knowledge_folders where id=${folderId}
      union all
      select f.id,f.parent_id from knowledge_folders f join ancestors a on a.parent_id=f.id
    ) select s.project_id from project_knowledge_spaces s join ancestors a on a.id=s.sources_folder_id limit 1`.execute(
      tx,
    );
    return project.rows[0]?.project_id;
  }
  private async queueSourceMaintenance(tx: Tx, document: KnowledgeDocument): Promise<void> {
    const projectId = await this.sourceProject(tx, document.folderId);
    if (projectId)
      await this.queueWikiMaintenanceTx(tx, projectId, [document.id], new Date(), false);
  }
  async listWikiMaintenance(
    projectId?: string,
  ): Promise<{ projectId: string; sourceDocumentId: string; dueAt: Date }[]> {
    let query = this.db.selectFrom('knowledge_maintenance_queue').selectAll();
    if (projectId) query = query.where('project_id', '=', projectId);
    return (await query.orderBy('due_at').execute()).map((row) => ({
      projectId: row.project_id,
      sourceDocumentId: row.source_document_id,
      dueAt: row.due_at,
    }));
  }
  async clearWikiMaintenance(
    records: { projectId: string; sourceDocumentId: string; dueAt: Date }[],
  ): Promise<void> {
    if (!records.length) return;
    await this.transaction(async (tx) => {
      for (const record of records)
        await tx
          .deleteFrom('knowledge_maintenance_queue')
          .where('project_id', '=', record.projectId)
          .where('source_document_id', '=', record.sourceDocumentId)
          .where('due_at', '=', record.dueAt)
          .execute();
    });
  }
  async queueWikiReconciliation(projectId: string, dueAt: Date): Promise<void> {
    await this.db
      .updateTable('project_knowledge_spaces')
      .set({ reconcile_due_at: dueAt })
      .where('project_id', '=', projectId)
      .execute();
  }
  async listWikiReconciliations(): Promise<{ projectId: string; dueAt: Date }[]> {
    return (
      await this.db
        .selectFrom('project_knowledge_spaces')
        .select(['project_id', 'reconcile_due_at'])
        .where('reconcile_due_at', 'is not', null)
        .execute()
    ).map((row) => ({ projectId: row.project_id, dueAt: row.reconcile_due_at! }));
  }
  async clearWikiReconciliation(projectId: string, dueAt: Date): Promise<void> {
    await this.db
      .updateTable('project_knowledge_spaces')
      .set({ reconcile_due_at: null })
      .where('project_id', '=', projectId)
      .where('reconcile_due_at', '=', dueAt)
      .execute();
  }
  async projectForSourceFolder(folderId: string): Promise<string | null> {
    const result = await sql<{ project_id: string }>`with recursive ancestors as (
      select id,parent_id from knowledge_folders where id=${folderId}
      union all
      select f.id,f.parent_id from knowledge_folders f join ancestors a on a.parent_id=f.id
    ) select s.project_id from project_knowledge_spaces s join ancestors a on a.id=s.sources_folder_id limit 1`.execute(
      this.db,
    );
    return result.rows[0]?.project_id ?? null;
  }
  async updateSourceDocument(
    id: string,
    input: KnowledgeDocumentEdit,
    attach: (tx: Tx, document: KnowledgeDocument) => Promise<void>,
    maintenanceProjectId?: string,
  ): Promise<KnowledgeDocument> {
    return this.transaction(async (tx) => {
      const doc = await this.edit(tx, id, input);
      await attach(tx, doc);
      if (maintenanceProjectId)
        await this.queueWikiMaintenanceTx(tx, maintenanceProjectId, [doc.id], new Date(), false);
      return doc;
    });
  }
  private async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
      return fn(tx);
    });
  }
  private async folders(tx: Tx): Promise<KnowledgeFolder[]> {
    return (
      await tx.selectFrom('knowledge_folders').selectAll().orderBy('name').orderBy('id').execute()
    ).map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      name: r.name,
      ...(r.role ? { role: r.role } : {}),
      ...(r.project_id ? { projectId: r.project_id } : {}),
      ...(r.archived ? { archived: true } : {}),
    }));
  }
  private effective(
    folders: KnowledgeFolder[],
    grants: KnowledgeGrant[],
  ): Map<string, KnowledgeMode> {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const direct = new Map(grants.map((g) => [g.folderId, g.mode]));
    const result = new Map<string, KnowledgeMode>();
    for (const folder of folders) {
      let cursor: KnowledgeFolder | undefined = folder;
      for (let depth = 0; cursor !== undefined && depth <= KNOWLEDGE_MAX_DEPTH; depth++) {
        const mode = direct.get(cursor.id);
        if (mode === 'read_write' || (mode === 'read' && !result.has(folder.id)))
          result.set(folder.id, mode);
        cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
      }
    }
    // Sources are immutable to agents, even when a parent or descendant has a write grant.
    for (const folder of folders) {
      let cursor: KnowledgeFolder | undefined = folder;
      while (cursor) {
        if ((cursor.role === 'sources' || cursor.role === 'general') && result.has(folder.id))
          result.set(folder.id, 'read');
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
    }
    return result;
  }
  private async grants(tx: Tx, projectId: string): Promise<KnowledgeGrant[]> {
    const explicit = (
      await tx
        .selectFrom('project_knowledge_grants')
        .select(['folder_id', 'mode'])
        .where('project_id', '=', projectId)
        .execute()
    ).map((r) => ({ folderId: r.folder_id, mode: r.mode }));
    const space = await tx
      .selectFrom('project_knowledge_spaces')
      .selectAll()
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    const general = await tx
      .selectFrom('knowledge_folders')
      .select('id')
      .where('role', '=', 'general')
      .executeTakeFirst();
    const fixed: KnowledgeGrant[] = [];
    if (space)
      fixed.push(
        { folderId: space.root_folder_id, mode: 'read', fixed: 'project' },
        { folderId: space.sources_folder_id, mode: 'read', fixed: 'project' },
        { folderId: space.wiki_folder_id, mode: 'read_write', fixed: 'project' },
      );
    if (general) fixed.push({ folderId: general.id, mode: 'read', fixed: 'general' });
    return [...explicit.filter((g) => !fixed.some((f) => f.folderId === g.folderId)), ...fixed];
  }
  private async access(tx: Tx, projectId: string): Promise<Map<string, KnowledgeMode>> {
    return this.effective(await this.folders(tx), await this.grants(tx, projectId));
  }
  private async policyState(tx: Tx) {
    const projects = await tx.selectFrom('projects').select('id').orderBy('id').execute();
    const grants = [];
    for (const p of projects)
      for (const g of await this.grants(tx, p.id))
        grants.push({ project_id: p.id, folder_id: g.folderId, mode: g.mode });
    return {
      folders: await this.folders(tx),
      documents: await tx
        .selectFrom('knowledge_documents')
        .select(['id', 'folder_id'])
        .orderBy('id')
        .execute(),
      grants,
    };
  }
  private async policyToken(tx: Tx): Promise<string> {
    return createHash('sha256')
      .update(JSON.stringify(await this.policyState(tx)))
      .digest('hex');
  }
  private async previewMove(
    tx: Tx,
    id: string,
    parentId: string | null,
    kind: 'folder' | 'document',
  ) {
    const before = await this.policyState(tx);
    const folders = before.folders.map((f) => ({ ...f }));
    const documents = before.documents.map((d) => ({ ...d }));
    if (kind === 'folder') {
      const folder = folders.find((f) => f.id === id);
      if (!folder) throw new KnowledgeError('not_found');
      folder.parentId = parentId;
      this.validateTree(folders);
    } else {
      const doc = documents.find((d) => d.id === id);
      if (!doc || !folders.some((f) => f.id === parentId)) throw new KnowledgeError('not_found');
      doc.folder_id = parentId!;
    }
    const affectedProjects = [];
    for (const projectId of new Set(before.grants.map((g) => g.project_id))) {
      const grants = before.grants
        .filter((g) => g.project_id === projectId)
        .map((g) => ({ folderId: g.folder_id, mode: g.mode }));
      const accessBefore = this.effective(before.folders, grants);
      const accessAfter = this.effective(folders, grants);
      const entries = (
        access: Map<string, KnowledgeMode>,
        docs: typeof documents,
        write: boolean,
      ) =>
        new Set([
          ...[...access]
            .filter(([, mode]) => !write || mode === 'read_write')
            .map(([folderId]) => 'folder:' + folderId),
          ...docs
            .filter((d) =>
              write ? access.get(d.folder_id) === 'read_write' : access.has(d.folder_id),
            )
            .map((d) => 'document:' + d.id),
        ]);
      const oldRead = entries(accessBefore, before.documents, false),
        newRead = entries(accessAfter, documents, false);
      const oldWrite = entries(accessBefore, before.documents, true),
        newWrite = entries(accessAfter, documents, true);
      const diff = (a: Set<string>, b: Set<string>) =>
        [...a].filter((entry) => !b.has(entry)).length;
      const change = {
        projectId,
        lostRead: diff(oldRead, newRead),
        gainedRead: diff(newRead, oldRead),
        lostWrite: diff(oldWrite, newWrite),
        gainedWrite: diff(newWrite, oldWrite),
      };
      if (change.lostRead || change.gainedRead || change.lostWrite || change.gainedWrite)
        affectedProjects.push(change);
    }
    return { policyToken: await this.policyToken(tx), affectedProjects };
  }
  async previewFolderMove(id: string, parentId: string | null) {
    return this.transaction((tx) => this.previewMove(tx, id, parentId, 'folder'));
  }
  async previewDocumentMove(id: string, folderId: string) {
    return this.transaction((tx) => this.previewMove(tx, id, folderId, 'document'));
  }
  private async readableSnapshot(tx: Tx): Promise<Map<string, Set<string>>> {
    const state = await this.policyState(tx);
    const result = new Map<string, Set<string>>();
    for (const projectId of new Set(state.grants.map((g) => g.project_id))) {
      const access = this.effective(
        state.folders,
        state.grants
          .filter((g) => g.project_id === projectId)
          .map((g) => ({ folderId: g.folder_id, mode: g.mode })),
      );
      result.set(
        projectId,
        new Set(
          [...access.keys()]
            .map((id) => 'folder:' + id)
            .concat(
              state.documents.filter((d) => access.has(d.folder_id)).map((d) => 'document:' + d.id),
            ),
        ),
      );
    }
    return result;
  }
  private async policyMutation<T>(
    fn: (tx: Tx) => Promise<T>,
    expectedPolicyToken?: string,
  ): Promise<T> {
    return this.transaction(async (tx) => {
      if (expectedPolicyToken !== undefined && expectedPolicyToken !== (await this.policyToken(tx)))
        throw new KnowledgeError('conflict', 'Knowledge access changed; preview the move again');
      const before = await this.readableSnapshot(tx);
      const result = await fn(tx);
      const after = await this.readableSnapshot(tx);
      for (const [projectId, ids] of before) {
        if (![...ids].some((id) => !after.get(projectId)?.has(id))) continue;
        await tx
          .updateTable('agent_loops')
          .set({ session_id: null })
          .where('project_id', '=', projectId)
          .execute();
        const sessions = await tx
          .selectFrom('sessions')
          .select('session_id')
          .where('project_id', '=', projectId)
          .execute();
        for (const session of sessions) {
          await tx
            .insertInto('knowledge_invalidated_sessions')
            .values({ session_id: session.session_id })
            .onConflict((c) => c.column('session_id').doNothing())
            .execute();
        }
      }
      return result;
    });
  }
  async isSessionInvalidated(sessionId: string): Promise<boolean> {
    return !!(await this.db
      .selectFrom('knowledge_invalidated_sessions')
      .select('session_id')
      .where('session_id', '=', sessionId)
      .executeTakeFirst());
  }
  async listInvalidatedSessions(): Promise<string[]> {
    return (
      await this.db.selectFrom('knowledge_invalidated_sessions').select('session_id').execute()
    ).map((r) => r.session_id);
  }
  async listPendingInvalidatedSessions(): Promise<string[]> {
    return (
      await this.db
        .selectFrom('knowledge_invalidated_sessions')
        .select('session_id')
        .where('stopped_at', 'is', null)
        .execute()
    ).map((r) => r.session_id);
  }
  async markInvalidatedSessionStopped(sessionId: string): Promise<void> {
    await this.db
      .updateTable('knowledge_invalidated_sessions')
      .set({ stopped_at: new Date() })
      .where('session_id', '=', sessionId)
      .execute();
  }
  async hasProjectKnowledge(projectId: string): Promise<boolean> {
    return !!(await this.db
      .selectFrom('project_knowledge_spaces')
      .select('project_id')
      .where('project_id', '=', projectId)
      .executeTakeFirst());
  }
  async hasSessionKnowledgeExposure(sessionId: string): Promise<boolean> {
    return !!(await this.db
      .selectFrom('knowledge_access_events')
      .select('id')
      .where('session_id', '=', sessionId)
      .where('outcome', '=', 'allow')
      .executeTakeFirst());
  }
  async listFolders(): Promise<KnowledgeFolder[]> {
    return this.transaction(async (tx) => {
      const [folders, visibleProjects] = await Promise.all([
        this.folders(tx),
        tx
          .selectFrom('projects')
          .select('id')
          .where('hidden_at', 'is', null)
          .where('overview_visible', '=', true)
          .execute(),
      ]);
      const visibleProjectIds = new Set(visibleProjects.map((project) => project.id));
      // Older servers created spaces for GitHub installation placeholders.
      // Keep those rows intact in case a repository is later adopted, while
      // excluding their whole managed tree from the user-facing library.
      return folders.filter(
        (folder) => folder.projectId === undefined || visibleProjectIds.has(folder.projectId),
      );
    });
  }
  private validateTree(folders: KnowledgeFolder[]): void {
    if (folders.length > KNOWLEDGE_MAX_FOLDERS)
      throw new KnowledgeError('invalid', 'Knowledge folder limit reached');
    const byId = new Map(folders.map((f) => [f.id, f]));
    const siblings = new Set<string>();
    for (const folder of folders) {
      name(folder.name);
      const key = JSON.stringify([folder.parentId, folder.name]);
      if (siblings.has(key)) throw new KnowledgeError('conflict', 'A sibling folder has this name');
      siblings.add(key);
      let cursor: KnowledgeFolder | undefined = folder;
      let depth = 0;
      while (cursor) {
        if (++depth > KNOWLEDGE_MAX_DEPTH)
          throw new KnowledgeError('invalid', 'Folder cycle or depth limit exceeded');
        if (cursor.parentId !== null && !byId.has(cursor.parentId))
          throw new KnowledgeError('not_found');
        cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
      }
    }
  }
  private async insertFolder(
    tx: Tx,
    input: { parentId?: string | null; name: string },
  ): Promise<KnowledgeFolder> {
    const folder = { id: randomUUID(), parentId: input.parentId ?? null, name: input.name };
    this.validateTree([...(await this.folders(tx)), folder]);
    if (
      folder.parentId !== null &&
      (await tx
        .selectFrom('knowledge_documents')
        .select('id')
        .where('folder_id', '=', folder.parentId)
        .where('title', '=', folder.name)
        .executeTakeFirst())
    )
      throw new KnowledgeError('conflict', 'A document has this name');
    await tx
      .insertInto('knowledge_folders')
      .values({ id: folder.id, parent_id: folder.parentId, name: folder.name })
      .execute();
    return folder;
  }
  async createFolder(input: { parentId?: string | null; name: string }): Promise<KnowledgeFolder> {
    return this.transaction((tx) => this.insertFolder(tx, input));
  }
  /** Moving an original cannot leave its derived pages readable by a wider audience. */
  private async assertMovedSourceAudiences(tx: Tx, sourceIds: string[]): Promise<void> {
    if (!sourceIds.length) return;
    const moved = new Set(sourceIds);
    const rows = await tx
      .selectFrom('knowledge_documents as d')
      .innerJoin('knowledge_document_revisions as r', 'r.document_id', 'd.id')
      .innerJoin('knowledge_provenance as p', 'p.revision_id', 'r.id')
      .select(['d.folder_id', 'p.source_revisions'])
      .execute();
    const dependencies = rows
      .map((row) => ({
        folderId: row.folder_id,
        sourceIds: (JSON.parse(row.source_revisions) as KnowledgeWikiJob['sourceRevisions'])
          .filter((source) => moved.has(source.documentId))
          .map((source) => source.documentId),
      }))
      .filter((row) => row.sourceIds.length > 0);
    if (!dependencies.length) return;
    const sources = await tx
      .selectFrom('knowledge_documents')
      .select(['id', 'folder_id'])
      .where('id', 'in', sourceIds)
      .execute();
    const sourceFolders = new Map(sources.map((source) => [source.id, source.folder_id]));
    const projects = await tx.selectFrom('projects').select('id').execute();
    for (const project of projects) {
      const audience = await this.access(tx, project.id);
      for (const dependency of dependencies) {
        if (
          audience.has(dependency.folderId) &&
          dependency.sourceIds.some((id) => {
            const folderId = sourceFolders.get(id);
            return folderId !== undefined && !audience.has(folderId);
          })
        )
          throw new KnowledgeError(
            'forbidden',
            'Moving this source would leave a shared Wiki readable without access to its original; change sharing first',
          );
      }
    }
  }
  async updateFolder(
    id: string,
    input: { parentId?: string | null; name?: string; expectedPolicyToken?: string },
  ): Promise<KnowledgeFolder> {
    return this.policyMutation(async (tx) => {
      const folders = await this.folders(tx);
      const old = folders.find((f) => f.id === id);
      if (!old) throw new KnowledgeError('not_found');
      if (old.role && (input.parentId !== undefined || input.name !== undefined))
        throw new KnowledgeError('forbidden', 'Managed folders cannot be renamed or moved');
      if (input.parentId !== undefined && input.parentId !== old.parentId) {
        const affected = this.effective(folders, [{ folderId: id, mode: 'read' }]);
        const wiki = this.effective(
          folders,
          folders.filter((f) => f.role === 'wiki').map((f) => ({ folderId: f.id, mode: 'read' })),
        );
        if (
          wiki.has(id) ||
          (input.parentId && wiki.has(input.parentId)) ||
          [...affected.keys()].some((fid) => folders.find((f) => f.id === fid)?.role)
        )
          throw new KnowledgeError(
            'forbidden',
            'Wiki folder moves cannot cross knowledge boundaries',
          );
      }
      const next = {
        ...old,
        name: input.name ?? old.name,
        parentId: input.parentId === undefined ? old.parentId : input.parentId,
      };
      this.validateTree(folders.map((f) => (f.id === id ? next : f)));
      if (
        next.parentId !== null &&
        (await tx
          .selectFrom('knowledge_documents')
          .select('id')
          .where('folder_id', '=', next.parentId)
          .where('title', '=', next.name)
          .executeTakeFirst())
      )
        throw new KnowledgeError('conflict', 'A document has this name');
      await tx
        .updateTable('knowledge_folders')
        .set({ parent_id: next.parentId, name: next.name, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      if (next.parentId !== old.parentId) {
        const subtree = [...this.effective(folders, [{ folderId: id, mode: 'read' }]).keys()];
        const sources = await tx
          .selectFrom('knowledge_documents')
          .select('id')
          .where('folder_id', 'in', subtree)
          .execute();
        await this.assertMovedSourceAudiences(
          tx,
          sources.map((source) => source.id),
        );
      }
      return next;
    }, input.expectedPolicyToken);
  }
  async deleteFolder(id: string): Promise<void> {
    await this.policyMutation(async (tx) => {
      const subtree = [
        ...this.effective(await this.folders(tx), [{ folderId: id, mode: 'read' }]).keys(),
      ];
      if (
        subtree.length &&
        (await tx
          .selectFrom('project_knowledge_spaces as s')
          .innerJoin('knowledge_documents as d', 'd.id', 's.overview_document_id')
          .select('s.project_id')
          .where('d.folder_id', 'in', subtree)
          .executeTakeFirst())
      )
        throw new KnowledgeError(
          'conflict',
          'Clear the approved project overview before deleting its folder',
        );
      if ((await this.folders(tx)).find((f) => f.id === id)?.role)
        throw new KnowledgeError('forbidden', 'Managed folders cannot be deleted');
      const row = await tx
        .deleteFrom('knowledge_folders')
        .where('id', '=', id)
        .returning('id')
        .executeTakeFirst();
      if (!row) throw new KnowledgeError('not_found');
    });
  }
  async getGrants(projectId: string): Promise<KnowledgeGrant[]> {
    return this.transaction((tx) => this.grants(tx, projectId));
  }
  async setGrants(projectId: string, grants: KnowledgeGrant[]): Promise<KnowledgeGrant[]> {
    return this.policyMutation(async (tx) => {
      if (
        !(await tx
          .selectFrom('projects')
          .select('id')
          .where('id', '=', projectId)
          .executeTakeFirst())
      )
        throw new KnowledgeError('not_found');
      const folders = await this.folders(tx);
      const folderById = new Map(folders.map((folder) => [folder.id, folder]));
      const folderIds = new Set(folderById.keys());
      if (
        grants.length > KNOWLEDGE_MAX_FOLDERS ||
        new Set(grants.map((g) => g.folderId)).size !== grants.length
      )
        throw new KnowledgeError('invalid');
      for (const g of grants)
        if (!folderIds.has(g.folderId) || (g.mode !== 'read' && g.mode !== 'read_write'))
          throw new KnowledgeError('invalid');
      for (const grant of grants) {
        if (grant.mode !== 'read_write') continue;
        let folder = folderById.get(grant.folderId);
        while (folder) {
          if (folder.role === 'sources' || folder.role === 'general')
            throw new KnowledgeError(
              'forbidden',
              'Sources and General are read-only for project agents',
            );
          folder = folder.parentId ? folderById.get(folder.parentId) : undefined;
        }
      }
      const fixed = (await this.grants(tx, projectId)).filter((g) => g.fixed);
      grants = grants.filter((g) => !fixed.some((f) => f.folderId === g.folderId));
      const current = this.effective(await this.folders(tx), await this.grants(tx, projectId));
      const next = this.effective(await this.folders(tx), [...grants, ...fixed]);
      // Revalidate provenance only where this mutation expands the audience. A
      // deleted source keeps its derived page stale, but must not prevent a
      // project from retaining or revoking access it already had.
      const added = [...next.keys()].filter((folderId) => !current.has(folderId));
      const removed = [...current.keys()].filter((folderId) => !next.has(folderId));
      const provenanceFolders = removed.length ? [...next.keys()] : added;
      if (provenanceFolders.length) {
        const derived = await tx
          .selectFrom('knowledge_documents as d')
          .innerJoin('knowledge_document_revisions as r', 'r.document_id', 'd.id')
          .innerJoin('knowledge_provenance as p', 'p.revision_id', 'r.id')
          .select(['d.folder_id', 'p.source_revisions'])
          .where('d.folder_id', 'in', provenanceFolders)
          .execute();
        for (const d of derived)
          for (const source of JSON.parse(
            d.source_revisions,
          ) as KnowledgeWikiJob['sourceRevisions']) {
            const original = await tx
              .selectFrom('knowledge_documents')
              .select('folder_id')
              .where('id', '=', source.documentId)
              .executeTakeFirst();
            const derivedWasReadable = current.has(d.folder_id);
            if (
              (!original && !derivedWasReadable) ||
              (original &&
                !next.has(original.folder_id) &&
                (!derivedWasReadable || current.has(original.folder_id)))
            )
              throw new KnowledgeError(
                'forbidden',
                'Sharing a Wiki also requires access to every original source',
              );
          }
      }
      await tx.deleteFrom('project_knowledge_grants').where('project_id', '=', projectId).execute();
      if (grants.length)
        await tx
          .insertInto('project_knowledge_grants')
          .values(
            grants.map((g) => ({ project_id: projectId, folder_id: g.folderId, mode: g.mode })),
          )
          .execute();
      return this.grants(tx, projectId);
    });
  }
  /** Compare captured input revisions, including deleted sources, without exposing their identities. */
  private async staleRevisions(tx: Tx, revisionIds: string[]): Promise<Set<string>> {
    if (!revisionIds.length) return new Set();
    const provenance = await tx
      .selectFrom('knowledge_provenance')
      .select(['revision_id', 'source_revisions'])
      .where('revision_id', 'in', revisionIds)
      .execute();
    const captured = provenance.map((row) => ({
      revisionId: row.revision_id,
      sources: JSON.parse(row.source_revisions) as KnowledgeWikiJob['sourceRevisions'],
    }));
    const ids = [
      ...new Set(captured.flatMap((row) => row.sources.map((source) => source.documentId))),
    ];
    if (!ids.length) return new Set();
    const current = await tx
      .selectFrom('knowledge_documents')
      .select(['id', 'current_revision_id'])
      .where('id', 'in', ids)
      .execute();
    const revisions = new Map(current.map((row) => [row.id, row.current_revision_id]));
    return new Set(
      captured
        .filter((row) =>
          row.sources.some((source) => revisions.get(source.documentId) !== source.revisionId),
        )
        .map((row) => row.revisionId),
    );
  }
  private async document(tx: Tx, id: string, revisionId?: string): Promise<KnowledgeDocument> {
    const d = await tx
      .selectFrom('knowledge_documents')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!d || !d.current_revision_id) throw new KnowledgeError('not_found');
    const r = await tx
      .selectFrom('knowledge_document_revisions')
      .selectAll()
      .where('document_id', '=', id)
      .where('id', '=', revisionId ?? d.current_revision_id)
      .executeTakeFirst();
    if (!r) throw new KnowledgeError('not_found');
    const stale = (await this.staleRevisions(tx, [r.id])).has(r.id);
    return {
      ...(stale ? { stale: true } : {}),
      id: d.id,
      folderId: d.folder_id,
      title: r.title,
      currentRevisionId: r.id,
      bodyMarkdown: r.body_markdown,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    };
  }
  async getDocument(id: string, revisionId?: string): Promise<KnowledgeDocument> {
    return this.transaction((tx) => this.document(tx, id, revisionId));
  }
  private async documents(
    tx: Tx,
    input: { folderId?: string; query?: string; offset?: number; limit?: number },
    permitted?: Map<string, KnowledgeMode>,
    documentIds?: Set<string>,
  ): Promise<KnowledgeDocumentSummary[]> {
    if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 200))
      throw new KnowledgeError('invalid');
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new KnowledgeError('invalid');
    let q = tx
      .selectFrom('knowledge_documents as d')
      .innerJoin('knowledge_document_revisions as r', 'r.id', 'd.current_revision_id')
      .select([
        'd.id',
        'd.folder_id',
        'd.title',
        'r.id as revision_id',
        'd.created_at',
        'd.updated_at',
      ]);
    if (permitted) {
      if (permitted.size === 0) return [];
      q = q.where('d.folder_id', 'in', [...permitted.keys()]);
    }
    if (documentIds) {
      if (documentIds.size === 0) return [];
      q = q.where('d.id', 'in', [...documentIds]);
    }
    if (input.folderId !== undefined) q = q.where('d.folder_id', '=', input.folderId);
    if (input.query) {
      const pattern = '%' + input.query.replace(/[\\%_]/g, '\\$&') + '%';
      q = q.where((eb) =>
        eb.or([eb('d.title', 'ilike', pattern), eb('r.body_markdown', 'ilike', pattern)]),
      );
    }
    const rows = await q.orderBy('d.title').orderBy('d.id').offset(offset).limit(limit).execute();
    const stale = await this.staleRevisions(
      tx,
      rows.map((row) => row.revision_id),
    );
    return rows.map((r) => ({
      ...(stale.has(r.revision_id) ? { stale: true } : {}),
      id: r.id,
      folderId: r.folder_id,
      title: r.title,
      currentRevisionId: r.revision_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
  async listDocuments(
    input: { folderId?: string; query?: string; offset?: number; limit?: number } = {},
  ): Promise<KnowledgeDocumentSummary[]> {
    return this.transaction((tx) => this.documents(tx, input));
  }
  private async collision(tx: Tx, folderId: string, title: string, except?: string): Promise<void> {
    name(title);
    if (
      !(await tx
        .selectFrom('knowledge_folders')
        .select('id')
        .where('id', '=', folderId)
        .executeTakeFirst())
    )
      throw new KnowledgeError('not_found');
    if (
      await tx
        .selectFrom('knowledge_folders')
        .select('id')
        .where('parent_id', '=', folderId)
        .where('name', '=', title)
        .executeTakeFirst()
    )
      throw new KnowledgeError('conflict', 'A folder has this name');
    let q = tx
      .selectFrom('knowledge_documents')
      .select('id')
      .where('folder_id', '=', folderId)
      .where('title', '=', title);
    if (except) q = q.where('id', '!=', except);
    if (await q.executeTakeFirst())
      throw new KnowledgeError('conflict', 'A document has this name');
  }
  private async revision(
    tx: Tx,
    id: string,
    title: string,
    bodyMarkdown: string,
    actor?: KnowledgeActor | string,
  ): Promise<string> {
    const revisionId = randomUUID();
    const agent = typeof actor === 'object' ? actor : undefined;
    await tx
      .insertInto('knowledge_document_revisions')
      .values({
        id: revisionId,
        document_id: id,
        title,
        body_markdown: bodyMarkdown,
        author_identity: agent ? 'agent' : ((actor as string | undefined) ?? 'operator'),
        project_id: agent?.projectId ?? null,
        session_id: agent?.sessionId ?? null,
        turn_id: agent?.turnId ?? null,
      })
      .execute();
    await tx
      .updateTable('knowledge_documents')
      .set({ title, current_revision_id: revisionId, updated_at: new Date() })
      .where('id', '=', id)
      .execute();
    return revisionId;
  }
  private async create(
    tx: Tx,
    input: KnowledgeDocumentInput,
    actor?: KnowledgeActor | string,
  ): Promise<KnowledgeDocument> {
    input = { ...input, title: input.title.endsWith('.md') ? input.title : input.title + '.md' };
    body(input.bodyMarkdown);
    await this.collision(tx, input.folderId, input.title);
    const id = randomUUID();
    await tx
      .insertInto('knowledge_documents')
      .values({ id, folder_id: input.folderId, title: input.title, current_revision_id: null })
      .execute();
    await this.revision(tx, id, input.title, input.bodyMarkdown, actor);
    return this.document(tx, id);
  }
  async createDocument(input: KnowledgeDocumentInput, author?: string): Promise<KnowledgeDocument> {
    return this.transaction(async (tx) => {
      const document = await this.create(tx, input, author);
      await this.queueSourceMaintenance(tx, document);
      return document;
    });
  }
  private async edit(
    tx: Tx,
    id: string,
    input: KnowledgeDocumentEdit,
    actor?: KnowledgeActor | string,
  ): Promise<KnowledgeDocument> {
    input = { ...input, title: input.title.endsWith('.md') ? input.title : input.title + '.md' };
    const old = await this.document(tx, id);
    if (input.expectedRevisionId !== old.currentRevisionId)
      throw new KnowledgeError('conflict', 'Document changed; reload before saving');
    body(input.bodyMarkdown);
    await this.collision(tx, old.folderId, input.title, id);
    await this.revision(tx, id, input.title, input.bodyMarkdown, actor);
    return this.document(tx, id);
  }
  async updateDocument(
    id: string,
    input: KnowledgeDocumentEdit,
    author?: string,
  ): Promise<KnowledgeDocument> {
    return this.transaction(async (tx) => {
      const original = await tx
        .selectFrom('knowledge_source_revisions as s')
        .innerJoin('knowledge_document_revisions as r', 'r.id', 's.revision_id')
        .select('s.revision_id')
        .where('r.document_id', '=', id)
        .executeTakeFirst();
      if (original)
        throw new KnowledgeError(
          'forbidden',
          'Replace the original source file instead of editing its extracted text',
        );
      const before = await this.document(tx, id);
      const provenance = await tx
        .selectFrom('knowledge_provenance')
        .selectAll()
        .where('revision_id', '=', before.currentRevisionId)
        .executeTakeFirst();
      const updated = await this.edit(tx, id, input, author);
      if (provenance)
        await tx
          .insertInto('knowledge_provenance')
          .values({ ...provenance, revision_id: updated.currentRevisionId })
          .execute();
      await this.queueSourceMaintenance(tx, updated);
      return provenance ? this.document(tx, id) : updated;
    });
  }
  async listRevisions(
    id: string,
    input: { offset?: number; limit?: number } = {},
  ): Promise<KnowledgeRevision[]> {
    return this.transaction(async (tx) => {
      await this.document(tx, id);
      const offset = input.offset ?? 0,
        limit = input.limit ?? 100;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new KnowledgeError('invalid');
      return (
        await tx
          .selectFrom('knowledge_document_revisions')
          .selectAll()
          .where('document_id', '=', id)
          .orderBy('created_at', 'desc')
          .orderBy('id')
          .offset(offset)
          .limit(limit)
          .execute()
      ).map((r) => ({
        id: r.id,
        documentId: r.document_id,
        title: r.title,
        bodyMarkdown: r.body_markdown,
        authorIdentity: r.author_identity,
        projectId: r.project_id,
        sessionId: r.session_id,
        turnId: r.turn_id,
        createdAt: r.created_at,
      }));
    });
  }
  async restoreDocument(
    id: string,
    input: { revisionId: string; expectedRevisionId: string },
    author?: string,
  ): Promise<KnowledgeDocument> {
    return this.transaction(async (tx) => {
      const revision = await this.document(tx, id, input.revisionId);
      const restored = await this.edit(
        tx,
        id,
        {
          expectedRevisionId: input.expectedRevisionId,
          title: revision.title,
          bodyMarkdown: revision.bodyMarkdown,
        },
        author,
      );
      if (
        await tx
          .selectFrom('knowledge_source_revisions')
          .select('revision_id')
          .where('revision_id', '=', input.revisionId)
          .executeTakeFirst()
      ) {
        await this.sources.attachRevision(
          tx,
          restored.currentRevisionId,
          await this.sources.getRevision(input.revisionId, tx),
        );
      }
      const provenance = await tx
        .selectFrom('knowledge_provenance')
        .selectAll()
        .where('revision_id', '=', input.revisionId)
        .executeTakeFirst();
      if (provenance)
        await tx
          .insertInto('knowledge_provenance')
          .values({ ...provenance, revision_id: restored.currentRevisionId })
          .execute();
      await this.queueSourceMaintenance(tx, restored);
      return this.document(tx, restored.id);
    });
  }
  async moveDocument(
    id: string,
    folderId: string,
    expectedPolicyToken?: string,
  ): Promise<KnowledgeDocument> {
    return this.policyMutation(async (tx) => {
      const d = await this.document(tx, id);
      const previousSourceProject = await this.sourceProject(tx, d.folderId);
      const nextSourceProject = await this.sourceProject(tx, folderId);
      const fs = await this.folders(tx);
      const subtree = (role: 'wiki' | 'sources', folder: string) =>
        fs.some(
          (f) =>
            f.role === role && this.effective(fs, [{ folderId: f.id, mode: 'read' }]).has(folder),
        );
      if (d.folderId !== folderId && (subtree('wiki', folderId) || subtree('wiki', d.folderId)))
        throw new KnowledgeError(
          'forbidden',
          'Wiki documents cannot cross knowledge boundaries by moving',
        );
      await this.collision(tx, folderId, d.title, id);
      await tx
        .updateTable('knowledge_documents')
        .set({ folder_id: folderId, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      if (d.folderId !== folderId) await this.assertMovedSourceAudiences(tx, [id]);
      const moved = await this.document(tx, id);
      if (previousSourceProject && previousSourceProject !== nextSourceProject) {
        await tx
          .deleteFrom('knowledge_maintenance_queue')
          .where('project_id', '=', previousSourceProject)
          .where('source_document_id', '=', id)
          .execute();
        await tx
          .updateTable('project_knowledge_spaces')
          .set({ reconcile_due_at: new Date() })
          .where('project_id', '=', previousSourceProject)
          .execute();
      }
      if (nextSourceProject && nextSourceProject !== previousSourceProject)
        await this.queueWikiMaintenanceTx(tx, nextSourceProject, [id], new Date(), false);
      return moved;
    }, expectedPolicyToken);
  }
  async deleteDocument(id: string): Promise<void> {
    await this.policyMutation(async (tx) => {
      if (
        await tx
          .selectFrom('project_knowledge_spaces')
          .select('project_id')
          .where('overview_document_id', '=', id)
          .executeTakeFirst()
      )
        throw new KnowledgeError(
          'conflict',
          'Clear the approved project overview before deleting its document',
        );
      const document = await this.document(tx, id);
      const sourceProject = await this.sourceProject(tx, document.folderId);
      if (
        !(await tx
          .deleteFrom('knowledge_documents')
          .where('id', '=', id)
          .returning('id')
          .executeTakeFirst())
      )
        throw new KnowledgeError('not_found');
      if (sourceProject)
        await tx
          .updateTable('project_knowledge_spaces')
          .set({ reconcile_due_at: new Date() })
          .where('project_id', '=', sourceProject)
          .execute();
    });
  }
  async exportDocuments(folderId?: string, includeOriginals = false): Promise<KnowledgeFile[]> {
    return this.transaction(async (tx) => {
      const folders = await this.folders(tx);
      if (folderId && !folders.some((f) => f.id === folderId))
        throw new KnowledgeError('not_found');
      const permitted = folderId
        ? this.effective(folders, [{ folderId, mode: 'read' }])
        : new Map(folders.map((f) => [f.id, 'read' as const]));
      if (!permitted.size) return [];
      const docs = await tx
        .selectFrom('knowledge_documents as d')
        .innerJoin('knowledge_document_revisions as r', 'r.id', 'd.current_revision_id')
        .select(['d.folder_id', 'd.title', 'r.body_markdown', 'r.id'])
        .where('d.folder_id', 'in', [...permitted.keys()])
        .orderBy('d.id')
        .limit(KNOWLEDGE_IMPORT_MAX_DOCUMENTS + 1)
        .execute();
      if (docs.length > KNOWLEDGE_IMPORT_MAX_DOCUMENTS)
        throw new KnowledgeError(
          'invalid',
          'Export exceeds 100 documents; select a smaller folder',
        );
      const files: KnowledgeFile[] = [];
      for (const d of docs) {
        const path = [d.title.endsWith('.md') ? d.title : d.title + '.md'];
        let current = folders.find((f) => f.id === d.folder_id);
        while (current && current.id !== folderId) {
          path.unshift(current.name);
          current = folders.find((f) => f.id === current?.parentId);
        }
        const file: KnowledgeFile = { path: path.join('/'), bodyMarkdown: d.body_markdown };
        if (includeOriginals) {
          try {
            const original = await this.sources.getRevision(d.id, tx);
            file.original = {
              filename: original.filename,
              mediaType: original.mediaType,
              sha256: original.sha256,
              processingState: original.processingState,
              processingNote: original.processingNote,
              locators: original.locators,
              previews: original.previews,
              base64: original.bytes.toString('base64'),
            };
          } catch (error) {
            if (!(error instanceof KnowledgeError && error.code === 'not_found')) throw error;
          }
        }
        files.push(file);
        if (
          Buffer.byteLength(JSON.stringify(files)) >
          (includeOriginals ? 20 * 1024 * 1024 : KNOWLEDGE_IMPORT_MAX_BYTES)
        )
          throw new KnowledgeError('invalid', 'Export exceeds size limit; select a smaller folder');
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      return files;
    });
  }
  async importDocuments(
    folderId: string,
    files: KnowledgeFile[],
    includeOriginals = false,
  ): Promise<number> {
    if (
      !Array.isArray(files) ||
      files.length > KNOWLEDGE_IMPORT_MAX_DOCUMENTS ||
      Buffer.byteLength(JSON.stringify(files)) >
        (includeOriginals ? 20 * 1024 * 1024 : KNOWLEDGE_IMPORT_MAX_BYTES)
    )
      throw new KnowledgeError('invalid', 'Import exceeds 100 documents or bundle size limit');
    return this.transaction(async (tx) => {
      if (!(await this.folders(tx)).some((f) => f.id === folderId))
        throw new KnowledgeError('not_found');
      for (const file of files) {
        if (typeof file.path !== 'string' || !file.path.endsWith('.md'))
          throw new KnowledgeError('invalid', 'Import accepts relative Markdown paths');
        const parts = file.path.split('/');
        parts.forEach(name);
        const title = parts.pop()!;
        let parentId = folderId;
        for (const part of parts) {
          const existing = (await this.folders(tx)).find(
            (f) => f.parentId === parentId && f.name === part,
          );
          parentId = existing?.id ?? (await this.insertFolder(tx, { parentId, name: part })).id;
        }
        const document = await this.create(tx, {
          folderId: parentId,
          title,
          bodyMarkdown: file.bodyMarkdown,
        });
        if (file.original) {
          if (!includeOriginals)
            throw new KnowledgeError('invalid', 'Use the original-source bundle import');
          const { base64, sha256, ...original } = file.original;
          const bytes = Buffer.from(base64, 'base64');
          if (
            bytes.toString('base64') !== base64 ||
            createHash('sha256').update(bytes).digest('hex') !== sha256
          )
            throw new KnowledgeError('invalid', 'Original source digest mismatch');
          await this.sources.attachRevision(tx, document.currentRevisionId, { ...original, bytes });
        }
      }
      return files.length;
    });
  }
  private async audit(
    tx: Tx,
    actor: KnowledgeActor,
    operation: string,
    target: string | null,
    revisionId: string | null,
    outcome: 'allow' | 'deny' | 'conflict',
  ): Promise<void> {
    await tx
      .insertInto('knowledge_access_events')
      .values({
        id: randomUUID(),
        project_id: actor.projectId,
        session_id: actor.sessionId,
        turn_id: actor.turnId,
        operation,
        target,
        revision_id: revisionId,
        outcome,
      })
      .execute();
  }
  async runAgent(
    actor: KnowledgeActor,
    operation: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await this.transaction(async (tx) => {
      let target: string | null =
        typeof input.documentId === 'string'
          ? input.documentId
          : typeof input.folderId === 'string'
            ? input.folderId
            : null;
      let revisionId: string | null = null;
      try {
        const session = await tx
          .selectFrom('sessions')
          .select('project_id')
          .where('session_id', '=', actor.sessionId)
          .executeTakeFirst();
        if (
          session?.project_id !== actor.projectId ||
          !actor.turnId ||
          (await tx
            .selectFrom('knowledge_invalidated_sessions')
            .select('session_id')
            .where('session_id', '=', actor.sessionId)
            .executeTakeFirst())
        )
          throw new KnowledgeError('forbidden');
        let permitted = await this.access(tx, actor.projectId);
        const allFolders = await this.folders(tx);
        const jobRow = await tx
          .selectFrom('knowledge_wiki_jobs')
          .selectAll()
          .where('session_id', '=', actor.sessionId)
          .executeTakeFirst();
        const job = jobRow ? this.wikiJob(jobRow) : null;
        const managedWiki = this.effective(
          allFolders,
          allFolders
            .filter((f) => f.role === 'wiki')
            .map((f) => ({ folderId: f.id, mode: 'read' })),
        );
        let captured: Map<string, string> | null = null;
        let capturedWiki: Map<string, string> | null = null;
        const capturedSourceFolders = new Set<string>();
        if (job) {
          if (job.status !== 'running' || job.projectId !== actor.projectId)
            throw new KnowledgeError('forbidden', 'Wiki job is not running');
          const space = await tx
            .selectFrom('project_knowledge_spaces')
            .selectAll()
            .where('project_id', '=', actor.projectId)
            .executeTakeFirst();
          if (!space) throw new KnowledgeError('forbidden');
          const scope = this.effective(allFolders, [
            { folderId: space.sources_folder_id, mode: 'read' },
            { folderId: space.wiki_folder_id, mode: 'read_write' },
          ]);
          permitted = new Map(
            [...permitted]
              .filter(([id]) => scope.has(id))
              .map(([id, mode]) => [id, scope.get(id) === 'read' ? 'read' : mode]),
          );
          captured = new Map(job.sourceRevisions.map((r) => [r.documentId, r.revisionId]));
          for (const [documentId, revisionId] of captured) {
            let current: KnowledgeDocument;
            try {
              current = await this.document(tx, documentId);
            } catch (error) {
              if (error instanceof KnowledgeError && error.code === 'not_found')
                throw new KnowledgeError(
                  'conflict',
                  'A captured source was deleted; start a new Wiki job',
                );
              throw error;
            }
            capturedSourceFolders.add(current.folderId);
            if (!permitted.has(current.folderId) || current.currentRevisionId !== revisionId)
              throw new KnowledgeError(
                'conflict',
                'A captured source changed; start a new Wiki job',
              );
          }
          const wikiRows = await tx
            .selectFrom('knowledge_documents as d')
            .innerJoin('knowledge_document_revisions as r', 'r.id', 'd.current_revision_id')
            .leftJoin('knowledge_provenance as p', 'p.revision_id', 'r.id')
            .select([
              'd.id',
              'r.id as revision_id',
              'r.created_at',
              'p.job_id',
              'p.source_revisions',
            ])
            .where('d.folder_id', 'in', [...managedWiki.keys()])
            .execute();
          capturedWiki = new Map(
            wikiRows
              .filter(
                (row) =>
                  (row.created_at <= job.createdAt || row.job_id === job.id) &&
                  (job.kind === 'check' ||
                    job.kind === 'reconcile' ||
                    row.source_revisions === null ||
                    (JSON.parse(row.source_revisions) as KnowledgeWikiJob['sourceRevisions']).every(
                      (source) => captured?.has(source.documentId) === true,
                    )),
              )
              .map((row) => [row.id, row.revision_id]),
          );
        }
        const requireFolder = (id: unknown, write = false): string => {
          if (write && job?.kind === 'check')
            throw new KnowledgeError('forbidden', 'Wiki checks are read-only');
          if (
            typeof id !== 'string' ||
            !permitted.has(id) ||
            (write && permitted.get(id) !== 'read_write')
          )
            throw new KnowledgeError('forbidden');
          if (write && managedWiki.has(id) && !job)
            throw new KnowledgeError(
              'forbidden',
              'Use the explicit Wiki action to update managed Wiki pages',
            );
          return id;
        };
        const requireSafeWikiAudience = async (folderId: string): Promise<void> => {
          if (!job) return;
          const projects = await tx.selectFrom('projects').select('id').execute();
          for (const project of projects) {
            const audience = this.effective(allFolders, await this.grants(tx, project.id));
            if (
              audience.has(folderId) &&
              [...capturedSourceFolders].some((sourceFolder) => !audience.has(sourceFolder))
            )
              throw new KnowledgeError(
                'forbidden',
                'This Wiki is shared with a project that cannot read every source; change sharing before incorporating these sources',
              );
          }
        };
        const requireDocument = async (id: unknown, write = false): Promise<string> => {
          if (typeof id !== 'string') throw new KnowledgeError('forbidden');
          const doc = await tx
            .selectFrom('knowledge_documents')
            .select('folder_id')
            .where('id', '=', id)
            .executeTakeFirst();
          requireFolder(doc?.folder_id, write);
          if (capturedWiki && doc && managedWiki.has(doc.folder_id) && !capturedWiki.has(id))
            throw new KnowledgeError(
              'forbidden',
              'This Wiki page is outside the job snapshot; start a new Wiki job',
            );
          if (captured && doc && !managedWiki.has(doc.folder_id) && !captured.has(id))
            throw new KnowledgeError('forbidden', 'This source was not selected for the Wiki job');
          if (
            write &&
            (await tx
              .selectFrom('knowledge_source_revisions as s')
              .innerJoin('knowledge_document_revisions as r', 'r.id', 's.revision_id')
              .select('s.revision_id')
              .where('r.document_id', '=', id)
              .executeTakeFirst())
          )
            throw new KnowledgeError(
              'forbidden',
              'Original source files cannot be edited by agents',
            );
          if (write && doc) await requireSafeWikiAudience(doc.folder_id);
          return id;
        };
        const string = (key: string): string => {
          const value = input[key];
          if (typeof value !== 'string') throw new KnowledgeError('invalid');
          return value;
        };
        const pagination = {
          ...(input.offset === undefined ? {} : { offset: Number(input.offset) }),
          ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
        };
        const capturedDocuments = captured
          ? new Set([...(captured?.keys() ?? []), ...(capturedWiki?.keys() ?? [])])
          : undefined;
        let value: unknown;
        if (operation === 'list') {
          if (input.folderId !== undefined) {
            const folderId = requireFolder(input.folderId);
            value = {
              folders: (await this.folders(tx)).filter(
                (f) => f.parentId === folderId && permitted.has(f.id),
              ),
              documents: await this.documents(
                tx,
                { folderId, ...pagination },
                permitted,
                capturedDocuments,
              ),
            };
          } else {
            // Hidden ancestors must not disclose their identifiers or names through navigation.
            value = {
              folders: (await this.folders(tx))
                .filter((f) => permitted.has(f.id))
                .map((f) => ({
                  ...f,
                  parentId: f.parentId && permitted.has(f.parentId) ? f.parentId : null,
                  mode: permitted.get(f.id),
                })),
              documents: [],
            };
          }
        } else if (operation === 'search') {
          if (input.folderId !== undefined) requireFolder(input.folderId);
          value = await this.documents(
            tx,
            {
              query: string('query'),
              ...pagination,
              ...(typeof input.folderId === 'string' ? { folderId: input.folderId } : {}),
            },
            permitted,
            capturedDocuments,
          );
        } else if (operation === 'read' || operation === 'read_original') {
          const id = await requireDocument(input.documentId);
          const doc = await this.document(
            tx,
            id,
            captured?.get(id) ??
              capturedWiki?.get(id) ??
              (typeof input.revisionId === 'string' ? input.revisionId : undefined),
          );
          revisionId = doc.currentRevisionId;
          value =
            operation === 'read_original'
              ? { source: await this.sources.getRevision(doc.currentRevisionId, tx) }
              : doc;
        } else if (operation === 'create') {
          const folderId = requireFolder(input.folderId, true);
          await requireSafeWikiAudience(folderId);
          const doc = await this.create(
            tx,
            { folderId, title: string('title'), bodyMarkdown: string('bodyMarkdown') },
            actor,
          );
          target = doc.id;
          revisionId = doc.currentRevisionId;
          value = doc;
        } else if (operation === 'edit') {
          const id = await requireDocument(input.documentId, true);
          const doc = await this.edit(
            tx,
            id,
            {
              expectedRevisionId: string('expectedRevisionId'),
              title: string('title'),
              bodyMarkdown: string('bodyMarkdown'),
            },
            actor,
          );
          revisionId = doc.currentRevisionId;
          value = doc;
        } else throw new KnowledgeError('invalid');
        if (captured && (operation === 'search' || operation === 'list')) {
          const visible = (d: { id: string; folderId: string }) =>
            managedWiki.has(d.folderId) ? capturedWiki?.has(d.id) === true : captured.has(d.id);
          if (Array.isArray(value)) value = (value as KnowledgeDocumentSummary[]).filter(visible);
          else if (value && typeof value === 'object' && 'documents' in value)
            (value as { documents: KnowledgeDocumentSummary[] }).documents = (
              value as { documents: KnowledgeDocumentSummary[] }
            ).documents.filter(visible);
        }
        if (job && revisionId && (operation === 'create' || operation === 'edit')) {
          await tx
            .insertInto('knowledge_provenance')
            .values({
              revision_id: revisionId,
              job_id: job.id,
              source_revisions: JSON.stringify(job.sourceRevisions),
            })
            .execute();
        }
        await this.audit(tx, actor, operation, target, revisionId, 'allow');
        return { value };
      } catch (error) {
        if (!(error instanceof KnowledgeError)) throw error;
        await this.audit(
          tx,
          actor,
          operation,
          target,
          revisionId,
          error.code === 'conflict' ? 'conflict' : 'deny',
        );
        return { error };
      }
    });
    if ('error' in result) throw result.error;
    return result.value;
  }
}
