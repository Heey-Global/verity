import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { migrateToLatest } from './db.js';
import { createEmbeddedDb } from './pglite.js';
import { EventStore } from './store.js';

it('restores knowledge, revisions, grants and access provenance from a complete database archive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verity-knowledge-backup-'));
  const sourcePath = join(directory, 'source');
  const restoredPath = join(directory, 'restored');
  let source: ReturnType<typeof createEmbeddedDb> | undefined;
  let restored: ReturnType<typeof createEmbeddedDb> | undefined;
  let archiveDb: PGlite | undefined;
  try {
    source = createEmbeddedDb(sourcePath).withPlugin({
      transformQuery({ node }) {
        if (node.kind === 'RawNode') {
          const statement = node.sqlFragments.join('');
          // Cached templates can hide batches that PostgreSQL prepared queries reject.
          if (statement.includes('knowledge_')) expect(statement).not.toMatch(/;\s*\S/u);
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    await migrateToLatest(source);
    const store = new EventStore(source);
    await store.upsertProject({
      id: 'project',
      owner: 'test',
      repo: 'backup',
      containerName: 'backup',
      state: 'absent',
    });
    const actor = { projectId: 'project', sessionId: 'session', turnId: 'turn' };
    await store.createSession({
      sessionId: actor.sessionId,
      projectId: actor.projectId,
      model: 'test',
      worktree: '/test-backup',
    });
    const folder = await store.knowledge.createFolder({ name: 'Library' });
    const document = await store.knowledge.createDocument({
      folderId: folder.id,
      title: 'reference.md',
      bodyMarkdown: '# Original\n\n[Source](https://example.com)',
    });
    await store.knowledge.setGrants(actor.projectId, [{ folderId: folder.id, mode: 'read_write' }]);
    await store.knowledge.runAgent(actor, 'edit', {
      documentId: document.id,
      expectedRevisionId: document.currentRevisionId,
      title: document.title,
      bodyMarkdown: '# Revised\n\nDurable shared knowledge.',
    });
    await store.knowledge.setGrants(actor.projectId, []);
    await store.knowledge.setGrants(actor.projectId, [{ folderId: folder.id, mode: 'read_write' }]);
    const freshActor = { ...actor, sessionId: 'fresh-session' };
    await store.createSession({
      sessionId: freshActor.sessionId,
      projectId: actor.projectId,
      model: 'test',
      worktree: '/fresh-backup',
    });
    const expected = {
      document: await store.knowledge.getDocument(document.id),
      revisions: await store.knowledge.listRevisions(document.id),
      grants: await store.knowledge.getGrants(actor.projectId),
      folders: await store.knowledge.listFolders(),
      invalidated: await store.knowledge.listInvalidatedSessions(),
      audit: await source.selectFrom('knowledge_access_events').selectAll().orderBy('id').execute(),
    };
    await store.waitForMessageProjectionIdle();
    await source.destroy();
    source = undefined;

    archiveDb = new PGlite(sourcePath);
    const archive = await archiveDb.dumpDataDir();
    await archiveDb.close();
    archiveDb = undefined;
    // A reopen of the original database would mask tables missing from the backup.
    await rm(sourcePath, { recursive: true, force: true });
    archiveDb = new PGlite(restoredPath, { loadDataDir: archive });
    await archiveDb.waitReady;
    await archiveDb.close();
    archiveDb = undefined;

    restored = createEmbeddedDb(restoredPath);
    await migrateToLatest(restored);
    const recovered = new EventStore(restored);
    expect(await recovered.knowledge.getDocument(document.id)).toEqual(expected.document);
    expect(await recovered.knowledge.listRevisions(document.id)).toEqual(expected.revisions);
    expect(await recovered.knowledge.getGrants(actor.projectId)).toEqual(expected.grants);
    expect(await recovered.knowledge.listFolders()).toEqual(expected.folders);
    expect(await recovered.knowledge.listInvalidatedSessions()).toEqual(expected.invalidated);
    expect(
      await restored.selectFrom('knowledge_access_events').selectAll().orderBy('id').execute(),
    ).toEqual(expected.audit);
    expect(await recovered.knowledge.hasSessionKnowledgeExposure(actor.sessionId)).toBe(true);
    await expect(
      recovered.knowledge.runAgent(freshActor, 'read', { documentId: document.id }),
    ).resolves.toEqual(expected.document);
    await expect(
      recovered.knowledge.runAgent(actor, 'read', { documentId: document.id }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await recovered.waitForMessageProjectionIdle();
  } finally {
    await archiveDb?.close();
    await source?.destroy();
    await restored?.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
