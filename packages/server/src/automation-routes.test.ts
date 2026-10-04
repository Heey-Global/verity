import { EventStore } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import type { AutomationRunResult } from './automation-executor.js';
import { registerAutomationRoutes } from './automation-routes.js';

let ctx: TestDb;
let app: FastifyInstance;
let store: EventStore;
let checkScript: ReturnType<typeof vi.fn<() => Promise<AutomationRunResult>>>;
let changed: ReturnType<typeof vi.fn<() => void>>;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  store = new EventStore(ctx.db);
  await store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
  checkScript = vi.fn(async () => ({ outcome: 'ok' as const, detail: 'Nothing to do.' }));
  changed = vi.fn<() => void>();
  app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'invalid request' });
    return reply.send(error);
  });
  registerAutomationRoutes(app, {
    eventStore: store,
    checkScript,
    validateModel: async (model) => (model === 'other/model' ? 'unsupported model' : null),
    onAutomationsChanged: changed,
  });
});
afterEach(async () => app.close());

const proposal = {
  name: 'Morning review',
  schedule: { kind: 'daily', hour: 9, minute: 0 },
  prompt: 'Summarize the open pull requests.',
};

const put = (payload: unknown, id = 's1') =>
  app.inject({ method: 'PUT', url: `/sessions/${id}/automation`, payload: payload as object });

describe('session automation routes', () => {
  it('creates an active prompt-only automation without running a check', async () => {
    const res = await put(proposal);
    expect(res.statusCode).toBe(200);
    expect(res.json().automation).toMatchObject({ ...proposal, status: 'enabled', script: null });
    expect(checkScript).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledOnce();

    const read = await app.inject({ method: 'GET', url: '/sessions/s1/automation' });
    expect(read.json().automation).toMatchObject({ name: 'Morning review' });
  });

  it('reports no automation as null rather than 404 for an existing session', async () => {
    const read = await app.inject({ method: 'GET', url: '/sessions/s1/automation' });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ automation: null });
    expect((await app.inject({ method: 'GET', url: '/sessions/nope/automation' })).statusCode).toBe(
      404,
    );
  });

  it('checks a script before saving and refuses one that fails', async () => {
    checkScript.mockResolvedValueOnce({
      outcome: 'error',
      detail: 'The check failed with exit code 2.',
    });
    const res = await put({ ...proposal, script: 'exit 2' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: 'The check failed with exit code 2.',
      code: 'automationCheckFailed',
    });
    expect(await store.getSessionAutomation('s1')).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
  });

  it('saves a script whose check passes', async () => {
    const res = await put({ ...proposal, script: 'exit 0' });
    expect(res.statusCode).toBe(200);
    expect(checkScript).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', script: 'exit 0' }),
    );
    expect(res.json().automation.script).toBe('exit 0');
  });

  it('rejects a confirmation when the workspace changes during its script check', async () => {
    checkScript.mockImplementationOnce(async () => {
      await ctx.db
        .updateTable('sessions')
        .set({ worktree: '/wt/moved' })
        .where('session_id', '=', 's1')
        .execute();
      return { outcome: 'ok', detail: null };
    });
    const res = await put({ ...proposal, script: 'exit 0' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('automationWorkspaceChanged');
    expect(await store.getSessionAutomation('s1')).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
  });

  it('rejects a model the session cannot run', async () => {
    const res = await put({ ...proposal, model: 'other/model' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unsupported model' });
  });

  it('rejects invalid schedules and unknown sessions', async () => {
    expect(
      (await put({ ...proposal, schedule: { kind: 'interval', everyMinutes: 5 } })).statusCode,
    ).toBe(400);
    expect((await put({ name: 'x', schedule: proposal.schedule })).statusCode).toBe(400);
    expect((await put(proposal, 'nope')).statusCode).toBe(404);
  });

  it('pauses, resumes, and deletes only the automation', async () => {
    await put(proposal);
    const paused = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1/automation',
      payload: { status: 'paused' },
    });
    expect(paused.json().automation).toMatchObject({ status: 'paused', nextRunAt: null });
    const resumed = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1/automation',
      payload: { status: 'enabled' },
    });
    expect(resumed.json().automation.status).toBe('enabled');

    const deleted = await app.inject({ method: 'DELETE', url: '/sessions/s1/automation' });
    expect(deleted.json()).toEqual({ ok: true });
    expect(await store.getSession('s1')).toBeDefined();
    expect(
      (await app.inject({ method: 'DELETE', url: '/sessions/s1/automation' })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/sessions/s1/automation',
          payload: { status: 'enabled' },
        })
      ).statusCode,
    ).toBe(404);
  });
});
