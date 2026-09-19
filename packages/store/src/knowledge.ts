import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from './schema.js';

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
export interface KnowledgeFolder {
  id: string;
  parentId: string | null;
  name: string;
}
export interface KnowledgeGrant {
  folderId: string;
  mode: KnowledgeMode;
}
export interface KnowledgeDocumentSummary {
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
  constructor(private readonly db: Kysely<Database>) {}
  private async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
      return fn(tx);
    });
  }
  private async folders(tx: Tx): Promise<KnowledgeFolder[]> {
    return (
      await tx.selectFrom('knowledge_folders').selectAll().orderBy('name').orderBy('id').execute()
    ).map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name }));
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
    return result;
  }
  private async grants(tx: Tx, projectId: string): Promise<KnowledgeGrant[]> {
    return (
      await tx
        .selectFrom('project_knowledge_grants')
        .select(['folder_id', 'mode'])
        .where('project_id', '=', projectId)
        .execute()
    ).map((r) => ({ folderId: r.folder_id, mode: r.mode }));
  }
  private async access(tx: Tx, projectId: string): Promise<Map<string, KnowledgeMode>> {
    return this.effective(await this.folders(tx), await this.grants(tx, projectId));
  }
  private async policyState(tx: Tx) {
    return {
      folders: await this.folders(tx),
      documents: await tx
        .selectFrom('knowledge_documents')
        .select(['id', 'folder_id'])
        .orderBy('id')
        .execute(),
      grants: await tx
        .selectFrom('project_knowledge_grants')
        .selectAll()
        .orderBy('project_id')
        .orderBy('folder_id')
        .execute(),
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
    const folders = await this.folders(tx);
    const grants = await tx.selectFrom('project_knowledge_grants').selectAll().execute();
    const docs = await tx.selectFrom('knowledge_documents').select(['id', 'folder_id']).execute();
    const result = new Map<string, Set<string>>();
    for (const projectId of new Set(grants.map((g) => g.project_id))) {
      const access = this.effective(
        folders,
        grants
          .filter((g) => g.project_id === projectId)
          .map((g) => ({ folderId: g.folder_id, mode: g.mode })),
      );
      result.set(
        projectId,
        new Set(
          [...access.keys()]
            .map((id) => 'folder:' + id)
            .concat(docs.filter((d) => access.has(d.folder_id)).map((d) => 'document:' + d.id)),
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
      .selectFrom('project_knowledge_grants')
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
    return this.transaction((tx) => this.folders(tx));
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
  async updateFolder(
    id: string,
    input: { parentId?: string | null; name?: string; expectedPolicyToken?: string },
  ): Promise<KnowledgeFolder> {
    return this.policyMutation(async (tx) => {
      const folders = await this.folders(tx);
      const old = folders.find((f) => f.id === id);
      if (!old) throw new KnowledgeError('not_found');
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
      return next;
    }, input.expectedPolicyToken);
  }
  async deleteFolder(id: string): Promise<void> {
    await this.policyMutation(async (tx) => {
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
      const folderIds = new Set((await this.folders(tx)).map((f) => f.id));
      if (
        grants.length > KNOWLEDGE_MAX_FOLDERS ||
        new Set(grants.map((g) => g.folderId)).size !== grants.length
      )
        throw new KnowledgeError('invalid');
      for (const g of grants)
        if (!folderIds.has(g.folderId) || (g.mode !== 'read' && g.mode !== 'read_write'))
          throw new KnowledgeError('invalid');
      await tx.deleteFrom('project_knowledge_grants').where('project_id', '=', projectId).execute();
      if (grants.length)
        await tx
          .insertInto('project_knowledge_grants')
          .values(
            grants.map((g) => ({ project_id: projectId, folder_id: g.folderId, mode: g.mode })),
          )
          .execute();
      return grants;
    });
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
    return {
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
    if (input.folderId !== undefined) q = q.where('d.folder_id', '=', input.folderId);
    if (input.query) {
      const pattern = '%' + input.query.replace(/[\\%_]/g, '\\$&') + '%';
      q = q.where((eb) =>
        eb.or([eb('d.title', 'ilike', pattern), eb('r.body_markdown', 'ilike', pattern)]),
      );
    }
    return (await q.orderBy('d.title').orderBy('d.id').offset(offset).limit(limit).execute()).map(
      (r) => ({
        id: r.id,
        folderId: r.folder_id,
        title: r.title,
        currentRevisionId: r.revision_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }),
    );
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
    return this.transaction((tx) => this.create(tx, input, author));
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
    return this.transaction((tx) => this.edit(tx, id, input, author));
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
      return this.edit(
        tx,
        id,
        {
          expectedRevisionId: input.expectedRevisionId,
          title: revision.title,
          bodyMarkdown: revision.bodyMarkdown,
        },
        author,
      );
    });
  }
  async moveDocument(
    id: string,
    folderId: string,
    expectedPolicyToken?: string,
  ): Promise<KnowledgeDocument> {
    return this.policyMutation(async (tx) => {
      const d = await this.document(tx, id);
      await this.collision(tx, folderId, d.title, id);
      await tx
        .updateTable('knowledge_documents')
        .set({ folder_id: folderId, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      return this.document(tx, id);
    }, expectedPolicyToken);
  }
  async deleteDocument(id: string): Promise<void> {
    await this.policyMutation(async (tx) => {
      if (
        !(await tx
          .deleteFrom('knowledge_documents')
          .where('id', '=', id)
          .returning('id')
          .executeTakeFirst())
      )
        throw new KnowledgeError('not_found');
    });
  }
  async exportDocuments(folderId?: string): Promise<KnowledgeFile[]> {
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
        .select(['d.folder_id', 'd.title', 'r.body_markdown'])
        .where('d.folder_id', 'in', [...permitted.keys()])
        .orderBy('d.id')
        .limit(KNOWLEDGE_IMPORT_MAX_DOCUMENTS + 1)
        .execute();
      if (docs.length > KNOWLEDGE_IMPORT_MAX_DOCUMENTS)
        throw new KnowledgeError(
          'invalid',
          'Export exceeds 100 documents; select a smaller folder',
        );
      const files = docs
        .map((d) => {
          const path = [d.title.endsWith('.md') ? d.title : d.title + '.md'];
          let current = folders.find((f) => f.id === d.folder_id);
          while (current && current.id !== folderId) {
            path.unshift(current.name);
            current = folders.find((f) => f.id === current?.parentId);
          }
          const file = { path: path.join('/'), bodyMarkdown: d.body_markdown };
          return file;
        })
        .sort((a, b) => a.path.localeCompare(b.path));
      if (Buffer.byteLength(JSON.stringify(files)) > KNOWLEDGE_IMPORT_MAX_BYTES)
        throw new KnowledgeError('invalid', 'Export exceeds 2 MiB; select a smaller folder');
      return files;
    });
  }
  async importDocuments(folderId: string, files: KnowledgeFile[]): Promise<number> {
    if (
      !Array.isArray(files) ||
      files.length > KNOWLEDGE_IMPORT_MAX_DOCUMENTS ||
      Buffer.byteLength(JSON.stringify(files)) > KNOWLEDGE_IMPORT_MAX_BYTES
    )
      throw new KnowledgeError('invalid', 'Import exceeds 100 documents or 2 MiB');
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
        await this.create(tx, { folderId: parentId, title, bodyMarkdown: file.bodyMarkdown });
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
        const permitted = await this.access(tx, actor.projectId);
        const requireFolder = (id: unknown, write = false): string => {
          if (
            typeof id !== 'string' ||
            !permitted.has(id) ||
            (write && permitted.get(id) !== 'read_write')
          )
            throw new KnowledgeError('forbidden');
          return id;
        };
        const requireDocument = async (id: unknown, write = false): Promise<string> => {
          if (typeof id !== 'string') throw new KnowledgeError('forbidden');
          const doc = await tx
            .selectFrom('knowledge_documents')
            .select('folder_id')
            .where('id', '=', id)
            .executeTakeFirst();
          requireFolder(doc?.folder_id, write);
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
        let value: unknown;
        if (operation === 'list') {
          if (input.folderId !== undefined) {
            const folderId = requireFolder(input.folderId);
            value = {
              folders: (await this.folders(tx)).filter(
                (f) => f.parentId === folderId && permitted.has(f.id),
              ),
              documents: await this.documents(tx, { folderId, ...pagination }, permitted),
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
          );
        } else if (operation === 'read') {
          const id = await requireDocument(input.documentId);
          const doc = await this.document(
            tx,
            id,
            typeof input.revisionId === 'string' ? input.revisionId : undefined,
          );
          revisionId = doc.currentRevisionId;
          value = doc;
        } else if (operation === 'create') {
          const folderId = requireFolder(input.folderId, true);
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
