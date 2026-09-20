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
    overviewVisible: true,
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
    expect(job.model).toBe('codex/default');
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
it('debounces new Sources into one automatic maintenance job', async () => {
  const { source } = await setup();
  const second = await ctx.store.knowledge.createDocument({
    folderId: (await ctx.store.knowledge.getProjectSpace('project'))!.sourcesFolderId,
    title: 'Follow-up',
    bodyMarkdown: 'A second decision.',
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
    prepare: async () => ({ model: 'codex/knowledge', directory, release: () => {} }),
    debounceMs: 5,
    onError: (error) => {
      throw error;
    },
  });
  await jobs.enqueue('project', [source.id]);
  await jobs.enqueue('project', [second.id]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await jobs.close();
  expect(sendTurn).toHaveBeenCalledOnce();
  const [job] = await ctx.store.knowledge.listWikiJobs('project');
  expect(job).toMatchObject({ model: 'codex/knowledge', status: 'completed' });
  expect(job!.sourceRevisions.map((item) => item.documentId)).toEqual(
    expect.arrayContaining([source.id, second.id]),
  );
});
it('recovers debounced maintenance after a server restart', async () => {
  const { source } = await setup();
  const first = createKnowledgeWikiJobs({
    store: ctx.store,
    conductor: { sendTurn: vi.fn(), cancelTurn: vi.fn(async () => true) },
    prepare: async () => ({ model: 'codex/knowledge', directory, release: () => {} }),
    debounceMs: 10,
    onError: () => {},
  });
  await first.enqueue('project', [source.id]);
  await first.close();
  expect(await ctx.store.knowledge.listWikiMaintenance('project')).toHaveLength(1);

  const sendTurn = vi.fn(async (sessionId: string) => ({
    sessionId,
    exitCode: 0,
    stderr: '',
    aborted: false,
  }));
  const recovered = createKnowledgeWikiJobs({
    store: ctx.store,
    conductor: { sendTurn, cancelTurn: vi.fn(async () => true) },
    prepare: async () => ({ model: 'codex/knowledge', directory, release: () => {} }),
    onError: (error) => {
      throw error;
    },
  });
  await recovered.recover();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await recovered.close();
  expect(sendTurn).toHaveBeenCalledOnce();
  expect(await ctx.store.knowledge.listWikiMaintenance('project')).toEqual([]);
});
it('retains automatic maintenance after a backend failure', async () => {
  const { source } = await setup();
  const jobs = createKnowledgeWikiJobs({
    store: ctx.store,
    conductor: {
      sendTurn: vi.fn(async (sessionId: string) => ({
        sessionId,
        exitCode: 1,
        stderr: 'backend failed',
        aborted: false,
      })),
      cancelTurn: vi.fn(async () => true),
    },
    prepare: async () => ({ model: 'codex/knowledge', directory, release: () => {} }),
    debounceMs: 5,
    onError: () => {},
  });
  await jobs.enqueue('project', [source.id]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await jobs.close();
  expect(await ctx.store.knowledge.listWikiMaintenance('project')).toMatchObject([
    { projectId: 'project', sourceDocumentId: source.id },
  ]);
});
it('reports a failed post-job queue read without leaking an unhandled rejection', async () => {
  const { source } = await setup();
  const errors: unknown[] = [];
  const original = ctx.store.knowledge.listWikiMaintenance.bind(ctx.store.knowledge);
  const list = vi
    .spyOn(ctx.store.knowledge, 'listWikiMaintenance')
    .mockImplementationOnce(original)
    .mockRejectedValueOnce(new Error('database temporarily unavailable'));
  const jobs = createKnowledgeWikiJobs({
    store: ctx.store,
    conductor: {
      sendTurn: vi.fn(async (sessionId: string) => ({
        sessionId,
        exitCode: 0,
        stderr: '',
        aborted: false,
      })),
      cancelTurn: vi.fn(async () => true),
    },
    prepare: async () => ({ model: 'codex/knowledge', directory, release: () => {} }),
    debounceMs: 5,
    onError: (error) => errors.push(error),
  });
  try {
    await jobs.enqueue('project', [source.id]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(errors).toEqual([
      expect.objectContaining({ message: 'database temporarily unavailable' }),
    ]);
  } finally {
    await jobs.close();
    list.mockRestore();
  }
});
it('automatically reconciles the Wiki after its last Source is deleted', async () => {
  const { source } = await setup();
  await ctx.store.knowledge.deleteDocument(source.id);
  const prompts: string[] = [];
  const jobs = createKnowledgeWikiJobs({
    store: ctx.store,
    conductor: {
      sendTurn: vi.fn(async (sessionId: string, prompt: string) => {
        prompts.push(prompt);
        return { sessionId, exitCode: 0, stderr: '', aborted: false };
      }),
      cancelTurn: vi.fn(async () => true),
    },
    prepare: async () => ({ model: 'codex/knowledge', directory, release: () => {} }),
    debounceMs: 5,
    onError: (error) => {
      throw error;
    },
  });
  await jobs.enqueueReconciliation('project');
  await new Promise((resolve) => setTimeout(resolve, 30));
  await jobs.close();
  expect(prompts[0]).toContain('Reconcile the project Wiki after Sources were removed');
  expect((await ctx.store.knowledge.listWikiJobs('project'))[0]).toMatchObject({
    kind: 'reconcile',
    status: 'completed',
    sourceRevisions: [],
  });
  expect(await ctx.store.knowledge.listWikiReconciliations()).toEqual([]);
});
it('runs reconciliation and ingestion separately when both are pending', async () => {
  const { source } = await setup();
  const kinds: string[] = [];
  const jobs = createKnowledgeWikiJobs({
    store: ctx.store,
    conductor: {
      sendTurn: vi.fn(async (sessionId: string, prompt: string) => {
        kinds.push(prompt.includes('Reconcile the project Wiki') ? 'reconcile' : 'ingest');
        return { sessionId, exitCode: 0, stderr: '', aborted: false };
      }),
      cancelTurn: vi.fn(async () => true),
    },
    prepare: async () => ({ model: 'codex/knowledge', directory, release: () => {} }),
    debounceMs: 5,
    onError: (error) => {
      throw error;
    },
  });
  await jobs.enqueue('project', [source.id]);
  await jobs.enqueueReconciliation('project');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await jobs.close();
  expect(kinds).toEqual(['reconcile', 'ingest']);
  expect(await ctx.store.knowledge.listWikiMaintenance('project')).toEqual([]);
  expect(await ctx.store.knowledge.listWikiReconciliations()).toEqual([]);
});
it('does not clear a source that was queued again after a job claimed it', async () => {
  const { source } = await setup();
  const firstDueAt = new Date('2026-01-01T00:00:00.000Z');
  const replacementDueAt = new Date('2026-01-01T00:01:00.000Z');
  await ctx.store.knowledge.queueWikiMaintenance('project', [source.id], firstDueAt);
  const claimed = await ctx.store.knowledge.listWikiMaintenance('project');
  await ctx.store.knowledge.queueWikiMaintenance('project', [source.id], replacementDueAt);
  await ctx.store.knowledge.clearWikiMaintenance(claimed);
  expect(await ctx.store.knowledge.listWikiMaintenance('project')).toEqual([
    { projectId: 'project', sourceDocumentId: source.id, dueAt: replacementDueAt },
  ]);
});
it('waits for active project maintenance before starting the next batch', async () => {
  const { source, space } = await setup();
  const second = await ctx.store.knowledge.createDocument({
    folderId: space.sourcesFolderId,
    title: 'Later upload',
    bodyMarkdown: 'A later decision.',
  });
  let firstStarted!: () => void;
  let finishFirst!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const firstFinished = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const prompts: string[] = [];
  const sendTurn = vi.fn(async (sessionId: string, prompt: string) => {
    prompts.push(prompt);
    if (sendTurn.mock.calls.length === 1) {
      firstStarted();
      await firstFinished;
    }
    return { sessionId, exitCode: 0, stderr: '', aborted: false };
  });
  const jobs = createKnowledgeWikiJobs({
    store: ctx.store,
    conductor: { sendTurn, cancelTurn: vi.fn(async () => true) },
    prepare: async () => ({ model: 'codex/knowledge', directory, release: () => {} }),
    debounceMs: 5,
    onError: (error) => {
      throw error;
    },
  });
  await jobs.enqueue('project', [source.id]);
  await started;
  await jobs.enqueue('project', [second.id]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sendTurn).toHaveBeenCalledOnce();
  finishFirst();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await jobs.close();
  expect(sendTurn).toHaveBeenCalledTimes(2);
  expect(prompts[1]).toContain(second.id);
  expect(prompts[1]).not.toContain(source.id);
});
it('cancels a running automatic job before waiting for its completion on shutdown', async () => {
  const { source } = await setup();
  let started!: () => void;
  let finish!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  const didFinish = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const cancelTurn = vi.fn(async () => {
    finish();
    return true;
  });
  const jobs = createKnowledgeWikiJobs({
    store: ctx.store,
    conductor: {
      sendTurn: vi.fn(async (sessionId: string) => {
        started();
        await didFinish;
        return { sessionId, exitCode: 0, stderr: '', aborted: true };
      }),
      cancelTurn,
    },
    prepare: async () => ({ model: 'codex/knowledge', directory, release: () => {} }),
    debounceMs: 5,
    onError: (error) => {
      throw error;
    },
  });
  await jobs.enqueue('project', [source.id]);
  await didStart;
  await jobs.close();
  expect(cancelTurn).toHaveBeenCalledOnce();
});
it('marks backend failure without claiming success and cleans rejected job sessions', async () => {
  const { source } = await setup();
  const errors: unknown[] = [];
  const release = vi.fn();
  const sendTurn = vi.fn(async () => {
    throw new Error('backend unavailable');
  });
  const jobs = createKnowledgeWikiJobs({
    store: ctx.store,
    conductor: {
      sendTurn,
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
  expect(sendTurn).toHaveBeenCalledTimes(3);
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
