import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createKnowledgeWikiJobs } from './knowledge-wiki-jobs.js';
import { registerKnowledgeProjectRoutes } from './knowledge-project-routes.js';

let ctx: TestDb;
let directory: string;
beforeAll(async () => {
  ctx = await createTestDb();
  directory = await mkdtemp(join(tmpdir(), 'wiki-jobs-'));
});
afterAll(async () => {
  await ctx.close();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});
async function setup() {
  await ctx.store.upsertProject({
    id: 'project',
    owner: 'example',
    repo: 'project',
    containerName: 'project',
    state: 'active',
  });
  const space = (await ctx.store.knowledge.getProjectSpace('project'))!;
  const source = await ctx.store.knowledge.createDocument({
    folderId: space.sourcesFolderId,
    title: 'Meeting',
    bodyMarkdown: 'A project decision.',
  });
  return { space, source };
}
it('starts a fresh scoped session with selected model and exposes completion through routes', async () => {
  const { space, source } = await setup();
  const release = vi.fn();
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const sendTurn = vi.fn(async (sessionId: string) => {
    const session = (await ctx.store.getSession(sessionId))!;
    expect(session.projectId).toBe('project');
    expect(session.model).toBe('codex/default');
    expect(await readFile(join(session.worktree, '.git/HEAD'), 'utf8')).toContain(
      'refs/heads/wiki',
    );
    const actor = { projectId: 'project', sessionId, turnId: 'wiki-turn' };
    // Creating through the ordinary tool succeeds only after the server binds a fresh job.
    await ctx.store.knowledge.runAgent(actor, 'create', {
      folderId: space.wikiFolderId,
      title: 'Decisions',
      bodyMarkdown: 'Decision from meeting.',
    });
    await waiting;
    return { sessionId, exitCode: 0, stderr: '', aborted: false };
  });
  const jobs = createKnowledgeWikiJobs({
    store: ctx.store,
    conductor: {
      sendTurn,
      cancelTurn: vi.fn(async () => {
        finish();
        return true;
      }),
    },
    prepare: async (_id, model) => ({ model: model!, directory, release }),
    onError: (error) => {
      throw error;
    },
  });
  const app = Fastify();
  registerKnowledgeProjectRoutes(app, {
    knowledge: ctx.store.knowledge,
    startWikiJob: (id, input) => jobs.start(id, input),
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/projects/project/knowledge-wiki-jobs',
      payload: { kind: 'ingest', sourceDocumentIds: [source.id], model: 'codex/default' },
    });
    expect(response.statusCode).toBe(202);
    const { job } = response.json();
    expect(job.status).toBe('running');
    expect(job.sourceRevisions).toEqual([
      { documentId: source.id, revisionId: source.currentRevisionId },
    ]);
    expect(release).toHaveBeenCalledOnce();
    expect((await app.inject('/projects/project/knowledge-space')).json().space.wikiFolderId).toBe(
      space.wikiFolderId,
    );
    finish();
    await jobs.close();
    expect((await app.inject(`/knowledge/wiki-jobs/${job.id}`)).json().job.status).toBe(
      'completed',
    );
    expect(sendTurn.mock.calls[0]?.[0]).toBe(job.sessionId);
    const overviewDoc = (
      await ctx.store.knowledge.listDocuments({ folderId: space.wikiFolderId })
    )[0]!;
    const approved = await app.inject({
      method: 'PUT',
      url: '/projects/project/knowledge-overview',
      payload: { documentId: overviewDoc.id, expectedRevisionId: overviewDoc.currentRevisionId },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().overview.documentId).toBe(overviewDoc.id);
  } finally {
    finish();
    await jobs.close();
    await app.close();
  }
});
it('marks backend failure without claiming success and cleans rejected job sessions', async () => {
  const { source } = await setup();
  const errors: unknown[] = [];
  const release = vi.fn();
  const jobs = createKnowledgeWikiJobs({
    store: ctx.store,
    conductor: {
      sendTurn: vi.fn(async () => {
        throw new Error('backend unavailable');
      }),
      cancelTurn: vi.fn(async () => true),
    },
    prepare: async () => ({ model: 'claude', directory, release }),
    onError: (error) => {
      errors.push(error);
    },
  });
  const before = await readdir(directory);
  await expect(
    jobs.start('project', { kind: 'ingest', sourceDocumentIds: ['missing'] }),
  ).rejects.toMatchObject({ code: 'not_found' });
  expect(await readdir(directory)).toEqual(before);
  const job = await jobs.start('project', { kind: 'ingest', sourceDocumentIds: [source.id] });
  await jobs.close();
  expect((await ctx.store.knowledge.getWikiJob(job.id))?.status).toBe('failed');
  expect(errors).toHaveLength(1);
  expect(release).toHaveBeenCalledTimes(2);
});

it('drains pending starts on shutdown and never starts a backend after close returns', async () => {
  const { source } = await setup();
  const release = vi.fn();
  let prepareReady!: () => void;
  const prepared = new Promise<void>((resolve) => {
    prepareReady = resolve;
  });
  const sendTurn = vi.fn(async (sessionId: string) => ({
    sessionId,
    exitCode: 0,
    stderr: '',
    aborted: false,
  }));
  const jobs = createKnowledgeWikiJobs({
    store: ctx.store,
    conductor: { sendTurn, cancelTurn: vi.fn(async () => true) },
    prepare: async () => {
      await prepared;
      return { model: 'claude', directory, release };
    },
    onError: () => {},
  });
  const pending = jobs.start('project', { kind: 'ingest', sourceDocumentIds: [source.id] });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'conflict' });
  let closed = false;
  const closing = jobs.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  prepareReady();
  await rejected;
  await closing;
  expect(sendTurn).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
  expect(await ctx.store.knowledge.listWikiJobs('project')).toEqual([]);
});
