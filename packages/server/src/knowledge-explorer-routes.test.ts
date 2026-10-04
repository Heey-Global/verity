import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
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
  attempts: 0,
  path: '',
  root: '',
  depths: [] as number[],
  held: new Map<string, number>(),
}));
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
    const res = await app.inject({ method: 'GET', url: '/sessions/s-loose/files?root=knowledge' });

    expect(res.statusCode).toBe(404);
    // The worktree root of the same session still works, so the message must not
    // send the operator looking for a missing session.
    expect(res.json()).toEqual({ error: 'this session has no knowledge folder' });
    const worktreeRoot = await app.inject({ method: 'GET', url: '/sessions/s-loose/files' });
    expect(worktreeRoot.statusCode).toBe(200);
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
