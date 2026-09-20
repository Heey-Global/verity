import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from './testing.js';
import type { KnowledgeDocument } from './knowledge.js';
import type { KnowledgeSourceInput } from './knowledge-sources.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

async function derivedPage() {
  await ctx.store.upsertProject({
    id: 'project',
    owner: 'test',
    repo: 'test',
    containerName: 'test',
    state: 'absent',
  });
  const k = ctx.store.knowledge;
  const space = (await k.getProjectSpace('project'))!;
  const original: KnowledgeSourceInput = {
    filename: 'meeting.txt',
    bytes: Buffer.from('original'),
    mediaType: 'text/plain',
    processingState: 'ready',
    processingNote: 'Extracted text',
    locators: [{ label: 'Document', text: 'original' }],
    previews: [],
  };
  const source = await k.createSourceDocument(
    { folderId: space.sourcesFolderId, title: original.filename, bodyMarkdown: 'original' },
    (tx, doc) => k.sources.attachRevision(tx, doc.currentRevisionId, original),
  );
  await ctx.store.createSession({
    projectId: 'project',
    sessionId: 'job-session',
    worktree: '/test',
    model: 'test',
  });
  const job = await k.createWikiJob({
    projectId: 'project',
    sessionId: 'job-session',
    kind: 'ingest',
    sourceDocumentIds: [source.id],
  });
  await k.updateWikiJob(job.id, { status: 'running' });
  const actor = { projectId: 'project', sessionId: 'job-session', turnId: 'turn' };
  const page = (await k.runAgent(actor, 'create', {
    folderId: space.wikiFolderId,
    title: 'Overview',
    bodyMarkdown: 'Derived from meeting',
  })) as KnowledgeDocument;
  await k.updateWikiJob(job.id, { status: 'completed' });
  return { k, space, source, page, original };
}

it('marks derived Wiki reads and listings stale when an original source is replaced', async () => {
  const { k, space, source, page, original } = await derivedPage();
  expect((await k.getDocument(page.id)).stale).not.toBe(true);
  await k.updateSourceDocument(
    source.id,
    {
      expectedRevisionId: source.currentRevisionId,
      title: source.title,
      bodyMarkdown: 'replacement',
    },
    (tx, doc) =>
      k.sources.attachRevision(tx, doc.currentRevisionId, {
        ...original,
        bytes: Buffer.from('replacement'),
        locators: [{ label: 'Document', text: 'replacement' }],
      }),
  );
  expect((await k.getDocument(page.id)).stale).toBe(true);
  expect(await k.listDocuments({ folderId: space.wikiFolderId })).toContainEqual(
    expect.objectContaining({ id: page.id, stale: true }),
  );
  expect((await k.getDocument(page.id)).bodyMarkdown).toBe(page.bodyMarkdown);
  expect((await k.sources.getRevision(source.currentRevisionId)).bytes.toString()).toBe('original');
  expect(
    await k.restoreDocument(page.id, {
      revisionId: page.currentRevisionId,
      expectedRevisionId: page.currentRevisionId,
    }),
  ).toMatchObject({ stale: true });
});

it('keeps derived pages visibly stale after their source is deleted', async () => {
  const { k, page, source } = await derivedPage();
  await k.deleteDocument(source.id);
  expect((await k.getDocument(page.id)).stale).toBe(true);
});

it('preserves stale provenance when a derived Wiki page is edited manually', async () => {
  const { k, page, source } = await derivedPage();
  await k.deleteDocument(source.id);
  const edited = await k.updateDocument(page.id, {
    expectedRevisionId: page.currentRevisionId,
    title: page.title,
    bodyMarkdown: 'Manual clarification',
  });
  expect(edited.stale).toBe(true);
  expect((await k.getDocument(page.id)).stale).toBe(true);
});

it('allows a read-only check of Wiki pages whose original source was deleted', async () => {
  const { k, page, source } = await derivedPage();
  await k.deleteDocument(source.id);
  await ctx.store.createSession({
    projectId: 'project',
    sessionId: 'check-session',
    worktree: '/check',
    model: 'test',
  });
  const job = await k.createWikiJob({
    projectId: 'project',
    sessionId: 'check-session',
    kind: 'check',
    sourceDocumentIds: [],
  });
  expect(job.sourceRevisions).toEqual([]);
  await k.updateWikiJob(job.id, { status: 'running' });
  const actor = { projectId: 'project', sessionId: 'check-session', turnId: 'check-turn' };
  expect(await k.runAgent(actor, 'read', { documentId: page.id })).toMatchObject({
    id: page.id,
    stale: true,
  });
  await expect(
    k.runAgent(actor, 'edit', {
      documentId: page.id,
      expectedRevisionId: page.currentRevisionId,
      title: page.title,
      bodyMarkdown: 'overwrite',
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    k.runAgent(actor, 'create', {
      folderId: page.folderId,
      title: 'New page',
      bodyMarkdown: 'create',
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
});

it('allows a new ingest to replace a deleted historical source without reading its stale Wiki', async () => {
  const { k, source, page, space } = await derivedPage();
  await k.deleteDocument(source.id);
  const replacement = await k.createDocument({
    folderId: space.sourcesFolderId,
    title: 'Replacement',
    bodyMarkdown: 'Current source',
  });
  await ctx.store.createSession({
    projectId: 'project',
    sessionId: 'replacement-ingest',
    worktree: '/replacement-ingest',
    model: 'test',
  });
  const job = await k.createWikiJob({
    projectId: 'project',
    sessionId: 'replacement-ingest',
    kind: 'ingest',
    sourceDocumentIds: [replacement.id],
  });
  expect(job.sourceRevisions).toEqual([
    { documentId: replacement.id, revisionId: replacement.currentRevisionId },
  ]);
  await k.updateWikiJob(job.id, { status: 'running' });
  const replacementActor = {
    projectId: 'project',
    sessionId: 'replacement-ingest',
    turnId: 'replacement-turn',
  };
  await expect(k.runAgent(replacementActor, 'read', { documentId: page.id })).rejects.toMatchObject(
    { code: 'forbidden' },
  );
  const refreshed = (await k.runAgent(replacementActor, 'create', {
    folderId: space.wikiFolderId,
    title: 'Refreshed',
    bodyMarkdown: 'Includes the prior Wiki context',
  })) as KnowledgeDocument;
  const provenance = await ctx.db
    .selectFrom('knowledge_provenance')
    .select('source_revisions')
    .where('revision_id', '=', refreshed.currentRevisionId)
    .executeTakeFirstOrThrow();
  expect(JSON.parse(provenance.source_revisions)).toEqual(job.sourceRevisions);
});

it('allows unrelated maintenance after a historical source moves outside project Sources', async () => {
  const { k, source, page, space } = await derivedPage();
  await k.moveDocument(source.id, space.generalFolderId);
  const replacement = await k.createDocument({
    folderId: space.sourcesFolderId,
    title: 'Unrelated current source',
    bodyMarkdown: 'Current source',
  });
  await ctx.store.createSession({
    projectId: 'project',
    sessionId: 'moved-source-ingest',
    worktree: '/moved-source-ingest',
    model: 'test',
  });
  const job = await k.createWikiJob({
    projectId: 'project',
    sessionId: 'moved-source-ingest',
    kind: 'ingest',
    sourceDocumentIds: [replacement.id],
  });
  expect(job.sourceRevisions).toEqual([
    { documentId: replacement.id, revisionId: replacement.currentRevisionId },
  ]);
  await k.updateWikiJob(job.id, { status: 'running' });
  await expect(
    k.runAgent({ projectId: 'project', sessionId: 'moved-source-ingest', turnId: 'turn' }, 'read', {
      documentId: page.id,
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
});

it('does not expose Wiki pages created after an ingest snapshot', async () => {
  const { k, space, source } = await derivedPage();
  await ctx.store.createSession({
    projectId: 'project',
    sessionId: 'snapshot-ingest',
    worktree: '/snapshot-ingest',
    model: 'test',
  });
  const job = await k.createWikiJob({
    projectId: 'project',
    sessionId: 'snapshot-ingest',
    kind: 'ingest',
    sourceDocumentIds: [source.id],
  });
  const later = await k.createDocument({
    folderId: space.wikiFolderId,
    title: 'Later private page',
    bodyMarkdown: 'Created after the snapshot',
  });
  await k.updateWikiJob(job.id, { status: 'running' });
  const actor = { projectId: 'project', sessionId: 'snapshot-ingest', turnId: 'snapshot-turn' };
  await expect(k.runAgent(actor, 'read', { documentId: later.id })).rejects.toMatchObject({
    code: 'forbidden',
  });
  expect(await k.runAgent(actor, 'search', { query: 'Later private page' })).toEqual([]);
});

it('applies captured document visibility before search pagination', async () => {
  const { k, space } = await derivedPage();
  await k.createDocument({
    folderId: space.sourcesFolderId,
    title: 'Match first but unselected',
    bodyMarkdown: 'Match',
  });
  const selected = await k.createDocument({
    folderId: space.sourcesFolderId,
    title: 'Match selected',
    bodyMarkdown: 'Match',
  });
  await ctx.store.createSession({
    projectId: 'project',
    sessionId: 'pagination-ingest',
    worktree: '/pagination-ingest',
    model: 'test',
  });
  const job = await k.createWikiJob({
    projectId: 'project',
    sessionId: 'pagination-ingest',
    kind: 'ingest',
    sourceDocumentIds: [selected.id],
  });
  await k.updateWikiJob(job.id, { status: 'running' });
  await expect(
    k.runAgent({ projectId: 'project', sessionId: 'pagination-ingest', turnId: 'turn' }, 'search', {
      query: 'Match',
      limit: 1,
    }),
  ).resolves.toEqual([expect.objectContaining({ id: selected.id })]);
});

it('invalidates a running ingest when a captured source is deleted', async () => {
  const { k, space, source } = await derivedPage();
  await ctx.store.createSession({
    projectId: 'project',
    sessionId: 'deleted-during-ingest',
    worktree: '/deleted-during-ingest',
    model: 'test',
  });
  const job = await k.createWikiJob({
    projectId: 'project',
    sessionId: 'deleted-during-ingest',
    kind: 'ingest',
    sourceDocumentIds: [source.id],
  });
  await k.updateWikiJob(job.id, { status: 'running' });
  await k.deleteDocument(source.id);
  await expect(
    k.runAgent(
      { projectId: 'project', sessionId: 'deleted-during-ingest', turnId: 'turn' },
      'create',
      { folderId: space.wikiFolderId, title: 'Unsafe', bodyMarkdown: 'Unsafe' },
    ),
  ).rejects.toMatchObject({ code: 'forbidden' });
});

it('lets a fresh ingest read and refresh a page made stale by the same source', async () => {
  const { k, page, source, original } = await derivedPage();
  const replaced = await k.updateSourceDocument(
    source.id,
    {
      expectedRevisionId: source.currentRevisionId,
      title: source.title,
      bodyMarkdown: 'replacement',
    },
    (tx, doc) =>
      k.sources.attachRevision(tx, doc.currentRevisionId, {
        ...original,
        bytes: Buffer.from('replacement'),
        locators: [{ label: 'Document', text: 'replacement' }],
      }),
  );
  await ctx.store.createSession({
    projectId: 'project',
    sessionId: 'refresh-ingest',
    worktree: '/refresh-ingest',
    model: 'test',
  });
  const job = await k.createWikiJob({
    projectId: 'project',
    sessionId: 'refresh-ingest',
    kind: 'ingest',
    sourceDocumentIds: [replaced.id],
  });
  await k.updateWikiJob(job.id, { status: 'running' });
  const actor = { projectId: 'project', sessionId: 'refresh-ingest', turnId: 'turn' };
  await expect(k.runAgent(actor, 'read', { documentId: page.id })).resolves.toMatchObject({
    id: page.id,
    stale: true,
  });
  await expect(
    k.runAgent(actor, 'edit', {
      documentId: page.id,
      expectedRevisionId: page.currentRevisionId,
      title: page.title,
      bodyMarkdown: 'Refreshed content',
    }),
  ).resolves.toMatchObject({ bodyMarkdown: 'Refreshed content' });
  expect((await k.getDocument(page.id)).stale).not.toBe(true);
});

it('allows unrelated grants to be revoked after a Wiki source is deleted', async () => {
  const { k, source } = await derivedPage();
  const unrelated = await k.createFolder({ name: 'Temporary access' });
  await k.setGrants('project', [{ folderId: unrelated.id, mode: 'read' }]);
  await k.deleteDocument(source.id);
  await expect(k.setGrants('project', [])).resolves.toEqual(
    expect.not.arrayContaining([expect.objectContaining({ folderId: unrelated.id })]),
  );
});

it('does not retain shared Wiki access when its source grant is revoked', async () => {
  const { k, space } = await derivedPage();
  await ctx.store.upsertProject({
    id: 'reader',
    owner: 'test',
    repo: 'reader',
    containerName: 'reader',
    state: 'absent',
  });
  await k.setGrants('reader', [
    { folderId: space.sourcesFolderId, mode: 'read' },
    { folderId: space.wikiFolderId, mode: 'read' },
  ]);
  await expect(
    k.setGrants('reader', [{ folderId: space.wikiFolderId, mode: 'read' }]),
  ).rejects.toMatchObject({ code: 'forbidden' });
});

it('rejects misleading write selections below managed Sources and General', async () => {
  const { k, space } = await derivedPage();
  const nested = await k.createFolder({ parentId: space.sourcesFolderId, name: 'Meetings' });
  const generalChild = await k.createFolder({ parentId: space.generalFolderId, name: 'Shared' });
  for (const folderId of [
    space.sourcesFolderId,
    nested.id,
    space.generalFolderId,
    generalChild.id,
  ]) {
    await expect(k.setGrants('project', [{ folderId, mode: 'read_write' }])).rejects.toMatchObject({
      code: 'forbidden',
    });
  }
  const grants = await k.getGrants('project');
  expect(grants).toContainEqual({
    folderId: space.wikiFolderId,
    mode: 'read_write',
    fixed: 'project',
  });
});
