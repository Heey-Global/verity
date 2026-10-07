import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { Conductor } from './conductor.js';
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

describe('knowledge changes during a session', () => {
  it('continues direct, background, loop and initial turns after knowledge is removed', async () => {
    const folder = await ctx.store.knowledge.createFolder({ name: 'Notes' });
    await ctx.store.knowledge.setGrants('p', [{ folderId: folder.id, mode: 'read' }]);
    await ctx.store.appendEvent('s', { t: 'text', delta: 'Previously visible knowledge' });
    await ctx.store.knowledge.deleteFolder(folder.id);
    const run = vi.fn<Backend['run']>(async (opts) => {
      await opts.onSession?.('s');
      return { sessionId: 's', exitCode: 0, stderr: '', aborted: false };
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: { run },
      worktreeExists: async () => true,
    });
    // Deleting a source must not silently turn every existing conversation into history.
    await expect(conductor.sendTurn('s', 'Continue')).resolves.toMatchObject({ exitCode: 0 });
    await expect(conductor.dispatchTurn('s', 'Continue')).resolves.toEqual({ queued: false });
    await expect.poll(() => conductor.isBusy('s')).toBe(false);
    await expect(conductor.dispatchTurnWhenIdle('s', 'Continue')).resolves.toEqual({
      accepted: true,
    });
    await expect.poll(() => conductor.isBusy('s')).toBe(false);
    await expect(
      conductor.startSession({ sessionId: 's', worktree: '/test', prompt: 'Continue' }),
    ).resolves.toEqual({ sessionId: 's' });
    await expect.poll(() => conductor.isBusy('s')).toBe(false);
    expect(run).toHaveBeenCalledTimes(4);
    const restarted = new Conductor({
      store: ctx.store,
      backend: { run },
      worktreeExists: async () => true,
    });
    await expect(restarted.sendTurn('s', 'Resume after restart')).resolves.toMatchObject({
      exitCode: 0,
    });
  });
});

describe('knowledge discovery context', () => {
  it.each(RUNNER_SUPERVISOR_BACKENDS)(
    'announces filesystem knowledge on fresh and resumed %s turns',
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
      expect(seen[0]).toContain('writable `/knowledge/insights`');
      expect(seen[0]).toContain('without asking first');
      expect(seen[0]).toContain('Prefer improving an existing insight');
      expect(seen[0]).toContain('cite the relevant source paths');
      expect(seen[0]).toContain('Ask before saving sensitive personal information');
      expect(seen[0]).toContain('`publish_shared`');
      await conductor.sendTurn('s', 'What are my values?');
      expect(seen[1]).toContain('## Project knowledge');
      expect(seen[1]).toContain('`/knowledge/.text`');
      expect(seen[1]).toContain('`verity-memory append`');
      for (const prompt of seen) {
        // Mount announcements alone allow answers that never consult either scope.
        expect(prompt).toContain('search both project knowledge and shared general knowledge');
        expect(prompt).toContain('`/knowledge/shared/.text`');
        expect(prompt).toContain('surface relevant conflicts');
      }
    },
  );
});
