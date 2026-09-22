import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { InMemoryEventBus, type Conductor } from '@verity/session';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  EXTRACTED_TEXT_DIR,
  PROJECT_KNOWLEDGE_TOP_LEVEL_DIRS,
  projectKnowledgeDir,
  SHARED_KNOWLEDGE_DIR,
  sharedKnowledgeDir,
} from './knowledge-folder.js';
import { buildServer } from './server.js';

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
});
