import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from './testing.js';
import type { KnowledgeDocument } from './knowledge.js';
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
async function project(id: string) {
  await ctx.store.upsertProject({
    id,
    owner: 'test',
    repo: id,
    containerName: id,
    state: 'absent',
    overviewVisible: true,
  });
  return (await ctx.store.knowledge.getProjectSpace(id))!;
}
it('does not expose GitHub installation placeholders as Knowledge projects', async () => {
  await ctx.store.upsertProject({
    id: 'placeholder',
    owner: 'test',
    repo: 'available-repository',
    containerName: 'available-repository',
    state: 'absent',
  });
  expect(await ctx.store.knowledge.getProjectSpace('placeholder')).toBeNull();

  const adopted = await project('adopted');
  await ctx.db
    .updateTable('projects')
    .set({ overview_visible: false })
    .where('id', '=', 'adopted')
    .execute();
  expect(
    (await ctx.store.knowledge.listFolders()).some((folder) => folder.id === adopted.rootFolderId),
  ).toBe(false);
});
async function session(projectId: string, sessionId: string) {
  await ctx.store.createSession({
    projectId,
    sessionId,
    worktree: '/test/' + sessionId,
    model: 'test',
  });
  return { projectId, sessionId, turnId: 'turn' };
}
it('creates stable separate project spaces and fixed General access without adopting same-name folders', async () => {
  const manual = await ctx.store.knowledge.createFolder({ name: 'a' });
  const a = await project('a'),
    b = await project('b');
  expect(a.rootFolderId).not.toBe(manual.id);
  expect(a.rootFolderId).not.toBe(b.rootFolderId);
  expect(a.generalFolderId).toBe(b.generalFolderId);
  expect(await project('a')).toEqual(a);
  const grants = await ctx.store.knowledge.setGrants('a', []);
  expect(grants).toEqual(
    expect.arrayContaining([
      { folderId: a.generalFolderId, mode: 'read', fixed: 'general' },
      { folderId: a.wikiFolderId, mode: 'read_write', fixed: 'project' },
    ]),
  );
  const actor = await session('a', 's');
  await expect(
    ctx.store.knowledge.runAgent(actor, 'create', {
      folderId: a.sourcesFolderId,
      title: 'overwrite',
      bodyMarkdown: 'bad',
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    ctx.store.knowledge.runAgent(actor, 'create', {
      folderId: a.wikiFolderId,
      title: 'unscoped',
      bodyMarkdown: 'bad',
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await expect(ctx.store.knowledge.deleteFolder(a.rootFolderId)).rejects.toMatchObject({
    code: 'forbidden',
  });
  await expect(
    ctx.store.knowledge.updateFolder(a.wikiFolderId, { parentId: b.rootFolderId }),
  ).rejects.toMatchObject({ code: 'forbidden' });
});
it('preserves archived knowledge and explicit shares when its project is deleted', async () => {
  const a = await project('a');
  await project('b');
  await ctx.store.knowledge.setGrants('b', [{ folderId: a.rootFolderId, mode: 'read' }]);
  await ctx.store.deleteProject('a');
  expect(await ctx.store.knowledge.getProjectSpace('a')).toBeNull();
  expect(
    (await ctx.store.knowledge.listFolders()).find((f) => f.id === a.rootFolderId),
  ).toMatchObject({ archived: true });
  expect(await ctx.store.knowledge.getGrants('b')).toEqual(
    expect.arrayContaining([{ folderId: a.rootFolderId, mode: 'read' }]),
  );
});
it('freezes an explicitly approved overview revision across Wiki edits', async () => {
  const a = await project('a');
  const k = ctx.store.knowledge;
  const doc = await k.createDocument({
    folderId: a.wikiFolderId,
    title: 'Overview',
    bodyMarkdown: 'approved',
  });
  await ctx.store.updateProjectSettings('a', { memory: 'Preserved legacy notes' });
  await k.approveProjectOverview('a', doc.id, doc.currentRevisionId);
  await expect(ctx.store.appendProjectMemory('a', 'Invisible append')).rejects.toMatchObject({
    code: 'conflict',
  });
  expect((await ctx.store.getProjectSettingsRaw('a'))?.memory).toBe('Preserved legacy notes');
  await k.updateDocument(doc.id, {
    expectedRevisionId: doc.currentRevisionId,
    title: 'Overview',
    bodyMarkdown: 'unapproved',
  });
  expect(await k.getProjectOverview('a')).toMatchObject({
    bodyMarkdown: 'approved',
    revisionId: doc.currentRevisionId,
  });
  await k.clearProjectOverview('a');
  expect(await k.getProjectOverview('a')).toBeNull();
  await ctx.store.appendProjectMemory('a', 'Visible after rollback');
  expect((await ctx.store.getProjectSettingsRaw('a'))?.memory).toContain('Visible after rollback');
});
it('isolates a fresh Wiki job from extras, pins selected sources and records provenance before sharing', async () => {
  const a = await project('a');
  await project('b');
  const k = ctx.store.knowledge;
  const source = await k.createDocument({
    folderId: a.sourcesFolderId,
    title: 'Meeting',
    bodyMarkdown: 'private meeting',
  });
  const general = await k.createDocument({
    folderId: a.generalFolderId,
    title: 'General',
    bodyMarkdown: 'other context',
  });
  const actor = await session('a', 'job');
  const job = await k.createWikiJob({
    projectId: 'a',
    sessionId: 'job',
    sourceDocumentIds: [source.id],
    kind: 'ingest',
  });
  await k.updateWikiJob(job.id, { status: 'running' });
  await expect(k.runAgent(actor, 'read', { documentId: general.id })).rejects.toMatchObject({
    code: 'forbidden',
  });
  expect(await k.runAgent(actor, 'read', { documentId: source.id })).toMatchObject({
    bodyMarkdown: 'private meeting',
  });
  const page = (await k.runAgent(actor, 'create', {
    folderId: a.wikiFolderId,
    title: 'Meeting overview',
    bodyMarkdown: 'derived private meeting',
  })) as KnowledgeDocument;
  expect(
    await ctx.db
      .selectFrom('knowledge_provenance')
      .selectAll()
      .where('revision_id', '=', page.currentRevisionId)
      .executeTakeFirst(),
  ).toMatchObject({ job_id: job.id });
  await expect(
    k.setGrants('b', [{ folderId: a.wikiFolderId, mode: 'read' }]),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await k.setGrants('b', [{ folderId: a.rootFolderId, mode: 'read' }]);
  await k.updateDocument(source.id, {
    expectedRevisionId: source.currentRevisionId,
    title: source.title,
    bodyMarkdown: 'changed',
  });
  await expect(
    k.runAgent(actor, 'create', {
      folderId: a.wikiFolderId,
      title: 'Stale',
      bodyMarkdown: 'stale',
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await k.updateWikiJob(job.id, { status: 'completed' });
  await expect(k.runAgent(actor, 'read', { documentId: source.id })).rejects.toMatchObject({
    code: 'forbidden',
  });
});
it('rejects reused job contexts and closes interrupted jobs on restart', async () => {
  const a = await project('a');
  const k = ctx.store.knowledge;
  const source = await k.createDocument({
    folderId: a.sourcesFolderId,
    title: 'Source',
    bodyMarkdown: 'source',
  });
  await session('a', 'used');
  await ctx.db
    .insertInto('transcript_lines')
    .values({ session_id: 'used', line: 'previous private context' })
    .execute();
  await expect(
    k.createWikiJob({
      projectId: 'a',
      sessionId: 'used',
      sourceDocumentIds: [source.id],
      kind: 'ingest',
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  const actor = await session('a', 'fresh');
  const job = await k.createWikiJob({
    projectId: 'a',
    sessionId: 'fresh',
    sourceDocumentIds: [source.id],
    kind: 'ingest',
  });
  await k.updateWikiJob(job.id, { status: 'running' });
  expect(await k.recoverWikiJobs()).toBe(1);
  expect(await k.getWikiJobForSession('fresh')).toMatchObject({ status: 'failed' });
  await expect(k.runAgent(actor, 'read', { documentId: source.id })).rejects.toMatchObject({
    code: 'forbidden',
  });
});
it('does not silently restore legacy memory by deleting an approved overview', async () => {
  const a = await project('a');
  const k = ctx.store.knowledge;
  const folder = await k.createFolder({ parentId: a.wikiFolderId, name: 'Brief' });
  const doc = await k.createDocument({
    folderId: folder.id,
    title: 'Overview',
    bodyMarkdown: 'approved',
  });
  await k.approveProjectOverview('a', doc.id, doc.currentRevisionId);
  await expect(k.deleteDocument(doc.id)).rejects.toMatchObject({ code: 'conflict' });
  await expect(k.deleteFolder(folder.id)).rejects.toMatchObject({ code: 'conflict' });
  await k.clearProjectOverview('a');
  await k.deleteFolder(folder.id);
});

it('archives and unlinks on UI soft deletion without recreating knowledge during repository sync', async () => {
  const original = await project('a');
  await project('b');
  const k = ctx.store.knowledge;
  await k.setGrants('b', [{ folderId: original.rootFolderId, mode: 'read' }]);
  await ctx.store.hideProject('a');
  expect(await k.getProjectSpace('a')).toBeNull();
  await ctx.store.upsertProject({
    id: 'ignored-sync-id',
    owner: 'test',
    repo: 'a',
    containerName: 'a',
    state: 'absent',
  });
  expect(await k.getProjectSpace('a')).toBeNull();
  expect((await k.listFolders()).find((f) => f.id === original.rootFolderId)).toMatchObject({
    archived: true,
  });
  expect(await k.getGrants('b')).toEqual(
    expect.arrayContaining([{ folderId: original.rootFolderId, mode: 'read' }]),
  );
});
