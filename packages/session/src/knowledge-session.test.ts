import { KNOWLEDGE_WIKI_CONTEXT_INSTRUCTIONS } from '@verity/events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { Conductor, KnowledgeSessionClosedError } from './conductor.js';
import { RUNNER_SUPERVISOR_BACKENDS, type Backend } from './backend.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'test',
    repo: 'test',
    containerName: 'test',
    state: 'absent',
    overviewVisible: true,
  });
  await ctx.store.createSession({
    sessionId: 's',
    projectId: 'p',
    worktree: '/test',
    model: 'test',
  });
});

describe('knowledge session closure', () => {
  it('fences direct, background, loop and initial dispatch after a read grant is removed', async () => {
    const folder = await ctx.store.knowledge.createFolder({ name: 'Notes' });
    await ctx.store.knowledge.setGrants('p', [{ folderId: folder.id, mode: 'read' }]);
    await ctx.store.appendEvent('s', { t: 'text', delta: 'Previously visible knowledge' });
    await ctx.store.knowledge.setGrants('p', []);
    const run = vi.fn<Backend['run']>(async () => {
      throw new Error('closed session reached backend');
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: { run },
      worktreeExists: async () => true,
    });
    await expect(conductor.sendTurn('s', 'Continue')).rejects.toBeInstanceOf(
      KnowledgeSessionClosedError,
    );
    await expect(conductor.dispatchTurn('s', 'Continue')).rejects.toBeInstanceOf(
      KnowledgeSessionClosedError,
    );
    await expect(conductor.dispatchTurnWhenIdle('s', 'Continue')).rejects.toBeInstanceOf(
      KnowledgeSessionClosedError,
    );
    await expect(
      conductor.startSession({ sessionId: 's', worktree: '/test', prompt: 'Continue' }),
    ).rejects.toBeInstanceOf(KnowledgeSessionClosedError);
    expect(run).not.toHaveBeenCalled();
    expect(conductor.isBusy('s')).toBe(false);
    expect(await ctx.store.getEvents('s')).toEqual([
      expect.objectContaining({ t: 'text', delta: 'Previously visible knowledge' }),
    ]);
    // A fresh conductor must read the durable fence rather than rely on a stopped in-memory handle.
    const restarted = new Conductor({
      store: ctx.store,
      backend: { run },
      worktreeExists: async () => true,
    });
    await expect(restarted.dispatchTurn('s', 'Resume after restart')).rejects.toBeInstanceOf(
      KnowledgeSessionClosedError,
    );
  });
});

describe('knowledge discovery context', () => {
  it.each(RUNNER_SUPERVISOR_BACKENDS)(
    'announces newly granted knowledge on resumed %s turns',
    async (runnerSupervisorBackend) => {
      const seen: string[] = [];
      const backend: Backend = {
        runnerSupervisorBackend,
        run: async (opts) => {
          expect(opts.knowledgeIsolation).not.toBe(true);
          seen.push(opts.appendSystemPrompt ?? '');
          await opts.onSession?.('thread-knowledge');
          return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend,
        worktreeExists: async () => true,
      });
      await conductor.sendTurn('s', 'Hello');
      expect(seen[0]).toContain('## Project knowledge');
      const folder = await ctx.store.knowledge.createFolder({ name: 'Personal' });
      await ctx.store.knowledge.setGrants('p', [{ folderId: folder.id, mode: 'read' }]);
      // A grant added after context creation must not leave the agent searching only its repo.
      await conductor.sendTurn('s', 'What are my values?');
      expect(seen[1]).toContain('## Project knowledge');
      expect(seen[1]).toContain('use verity_knowledge to list');
      expect(seen[1]).toContain('unavailable verity-memory');
    },
  );
});

describe('scoped Wiki session context', () => {
  it.each(['completed', 'failed'] as const)(
    'cannot resume a %s Wiki job through any dispatch path',
    async (status) => {
      const job = await ctx.store.knowledge.createWikiJob({
        projectId: 'p',
        sessionId: 's',
        sourceDocumentIds: [],
        kind: 'check',
      });
      await ctx.store.knowledge.updateWikiJob(job.id, { status });
      const run = vi.fn<Backend['run']>(async () => {
        throw new Error('terminal Wiki job reached backend');
      });
      const conductor = new Conductor({
        store: ctx.store,
        backend: { run },
        worktreeExists: async () => true,
      });
      await expect(conductor.sendTurn('s', 'Continue')).rejects.toBeInstanceOf(
        KnowledgeSessionClosedError,
      );
      await expect(conductor.dispatchTurn('s', 'Continue')).rejects.toBeInstanceOf(
        KnowledgeSessionClosedError,
      );
      await expect(conductor.dispatchTurnWhenIdle('s', 'Continue')).rejects.toBeInstanceOf(
        KnowledgeSessionClosedError,
      );
      await expect(
        conductor.startSession({ sessionId: 's', worktree: '/test', prompt: 'Continue' }),
      ).rejects.toBeInstanceOf(KnowledgeSessionClosedError);
      expect(run).not.toHaveBeenCalled();
    },
  );
  it.each(RUNNER_SUPERVISOR_BACKENDS)(
    'uses only Wiki context on %s, excluding legacy memory and custom session context',
    async (runnerSupervisorBackend) => {
      await ctx.store.updateProjectSettings('p', { memory: 'private-memory-sentinel' });
      await ctx.store.knowledge.createWikiJob({
        projectId: 'p',
        sessionId: 's',
        sourceDocumentIds: [],
        kind: 'check',
      });
      const prompts: string[] = [];
      const backend: Backend = {
        runnerSupervisorBackend,
        run: async () => {
          throw new Error('Wiki job must use the supervised runner boundary');
        },
      };
      const customContext = vi.fn(async () => 'private-session-context-sentinel');
      const conductor = new Conductor({
        store: ctx.store,
        backend,
        sessionSystemPrompt: customContext,
        worktreeExists: async () => true,
        runner: () => ({
          startTurn: (opts, hooks) => {
            expect(opts.knowledgeIsolation).toBe(true);
            prompts.push(opts.appendSystemPrompt ?? '');
            return {
              result: (async () => {
                await hooks.onSession?.('wiki-thread');
                return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
              })(),
              steer: async () => false,
              answerPermission: async () => false,
              cancel: async () => true,
            };
          },
        }),
      });
      await conductor.sendTurn('s', 'Check Wiki');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toBe(KNOWLEDGE_WIKI_CONTEXT_INSTRUCTIONS);
      expect(prompts[0]).not.toContain('private-memory-sentinel');
      expect(prompts[0]).not.toContain('private-session-context-sentinel');
      expect(customContext).not.toHaveBeenCalled();
    },
  );
});

it.each(['pending', 'running'] as const)(
  'keeps %s Wiki jobs closed to public follow-up prompts and initial dispatch',
  async (status) => {
    const job = await ctx.store.knowledge.createWikiJob({
      projectId: 'p',
      sessionId: 's',
      sourceDocumentIds: [],
      kind: 'check',
    });
    if (status === 'running') await ctx.store.knowledge.updateWikiJob(job.id, { status });
    const run = vi.fn<Backend['run']>(async () => {
      throw new Error('public prompt reached Wiki backend');
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: { run },
      worktreeExists: async () => true,
    });
    await expect(
      conductor.dispatchTurn('s', 'Read unrelated project secrets'),
    ).rejects.toBeInstanceOf(KnowledgeSessionClosedError);
    await expect(
      conductor.dispatchTurnWhenIdle('s', 'Continue with unrelated context'),
    ).rejects.toBeInstanceOf(KnowledgeSessionClosedError);
    await expect(
      conductor.startSession({ sessionId: 's', worktree: '/test', prompt: 'New context' }),
    ).rejects.toBeInstanceOf(KnowledgeSessionClosedError);
    expect(run).not.toHaveBeenCalled();
    expect(await ctx.store.getEvents('s')).toEqual([]);
  },
);
