import { expect, it } from 'vitest';
import { createTestDb } from './testing.js';

it('checks existing destination readers before creating or revising a Wiki page', async () => {
  const ctx = await createTestDb();
  try {
    for (const id of ['author', 'reader'])
      await ctx.store.upsertProject({
        id,
        owner: 'test',
        repo: id,
        containerName: id,
        state: 'active',
      });
    const k = ctx.store.knowledge;
    const space = (await k.getProjectSpace('author'))!;
    const publicFolder = await k.createFolder({
      parentId: space.sourcesFolderId,
      name: 'Shared sources',
    });
    const privateFolder = await k.createFolder({
      parentId: space.sourcesFolderId,
      name: 'Private sources',
    });
    const source = await k.createDocument({
      folderId: privateFolder.id,
      title: 'Private meeting',
      bodyMarkdown: 'Confidential decision',
    });
    const existing = await k.createDocument({
      folderId: space.wikiFolderId,
      title: 'Existing page',
      bodyMarkdown: 'Public content',
    });
    await k.setGrants('reader', [
      { folderId: space.wikiFolderId, mode: 'read' },
      { folderId: publicFolder.id, mode: 'read' },
    ]);
    await ctx.store.createSession({
      sessionId: 'job',
      projectId: 'author',
      model: 'test',
      worktree: '/job',
    });
    const job = await k.createWikiJob({
      projectId: 'author',
      sessionId: 'job',
      kind: 'ingest',
      sourceDocumentIds: [source.id],
    });
    await k.updateWikiJob(job.id, { status: 'running' });
    const actor = { projectId: 'author', sessionId: 'job', turnId: 'turn' };
    await expect(
      k.runAgent(actor, 'create', {
        folderId: space.wikiFolderId,
        title: 'Leaked page',
        bodyMarkdown: 'Confidential decision',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      k.runAgent(actor, 'edit', {
        documentId: existing.id,
        expectedRevisionId: existing.currentRevisionId,
        title: existing.title,
        bodyMarkdown: 'Confidential decision',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Denial auditing commits, so checking only the thrown error would miss a leaked revision.
    expect(await k.listDocuments({ folderId: space.wikiFolderId })).toHaveLength(1);
    expect(await k.getDocument(existing.id)).toMatchObject({
      bodyMarkdown: 'Public content',
      currentRevisionId: existing.currentRevisionId,
    });
    expect(await k.listRevisions(existing.id)).toHaveLength(1);
    await k.setGrants('reader', [{ folderId: space.rootFolderId, mode: 'read' }]);
    await expect(
      k.runAgent(actor, 'create', {
        folderId: space.wikiFolderId,
        title: 'Authorized page',
        bodyMarkdown: 'Confidential decision',
      }),
    ).resolves.toMatchObject({ bodyMarkdown: 'Confidential decision' });
  } finally {
    await ctx.close();
  }
});

it('rejects source document and subfolder moves that strand existing Wiki readers', async () => {
  const ctx = await createTestDb();
  try {
    for (const id of ['author', 'reader'])
      await ctx.store.upsertProject({
        id,
        owner: 'test',
        repo: id,
        containerName: id,
        state: 'active',
      });
    const k = ctx.store.knowledge;
    const space = (await k.getProjectSpace('author'))!;
    const publicFolder = await k.createFolder({
      parentId: space.sourcesFolderId,
      name: 'Shared sources',
    });
    const publicChild = await k.createFolder({ parentId: publicFolder.id, name: 'Meetings' });
    const privateFolder = await k.createFolder({
      parentId: space.sourcesFolderId,
      name: 'Private sources',
    });
    const source = await k.createDocument({
      folderId: publicChild.id,
      title: 'Meeting',
      bodyMarkdown: 'Decision',
    });
    await ctx.store.createSession({
      sessionId: 'job',
      projectId: 'author',
      model: 'test',
      worktree: '/job',
    });
    const job = await k.createWikiJob({
      projectId: 'author',
      sessionId: 'job',
      kind: 'ingest',
      sourceDocumentIds: [source.id],
    });
    await k.updateWikiJob(job.id, { status: 'running' });
    await k.runAgent({ projectId: 'author', sessionId: 'job', turnId: 'turn' }, 'create', {
      folderId: space.wikiFolderId,
      title: 'Summary',
      bodyMarkdown: 'Derived decision',
    });
    await k.setGrants('reader', [
      { folderId: space.wikiFolderId, mode: 'read' },
      { folderId: publicFolder.id, mode: 'read' },
    ]);
    await expect(k.moveDocument(source.id, privateFolder.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await k.getDocument(source.id)).folderId).toBe(publicChild.id);
    await expect(
      k.updateFolder(publicChild.id, { parentId: privateFolder.id }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await k.listFolders()).find((folder) => folder.id === publicChild.id)?.parentId).toBe(
      publicFolder.id,
    );
    const broader = await k.createFolder({ parentId: publicFolder.id, name: 'Other meetings' });
    await expect(k.moveDocument(source.id, broader.id)).resolves.toMatchObject({
      folderId: broader.id,
    });
  } finally {
    await ctx.close();
  }
});
