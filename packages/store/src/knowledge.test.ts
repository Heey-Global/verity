import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestDb, truncateAll, type TestDb } from './testing.js';
import {
  KNOWLEDGE_DOCUMENT_MAX_BYTES,
  KNOWLEDGE_MAX_FOLDERS,
  KNOWLEDGE_IMPORT_MAX_BYTES,
  type KnowledgeActor,
  type KnowledgeDocument,
} from './knowledge.js';
let ctx: TestDb;
const actor: KnowledgeActor = { projectId: 'p', sessionId: 's', turnId: 't' };
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'test',
    repo: 'test',
    containerName: 'test',
    state: 'absent',
  });
  await ctx.store.createSession({
    sessionId: 's',
    projectId: 'p',
    worktree: '/test',
    model: 'test',
  });
});
async function setup() {
  const k = ctx.store.knowledge;
  const parent = await k.createFolder({ name: 'Shared' });
  const child = await k.createFolder({ parentId: parent.id, name: 'Child' });
  const secret = await k.createFolder({ name: 'Secret' });
  const doc = await k.createDocument({
    folderId: child.id,
    title: 'guide.md',
    bodyMarkdown: '# Shared phrase',
  });
  const hidden = await k.createDocument({
    folderId: secret.id,
    title: 'hidden.md',
    bodyMarkdown: '# Shared phrase secret',
  });
  return { k, parent, child, secret, doc, hidden };
}
describe('managed knowledge', () => {
  it('filters discovery before returning metadata and refuses direct ids and historical revisions', async () => {
    const { k, parent, child, secret, doc, hidden } = await setup();
    await k.setGrants('p', [{ folderId: child.id, mode: 'read' }]);
    const listing = await k.runAgent(actor, 'list', {});
    expect(JSON.stringify(listing)).not.toContain(parent.id);
    expect(JSON.stringify(listing)).not.toContain(secret.name);
    expect(listing).toEqual({
      folders: [{ ...child, parentId: null, mode: 'read' }],
      documents: [],
    });
    const results = await k.runAgent(actor, 'search', { query: 'Shared' });
    expect(results).toEqual([expect.objectContaining({ id: doc.id })]);
    await expect(
      k.runAgent(actor, 'read', { documentId: hidden.id, revisionId: hidden.currentRevisionId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(k.runAgent(actor, 'read', { documentId: 'missing' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(
      await ctx.db
        .selectFrom('knowledge_access_events')
        .selectAll()
        .where('outcome', '=', 'deny')
        .execute(),
    ).toHaveLength(2);
  });
  it('unions inherited modes, attributes edits, rejects stale edits, and preserves immutable history on restore', async () => {
    const { k, parent, child, doc } = await setup();
    await k.setGrants('p', [
      { folderId: parent.id, mode: 'read' },
      { folderId: child.id, mode: 'read_write' },
    ]);
    const edited = (await k.runAgent(actor, 'edit', {
      documentId: doc.id,
      expectedRevisionId: doc.currentRevisionId,
      title: doc.title,
      bodyMarkdown: 'Changed',
    })) as KnowledgeDocument;
    expect(edited.bodyMarkdown).toBe('Changed');
    await expect(
      k.runAgent(actor, 'edit', {
        documentId: doc.id,
        expectedRevisionId: doc.currentRevisionId,
        title: doc.title,
        bodyMarkdown: 'Lost update',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const history = await k.listRevisions(doc.id);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: edited.currentRevisionId,
          authorIdentity: 'agent',
          projectId: actor.projectId,
          sessionId: actor.sessionId,
          turnId: actor.turnId,
        }),
      ]),
    );
    const restored = await k.restoreDocument(doc.id, {
      revisionId: doc.currentRevisionId,
      expectedRevisionId: edited.currentRevisionId,
    });
    expect(restored.bodyMarkdown).toBe(doc.bodyMarkdown);
    expect(restored.currentRevisionId).not.toBe(doc.currentRevisionId);
    expect(await k.listRevisions(doc.id)).toHaveLength(3);
    await k.setGrants('p', [
      { folderId: parent.id, mode: 'read_write' },
      { folderId: child.id, mode: 'read' },
    ]);
    await expect(
      k.runAgent(actor, 'create', { folderId: child.id, title: 'new.md', bodyMarkdown: 'Allowed' }),
    ).resolves.toMatchObject({ bodyMarkdown: 'Allowed' });
    await expect(k.runAgent(actor, 'delete', { documentId: doc.id })).rejects.toMatchObject({
      code: 'invalid',
    });
  });
  it('downgrades stop writes but retain contexts; read revocation permanently fences old sessions', async () => {
    const { k, parent, doc } = await setup();
    await k.setGrants('p', [{ folderId: parent.id, mode: 'read_write' }]);
    await k.runAgent(actor, 'read', { documentId: doc.id });
    expect(await k.hasSessionKnowledgeExposure('s')).toBe(true);
    await k.setGrants('p', [{ folderId: parent.id, mode: 'read' }]);
    expect(await k.isSessionInvalidated('s')).toBe(false);
    await expect(
      k.runAgent(actor, 'edit', {
        documentId: doc.id,
        expectedRevisionId: doc.currentRevisionId,
        title: doc.title,
        bodyMarkdown: 'Denied',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await k.setGrants('p', []);
    expect(await k.listPendingInvalidatedSessions()).toEqual(['s']);
    await k.markInvalidatedSessionStopped('s');
    expect(await k.listPendingInvalidatedSessions()).toEqual([]);
    await k.setGrants('p', [{ folderId: parent.id, mode: 'read_write' }]);
    await expect(k.runAgent(actor, 'read', { documentId: doc.id })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await k.hasSessionKnowledgeExposure('s')).toBe(true);
  });
  it('moving subtrees drops inherited access but preserves direct grants and stable ids', async () => {
    const { k, parent, child, secret, doc } = await setup();
    await k.setGrants('p', [
      { folderId: parent.id, mode: 'read' },
      { folderId: child.id, mode: 'read_write' },
    ]);
    await k.updateFolder(child.id, { parentId: secret.id });
    expect(await k.isSessionInvalidated('s')).toBe(false);
    await expect(k.runAgent(actor, 'read', { documentId: doc.id })).resolves.toMatchObject({
      id: doc.id,
    });
    await k.moveDocument(doc.id, parent.id);
    await expect(
      k.runAgent(actor, 'edit', {
        documentId: doc.id,
        expectedRevisionId: doc.currentRevisionId,
        title: doc.title,
        bodyMarkdown: 'Denied',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await k.moveDocument(doc.id, secret.id);
    expect(await k.isSessionInvalidated('s')).toBe(true);
  });
  it('rejects folder cycles, duplicate names, path traversal and oversized documents atomically', async () => {
    const { k, parent, child } = await setup();
    await expect(k.updateFolder(parent.id, { parentId: child.id })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(k.createFolder({ name: parent.name })).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      k.importDocuments(parent.id, [
        { path: 'safe/one.md', bodyMarkdown: 'ok' },
        { path: '../escape.md', bodyMarkdown: 'no' },
      ]),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect((await k.listFolders()).some((f) => f.name === 'safe')).toBe(false);
    await expect(
      k.createDocument({
        folderId: parent.id,
        title: 'large.md',
        bodyMarkdown: 'x'.repeat(KNOWLEDGE_DOCUMENT_MAX_BYTES + 1),
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
  it('exports and imports Markdown paths without overwriting collisions', async () => {
    const { k, parent, doc } = await setup();
    const files = await k.exportDocuments(parent.id);
    expect(files).toEqual([{ path: 'Child/guide.md', bodyMarkdown: doc.bodyMarkdown }]);
    const target = await k.createFolder({ name: 'Imported' });
    expect(await k.importDocuments(target.id, files)).toBe(1);
    expect(await k.exportDocuments(target.id)).toEqual(files);
    await expect(k.importDocuments(target.id, files)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('deletion invalidates existing contexts and cascades revisions while retaining audit metadata', async () => {
    const { k, parent, doc } = await setup();
    await k.setGrants('p', [{ folderId: parent.id, mode: 'read' }]);
    await k.runAgent(actor, 'read', { documentId: doc.id });
    await k.deleteFolder(parent.id);
    expect(await k.isSessionInvalidated('s')).toBe(true);
    expect(
      await ctx.db
        .selectFrom('knowledge_document_revisions')
        .select('id')
        .where('document_id', '=', doc.id)
        .execute(),
    ).toEqual([]);
    expect(await k.hasSessionKnowledgeExposure('s')).toBe(true);
  });
  it('paginates authorized results without counting inaccessible documents', async () => {
    const { k, parent, child, doc } = await setup();
    await k.createDocument({
      folderId: child.id,
      title: 'z-last.md',
      bodyMarkdown: 'Shared phrase',
    });
    await k.setGrants('p', [{ folderId: parent.id, mode: 'read' }]);
    expect(await k.runAgent(actor, 'search', { query: 'Shared', limit: 1, offset: 0 })).toEqual([
      expect.objectContaining({ id: doc.id }),
    ]);
    expect(await k.runAgent(actor, 'search', { query: 'Shared', limit: 1, offset: 1 })).toEqual([
      expect.objectContaining({ title: 'z-last.md' }),
    ]);
    expect(await k.runAgent(actor, 'search', { query: 'Shared', limit: 1, offset: 2 })).toEqual([]);
  });
  it('previews effective access changes and rejects a move after its preview becomes stale', async () => {
    const { k, parent, child, secret, doc } = await setup();
    await k.setGrants('p', [{ folderId: parent.id, mode: 'read_write' }]);
    const preview = await k.previewFolderMove(child.id, secret.id);
    expect(preview.affectedProjects).toEqual([
      { projectId: 'p', lostRead: 2, gainedRead: 0, lostWrite: 2, gainedWrite: 0 },
    ]);
    await k.setGrants('p', [{ folderId: parent.id, mode: 'read' }]);
    await expect(
      k.updateFolder(child.id, { parentId: secret.id, expectedPolicyToken: preview.policyToken }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await k.getDocument(doc.id)).folderId).toBe(child.id);
    const next = await k.previewFolderMove(child.id, secret.id);
    await k.updateFolder(child.id, { parentId: secret.id, expectedPolicyToken: next.policyToken });
    expect(await k.isSessionInvalidated('s')).toBe(true);
  });
  it('historical reads identify and audit the requested revision rather than the latest content', async () => {
    const { k, parent, doc } = await setup();
    await k.setGrants('p', [{ folderId: parent.id, mode: 'read' }]);
    const latest = await k.updateDocument(doc.id, {
      expectedRevisionId: doc.currentRevisionId,
      title: 'renamed.md',
      bodyMarkdown: 'Latest body',
    });
    const historical = await k.runAgent(actor, 'read', {
      documentId: doc.id,
      revisionId: doc.currentRevisionId,
    });
    expect(historical).toMatchObject({
      bodyMarkdown: doc.bodyMarkdown,
      title: doc.title,
      currentRevisionId: doc.currentRevisionId,
    });
    expect((await k.getDocument(doc.id)).currentRevisionId).toBe(latest.currentRevisionId);
    expect(
      await ctx.db
        .selectFrom('knowledge_access_events')
        .select(['revision_id', 'outcome'])
        .where('target', '=', doc.id)
        .execute(),
    ).toEqual([{ revision_id: doc.currentRevisionId, outcome: 'allow' }]);
    await expect(k.runAgent(actor, 'change_grants', {})).rejects.toMatchObject({ code: 'invalid' });
    expect(
      await ctx.db
        .selectFrom('knowledge_access_events')
        .select('outcome')
        .where('operation', '=', 'change_grants')
        .execute(),
    ).toEqual([{ outcome: 'deny' }]);
  });
  it('deleting one document fences existing sessions even while the containing folder remains accessible', async () => {
    const { k, parent, child, doc } = await setup();
    await k.setGrants('p', [{ folderId: parent.id, mode: 'read' }]);
    await k.runAgent(actor, 'read', { documentId: doc.id });
    await k.deleteDocument(doc.id);
    expect(await k.listFolders()).toEqual(expect.arrayContaining([child]));
    expect(await k.isSessionInvalidated(actor.sessionId)).toBe(true);
    expect(await k.hasSessionKnowledgeExposure(actor.sessionId)).toBe(true);
  });
  it('rolls back the entire import when new folders would exceed the installation limit', async () => {
    const k = ctx.store.knowledge;
    const root = await k.createFolder({ name: 'Import' });
    await ctx.db
      .insertInto('knowledge_folders')
      .values(
        Array.from({ length: KNOWLEDGE_MAX_FOLDERS - 2 }, (_, i) => ({
          id: 'seed-' + i,
          parent_id: null,
          name: 'Seed ' + i,
        })),
      )
      .execute();
    await expect(
      k.importDocuments(root.id, [{ path: 'first/second/doc.md', bodyMarkdown: 'Must roll back' }]),
    ).rejects.toMatchObject({ code: 'invalid' });
    const folders = await k.listFolders();
    expect(folders).toHaveLength(KNOWLEDGE_MAX_FOLDERS - 1);
    expect(folders.some((f) => f.name === 'first')).toBe(false);
    expect(await k.listDocuments()).toEqual([]);
  });
  it('exports exactly the byte envelope accepted by import, including JSON separators', async () => {
    const k = ctx.store.knowledge;
    const folder = await k.createFolder({ name: 'Boundary' });
    const count = Math.ceil(KNOWLEDGE_IMPORT_MAX_BYTES / KNOWLEDGE_DOCUMENT_MAX_BYTES);
    const files = Array.from({ length: count }, (_, i) => ({
      path: `doc${i}.md`,
      bodyMarkdown: i + 1 === count ? '' : 'x'.repeat(KNOWLEDGE_DOCUMENT_MAX_BYTES),
    }));
    const last = files.at(-1)!;
    last.bodyMarkdown = 'x'.repeat(
      KNOWLEDGE_IMPORT_MAX_BYTES - Buffer.byteLength(JSON.stringify(files)),
    );
    await k.importDocuments(folder.id, files);
    expect(await k.exportDocuments(folder.id)).toEqual(files);
    const doc = (await k.listDocuments({ folderId: folder.id })).find(
      (d) => d.title === last.path,
    )!;
    await k.updateDocument(doc.id, {
      expectedRevisionId: doc.currentRevisionId,
      title: doc.title,
      bodyMarkdown: last.bodyMarkdown + 'x',
    });
    await expect(
      k.exportDocuments(folder.id).then(() => 'unexpected export success'),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
  it('fails closed on audit failure and rolls back agent writes with their revisions', async () => {
    const { k, parent, child, doc } = await setup();
    await k.setGrants('p', [{ folderId: parent.id, mode: 'read_write' }]);
    await sql`alter table knowledge_access_events add constraint test_reject_audit check (operation = 'never')`.execute(
      ctx.db,
    );
    try {
      await expect(k.runAgent(actor, 'read', { documentId: doc.id })).rejects.toThrow();
      await expect(
        k.runAgent(actor, 'create', {
          folderId: child.id,
          title: 'rollback.md',
          bodyMarkdown: 'must not persist',
        }),
      ).rejects.toThrow();
      expect(await k.listDocuments({ folderId: child.id })).toHaveLength(1);
      await expect(
        k.runAgent(actor, 'edit', {
          documentId: doc.id,
          expectedRevisionId: doc.currentRevisionId,
          title: doc.title,
          bodyMarkdown: 'must not persist',
        }),
      ).rejects.toThrow();
      expect((await k.getDocument(doc.id)).currentRevisionId).toBe(doc.currentRevisionId);
    } finally {
      await sql`alter table knowledge_access_events drop constraint test_reject_audit`.execute(
        ctx.db,
      );
    }
  });
});
