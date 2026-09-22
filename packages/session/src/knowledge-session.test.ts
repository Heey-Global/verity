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
      await conductor.sendTurn('s', 'What are my values?');
      expect(seen[1]).toContain('## Project knowledge');
      expect(seen[1]).toContain('use verity_knowledge to list');
      expect(seen[1]).toContain('unavailable verity-memory');
    },
  );
});
