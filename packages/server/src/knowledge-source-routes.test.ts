import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@verity/store/testing';
import { registerKnowledgeSourceRoutes } from './knowledge-source-routes.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
it('uploads, replaces and downloads immutable originals with attachment headers', async () => {
  const app = Fastify();
  registerKnowledgeSourceRoutes(app, { knowledge: ctx.store.knowledge });
  try {
    const folder = await ctx.store.knowledge.createFolder({ name: 'Original files' });
    const bytes = Buffer.from([0, 255, 42, 100]);
    const response = await app.inject({
      method: 'POST',
      url: '/knowledge/sources',
      payload: { folderId: folder.id, filename: 'original.bin', base64: bytes.toString('base64') },
    });
    expect(response.statusCode).toBe(200);
    const uploaded = response.json<{
      document: { id: string; currentRevisionId: string };
      source: { sha256: string; size: number };
    }>();
    expect(uploaded.source.size).toBe(bytes.length);
    const replacement = await app.inject({
      method: 'PUT',
      url: `/knowledge/documents/${uploaded.document.id}/source`,
      payload: {
        expectedRevisionId: uploaded.document.currentRevisionId,
        filename: 'replacement.bin',
        base64: Buffer.from('new bytes').toString('base64'),
      },
    });
    expect(replacement.statusCode).toBe(200);
    const original = await app.inject({
      method: 'GET',
      url: `/knowledge/documents/${uploaded.document.id}/original?revisionId=${uploaded.document.currentRevisionId}`,
    });
    expect(original.rawPayload).toEqual(bytes);
    expect(original.headers['x-content-type-options']).toBe('nosniff');
    expect(original.headers['content-disposition']).toContain('attachment;');
    const latest = await app.inject({
      method: 'GET',
      url: `/knowledge/documents/${uploaded.document.id}/original`,
    });
    expect(latest.rawPayload).toEqual(Buffer.from('new bytes'));
    const conflict = await app.inject({
      method: 'PUT',
      url: `/knowledge/documents/${uploaded.document.id}/source`,
      payload: {
        expectedRevisionId: uploaded.document.currentRevisionId,
        filename: 'late.bin',
        base64: bytes.toString('base64'),
      },
    });
    expect(conflict.statusCode).toBe(409);
    const roundTrip = await app.inject({
      method: 'POST',
      url: '/knowledge/sources',
      payload: {
        folderId: folder.id,
        filename: 'roundtrip.bin',
        base64: original.rawPayload.toString('base64'),
      },
    });
    expect(roundTrip.json<{ source: { sha256: string } }>().source.sha256).toBe(
      uploaded.source.sha256,
    );
  } finally {
    await app.close();
  }
});
it('does not expose originals by revision id belonging to another document', async () => {
  const app = Fastify();
  registerKnowledgeSourceRoutes(app, { knowledge: ctx.store.knowledge });
  try {
    const folder = await ctx.store.knowledge.createFolder({ name: 'Revision boundaries' });
    const a = await ctx.store.knowledge.createDocument({
      folderId: folder.id,
      title: 'a',
      bodyMarkdown: '',
    });
    const b = await ctx.store.knowledge.createDocument({
      folderId: folder.id,
      title: 'b',
      bodyMarkdown: '',
    });
    const response = await app.inject({
      url: `/knowledge/documents/${a.id}/original?revisionId=${b.currentRevisionId}`,
    });
    expect(response.statusCode).toBe(404);
    const metadata = await app.inject({ url: `/knowledge/documents/${a.id}/source` });
    expect(metadata.json()).toEqual({ source: null });
  } finally {
    await app.close();
  }
});

it('round-trips a portable folder with exact originals and rejects a corrupted bundle atomically', async () => {
  const app = Fastify();
  registerKnowledgeSourceRoutes(app, { knowledge: ctx.store.knowledge });
  try {
    const source = await ctx.store.knowledge.createFolder({ name: 'Export source' });
    const target = await ctx.store.knowledge.createFolder({ name: 'Import target' });
    const empty = await ctx.store.knowledge.createFolder({ name: 'Corrupt target' });
    const bytes = Buffer.from('source for portable export');
    await app.inject({
      method: 'POST',
      url: '/knowledge/sources',
      payload: { folderId: source.id, filename: 'sample.bin', base64: bytes.toString('base64') },
    });
    const exported = await app.inject({ url: `/knowledge/source-bundle?folderId=${source.id}` });
    expect(exported.statusCode).toBe(200);
    const bundle = exported.json<{
      version: 1;
      documents: { path: string; bodyMarkdown: string; original: { base64: string } }[];
    }>();
    expect(Buffer.from(bundle.documents[0]!.original.base64, 'base64')).toEqual(bytes);
    const imported = await app.inject({
      method: 'POST',
      url: '/knowledge/source-bundle',
      payload: { ...bundle, folderId: target.id },
    });
    expect(imported.json()).toEqual({ imported: 1 });
    const secondExport = await app.inject({
      url: `/knowledge/source-bundle?folderId=${target.id}`,
    });
    expect(secondExport.json()).toEqual(bundle);
    bundle.documents[0]!.original.base64 = Buffer.from('corrupted').toString('base64');
    const rejected = await app.inject({
      method: 'POST',
      url: '/knowledge/source-bundle',
      payload: { ...bundle, folderId: empty.id },
    });
    expect(rejected.statusCode).toBe(400);
    expect(await ctx.store.knowledge.exportDocuments(empty.id)).toEqual([]);
  } finally {
    await app.close();
  }
});

it('refuses to emit a source bundle larger than the matching import route accepts', async () => {
  const app = Fastify();
  const base64 = Buffer.alloc(8 * 1024 * 1024).toString('base64');
  const original = {
    filename: 'large.bin',
    mediaType: 'application/octet-stream',
    sha256: '0'.repeat(64),
    processingState: 'ready' as const,
    processingNote: '',
    locators: [],
    previews: [],
    base64,
  };
  registerKnowledgeSourceRoutes(app, {
    knowledge: {
      exportDocuments: () =>
        Promise.resolve([
          { path: 'a.md', bodyMarkdown: '', original },
          { path: 'b.md', bodyMarkdown: '', original },
        ]),
    } as unknown as Parameters<typeof registerKnowledgeSourceRoutes>[1]['knowledge'],
  });
  try {
    const response = await app.inject({ url: '/knowledge/source-bundle' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid' });
  } finally {
    await app.close();
  }
});
