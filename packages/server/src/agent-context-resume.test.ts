import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedTestDb, type TestDb } from '@verity/store/testing';
import { Conductor, RUNNER_SUPERVISOR_BACKENDS, type Backend } from '@verity/session';
import { resolveAgentContext } from './agent-context.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createIsolatedTestDb();
  await ctx.db
    .insertInto('users')
    .values([
      { id: 'alice', role: 'member', status: 'active' },
      { id: 'bob', role: 'member', status: 'active' },
    ])
    .execute();
  for (const userId of ['alice', 'bob']) {
    await ctx.store.userContext.replace(userId, 0, {
      instructions: `${userId}-private-instructions`,
      memory: `${userId}-private-memory`,
    });
  }
});
afterAll(async () => {
  await ctx.close();
});

describe('personal context across real persisted turns', () => {
  it.each(RUNNER_SUPERVISOR_BACKENDS)(
    'resumes %s for the same user and rebuilds on user changes or missing identity',
    async (runnerSupervisorBackend) => {
      const sessionId = `context-${runnerSupervisorBackend}`;
      await ctx.store.createSession({ sessionId, worktree: `/test/${sessionId}`, model: 'test' });
      const seen: { resume: string | undefined; system: string; input: string }[] = [];
      const backend: Backend = {
        runnerSupervisorBackend,
        run: async (opts) => {
          seen.push({
            resume: opts.resumeSessionId,
            system: opts.appendSystemPrompt ?? '',
            input: JSON.stringify(opts.prompt),
          });
          await opts.onSession?.(`${sessionId}-thread-${seen.length}`);
          return { sessionId, exitCode: 0, stderr: '', aborted: false };
        },
      };
      const deps = {
        store: ctx.store,
        backend,
        worktreeExists: async () => true,
        // Resolve through the running prompt and persisted identity, as production does.
        agentContext: (session: Parameters<typeof resolveAgentContext>[2]) =>
          resolveAgentContext(ctx.store, '/unused', session, async () => undefined, true),
      };
      const alice = { initiatedBy: { userId: 'alice' } };
      const conductor = new Conductor(deps);
      await conductor.sendTurn(sessionId, 'First turn', {}, undefined, alice);
      expect(seen[0]!.system).toContain('alice-private-instructions');
      expect(seen[0]!.system).toContain('alice-private-memory');
      expect(seen[0]!.system).not.toContain('bob-private');
      expect(seen[0]!.resume).toBeUndefined();

      // A new Conductor loses in-memory state, so only durable identity and fingerprint remain.
      const restarted = new Conductor(deps);
      await restarted.sendTurn(sessionId, 'Continue after restart', {}, undefined, alice);
      expect(seen[1]!.resume).toBe(`${sessionId}-thread-1`);
      const [state] = await ctx.store.getSessionBackendStates(sessionId);
      expect(state?.contextFingerprint).toMatch(/^v2:canonical:/);

      await restarted.dispatchTurn(sessionId, 'Another user continues', undefined, {
        initiatedBy: { userId: 'bob' },
      });
      await expect.poll(() => restarted.isBusy(sessionId)).toBe(false);
      expect(seen).toHaveLength(3);
      expect(seen[2]!.resume).toBeUndefined();
      expect(seen[2]!.system).toContain('bob-private-instructions');
      expect(seen[2]!.system).toContain('bob-private-memory');
      expect(seen[2]!.system + seen[2]!.input).not.toContain('alice-private');

      await restarted.sendTurn(sessionId, 'Identity-less system turn');
      expect(seen[3]!.resume).toBeUndefined();
      expect(seen[3]!.system + seen[3]!.input).not.toMatch(/alice-private|bob-private/);
      expect(seen[3]!.system).not.toContain('## User Instructions');
      expect(seen[3]!.system).not.toContain('## User Memory');
    },
  );
});
