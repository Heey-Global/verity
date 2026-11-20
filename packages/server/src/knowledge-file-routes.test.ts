import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { Conductor } from '@verity/session';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { knowledgeExtractionPath } from './knowledge-file-ingest.js';
import { projectKnowledgeDir, sharedKnowledgeDir } from './knowledge-folder.js';
import { SOURCE_IMPORT_FOLDERS } from './knowledge-path-rules.js';
import { registerServerSessionFiles } from './server-session-files.js';

/**
 * The app's file management over project and Shared knowledge. Both scopes run
 * through one table of cases: the scopes are meant to differ only in where they
 * live and who may use them (paired-route-policy.ts), never in what they allow.
 */
describe('knowledge file routes', () => {
  let app: FastifyInstance;
  let dataRoot: string;
  let worktree: string;

  beforeAll(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), 'verity-knowledge-files-'));
    worktree = mkdtempSync(join(tmpdir(), 'verity-knowledge-files-wt-'));
    app = Fastify();
    app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
      done(null, payload);
    });
    // The server's own handler answers a malformed request with 400 the same way.
    app.setErrorHandler((error, _request, reply) =>
      reply.code(error instanceof ZodError ? 400 : 500).send({ error: String(error) }),
    );
    const eventStore = {
      getProject: async (id: string) => (id === 'p-1' ? { id, kind: 'local' } : undefined),
      getSession: async (id: string) =>
        id === 's-1' ? { sessionId: id, worktree, projectId: 'p-1' } : undefined,
    };
    registerServerSessionFiles(
      app,
      { eventStore: eventStore as never, dataRoot, projectCloneRoot: undefined },
      {} as Conductor,
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(join(dataRoot, 'knowledge'), { recursive: true, force: true });
    for (const entry of ['folder', 'moved', 'target', 'notes.txt'])
      rmSync(join(worktree, entry), { recursive: true, force: true });
  });

  const scopes = [
    {
      name: 'project',
      base: '/projects/p-1/knowledge',
      dir: () => projectKnowledgeDir(dataRoot, 'p-1'),
      agentWritable: true,
    },
    {
      name: 'Shared',
      base: '/knowledge/shared',
      dir: () => sharedKnowledgeDir(dataRoot),
      agentWritable: false,
    },
  ] as const;

  describe.each(scopes)('$name knowledge', ({ base, dir: scopeDir, agentWritable }) => {
    let dir: string;
    const write = (path: string, content: string) => {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    };
    const read = (path: string) => readFileSync(join(dir, path), 'utf8');
    const post = (url: string, payload: object) =>
      app.inject({ method: 'POST', url: `${base}${url}`, payload });
    const upload = (path: string, fileName: string, payload: string) =>
      app.inject({
        method: 'POST',
        url: `${base}/files?path=${encodeURIComponent(path)}&fileName=${encodeURIComponent(fileName)}`,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(Buffer.byteLength(payload)),
        },
        payload: Readable.from([Buffer.from(payload)]),
      });

    beforeEach(async () => {
      // The first browse creates the scope's folders.
      expect((await app.inject(`${base}/files`)).statusCode).toBe(200);
      dir = scopeDir();
    });

    it('creates a new page only where a new entry may go', async () => {
      const create = (path: string) =>
        app.inject({
          method: 'PUT',
          url: `${base}/files/content`,
          payload: { path, content: '# New', expectedVersion: null },
        });
      mkdirSync(join(dir, 'insights/decisions'), { recursive: true });
      expect((await create('insights/decisions/forged.md')).statusCode).toBe(403);
      expect(existsSync(join(dir, 'insights/decisions/forged.md'))).toBe(false);
      expect((await create('insights/new.md')).statusCode).toBe(200);
      expect(read('insights/new.md')).toBe('# New');
      // An existing decision page stays editable as before; only creating one is refused.
      write('insights/decisions/record.md', 'Decided');
      const page = await app.inject(
        `${base}/files/content?path=${encodeURIComponent('insights/decisions/record.md')}`,
      );
      const edited = await app.inject({
        method: 'PUT',
        url: `${base}/files/content`,
        payload: {
          path: 'insights/decisions/record.md',
          content: 'Decided, with a note',
          expectedVersion: page.json<{ version: string }>().version,
        },
      });
      expect(edited.statusCode).toBe(200);
    });

    it('refuses every path the rules refuse, before touching the disk', async () => {
      write('insights/page.md', 'Page');
      write('insights/decisions/record.md', 'Decided');
      const entries = [
        'insights',
        'sources',
        'insights/decisions',
        'insights/decisions/record.md',
        'insights/../sources',
        'insights/./page.md',
        'insights/:id',
        'insights/.text/page.md',
        'overview.md',
        ...[...SOURCE_IMPORT_FOLDERS].map((folder) => `sources/${folder}`),
      ];
      for (const path of entries) {
        const remove = await app.inject({
          method: 'DELETE',
          url: `${base}/files?path=${encodeURIComponent(path)}`,
        });
        expect(remove.statusCode, `delete ${path}`).toBe(403);
        expect((await post('/files/rename', { path, name: 'x' })).statusCode, path).toBe(403);
        expect((await post('/files/move', { path, toPath: 'insights' })).statusCode, path).toBe(
          403,
        );
      }
      for (const [path, toPath] of [
        ['insights/page.md', 'sources'],
        ['insights/page.md', 'insights/decisions'],
        ['insights/page.md', 'insights/..'],
      ])
        expect((await post('/files/move', { path, toPath })).statusCode, toPath).toBe(403);
      for (const [path, name] of [
        ['insights/decisions', 'new'],
        ['insights', 'decisions'],
        ['insights', ':new'],
        ['shared', 'new'],
      ]) {
        expect((await post('/folders', { path, name })).statusCode, `${path} ${name}`).toBe(403);
        expect((await upload(path!, name!, 'x')).statusCode, `${path} ${name}`).toBe(403);
      }
      expect(
        (await post('/files/rename', { path: 'insights/page.md', name: ':x' })).statusCode,
      ).toBe(403);
      expect(read('insights/page.md')).toBe('Page');
      expect(read('insights/decisions/record.md')).toBe('Decided');
    });

    it('creates folders, uploads into them and deletes them', async () => {
      const created = await post('/folders', { path: 'insights', name: 'Topic' });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toEqual({ path: 'insights/Topic' });
      expect(statSync(join(dir, 'insights/Topic')).mode & 0o777).toBe(
        agentWritable ? 0o777 : 0o755,
      );
      expect((await post('/folders', { path: 'insights', name: 'Topic' })).statusCode).toBe(409);
      expect((await post('/folders', { path: 'sources/documents', name: 'Q3' })).json()).toEqual({
        path: 'sources/documents/Q3',
      });

      const uploaded = await upload('insights/Topic', 'notes.md', '# Notes');
      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.json()).toEqual({ path: 'insights/Topic/notes.md', size: 7 });
      expect(read('insights/Topic/notes.md')).toBe('# Notes');
      expect(statSync(join(dir, 'insights/Topic/notes.md')).mode & 0o777).toBe(
        agentWritable ? 0o666 : 0o644,
      );
      expect(existsSync(knowledgeExtractionPath(dir, 'insights/Topic/notes.md'))).toBe(true);
      expect((await upload('insights/Topic', 'notes.md', 'other')).statusCode).toBe(409);
      expect((await upload('sources', 'call.txt', 'Call')).json()).toEqual({
        path: 'sources/call.txt',
        size: 4,
      });

      const removed = await app.inject({
        method: 'DELETE',
        url: `${base}/files?path=${encodeURIComponent('insights/Topic')}`,
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual({ path: 'insights/Topic', deleted: true });
      expect(existsSync(join(dir, 'insights/Topic'))).toBe(false);
      expect(existsSync(knowledgeExtractionPath(dir, 'insights/Topic/notes.md'))).toBe(false);
    });

    it('creates a new Wiki page through the editor', async () => {
      const save = (expectedVersion: string | null) =>
        app.inject({
          method: 'PUT',
          url: `${base}/files/content`,
          payload: { path: 'insights/new.md', content: '# New', expectedVersion },
        });
      const created = await save(null);
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({ path: 'insights/new.md' });
      expect(read('insights/new.md')).toBe('# New');
      // Creating never replaces a page that exists.
      expect((await save(null)).statusCode).toBe(409);
    });

    it('renames a Wiki page and keeps every link to it working', async () => {
      write('insights/topic/plan.md', '# Plan\n[Budget](budget.md)');
      write(
        'insights/index.md',
        'See [the plan](topic/plan.md#goals) and [web](https://x.test/plan.md).',
      );
      const backlinks = await app.inject(
        `${base}/files/backlinks?path=${encodeURIComponent('insights/topic/plan.md')}`,
      );
      expect(backlinks.json()).toEqual({ pages: [{ path: 'insights/index.md', links: 1 }] });

      const renamed = await post('/files/rename', {
        path: 'insights/topic/plan.md',
        name: 'roadmap.md',
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toEqual({
        path: 'insights/topic/roadmap.md',
        linksUpdated: [{ path: 'insights/index.md', links: 1 }],
      });
      expect(read('insights/index.md')).toBe(
        'See [the plan](topic/roadmap.md#goals) and [web](https://x.test/plan.md).',
      );
      // Its own link still reaches the sibling it reached before.
      expect(read('insights/topic/roadmap.md')).toBe('# Plan\n[Budget](budget.md)');
    });

    it('moves Wiki pages and folders and rewrites links on both sides', async () => {
      write('insights/topic/plan.md', '[Budget](budget.md) [Home](../index.md)');
      write('insights/topic/budget.md', '[Plan](plan.md)');
      write('insights/index.md', '[Plan](topic/plan.md) [Budget](topic/budget.md)');
      mkdirSync(join(dir, 'insights/archive'));

      const page = await post('/files/move', {
        path: 'insights/topic/plan.md',
        toPath: 'insights/archive',
      });
      expect(page.statusCode).toBe(200);
      expect(page.json()).toEqual({
        path: 'insights/archive/plan.md',
        linksUpdated: [
          { path: 'insights/archive/plan.md', links: 1 },
          { path: 'insights/index.md', links: 1 },
          { path: 'insights/topic/budget.md', links: 1 },
        ],
      });
      expect(read('insights/archive/plan.md')).toBe(
        '[Budget](../topic/budget.md) [Home](../index.md)',
      );
      expect(read('insights/topic/budget.md')).toBe('[Plan](../archive/plan.md)');

      const folder = await post('/files/move', {
        path: 'insights/topic',
        toPath: 'insights/archive',
      });
      expect(folder.statusCode).toBe(200);
      expect(folder.json()).toMatchObject({ path: 'insights/archive/topic' });
      expect(existsSync(join(dir, 'insights/topic'))).toBe(false);
      expect(read('insights/index.md')).toBe(
        '[Plan](archive/plan.md) [Budget](archive/topic/budget.md)',
      );
      expect(read('insights/archive/plan.md')).toBe(
        '[Budget](topic/budget.md) [Home](../index.md)',
      );
      expect(read('insights/archive/topic/budget.md')).toBe('[Plan](../plan.md)');
      // Extracted text follows the folder.
      expect(existsSync(knowledgeExtractionPath(dir, 'insights/archive/topic/budget.md'))).toBe(
        true,
      );

      expect(
        (await post('/files/move', { path: 'insights/archive', toPath: 'insights/archive/topic' }))
          .statusCode,
      ).toBe(403);
      write('insights/plan.md', 'Taken');
      expect(
        (await post('/files/move', { path: 'insights/archive/plan.md', toPath: 'insights' }))
          .statusCode,
      ).toBe(409);
      expect(read('insights/plan.md')).toBe('Taken');
    });

    it('moves Sources and keeps the Wiki links to them', async () => {
      write('sources/documents/call.md', 'Call');
      write('insights/index.md', '[Call](../sources/documents/call.md)');
      mkdirSync(join(dir, 'sources/calls'));
      const moved = await post('/files/move', {
        path: 'sources/documents/call.md',
        toPath: 'sources/calls',
      });
      expect(moved.json()).toEqual({
        path: 'sources/calls/call.md',
        linksUpdated: [{ path: 'insights/index.md', links: 1 }],
      });
      expect(read('insights/index.md')).toBe('[Call](../sources/calls/call.md)');
    });
  });

  it('keeps the scopes apart: a Shared move never rewrites project pages', async () => {
    await app.inject('/projects/p-1/knowledge/files');
    await app.inject('/knowledge/shared/files');
    const project = projectKnowledgeDir(dataRoot, 'p-1');
    const shared = sharedKnowledgeDir(dataRoot);
    writeFileSync(join(project, 'insights/index.md'), '[Page](page.md)');
    writeFileSync(join(shared, 'insights/page.md'), 'Shared page');
    const renamed = await app.inject({
      method: 'POST',
      url: '/knowledge/shared/files/rename',
      payload: { path: 'insights/page.md', name: 'renamed.md' },
    });
    expect(renamed.json()).toEqual({ path: 'insights/renamed.md', linksUpdated: [] });
    expect(readFileSync(join(project, 'insights/index.md'), 'utf8')).toBe('[Page](page.md)');
  });

  describe('session folders', () => {
    const createFolder = (payload: object) =>
      app.inject({ method: 'POST', url: '/sessions/s-1/files/folders', payload });

    it('creates folders in the worktree and the knowledge roots, never in drafts', async () => {
      const created = await createFolder({ root: 'worktree', path: '', name: 'folder' });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toEqual({ path: 'folder' });
      expect(statSync(join(worktree, 'folder')).isDirectory()).toBe(true);
      expect((await createFolder({ root: 'worktree', path: '', name: 'folder' })).statusCode).toBe(
        409,
      );
      expect(
        (await createFolder({ root: 'worktree', path: 'folder', name: '..' })).statusCode,
      ).toBe(400);
      expect((await createFolder({ root: 'wiki', path: '', name: 'Topic' })).json()).toEqual({
        path: 'Topic',
      });
      expect(
        statSync(join(projectKnowledgeDir(dataRoot, 'p-1'), 'insights/Topic')).mode & 0o777,
      ).toBe(0o777);
      mkdirSync(join(projectKnowledgeDir(dataRoot, 'p-1'), 'insights/decisions'), {
        recursive: true,
      });
      expect((await createFolder({ root: 'wiki', path: 'decisions', name: 'x' })).statusCode).toBe(
        400,
      );
      expect((await createFolder({ root: 'drafts', path: '', name: 'x' })).statusCode).toBe(403);
    });

    it('moves folders within the worktree, never into themselves', async () => {
      mkdirSync(join(worktree, 'folder/inner'), { recursive: true });
      writeFileSync(join(worktree, 'folder/inner/a.txt'), 'A');
      mkdirSync(join(worktree, 'target'));
      const move = (path: string, toPath: string, toFileName?: string) =>
        app.inject({
          method: 'POST',
          url: '/sessions/s-1/files/move',
          payload: {
            root: 'worktree',
            path,
            toRoot: 'worktree',
            toPath,
            ...(toFileName ? { toFileName } : {}),
          },
        });
      const moved = await move('folder', 'target');
      expect(moved.statusCode).toBe(200);
      expect(moved.json()).toEqual({ path: 'target/folder', root: 'worktree' });
      expect(readFileSync(join(worktree, 'target/folder/inner/a.txt'), 'utf8')).toBe('A');
      expect(existsSync(join(worktree, 'folder'))).toBe(false);
      expect((await move('target', 'target/folder')).statusCode).toBe(400);
      // A worktree folder renamed in place, which the app's rename sends as a move.
      expect((await move('target/folder', 'target', 'moved')).json()).toEqual({
        path: 'target/moved',
        root: 'worktree',
      });
      mkdirSync(join(worktree, 'moved'));
      writeFileSync(join(worktree, 'moved/keep.txt'), 'keep');
      expect((await move('target/moved', '')).statusCode).toBe(409);
      expect(readFileSync(join(worktree, 'moved/keep.txt'), 'utf8')).toBe('keep');
    });

    it('keeps a legacy worktree that is project knowledge from moving its folders', async () => {
      // An old session can name the project's knowledge folder as its worktree;
      // a Code move would carry Decisions or an import folder past the rules.
      const knowledge = projectKnowledgeDir(dataRoot, 'p-1');
      mkdirSync(join(knowledge, 'insights/decisions'), { recursive: true });
      writeFileSync(join(knowledge, 'insights/decisions/record.md'), 'Decided');
      mkdirSync(join(knowledge, 'sources'), { recursive: true });
      const legacy = Fastify();
      registerServerSessionFiles(
        legacy,
        {
          eventStore: {
            getProject: async (id: string) => (id === 'p-1' ? { id, kind: 'local' } : undefined),
            getSession: async (id: string) =>
              id === 's-legacy'
                ? { sessionId: id, worktree: knowledge, projectId: 'p-1' }
                : undefined,
          } as never,
          dataRoot,
          projectCloneRoot: undefined,
        },
        {} as Conductor,
      );
      await legacy.ready();
      const moved = await legacy.inject({
        method: 'POST',
        url: '/sessions/s-legacy/files/move',
        payload: {
          root: 'worktree',
          path: 'insights/decisions',
          toRoot: 'worktree',
          toPath: 'sources',
        },
      });
      await legacy.close();
      expect(moved.statusCode).toBe(403);
      expect(readFileSync(join(knowledge, 'insights/decisions/record.md'), 'utf8')).toBe('Decided');
    });

    it('leaves Shared to its own routes, which are administrator-only', async () => {
      // Without this, a session's execute permission would reach Shared knowledge.
      expect((await createFolder({ root: 'shared', path: '', name: 'x' })).statusCode).toBe(403);
    });

    it('moves knowledge folders only through the routes that check the knowledge rules', async () => {
      // A session root move would otherwise carry a Sources import folder into
      // the Wiki, past the rules the knowledge routes apply.
      const knowledge = projectKnowledgeDir(dataRoot, 'p-1');
      mkdirSync(join(knowledge, 'sources/meetings'), { recursive: true });
      writeFileSync(join(knowledge, 'sources/meetings/call.md'), 'Call');
      const moved = await app.inject({
        method: 'POST',
        url: '/sessions/s-1/files/move',
        payload: {
          root: 'knowledge',
          path: 'sources/meetings',
          toRoot: 'knowledge',
          toPath: 'insights',
        },
      });
      expect(moved.statusCode).toBe(403);
      expect(readFileSync(join(knowledge, 'sources/meetings/call.md'), 'utf8')).toBe('Call');
    });
  });
});
