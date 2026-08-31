import { EventStore } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { registerAgentLoopRoutes } from './agent-loop-routes.js';

let ctx: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  const store = new EventStore(ctx.db);
  await store.upsertProject({
    id: 'p1',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'verity-heey-global--verity',
    state: 'active',
  });
  app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'invalid request' });
    return reply.send(error);
  });
  registerAgentLoopRoutes(app, {
    eventStore: store,
    createLoopSession: async (loop) => {
      const sessionId = `session-${loop.id}`;
      await store.createSession({
        sessionId,
        worktree: `/worktrees/${sessionId}`,
        model: 'codex/default',
        name: `Agent Loop: ${loop.name}`,
        projectId: loop.projectId,
        kind: 'agent_loop',
      });
      return { sessionId };
    },
  });
});
afterEach(async () => app.close());

const validBody = {
  name: 'Nightly audit',
  schedule: { kind: 'daily', hour: 3, minute: 0 },
  script: '#!/bin/sh\nexit 0',
  reactionPrompt: 'Audit the repo for critical issues.',
} as const;

async function createLoop(body: Record<string, unknown> = validBody) {
  return app.inject({ method: 'POST', url: '/projects/p1/agent-loops', payload: body });
}

describe('Agent Loop routes', () => {
  it('creates a draft, lists, gets, patches, and deletes it', async () => {
    const created = await createLoop();
    expect(created.statusCode).toBe(201);
    const { loop } = created.json<{
      loop: { id: string; name: string; status: string; sessionId: string | null };
    }>();
    expect(loop).toMatchObject({
      name: 'Nightly audit',
      status: 'draft',
      sessionId: `session-${loop.id}`,
    });

    const list = await app.inject({ method: 'GET', url: '/projects/p1/agent-loops' });
    expect(list.json<{ loops: unknown[] }>().loops).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/agent-loops/${loop.id}` })).statusCode).toBe(
      200,
    );

    const patched = await app.inject({
      method: 'PATCH',
      url: `/agent-loops/${loop.id}`,
      payload: { name: 'renamed', status: 'paused' },
    });
    expect(patched.json<{ loop: { name: string; status: string } }>().loop).toMatchObject({
      name: 'renamed',
      status: 'paused',
    });
    expect((await new EventStore(ctx.db).getSession(loop.sessionId!))?.name).toBe(
      'Agent Loop: renamed',
    );

    expect(
      (await app.inject({ method: 'DELETE', url: `/agent-loops/${loop.id}` })).statusCode,
    ).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/projects/p1/agent-loops' });
    expect(after.json<{ loops: unknown[] }>().loops).toHaveLength(0);
  });

  it('recreates and links a deleted loop session on demand', async () => {
    const store = new EventStore(ctx.db);
    const { loop } = (await createLoop()).json<{
      loop: { id: string; sessionId: string | null };
    }>();
    expect(loop.sessionId).not.toBeNull();
    await store.deleteSession(loop.sessionId!);
    expect((await store.getAgentLoop(loop.id))?.sessionId).toBeNull();

    const response = await app.inject({
      method: 'POST',
      url: `/agent-loops/${loop.id}/session`,
    });

    expect(response.statusCode).toBe(200);
    const recovered = response.json<{ loop: { sessionId: string | null } }>().loop;
    expect(recovered.sessionId).toBe(`session-${loop.id}`);
    expect((await store.getSession(recovered.sessionId!))?.kind).toBe('agent_loop');
  });

  it('force-discards a seeded session that loses the recovery link race', async () => {
    const store = new EventStore(ctx.db);
    const loop = await store.createAgentLoop({ projectId: 'p1', name: 'Racing loop' });
    const raceApp = Fastify();
    const discardLoopSession = vi.fn(async (sessionId: string) => {
      await store.deleteSession(sessionId);
    });
    registerAgentLoopRoutes(raceApp, {
      eventStore: store,
      createLoopSession: async () => {
        await store.createSession({
          sessionId: 'losing-session',
          worktree: '/worktrees/loser',
          model: 'codex/default',
          projectId: 'p1',
          kind: 'agent_loop',
        });
        await store.createSession({
          sessionId: 'winning-session',
          worktree: '/worktrees/winner',
          model: 'codex/default',
          projectId: 'p1',
          kind: 'agent_loop',
        });
        await store.linkAgentLoopSessionIfMissing(loop.id, 'winning-session');
        return { sessionId: 'losing-session' };
      },
      discardLoopSession,
    });

    const response = await raceApp.inject({
      method: 'POST',
      url: `/agent-loops/${loop.id}/session`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ loop: { sessionId: 'winning-session' } });
    expect(discardLoopSession).toHaveBeenCalledWith('losing-session', expect.any(Object));
    expect(await store.getSession('losing-session')).toBeUndefined();
    await raceApp.close();
  });

  it('rejects enabling an untested script with a stable conflict response', async () => {
    const { loop } = (await createLoop()).json<{ loop: { id: string } }>();
    const res = await app.inject({
      method: 'PATCH',
      url: `/agent-loops/${loop.id}`,
      payload: { status: 'enabled' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'agentLoopNotReady' });
  });

  it('refuses to create an orphaned loop when session creation is unavailable', async () => {
    const noSessionApp = Fastify();
    registerAgentLoopRoutes(noSessionApp, { eventStore: new EventStore(ctx.db) });

    const response = await noSessionApp.inject({
      method: 'POST',
      url: '/projects/p1/agent-loops',
      payload: validBody,
    });
    expect(response.statusCode).toBe(503);
    expect(await new EventStore(ctx.db).listAgentLoops('p1')).toHaveLength(0);
    await noSessionApp.close();
  });

  it('tests the persisted script before allowing the loop to be enabled', async () => {
    const store = new EventStore(ctx.db);
    const testApp = Fastify();
    registerAgentLoopRoutes(testApp, {
      eventStore: store,
      testAgentLoop: async (loop) => ({
        outcome: 'ok',
        exitCode: 0,
        detail: 'clean',
        sessionId: loop.sessionId,
      }),
    });
    const loop = await store.createAgentLoop({ projectId: 'p1', ...validBody });

    const tested = await testApp.inject({ method: 'POST', url: `/agent-loops/${loop.id}/test` });
    expect(tested.statusCode).toBe(200);
    expect(
      tested.json<{ loop: { testedScriptFingerprint: string | null } }>().loop
        .testedScriptFingerprint,
    ).toMatch(/^sha256:/);

    const enabled = await testApp.inject({
      method: 'PATCH',
      url: `/agent-loops/${loop.id}`,
      payload: { status: 'enabled' },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json<{ loop: { status: string } }>().loop.status).toBe('enabled');
    await testApp.close();
  });

  it('does not attest a different script when configuration changes during a test', async () => {
    const store = new EventStore(ctx.db);
    const testApp = Fastify();
    registerAgentLoopRoutes(testApp, {
      eventStore: store,
      testAgentLoop: async (loop) => {
        await store.updateAgentLoop(loop.id, { script: 'echo changed' });
        return { outcome: 'ok', exitCode: 0, detail: 'old script passed', sessionId: null };
      },
    });
    const loop = await store.createAgentLoop({ projectId: 'p1', ...validBody });

    const tested = await testApp.inject({ method: 'POST', url: `/agent-loops/${loop.id}/test` });
    expect(tested.statusCode).toBe(409);
    expect(tested.json()).toMatchObject({ code: 'agentLoopChangedDuringTest' });
    expect((await store.getAgentLoop(loop.id))?.testedScriptFingerprint).toBeNull();
    await testApp.close();
  });

  it('validates schedules and project ownership', async () => {
    expect(
      (
        await createLoop({
          ...validBody,
          schedule: { kind: 'interval', everyMinutes: 5 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/projects/nope/agent-loops',
          payload: validBody,
        })
      ).statusCode,
    ).toBe(404);
    expect((await createLoop({ ...validBody, reactionModel: 'openai/gpt-5' })).statusCode).toBe(
      400,
    );
  });

  it('returns run history', async () => {
    const { loop } = (await createLoop()).json<{ loop: { id: string } }>();
    const store = new EventStore(ctx.db);
    const run = await store.startAgentLoopRun(loop.id);
    await store.finishAgentLoopRun(run.id, { outcome: 'acted', detail: 'found issues' });
    const res = await app.inject({ method: 'GET', url: `/agent-loops/${loop.id}/runs` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ runs: Array<{ outcome: string }> }>().runs[0]?.outcome).toBe('acted');
  });

  it('runs a tested loop now and records it as a production run', async () => {
    const store = new EventStore(ctx.db);
    const runApp = Fastify();
    registerAgentLoopRoutes(runApp, {
      eventStore: store,
      testAgentLoop: async (loop) => ({
        outcome: 'ok',
        exitCode: 0,
        detail: 'test passed',
        sessionId: loop.sessionId,
      }),
      runAgentLoop: async (loop) => ({
        outcome: 'acted',
        exitCode: 10,
        detail: 'Agent turn dispatched',
        sessionId: loop.sessionId,
      }),
    });
    const loop = await store.createAgentLoop({ projectId: 'p1', ...validBody });
    await runApp.inject({ method: 'POST', url: `/agent-loops/${loop.id}/test` });

    const response = await runApp.inject({
      method: 'POST',
      url: `/agent-loops/${loop.id}/run`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: { outcome: 'acted', exitCode: 10 },
      run: { outcome: 'acted', isTest: false },
      loop: { lastOutcome: 'acted', consecutiveErrorCount: 0 },
    });
    expect((await store.listAgentLoopRuns(loop.id))[0]).toMatchObject({
      outcome: 'acted',
      isTest: false,
    });
    await runApp.close();
  });

  it('refuses to run an untested loop now', async () => {
    const loop = await new EventStore(ctx.db).createAgentLoop({
      projectId: 'p1',
      ...validBody,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/agent-loops/${loop.id}/run`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'agentLoopNotReady' });
  });

  it('settles manual run history when the execution dependency throws', async () => {
    const store = new EventStore(ctx.db);
    const runApp = Fastify();
    registerAgentLoopRoutes(runApp, {
      eventStore: store,
      testAgentLoop: async (loop) => ({
        outcome: 'ok',
        exitCode: 0,
        detail: null,
        sessionId: loop.sessionId,
      }),
      runAgentLoop: async () => {
        throw new Error('container unavailable');
      },
    });
    const loop = await store.createAgentLoop({ projectId: 'p1', ...validBody });
    await runApp.inject({ method: 'POST', url: `/agent-loops/${loop.id}/test` });

    const response = await runApp.inject({
      method: 'POST',
      url: `/agent-loops/${loop.id}/run`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: { outcome: 'error', detail: 'container unavailable' },
      run: { outcome: 'error', finishedAt: expect.any(String) },
    });
    await runApp.close();
  });

  it('404s the loop list for an unknown project', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/nope/agent-loops' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'project not found' });
  });

  it('404s every loop-scoped route for an unknown loop id', async () => {
    const requests = [
      { method: 'GET' as const, url: '/agent-loops/nope' },
      { method: 'PATCH' as const, url: '/agent-loops/nope', payload: { name: 'x' } },
      { method: 'POST' as const, url: '/agent-loops/nope/session' },
      { method: 'POST' as const, url: '/agent-loops/nope/test' },
      { method: 'POST' as const, url: '/agent-loops/nope/run' },
      { method: 'DELETE' as const, url: '/agent-loops/nope' },
      { method: 'GET' as const, url: '/agent-loops/nope/runs' },
    ];
    for (const request of requests) {
      const res = await app.inject(request);
      expect([request.method, request.url, res.statusCode, res.json()]).toEqual([
        request.method,
        request.url,
        404,
        { error: 'Agent Loop not found' },
      ]);
    }
  });

  it('leaves no orphaned loop behind when session creation fails', async () => {
    const store = new EventStore(ctx.db);
    const failingApp = Fastify();
    registerAgentLoopRoutes(failingApp, {
      eventStore: store,
      createLoopSession: async () => {
        throw new Error('worktree could not be provisioned');
      },
    });

    const response = await failingApp.inject({
      method: 'POST',
      url: '/projects/p1/agent-loops',
      payload: validBody,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ message: 'worktree could not be provisioned' });
    expect(await store.listAgentLoops('p1')).toHaveLength(0);
    await failingApp.close();
  });

  it('discards the session and the loop when the loop vanishes during creation', async () => {
    const store = new EventStore(ctx.db);
    const racingApp = Fastify();
    const discardLoopSession = vi.fn(async () => undefined);
    registerAgentLoopRoutes(racingApp, {
      eventStore: store,
      createLoopSession: async (loop) => {
        await store.deleteAgentLoop(loop.id);
        return { sessionId: 'orphan-session' };
      },
      discardLoopSession,
    });

    const response = await racingApp.inject({
      method: 'POST',
      url: '/projects/p1/agent-loops',
      payload: validBody,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      message: 'Agent Loop disappeared while its session was being created',
    });
    expect(discardLoopSession).toHaveBeenCalledWith('orphan-session', expect.any(Object));
    expect(await store.listAgentLoops('p1')).toHaveLength(0);
    await racingApp.close();
  });

  it('returns the linked session instead of creating a second one', async () => {
    const store = new EventStore(ctx.db);
    const createLoopSession = vi.fn(async () => ({ sessionId: 'never-used' }));
    const linkedApp = Fastify();
    registerAgentLoopRoutes(linkedApp, { eventStore: store, createLoopSession });
    const loop = await store.createAgentLoop({ projectId: 'p1', name: 'Linked' });
    await store.createSession({
      sessionId: 'existing-session',
      worktree: '/worktrees/existing',
      model: 'codex/default',
      projectId: 'p1',
      kind: 'agent_loop',
    });
    await store.linkAgentLoopSessionIfMissing(loop.id, 'existing-session');

    const response = await linkedApp.inject({
      method: 'POST',
      url: `/agent-loops/${loop.id}/session`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ loop: { sessionId: 'existing-session' } });
    expect(createLoopSession).not.toHaveBeenCalled();
    await linkedApp.close();
  });

  it('503s session recovery when session creation is not configured', async () => {
    const store = new EventStore(ctx.db);
    const noSessionApp = Fastify();
    registerAgentLoopRoutes(noSessionApp, { eventStore: store });
    const loop = await store.createAgentLoop({ projectId: 'p1', name: 'Unrecoverable' });

    const response = await noSessionApp.inject({
      method: 'POST',
      url: `/agent-loops/${loop.id}/session`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Agent Loop session creation is not configured' });
    await noSessionApp.close();
  });

  it('404s session recovery when the loop project is gone', async () => {
    const store = new EventStore(ctx.db);
    const loop = await store.createAgentLoop({ projectId: 'p1', name: 'Orphan' });
    const orphanApp = Fastify();
    registerAgentLoopRoutes(orphanApp, {
      eventStore: store,
      createLoopSession: async () => ({ sessionId: 'unused' }),
    });
    const missingProject = vi.spyOn(store, 'getProject').mockResolvedValue(undefined);

    const response = await orphanApp.inject({
      method: 'POST',
      url: `/agent-loops/${loop.id}/session`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'project not found' });
    missingProject.mockRestore();
    await orphanApp.close();
  });

  it('409s session recovery and deletes the loser when the loop is deleted mid-creation', async () => {
    const store = new EventStore(ctx.db);
    const loop = await store.createAgentLoop({ projectId: 'p1', name: 'Doomed' });
    const deleteLoopSession = vi.fn(async () => 'deleted' as const);
    const raceApp = Fastify();
    registerAgentLoopRoutes(raceApp, {
      eventStore: store,
      createLoopSession: async () => {
        await store.deleteAgentLoop(loop.id);
        return { sessionId: 'losing-session' };
      },
      deleteLoopSession,
    });

    const response = await raceApp.inject({
      method: 'POST',
      url: `/agent-loops/${loop.id}/session`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'Agent Loop changed while its session was being created',
    });
    expect(deleteLoopSession).toHaveBeenCalledWith('losing-session');
    await raceApp.close();
  });

  it('503s test and run when Agent Loop execution is not configured', async () => {
    const store = new EventStore(ctx.db);
    const noExecutorApp = Fastify();
    registerAgentLoopRoutes(noExecutorApp, { eventStore: store });
    const loop = await store.createAgentLoop({ projectId: 'p1', ...validBody });
    await store.markAgentLoopTestPassed(loop.id, loop);

    const tested = await noExecutorApp.inject({
      method: 'POST',
      url: `/agent-loops/${loop.id}/test`,
    });
    expect(tested.statusCode).toBe(503);
    expect(tested.json()).toEqual({ error: 'Agent Loop execution is not configured' });

    const ran = await noExecutorApp.inject({ method: 'POST', url: `/agent-loops/${loop.id}/run` });
    expect(ran.statusCode).toBe(503);
    expect(ran.json()).toEqual({ error: 'Agent Loop execution is not configured' });
    expect(await store.listAgentLoopRuns(loop.id)).toHaveLength(0);
    await noExecutorApp.close();
  });

  it('records a failed test without proving the script', async () => {
    const store = new EventStore(ctx.db);
    const testApp = Fastify();
    registerAgentLoopRoutes(testApp, {
      eventStore: store,
      testAgentLoop: async () => ({
        outcome: 'error',
        exitCode: 2,
        detail: 'script exited 2',
        sessionId: null,
      }),
    });
    const loop = await store.createAgentLoop({ projectId: 'p1', ...validBody });

    const response = await testApp.inject({ method: 'POST', url: `/agent-loops/${loop.id}/test` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: { outcome: 'error', exitCode: 2, detail: 'script exited 2' },
      loop: { testedScriptFingerprint: null },
    });
    expect((await store.listAgentLoopRuns(loop.id))[0]).toMatchObject({
      outcome: 'error',
      isTest: true,
    });
    await testApp.close();
  });

  it('409s a manual run whose loop is deleted while it executes', async () => {
    const store = new EventStore(ctx.db);
    const loop = await store.createAgentLoop({ projectId: 'p1', ...validBody });
    await store.markAgentLoopTestPassed(loop.id, loop);
    const runApp = Fastify();
    registerAgentLoopRoutes(runApp, {
      eventStore: store,
      runAgentLoop: async () => {
        await store.deleteAgentLoop(loop.id);
        return { outcome: 'acted', exitCode: 10, detail: 'raced', sessionId: null };
      },
    });

    const response = await runApp.inject({ method: 'POST', url: `/agent-loops/${loop.id}/run` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'Agent Loop changed while it was running' });
    await runApp.close();
  });

  it('refuses to delete a loop whose session cannot be reaped', async () => {
    const store = new EventStore(ctx.db);
    const { loop } = (await createLoop()).json<{ loop: { id: string } }>();

    const unconfiguredApp = Fastify();
    registerAgentLoopRoutes(unconfiguredApp, { eventStore: store });
    const unconfigured = await unconfiguredApp.inject({
      method: 'DELETE',
      url: `/agent-loops/${loop.id}?deleteSession=true`,
    });
    expect(unconfigured.statusCode).toBe(503);
    expect(unconfigured.json()).toEqual({
      error: 'Agent Loop session deletion is not configured',
    });
    await unconfiguredApp.close();

    const busyApp = Fastify();
    const deleteLoopSession = vi.fn(async () => 'busy' as const);
    registerAgentLoopRoutes(busyApp, { eventStore: store, deleteLoopSession });
    const busy = await busyApp.inject({
      method: 'DELETE',
      url: `/agent-loops/${loop.id}?deleteSession=true`,
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: 'Agent Loop session is busy' });
    expect(deleteLoopSession).toHaveBeenCalledWith(`session-${loop.id}`);
    await busyApp.close();

    expect(await store.getAgentLoop(loop.id)).toBeDefined();
  });

  it('deletes the loop and its session when the session is reapable', async () => {
    const store = new EventStore(ctx.db);
    const { loop } = (await createLoop()).json<{ loop: { id: string } }>();
    const deleteLoopSession = vi.fn(async (sessionId: string) => {
      await store.deleteSession(sessionId);
      return 'deleted' as const;
    });
    const deleteApp = Fastify();
    registerAgentLoopRoutes(deleteApp, { eventStore: store, deleteLoopSession });

    const response = await deleteApp.inject({
      method: 'DELETE',
      url: `/agent-loops/${loop.id}?deleteSession=true`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(deleteLoopSession).toHaveBeenCalledWith(`session-${loop.id}`);
    expect(await store.getAgentLoop(loop.id)).toBeUndefined();
    expect(await store.getSession(`session-${loop.id}`)).toBeUndefined();
    await deleteApp.close();
  });

  it('keeps the session when deleteSession is not requested', async () => {
    const store = new EventStore(ctx.db);
    const { loop } = (await createLoop()).json<{ loop: { id: string } }>();
    const deleteLoopSession = vi.fn(async () => 'deleted' as const);
    const deleteApp = Fastify();
    registerAgentLoopRoutes(deleteApp, { eventStore: store, deleteLoopSession });

    const response = await deleteApp.inject({
      method: 'DELETE',
      url: `/agent-loops/${loop.id}?deleteSession=false`,
    });

    expect(response.statusCode).toBe(200);
    expect(deleteLoopSession).not.toHaveBeenCalled();
    expect(await store.getSession(`session-${loop.id}`)).toBeDefined();
    await deleteApp.close();
  });

  it('returns its own run when another run finishes concurrently', async () => {
    const store = new EventStore(ctx.db);
    const runApp = Fastify();
    let competingRunId: string | undefined;
    registerAgentLoopRoutes(runApp, {
      eventStore: store,
      testAgentLoop: async (loop) => ({
        outcome: 'ok',
        exitCode: 0,
        detail: null,
        sessionId: loop.sessionId,
      }),
      runAgentLoop: async (loop) => {
        const competing = await store.startAgentLoopRun(loop.id);
        competingRunId = competing.id;
        await store.finishAgentLoopRun(competing.id, {
          outcome: 'skipped',
          detail: 'concurrent run',
        });
        return {
          outcome: 'acted',
          exitCode: 10,
          detail: 'manual run',
          sessionId: loop.sessionId,
        };
      },
    });
    const loop = await store.createAgentLoop({ projectId: 'p1', ...validBody });
    await runApp.inject({ method: 'POST', url: `/agent-loops/${loop.id}/test` });

    const response = await runApp.inject({
      method: 'POST',
      url: `/agent-loops/${loop.id}/run`,
    });

    const body = response.json<{ run: { id: string; outcome: string } }>();
    expect(body.run).toMatchObject({ outcome: 'acted' });
    expect(body.run.id).not.toBe(competingRunId);
    await runApp.close();
  });
});
