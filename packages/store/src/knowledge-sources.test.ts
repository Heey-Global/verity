import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { migrateToLatest } from './db.js';
import { createEmbeddedDb } from './pglite.js';
import { EventStore } from './store.js';
import type { KnowledgeSourceInput } from './knowledge-sources.js';

it('database archives retain exact original revisions, extraction and previews after replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verity-original-backup-'));
  const sourcePath = join(directory, 'source'),
    restoredPath = join(directory, 'restored');
  let source: ReturnType<typeof createEmbeddedDb> | undefined;
  let restored: ReturnType<typeof createEmbeddedDb> | undefined;
  let archiveDb: PGlite | undefined;
  try {
    source = createEmbeddedDb(sourcePath);
    await migrateToLatest(source);
    const store = new EventStore(source);
    const folder = await store.knowledge.createFolder({ name: 'Original source files' });
    const input: KnowledgeSourceInput = {
      filename: 'original.bin',
      bytes: Buffer.from([0, 255, 10]),
      mediaType: 'application/octet-stream',
      processingState: 'unsupported',
      processingNote: 'Original retained',
      locators: [],
      previews: [],
    };
    const document = await store.knowledge.createSourceDocument(
      { folderId: folder.id, title: input.filename, bodyMarkdown: input.processingNote },
      (tx, doc) => store.knowledge.sources.attachRevision(tx, doc.currentRevisionId, input),
    );
    const first = await store.knowledge.sources.getRevision(document.currentRevisionId);
    const replacement = await store.knowledge.updateSourceDocument(
      document.id,
      {
        expectedRevisionId: document.currentRevisionId,
        title: input.filename,
        bodyMarkdown: 'Replacement',
      },
      (tx, doc) =>
        store.knowledge.sources.attachRevision(tx, doc.currentRevisionId, {
          ...input,
          bytes: Buffer.from('replacement'),
        }),
    );
    const second = await store.knowledge.sources.getRevision(replacement.currentRevisionId);
    await source.destroy();
    source = undefined;
    archiveDb = new PGlite(sourcePath);
    const archive = await archiveDb.dumpDataDir();
    await archiveDb.close();
    archiveDb = undefined;
    // Reopening the source would hide omitted original-byte storage in the archive.
    await rm(sourcePath, { recursive: true, force: true });
    archiveDb = new PGlite(restoredPath, { loadDataDir: archive });
    await archiveDb.waitReady;
    await archiveDb.close();
    archiveDb = undefined;
    restored = createEmbeddedDb(restoredPath);
    await migrateToLatest(restored);
    const recovered = new EventStore(restored);
    expect(await recovered.knowledge.sources.getRevision(document.currentRevisionId)).toEqual(
      first,
    );
    expect(await recovered.knowledge.sources.getRevision(replacement.currentRevisionId)).toEqual(
      second,
    );
    expect((await recovered.knowledge.getDocument(document.id)).currentRevisionId).toBe(
      replacement.currentRevisionId,
    );
  } finally {
    await archiveDb?.close();
    await source?.destroy();
    await restored?.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
