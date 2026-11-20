import { beforeEach, describe, expect, it } from 'vitest';
import {
  bus,
  conductor,
  ctx,
  dispatchTurn,
  runBackendHandoff,
} from './server-fixture.test-helper.js';
import { buildServer } from './server.js';
import { NO_PERSONAL_MODEL } from './turn-sandbox.js';

// In a shared project each person's turns run on their own model and account
// (ADR 0023 §3). Falling back to the session's model, or recording a choice
// before checking it, would run a member's work on whichever account serves
// that model: the administrator's instance login.
describe("a person's own model in a shared session", () => {
  beforeEach(async () => {
    await ctx.store.updateVeritySettings({
      claudeCodeOauthCredentialsJson: '{"claudeAiOauth":{"accessToken":"claude-token"}}',
    });
    await ctx.store.upsertProject({
      id: 'p-shared',
      owner: 'heey-global',
      repo: 'shared',
      containerName: 'dev-heey-global-shared',
      state: 'active',
    });
    await ctx.db
      .insertInto('users')
      .values({ id: 'lena', role: 'member', status: 'active' })
      .execute();
    await ctx.db
      .insertInto('project_memberships')
      .values({
        project_id: 'p-shared',
        user_id: 'lena',
        can_read: true,
        can_execute: true,
        can_manage: false,
      })
      .execute();
    await ctx.store.createSession({
      sessionId: 's-shared',
      worktree: '/wt/s-shared',
      model: 'claude-opus-5-5',
      projectId: 'p-shared',
    });
  });

  async function asLena<T>(run: (server: ReturnType<typeof buildServer>) => Promise<T>) {
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      listModels: () => Promise.resolve(['codex/gpt-5.5']),
    });
    server.addHook('onRequest', async (request) => {
      request.localUserId = 'lena';
    });
    try {
      return await run(server);
    } finally {
      await server.close();
    }
  }

  it('refuses a turn when none of their own accounts serves a model', async () => {
    await asLena(async (server) => {
      const turn = await server.inject({
        method: 'POST',
        url: '/sessions/s-shared/turns',
        payload: { prompt: 'go' },
      });
      expect(turn.statusCode).toBe(400);
      expect(turn.json()).toEqual({ error: NO_PERSONAL_MODEL });
      expect(dispatchTurn).not.toHaveBeenCalled();
    });
  });

  it('refuses and does not record a model their accounts cannot serve', async () => {
    await ctx.store.userProviderConnections.set('lena', 'codex', { credential: '{}' });
    await asLena(async (server) => {
      const turn = await server.inject({
        method: 'POST',
        url: '/sessions/s-shared/turns',
        payload: { prompt: 'go', model: 'claude-opus-5-5' },
      });
      expect(turn.statusCode).toBe(400);
      expect(turn.json<{ error: string }>().error).toContain('Connect your Claude account');
      expect(dispatchTurn).not.toHaveBeenCalled();

      runBackendHandoff.mockClear();
      const chosen = await server.inject({
        method: 'PATCH',
        url: '/sessions/s-shared',
        payload: { model: 'claude-opus-5-5' },
      });
      expect(chosen.statusCode).toBe(400);
      expect(runBackendHandoff).not.toHaveBeenCalled();
      expect(await ctx.store.userProviderConnections.sessionModel('s-shared', 'lena')).toBeNull();
    });
  });
});
