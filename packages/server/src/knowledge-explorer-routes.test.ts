import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { InMemoryEventBus, type Conductor } from '@verity/session';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const observation = vi.hoisted(() => ({
  extractionFailure: false,
  pruningFailure: false,
  attempts: 0,
  path: '',
  root: '',
  depths: [] as number[],
  held: new Map<string, number>(),
}));
vi.mock('./session-file-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session-file-history.js')>();
  return {
    ...actual,
    pruneFileHistory: async (...args: Parameters<typeof actual.pruneFileHistory>) => {
      if (observation.pruningFailure)
        throw Object.assign(new Error('read-only history'), { code: 'EROFS' });
      return actual.pruneFileHistory(...args);
    },
  };
});
vi.mock('./knowledge-mutation-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./knowledge-mutation-lock.js')>();
  return {
    ...actual,
    acquireKnowledgeMutationLock: async (root: string) => {
      observation.attempts++;
      const release = await actual.acquireKnowledgeMutationLock(root);
      observation.held.set(root, (observation.held.get(root) ?? 0) + 1);
      return () => {
        observation.held.set(root, (observation.held.get(root) ?? 1) - 1);
        release();
      };
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (typeof args[0] === 'string' && args[0] === observation.path)
        observation.depths.push(observation.held.get(observation.root) ?? 0);
      return actual.open(...args);
    },
  };
});
vi.mock('./knowledge-file-ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./knowledge-file-ingest.js')>();
  return {
    ...actual,
    extractKnowledgeFile: async (...args: Parameters<typeof actual.extractKnowledgeFile>) => {
      if (observation.extractionFailure) throw new Error('extraction unavailable');
      return actual.extractKnowledgeFile(...args);
    },
  };
});

import {
  EXTRACTED_TEXT_DIR,
  PROJECT_KNOWLEDGE_TOP_LEVEL_DIRS,
  projectKnowledgeDir,
  SHARED_KNOWLEDGE_DIR,
  sharedKnowledgeDir,
} from './knowledge-folder.js';
import { buildServer } from './server.js';
import { knowledgeExtractionPath } from './knowledge-file-ingest.js';
import { fileVersion } from './session-file-write.js';

/**
 * The session explorer's knowledge roots (ADR 0022 D2). What is being guarded is
 * the boundary between the three roots: the worktree stays what it was, and the
 * two knowledge roots are the only ones the explorer may change.
 */
describe('session explorer knowledge roots', () => {
  let ctx: TestDb;
  let app: FastifyInstance;
  let dataRoot: string;
  let worktree: string;
  let looseWorktree: string;

  const upload = (url: string, payload: string): Promise<ReturnType<typeof app.inject>> =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(Buffer.byteLength(payload)),
      },
      payload: Readable.from([Buffer.from(payload)]),
    }) as unknown as Promise<ReturnType<typeof app.inject>>;

  beforeAll(async () => {
    ctx = await createTestDb();
    dataRoot = mkdtempSync(join(tmpdir(), 'verity-knowledge-routes-'));
    worktree = mkdtempSync(join(tmpdir(), 'verity-knowledge-wt-'));
    looseWorktree = mkdtempSync(join(tmpdir(), 'verity-knowledge-wt-'));
    app = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: {} as Conductor,
      dataRoot,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await ctx.close();
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    rmSync(looseWorktree, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(ctx.db);
    rmSync(join(dataRoot, 'knowledge'), { recursive: true, force: true });
    rmSync(join(worktree, 'ok.txt'), { force: true });
    rmSync(join(worktree, 'README.md'), { force: true });
    rmSync(join(worktree, EXTRACTED_TEXT_DIR), { recursive: true, force: true });
    await ctx.store.upsertProject({
      id: 'p-1',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'verity-heey-global--verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-knowledge',
      worktree,
      model: 'm',
      projectId: 'p-1',
    });
    await ctx.store.createSession({ sessionId: 's-loose', worktree: looseWorktree, model: 'm' });
  });

  it('lists the project folder and hides what the operator must not see twice', async () => {
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    const res = await app.inject({
      method: 'GET',
      url: '/sessions/s-knowledge/files?root=knowledge',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ root: 'knowledge', path: '' });
    const names = res.json<{ entries: { name: string }[] }>().entries.map(({ name }) => name);
    expect(names).toEqual([...PROJECT_KNOWLEDGE_TOP_LEVEL_DIRS].sort());
    // Both exist on disk and are deliberately absent from the listing: `.text/`
    // mirrors every file, and `shared/` is an empty mount point whose real
    // contents are reachable under the Shared root. Showing either would put the
    // same material in front of the operator twice, under a second name.
    expect(existsSync(join(dir, EXTRACTED_TEXT_DIR))).toBe(true);
    expect(existsSync(join(dir, SHARED_KNOWLEDGE_DIR))).toBe(true);
    expect(names).not.toContain(EXTRACTED_TEXT_DIR);
    expect(names).not.toContain(SHARED_KNOWLEDGE_DIR);
  });

  it('browses the shared folder through its own root', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions/s-knowledge/files?root=shared' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ root: 'shared', path: '' });

    writeFileSync(join(sharedKnowledgeDir(dataRoot), 'insights/Preisliste.md'), '# Preise\n');
    const listed = await app.inject({
      method: 'GET',
      url: '/sessions/s-knowledge/files?root=shared&path=insights',
    });
    expect(listed.json<{ entries: { name: string }[] }>().entries).toMatchObject([
      { name: 'Preisliste.md', kind: 'file' },
    ]);
  });

  it('browses Shared without a session and preserves revision and path protections', async () => {
    await ctx.store.deleteSession('s-knowledge');
    await ctx.store.deleteSession('s-loose');
    const listing = await app.inject('/knowledge/shared/files');
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toMatchObject({ root: 'shared' });
    const file = join(sharedKnowledgeDir(dataRoot), 'insights/reference.md');
    writeFileSync(file, 'Original reference');
    const response = await app.inject('/knowledge/shared/files/content?path=insights/reference.md');
    expect(response.statusCode).toBe(200);
    const snapshot = response.json<{ version: string; content: string }>();
    expect(snapshot.content).toBe('Original reference');
    const original = join(sharedKnowledgeDir(dataRoot), 'sources/documents/original.txt');
    writeFileSync(original, 'Immutable source');
    const source = await app.inject(
      '/knowledge/shared/files/content?path=sources/documents/original.txt',
    );
    expect(source.json()).toMatchObject({ editable: false, content: 'Immutable source' });
    const download = await app.inject(
      '/knowledge/shared/files/download?path=sources/documents/original.txt',
    );
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('Immutable source');
    // Verity's page lists the same library's latest pages through its own route.
    const recent = await app.inject('/knowledge/shared/recent?limit=5');
    expect(recent.statusCode).toBe(200);
    expect(recent.json<{ entries: { path: string; area: string }[] }>().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'insights/reference.md', area: 'wiki' }),
        expect.objectContaining({ path: 'sources/documents/original.txt', area: 'sources' }),
      ]),
    );
    expect((await app.inject('/knowledge/shared/recent?limit=99')).statusCode).toBe(400);

    const save = (expectedVersion: string, path = 'insights/reference.md') =>
      app.inject({
        method: 'PUT',
        url: '/knowledge/shared/files/content',
        payload: { root: 'shared', path, content: 'Updated reference', expectedVersion },
      });
    expect((await save(snapshot.version)).statusCode).toBe(200);
    expect((await save(snapshot.version)).statusCode).toBe(409);
    expect(readFileSync(file, 'utf8')).toBe('Updated reference');
    symlinkSync('../sources', join(sharedKnowledgeDir(dataRoot), 'insights/alias'));
    expect(
      (
        await save(
          fileVersion(Buffer.from('Immutable source')),
          'insights/alias/documents/original.txt',
        )
      ).statusCode,
    ).toBe(400);
    expect(readFileSync(original, 'utf8')).toBe('Immutable source');
    expect((await save(snapshot.version, 'sources/original.md')).statusCode).toBe(403);
    expect((await save(snapshot.version, 'insights/../sources/original.md')).statusCode).toBe(403);
    expect(
      (await app.inject('/knowledge/shared/files/content?path=../outside.md')).statusCode,
    ).toBe(400);
  });

  it('serves the project Wiki catalog to the app', async () => {
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    mkdirSync(join(dir, 'insights'), { recursive: true });
    writeFileSync(join(dir, 'insights/plan.md'), '# The plan\n\nWhat we build next.');
    const res = await app.inject('/projects/p-1/knowledge/wiki');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      pages: [{ path: 'insights/plan.md', title: 'The plan', summary: 'What we build next.' }],
      index: null,
      decisions: [],
      review: [],
    });
    // A named 404: the app falls back to the folder view only for the router's
    // own "Not Found", which means a server without this route.
    const missing = await app.inject('/projects/missing/knowledge/wiki');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Project knowledge not found' });
  });

  it('browses project knowledge without sessions and confines edits to its Wiki', async () => {
    await ctx.store.deleteSession('s-knowledge');
    const base = '/projects/p-1/knowledge/files';
    const listing = await app.inject(base);
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toMatchObject({ root: 'knowledge' });
    expect((await app.inject(`${base}?path=insights/decisions`)).json()).toMatchObject({
      entries: [],
    });
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    writeFileSync(join(dir, 'insights/note.md'), 'Project note');
    writeFileSync(join(dir, 'sources/documents/original.txt'), 'Source');
    const snapshot = (await app.inject(`${base}/content?path=insights/note.md`)).json();
    expect(snapshot).toMatchObject({ content: 'Project note', editable: true });
    const save = (path: string) =>
      app.inject({
        method: 'PUT',
        url: `${base}/content`,
        payload: {
          root: 'shared',
          path,
          content: 'Revised',
          expectedVersion: snapshot.version,
        },
      });
    expect((await save('insights/note.md')).statusCode).toBe(200);
    expect((await save('insights/note.md')).statusCode).toBe(409);
    expect(readFileSync(join(dir, 'insights/note.md'), 'utf8')).toBe('Revised');
    symlinkSync('../sources', join(dir, 'insights/alias'));
    const escaped = await app.inject({
      method: 'PUT',
      url: `${base}/content`,
      payload: {
        path: 'insights/alias/documents/original.txt',
        content: 'Overwritten',
        expectedVersion: fileVersion(Buffer.from('Source')),
      },
    });
    expect(escaped.statusCode).toBe(400);
    expect(readFileSync(join(dir, 'sources/documents/original.txt'), 'utf8')).toBe('Source');
    expect((await save('sources/documents/original.txt')).statusCode).toBe(403);
    expect((await save('insights/../sources/documents/original.txt')).statusCode).toBe(403);
    expect(
      (await app.inject(`${base}/content?path=sources/documents/original.txt`)).json(),
    ).toMatchObject({ editable: false });
    expect((await app.inject(`${base}/download?path=sources/documents/original.txt`)).body).toBe(
      'Source',
    );
    expect((await app.inject(`${base}/content?path=../other/file.md`)).statusCode).toBe(400);
    expect((await app.inject('/projects/missing/knowledge/files')).statusCode).toBe(404);
    expect(
      listing.json<{ entries: { name: string }[] }>().entries.map((entry) => entry.name),
    ).not.toContain('shared');
  });

  it('deletes ordinary Wiki entries without sessions and protects library roots and decisions', async () => {
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    await app.inject('/projects/p-1/knowledge/files');
    writeFileSync(join(dir, 'insights/deletable.md'), 'Temporary');
    writeFileSync(join(dir, 'sources/documents/original.txt'), 'Original');
    const remove = (path: string) =>
      app.inject({
        method: 'DELETE',
        url: `/projects/p-1/knowledge/files?path=${encodeURIComponent(path)}`,
      });
    expect((await remove('insights/deletable.md')).statusCode).toBe(200);
    expect(existsSync(join(dir, 'insights/deletable.md'))).toBe(false);
    for (const path of [
      'sources',
      'insights',
      'insights/decisions',
      'insights/decisions/record.md',
      'insights/./decisions/record.md',
      'insights/../sources/documents/original.txt',
    ]) {
      expect((await remove(path)).statusCode).toBe(403);
    }
    symlinkSync('../sources', join(dir, 'insights/deletion-alias'));
    expect((await remove('insights/deletion-alias/documents/original.txt')).statusCode).toBe(400);
    expect(readFileSync(join(dir, 'sources/documents/original.txt'), 'utf8')).toBe('Original');
  });

  it('deletes an edited Wiki folder together with its saved history', async () => {
    await app.inject('/projects/p-1/knowledge/files');
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    mkdirSync(join(dir, 'insights/edited'), { recursive: true });
    writeFileSync(join(dir, 'insights/edited/note.md'), '# Original');
    const saved = await app.inject({
      method: 'PUT',
      url: '/projects/p-1/knowledge/files/content',
      payload: {
        path: 'insights/edited/note.md',
        content: '# Updated',
        expectedVersion: fileVersion(Buffer.from('# Original')),
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(existsSync(join(dir, 'insights/edited/.verity-file-history'))).toBe(true);
    const removed = await app.inject({
      method: 'DELETE',
      url: '/projects/p-1/knowledge/files?path=insights/edited',
    });
    expect(removed.statusCode).toBe(200);
    expect(existsSync(join(dir, 'insights/edited'))).toBe(false);
    expect(existsSync(knowledgeExtractionPath(dir, 'insights/edited/note.md'))).toBe(false);
  });

  it('protects decisions reached through intermediate Wiki aliases', async () => {
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    await app.inject('/projects/p-1/knowledge/files');
    const topic = join(dir, 'insights/decisions/topic');
    mkdirSync(join(topic, 'nested'), { recursive: true });
    writeFileSync(join(topic, 'record.md'), 'Protected decision');
    writeFileSync(join(topic, 'nested/another.md'), 'Another decision');
    symlinkSync('decisions', join(dir, 'insights/alias'));
    const remove = (path: string) =>
      app.inject({
        method: 'DELETE',
        url: `/projects/p-1/knowledge/files?path=${encodeURIComponent(path)}`,
      });
    expect((await remove('insights/alias/topic/record.md')).statusCode).toBe(400);
    expect((await remove('insights/alias/topic/nested')).statusCode).toBe(400);
    expect(readFileSync(join(topic, 'record.md'), 'utf8')).toBe('Protected decision');
    expect(readFileSync(join(topic, 'nested/another.md'), 'utf8')).toBe('Another decision');
  });

  it('protects decisions across session delete roots and intermediate aliases', async () => {
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    await app.inject('/projects/p-1/knowledge/files');
    const topic = join(dir, 'insights/decisions/topic');
    mkdirSync(join(topic, 'nested'), { recursive: true });
    writeFileSync(join(topic, 'record.md'), 'Protected decision');
    writeFileSync(join(topic, 'nested/another.md'), 'Another decision');
    symlinkSync('decisions', join(dir, 'insights/session-alias'));
    const remove = (root: string, path: string, id = 's-knowledge') =>
      app.inject({
        method: 'DELETE',
        url: `/sessions/${id}/files?root=${root}&path=${encodeURIComponent(path)}`,
      });
    for (const [root, path] of [
      ['documents', 'decisions'],
      ['wiki', 'decisions/topic'],
      ['documents', 'session-alias/topic/record.md'],
      ['documents', 'session-alias/topic/nested'],
      ['knowledge', 'insights/decisions/topic/record.md'],
      ['knowledge', 'insights/session-alias/topic/record.md'],
    ] as const)
      expect((await remove(root, path)).statusCode).toBe(400);
    await ctx.store.createSession({
      sessionId: 's-canonical-wiki',
      projectId: 'p-1',
      worktree: join(dir, 'insights'),
      model: 'm',
    });
    expect((await remove('worktree', 'decisions', 's-canonical-wiki')).statusCode).toBe(400);
    expect(
      (await remove('worktree', 'session-alias/topic/record.md', 's-canonical-wiki')).statusCode,
    ).toBe(400);
    await ctx.store.createSession({
      sessionId: 's-canonical-knowledge',
      projectId: 'p-1',
      worktree: dir,
      model: 'm',
    });
    expect((await remove('worktree', 'insights', 's-canonical-knowledge')).statusCode).toBe(400);
    await ctx.store.createSession({
      sessionId: 's-canonical-decision',
      projectId: 'p-1',
      worktree: topic,
      model: 'm',
    });
    expect((await remove('worktree', 'record.md', 's-canonical-decision')).statusCode).toBe(400);
    expect(readFileSync(join(topic, 'record.md'), 'utf8')).toBe('Protected decision');
    expect(readFileSync(join(topic, 'nested/another.md'), 'utf8')).toBe('Another decision');
    // The same name in an ordinary code checkout is not a project decision directory.
    mkdirSync(join(worktree, 'decisions'), { recursive: true });
    writeFileSync(join(worktree, 'decisions/design.md'), 'Code design');
    expect((await remove('worktree', 'decisions')).statusCode).toBe(200);
  });

  it('deletes Sources files and folders with their extracted text without following aliases', async () => {
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    await app.inject('/projects/p-1/knowledge/files');
    const sourcePath = 'sources/documents/import/batch/original.txt';
    mkdirSync(join(dir, 'sources/documents/import/batch'), { recursive: true });
    writeFileSync(join(dir, sourcePath), 'Original');
    const extracted = knowledgeExtractionPath(dir, sourcePath);
    mkdirSync(join(extracted, '..'), { recursive: true });
    writeFileSync(extracted, 'Extracted original');
    writeFileSync(`${extracted}.meta.json`, '{}');
    writeFileSync(join(dir, 'insights/retained.md'), 'Retained Wiki');
    symlinkSync('../../../insights', join(dir, 'sources/documents/import/wiki-alias'));
    const remove = (path: string) =>
      app.inject({
        method: 'DELETE',
        url: `/projects/p-1/knowledge/files?path=${encodeURIComponent(path)}`,
      });
    expect((await remove('sources/documents/import')).statusCode).toBe(200);
    expect(existsSync(join(dir, 'sources/documents/import'))).toBe(false);
    expect(existsSync(extracted)).toBe(false);
    expect(existsSync(`${extracted}.meta.json`)).toBe(false);
    expect(readFileSync(join(dir, 'insights/retained.md'), 'utf8')).toBe('Retained Wiki');
    writeFileSync(join(dir, 'sources/documents/another.txt'), 'Another');
    expect((await remove('sources/documents/another.txt')).statusCode).toBe(200);
    expect(existsSync(join(dir, 'sources/documents/another.txt'))).toBe(false);
    expect((await remove('sources/../insights/retained.md')).statusCode).toBe(403);
    expect((await remove('sources\\..\\insights\\retained.md')).statusCode).toBe(403);
    expect((await remove('sources/documents\\..\\..\\insights/retained.md')).statusCode).toBe(403);
    symlinkSync('../../insights', join(dir, 'sources/documents/wiki-alias'));
    expect((await remove('sources/documents/wiki-alias/retained.md')).statusCode).toBe(400);
    expect(readFileSync(join(dir, 'insights/retained.md'), 'utf8')).toBe('Retained Wiki');
  });

  it('keeps the worktree root exactly what it was', async () => {
    // The default when no root is named, so every client built before the
    // knowledge roots existed keeps browsing the worktree.
    writeFileSync(join(worktree, 'README.md'), '# Hello\n');
    const res = await app.inject({ method: 'GET', url: '/sessions/s-knowledge/files' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ entries: { name: string }[] }>().entries).toMatchObject([
      { name: 'README.md', kind: 'file' },
    ]);
  });

  it('uploads into a knowledge folder', async () => {
    const res = await upload(
      '/sessions/s-knowledge/files?root=knowledge&path=sources/documents&fileName=Angebot.txt',
      'Angebot',
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ path: 'sources/documents/Angebot.txt' });
    expect(
      readFileSync(
        join(projectKnowledgeDir(dataRoot, 'p-1'), 'sources/documents/Angebot.txt'),
        'utf8',
      ),
    ).toBe('Angebot');
    // The worktree is untouched: the two roots are separate directories, not two
    // views of one.
    expect(existsSync(join(worktree, 'sources/documents/Angebot.txt'))).toBe(false);
  });

  it('deletes a knowledge file', async () => {
    const file = join(projectKnowledgeDir(dataRoot, 'p-1'), 'insights/gedanke.md');
    await app.inject({ method: 'GET', url: '/sessions/s-knowledge/files?root=knowledge' });
    writeFileSync(file, 'note\n');

    const res = await app.inject({
      method: 'DELETE',
      url: '/sessions/s-knowledge/files?root=knowledge&path=insights/gedanke.md',
    });

    expect(res.statusCode).toBe(200);
    expect(existsSync(file)).toBe(false);
  });

  it('deletes a worktree file', async () => {
    writeFileSync(join(worktree, 'ok.txt'), 'ok');
    mkdirSync(join(worktree, EXTRACTED_TEXT_DIR), { recursive: true });
    writeFileSync(join(worktree, EXTRACTED_TEXT_DIR, 'ok.txt.md'), 'unrelated worktree file');

    const res = await app.inject({
      method: 'DELETE',
      url: '/sessions/s-knowledge/files?root=worktree&path=ok.txt',
    });

    expect(res.statusCode).toBe(200);
    expect(existsSync(join(worktree, 'ok.txt'))).toBe(false);
    expect(readFileSync(join(worktree, EXTRACTED_TEXT_DIR, 'ok.txt.md'), 'utf8')).toBe(
      'unrelated worktree file',
    );
  });

  it('deletes a worktree folder recursively and preserves external symlink targets', async () => {
    mkdirSync(join(worktree, 'remove/nested'), { recursive: true });
    mkdirSync(join(worktree, 'keep'), { recursive: true });
    writeFileSync(join(worktree, 'remove/nested/note.md'), 'remove');
    writeFileSync(join(worktree, 'keep/note.md'), 'keep');
    symlinkSync(join(worktree, 'keep'), join(worktree, 'remove/link'));
    const res = await app.inject({
      method: 'DELETE',
      url: '/sessions/s-knowledge/files?root=worktree&path=remove',
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(worktree, 'remove'))).toBe(false);
    expect(readFileSync(join(worktree, 'keep/note.md'), 'utf8')).toBe('keep');
  });

  it('refuses to delete derived text or the shared mount point', async () => {
    await app.inject({ method: 'GET', url: '/sessions/s-knowledge/files?root=knowledge' });
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    writeFileSync(join(dir, EXTRACTED_TEXT_DIR, 'Angebot.pdf.md'), 'page 1\n');

    // Deleting the extraction alone would leave a file an agent can no longer
    // read, with nothing in the folder to show why.
    const derived = await app.inject({
      method: 'DELETE',
      url: `/sessions/s-knowledge/files?root=knowledge&path=${EXTRACTED_TEXT_DIR}/Angebot.pdf.md`,
    });
    expect(derived.statusCode).toBe(400);
    expect(existsSync(join(dir, EXTRACTED_TEXT_DIR, 'Angebot.pdf.md'))).toBe(true);

    // Removing the mount point breaks every sandbox of the project at create.
    const mountPoint = await app.inject({
      method: 'DELETE',
      url: `/sessions/s-knowledge/files?root=knowledge&path=${SHARED_KNOWLEDGE_DIR}`,
    });
    expect(mountPoint.statusCode).toBe(400);
    expect(existsSync(join(dir, SHARED_KNOWLEDGE_DIR))).toBe(true);
  });

  it('renames a Sources file with its extracted text and never replaces another', async () => {
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    await app.inject('/projects/p-1/knowledge/files');
    const from = 'sources/documents/call.md';
    writeFileSync(join(dir, from), '# Call');
    writeFileSync(join(dir, 'sources/documents/taken.md'), 'Taken');
    const extracted = knowledgeExtractionPath(dir, from);
    mkdirSync(join(extracted, '..'), { recursive: true });
    writeFileSync(extracted, `# call.md\n\nSource: ${from}\n\nCall transcript\n`);
    const rename = (path: string, name: string) =>
      app.inject({
        method: 'POST',
        url: '/projects/p-1/knowledge/files/rename',
        payload: { path, name },
      });

    const renamed = await rename(from, 'kickoff.md');
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ path: 'sources/documents/kickoff.md' });
    expect(existsSync(join(dir, from))).toBe(false);
    expect(readFileSync(join(dir, 'sources/documents/kickoff.md'), 'utf8')).toBe('# Call');
    // Search reads the extracted text, so it has to name the file by its new path.
    expect(existsSync(extracted)).toBe(false);
    expect(
      readFileSync(knowledgeExtractionPath(dir, 'sources/documents/kickoff.md'), 'utf8'),
    ).toContain('Source: sources/documents/kickoff.md');

    const conflict = await rename('sources/documents/kickoff.md', 'taken.md');
    expect(conflict.statusCode).toBe(409);
    expect(readFileSync(join(dir, 'sources/documents/taken.md'), 'utf8')).toBe('Taken');
    expect(readFileSync(join(dir, 'sources/documents/kickoff.md'), 'utf8')).toBe('# Call');
    expect((await rename('sources/documents/missing.md', 'other.md')).statusCode).toBe(404);
    expect((await rename('sources/documents/kickoff.md', '../escape.md')).statusCode).toBe(400);
    expect((await rename('sources/documents/kickoff.md', 'nested/name.md')).statusCode).toBe(400);
  });

  it('reports a rename that happened even when its text cannot be refreshed', async () => {
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    await app.inject('/projects/p-1/knowledge/files');
    writeFileSync(join(dir, 'sources/documents/scan.pdf'), 'binary');
    observation.extractionFailure = true;
    try {
      const renamed = await app.inject({
        method: 'POST',
        url: '/projects/p-1/knowledge/files/rename',
        payload: { path: 'sources/documents/scan.pdf', name: 'contract.pdf' },
      });
      // A 500 here would leave the app offering the old name, which is gone.
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({
        path: 'sources/documents/contract.pdf',
        warning: expect.stringContaining('Renamed'),
      });
      expect(existsSync(join(dir, 'sources/documents/contract.pdf'))).toBe(true);
      expect(existsSync(join(dir, 'sources/documents/scan.pdf'))).toBe(false);
    } finally {
      observation.extractionFailure = false;
    }
  });

  it('renames a Sources folder with the extracted text of everything inside', async () => {
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    await app.inject('/projects/p-1/knowledge/files');
    mkdirSync(join(dir, 'sources/interviews/2026'), { recursive: true });
    const inner = 'sources/interviews/2026/anna.md';
    writeFileSync(join(dir, inner), '# Anna');
    const extracted = knowledgeExtractionPath(dir, inner);
    mkdirSync(join(extracted, '..'), { recursive: true });
    writeFileSync(extracted, `# anna.md\n\nSource: ${inner}\n\nInterview\n`);
    mkdirSync(join(dir, 'sources/taken'));
    writeFileSync(join(dir, 'sources/taken/keep.md'), 'Keep');
    const rename = (path: string, name: string) =>
      app.inject({
        method: 'POST',
        url: '/projects/p-1/knowledge/files/rename',
        payload: { path, name },
      });

    expect((await rename('sources/interviews', 'taken')).statusCode).toBe(409);
    expect(readFileSync(join(dir, 'sources/taken/keep.md'), 'utf8')).toBe('Keep');
    expect(readFileSync(join(dir, inner), 'utf8')).toBe('# Anna');

    const renamed = await rename('sources/interviews', 'customer-interviews');
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ path: 'sources/customer-interviews' });
    expect(existsSync(join(dir, 'sources/interviews'))).toBe(false);
    const moved = 'sources/customer-interviews/2026/anna.md';
    expect(readFileSync(join(dir, moved), 'utf8')).toBe('# Anna');
    expect(readFileSync(knowledgeExtractionPath(dir, moved), 'utf8')).toContain(`Source: ${moved}`);
    expect(existsSync(join(dir, EXTRACTED_TEXT_DIR, 'sources/interviews'))).toBe(false);
  });

  it('renames only ordinary Sources entries', async () => {
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    await app.inject('/projects/p-1/knowledge/files');
    writeFileSync(join(dir, 'insights/page.md'), 'Page');
    const rename = (path: string) =>
      app.inject({
        method: 'POST',
        url: '/projects/p-1/knowledge/files/rename',
        payload: { path, name: 'renamed' },
      });
    for (const path of [
      'sources',
      // Verity's entry points write into these; renamed, they would come back empty.
      'sources/documents',
      'sources/meetings',
      'sources/matrix',
      // Renaming a Wiki page would break the links to it.
      'insights/page.md',
      'insights/decisions',
      'sources/../insights/page.md',
      'sources\\..\\insights\\page.md',
    ])
      expect((await rename(path)).statusCode).toBe(403);
    expect(readFileSync(join(dir, 'insights/page.md'), 'utf8')).toBe('Page');
    symlinkSync('../../insights', join(dir, 'sources/documents/wiki-alias'));
    expect((await rename('sources/documents/wiki-alias/page.md')).statusCode).toBe(400);
    expect(readFileSync(join(dir, 'insights/page.md'), 'utf8')).toBe('Page');
  });

  it('moves a file between the project folder and the shared one', async () => {
    // The only scope change there is (ADR 0022 D1): what is in `shared/` is
    // readable by every project, what is in the project folder is not.
    await app.inject({ method: 'GET', url: '/sessions/s-knowledge/files?root=knowledge' });
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    writeFileSync(join(dir, 'sources/documents/Preisliste.md'), '# Preise\n');
    mkdirSync(join(dir, EXTRACTED_TEXT_DIR, 'sources/documents'), { recursive: true });
    writeFileSync(
      join(dir, EXTRACTED_TEXT_DIR, 'sources/documents/Preisliste.md.md'),
      '# Preisliste.md\n\nSource: sources/documents/Preisliste.md\n\ntrusted transcript\n',
    );

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s-knowledge/files/move',
      payload: {
        root: 'knowledge',
        path: 'sources/documents/Preisliste.md',
        toRoot: 'shared',
        toPath: 'sources/documents',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(existsSync(join(dir, 'sources/documents/Preisliste.md'))).toBe(false);
    expect(
      readFileSync(join(sharedKnowledgeDir(dataRoot), 'sources/documents/Preisliste.md'), 'utf8'),
    ).toBe('# Preise\n');
    expect(
      readFileSync(
        join(
          sharedKnowledgeDir(dataRoot),
          EXTRACTED_TEXT_DIR,
          'sources/documents/Preisliste.md.md',
        ),
        'utf8',
      ),
    ).toBe('# Preisliste.md\n\nSource: sources/documents/Preisliste.md\n\ntrusted transcript\n');
  });

  it('never overwrites on a move', async () => {
    // A move into `shared/` widens who can read the file; landing on a name that
    // is already taken would destroy another project's material in the process.
    await app.inject({ method: 'GET', url: '/sessions/s-knowledge/files?root=knowledge' });
    await app.inject({ method: 'GET', url: '/sessions/s-knowledge/files?root=shared' });
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    writeFileSync(join(dir, 'sources/documents/Preisliste.md'), 'mine\n');
    writeFileSync(
      join(sharedKnowledgeDir(dataRoot), 'sources/documents/Preisliste.md'),
      'theirs\n',
    );

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s-knowledge/files/move',
      payload: {
        root: 'knowledge',
        path: 'sources/documents/Preisliste.md',
        toRoot: 'shared',
        toPath: 'sources/documents',
      },
    });

    expect(res.statusCode).toBe(409);
    expect(
      readFileSync(join(sharedKnowledgeDir(dataRoot), 'sources/documents/Preisliste.md'), 'utf8'),
    ).toBe('theirs\n');
    expect(readFileSync(join(dir, 'sources/documents/Preisliste.md'), 'utf8')).toBe('mine\n');
  });

  it('refuses a move that leaves the knowledge folders', async () => {
    writeFileSync(join(worktree, 'ok.txt'), 'ok');
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s-knowledge/files/move',
      payload: { root: 'worktree', path: 'ok.txt', toRoot: 'shared' },
    });

    expect(res.statusCode).toBe(400);
    expect(existsSync(join(worktree, 'ok.txt'))).toBe(true);
  });

  it('renames a worktree file without leaving an extracted-text mirror behind', async () => {
    writeFileSync(join(worktree, 'ok.txt'), 'draft\n');

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s-knowledge/files/move',
      payload: { root: 'worktree', path: 'ok.txt', toRoot: 'worktree', toFileName: 'README.md' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: 'README.md', root: 'worktree' });
    expect(existsSync(join(worktree, 'ok.txt'))).toBe(false);
    expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('draft\n');
    // Knowledge moves re-extract at the destination; doing that in a repository
    // would litter it with a `.text/` folder the agent then commits.
    expect(existsSync(join(worktree, EXTRACTED_TEXT_DIR))).toBe(false);
  });

  it('never overwrites on a worktree rename', async () => {
    // The agent may have written the target name since the list was loaded.
    writeFileSync(join(worktree, 'ok.txt'), 'mine\n');
    writeFileSync(join(worktree, 'README.md'), 'theirs\n');

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s-knowledge/files/move',
      payload: { root: 'worktree', path: 'ok.txt', toRoot: 'worktree', toFileName: 'README.md' },
    });

    expect(res.statusCode).toBe(409);
    expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('theirs\n');
    expect(readFileSync(join(worktree, 'ok.txt'), 'utf8')).toBe('mine\n');
  });

  it('refuses to move a knowledge file into the worktree', async () => {
    // Opening the worktree to renames must not open it as a move destination.
    await app.inject({ method: 'GET', url: '/sessions/s-knowledge/files?root=knowledge' });
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    writeFileSync(join(dir, 'ok.txt'), 'ok');
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s-knowledge/files/move',
      payload: { root: 'knowledge', path: 'ok.txt', toRoot: 'worktree' },
    });

    expect(res.statusCode).toBe(400);
    expect(existsSync(join(dir, 'ok.txt'))).toBe(true);
    expect(existsSync(join(worktree, 'ok.txt'))).toBe(false);
  });

  it('blocks path escapes out of a knowledge root', async () => {
    for (const path of ['../', '../../secrets']) {
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/s-knowledge/files?root=knowledge&path=${encodeURIComponent(path)}`,
      });
      expect(res.statusCode).toBe(400);
    }

    const escape = await app.inject({
      method: 'DELETE',
      url: '/sessions/s-knowledge/files?root=knowledge&path=../p-2/overview.md',
    });
    expect(escape.statusCode).toBe(400);
  });

  it('has no knowledge folder for a session without a project', async () => {
    for (const root of ['knowledge', 'documents', 'sources', 'drafts']) {
      const res = await app.inject({ method: 'GET', url: `/sessions/s-loose/files?root=${root}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: 'This session is not linked to a project. Open the Wiki from a project.',
      });
    }
    const worktreeRoot = await app.inject({ method: 'GET', url: '/sessions/s-loose/files' });
    expect(worktreeRoot.statusCode).toBe(200);
  });
  it('reports unavailable knowledge storage without claiming the Wiki is empty', async () => {
    const unconfigured = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: {} as Conductor,
    });
    try {
      const res = await unconfigured.inject('/sessions/s-knowledge/files?root=documents');
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        error: 'Knowledge storage is not configured. Ask your administrator to configure it.',
      });
    } finally {
      await unconfigured.close();
    }
  });

  it('distinguishes a missing session from unavailable project knowledge', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions/missing/files?root=documents' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: 'Session not found. Reopen the session and try again.',
    });
  });

  it('creates and edits text in every root without overwriting create collisions', async () => {
    for (const root of ['worktree', 'knowledge', 'shared'] as const) {
      const url = '/sessions/s-knowledge/files/content';
      const path = `created-${root}.md`;
      if (root === 'worktree') rmSync(join(worktree, path), { force: true });
      const created = await app.inject({
        method: 'PUT',
        url,
        payload: { root, path, content: '# Original', expectedVersion: null },
      });
      expect(created.statusCode).toBe(200);
      const version = created.json<{ version: string }>().version;
      expect(version).toBe(fileVersion(Buffer.from('# Original')));
      const collision = await app.inject({
        method: 'PUT',
        url,
        payload: { root, path, content: 'collision', expectedVersion: null },
      });
      expect(collision.statusCode).toBe(409);
      const saved = await app.inject({
        method: 'PUT',
        url,
        payload: { root, path, content: '# Updated', expectedVersion: version },
      });
      expect(saved.statusCode).toBe(200);
      const preview = await app.inject({ method: 'GET', url: `${url}?root=${root}&path=${path}` });
      expect(preview.json()).toMatchObject({
        content: '# Updated',
        editable: true,
        version: fileVersion(Buffer.from('# Updated')),
      });
      if (root !== 'worktree') {
        const dir =
          root === 'knowledge'
            ? projectKnowledgeDir(dataRoot, 'p-1')
            : sharedKnowledgeDir(dataRoot);
        expect(readFileSync(knowledgeExtractionPath(dir, path), 'utf8')).toContain('Updated');
      } else expect(existsSync(join(worktree, EXTRACTED_TEXT_DIR))).toBe(false);
    }
  });

  it('refuses stale edits and serializes competing saves', async () => {
    writeFileSync(join(worktree, 'ok.txt'), 'old');
    const url = '/sessions/s-knowledge/files/content';
    const original = await app.inject({ method: 'GET', url: `${url}?path=ok.txt` });
    const expectedVersion = original.json<{ version: string }>().version;
    writeFileSync(join(worktree, 'ok.txt'), 'agent change');
    const stale = await app.inject({
      method: 'PUT',
      url,
      payload: { path: 'ok.txt', content: 'my change', expectedVersion },
    });
    expect(stale.statusCode).toBe(409);
    expect(readFileSync(join(worktree, 'ok.txt'), 'utf8')).toBe('agent change');
    const currentVersion = fileVersion(Buffer.from('agent change'));
    const results = await Promise.all(
      ['one', 'two'].map((content) =>
        app.inject({
          method: 'PUT',
          url,
          payload: { path: 'ok.txt', content, expectedVersion: currentVersion },
        }),
      ),
    );
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
  });

  it('rejects managed paths, git paths and escaping writes', async () => {
    for (const path of ['.text/private.md', '../outside.md', '.git/config']) {
      const res = await app.inject({
        method: 'PUT',
        url: '/sessions/s-knowledge/files/content',
        payload: { root: 'knowledge', path, content: 'edit', expectedVersion: null },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('enforces UTF-8 byte and project overview limits', async () => {
    const url = '/sessions/s-knowledge/files/content';
    const large = await app.inject({
      method: 'PUT',
      url,
      payload: { path: 'ok.txt', content: 'é'.repeat(500001), expectedVersion: null },
    });
    expect(large.statusCode).toBe(413);
    const overview = await app.inject({
      method: 'PUT',
      url,
      payload: {
        root: 'knowledge',
        path: 'overview.md',
        content: 'x'.repeat(100000),
        expectedVersion: null,
      },
    });
    expect(overview.statusCode).toBe(413);
    expect(existsSync(join(worktree, 'ok.txt'))).toBe(false);
  });
  it('never exposes extracted binary text as editable source', async () => {
    await app.inject({ method: 'GET', url: '/sessions/s-knowledge/files?root=knowledge' });
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    const bytes = Buffer.from([0, 1, 2]);
    writeFileSync(join(dir, 'binary.pdf'), bytes);
    writeFileSync(knowledgeExtractionPath(dir, 'binary.pdf'), 'extracted text');
    const url = '/sessions/s-knowledge/files/content';
    const preview = await app.inject({
      method: 'GET',
      url: `${url}?root=knowledge&path=binary.pdf`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ content: 'extracted text', editable: false });
    expect(preview.json()).not.toHaveProperty('version');
    const write = await app.inject({
      method: 'PUT',
      url,
      payload: {
        root: 'knowledge',
        path: 'binary.pdf',
        content: 'replacement',
        expectedVersion: fileVersion(bytes),
      },
    });
    expect(write.statusCode).toBe(415);
    expect(readFileSync(join(dir, 'binary.pdf'))).toEqual(bytes);
  });
  it('lists and reads versions while reserving private history paths', async () => {
    writeFileSync(join(worktree, 'versioned.txt'), 'before');
    const saved = await app.inject({
      method: 'PUT',
      url: '/sessions/s-knowledge/files/content',
      payload: {
        root: 'worktree',
        path: 'versioned.txt',
        content: 'after',
        expectedVersion: fileVersion(Buffer.from('before')),
      },
    });
    expect(saved.statusCode).toBe(200);
    const url = '/sessions/s-knowledge/files/history?root=worktree&path=versioned.txt';
    const history = await app.inject({ method: 'GET', url });
    expect(history.statusCode).toBe(200);
    const versions = history.json().versions as Array<{ id: string; kind: string }>;
    const snapshot = versions.find((version) => version.kind === 'snapshot')!;
    const old = await app.inject({
      method: 'GET',
      url: `${url}&version=${encodeURIComponent(snapshot.id)}`,
    });
    expect(old.json()).toEqual({ content: 'before' });
    const wrongFile = await app.inject({
      method: 'GET',
      url: `/sessions/s-knowledge/files/history?root=worktree&path=other.txt&version=${encodeURIComponent(snapshot.id)}`,
    });
    expect(wrongFile.statusCode).toBe(404);
    const listing = await app.inject({
      method: 'GET',
      url: '/sessions/s-knowledge/files?root=worktree',
    });
    expect(
      listing.json<{ entries: Array<{ name: string }> }>().entries.map((entry) => entry.name),
    ).not.toContain('.verity-file-history');
    const privateRead = await app.inject({
      method: 'GET',
      url: '/sessions/s-knowledge/files/content?root=worktree&path=.verity-file-history/name',
    });
    expect(privateRead.statusCode).toBe(400);
  });
  it('creates insights with the same sandbox write permissions as provisioned insights', async () => {
    await app.inject({ method: 'GET', url: '/sessions/s-knowledge/files?root=knowledge' });
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    const seed = join(dir, 'insights/provisioned.md');
    writeFileSync(seed, 'existing insight');
    await app.inject({ method: 'GET', url: '/sessions/s-knowledge/files?root=knowledge' });
    const provisionedMode = statSync(seed).mode & 0o777;
    expect(provisionedMode & 0o002).toBe(0o002);
    const created = await app.inject({
      method: 'PUT',
      url: '/sessions/s-knowledge/files/content',
      payload: {
        root: 'knowledge',
        path: 'insights/new.md',
        content: 'new insight',
        expectedVersion: null,
      },
    });
    expect(created.statusCode).toBe(200);
    // Check disk before another request can repair the new note's permissions.
    expect(statSync(join(dir, 'insights/new.md')).mode & 0o777).toBe(provisionedMode);
  });
  it.each(['worktree', 'knowledge'] as const)(
    'queues %s deletes and renames behind an in-flight save lock',
    async (root) => {
      await app.inject({ method: 'GET', url: `/sessions/s-knowledge/files?root=${root}` });
      const dir = root === 'worktree' ? worktree : projectKnowledgeDir(dataRoot, 'p-1');
      const { acquireKnowledgeMutationLock } = await import('./knowledge-mutation-lock.js');
      for (const operation of ['delete', 'move']) {
        const path = `concurrent-${operation}.md`;
        writeFileSync(join(dir, path), 'before save');
        const releaseSave = await acquireKnowledgeMutationLock(dir);
        const attempts = observation.attempts;
        let settled = false;
        const request = app
          .inject(
            operation === 'delete'
              ? {
                  method: 'DELETE',
                  url: `/sessions/s-knowledge/files?root=${root}&path=${path}`,
                }
              : {
                  method: 'POST',
                  url: '/sessions/s-knowledge/files/move',
                  payload: { root, path, toRoot: root, toFileName: `renamed-${path}` },
                },
          )
          .then((response) => {
            settled = true;
            return response;
          });
        try {
          // Mutation must wait before inspecting the pathname a save replaces.
          await vi.waitFor(() => expect(observation.attempts).toBeGreaterThan(attempts));
          expect(settled).toBe(false);
          expect(readFileSync(join(dir, path), 'utf8')).toBe('before save');
          writeFileSync(join(dir, path), 'published save');
        } finally {
          releaseSave();
        }
        expect((await request).statusCode).toBe(200);
        if (operation === 'move')
          expect(readFileSync(join(dir, `renamed-${path}`), 'utf8')).toBe('published save');
      }
    },
  );

  it('keeps history readable when pruning fails', async () => {
    await app.inject({ method: 'GET', url: '/sessions/s-knowledge/files?root=knowledge' });
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    writeFileSync(join(dir, 'retained.md'), 'original');
    const saved = await app.inject({
      method: 'PUT',
      url: '/sessions/s-knowledge/files/content',
      payload: {
        root: 'knowledge',
        path: 'retained.md',
        content: 'edited',
        expectedVersion: fileVersion(Buffer.from('original')),
      },
    });
    expect(saved.statusCode).toBe(200);
    observation.pruningFailure = true;
    try {
      const listed = await app.inject({
        method: 'GET',
        url: '/sessions/s-knowledge/files/history?root=knowledge&path=retained.md',
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().versions).toHaveLength(2);
    } finally {
      observation.pruningFailure = false;
    }
  });

  it('opens a preview descriptor before releasing the pathname mutation lock', async () => {
    await app.inject({ method: 'GET', url: '/sessions/s-knowledge/files?root=knowledge' });
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    const path = join(dir, 'locked-read.md');
    writeFileSync(path, 'read me');
    observation.root = dir;
    observation.path = path;
    observation.depths = [];
    try {
      const read = await app.inject({
        method: 'GET',
        url: '/sessions/s-knowledge/files/content?root=knowledge&path=locked-read.md',
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().content).toBe('read me');
      expect(observation.depths.length).toBeGreaterThan(0);
      expect(observation.depths.every((depth) => depth > 0)).toBe(true);
    } finally {
      observation.path = '';
    }
  });

  it('reports a committed save with a warning when Knowledge extraction fails', async () => {
    observation.extractionFailure = true;
    try {
      const saved = await app.inject({
        method: 'PUT',
        url: '/sessions/s-knowledge/files/content',
        payload: {
          root: 'knowledge',
          path: 'committed.md',
          content: 'saved content',
          expectedVersion: null,
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({
        content: 'saved content',
        warning: expect.any(String),
        version: fileVersion(Buffer.from('saved content')),
      });
      expect(readFileSync(join(projectKnowledgeDir(dataRoot, 'p-1'), 'committed.md'), 'utf8')).toBe(
        'saved content',
      );
    } finally {
      observation.extractionFailure = false;
    }
  });
});
