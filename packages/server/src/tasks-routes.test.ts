import type { AgentEvent } from '@verity/events';
import { EventStore } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { executeTasksTool, registerTasksRoutes } from './tasks-routes.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const MEMBER = '00000000-0000-4000-8000-000000000002';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

let ctx: TestDb;
let app: FastifyInstance;
let store: EventStore;
let published: { sessionId: string; event: AgentEvent }[];

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  store = new EventStore(ctx.db);
  await ctx.db
    .insertInto('users')
    .values({ id: MEMBER, role: 'member', status: 'active' })
    .execute();
  await store.upsertProject({
    id: 'p1',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'verity-p1',
    state: 'active',
  });
  await store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm', projectId: 'p1' });
  await store.createSession({ sessionId: 'loose', worktree: '/wt/loose', model: 'm' });
  published = [];
  app = Fastify();
  app.decorateRequest('localUserId', null);
  app.addHook('onRequest', async (request) => {
    const header = request.headers['x-test-user'];
    request.localUserId = typeof header === 'string' ? header : null;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'invalid request' });
    return reply.send(error);
  });
  registerTasksRoutes(app, {
    eventStore: store,
    publish: async (sessionId, event) => {
      published.push({ sessionId, event });
    },
  });
});
afterEach(async () => app.close());

const asMember = { 'x-test-user': MEMBER };

const ids = (body: unknown): string[] =>
  (body as { tasks: { id: string }[] }).tasks.map((task) => task.id);

async function grantMember(permissions: { read: boolean; execute: boolean }): Promise<void> {
  await ctx.db
    .insertInto('project_memberships')
    .values({
      project_id: 'p1',
      user_id: MEMBER,
      can_read: permissions.read,
      can_execute: permissions.execute,
      can_manage: false,
    })
    .execute();
}

describe('tasks routes', () => {
  it('saves a capture idempotently and lists it by bucket', async () => {
    const first = await app.inject({
      method: 'PUT',
      url: `/tasks/${T1}`,
      payload: { title: 'Fix badge', projectId: 'p1', sourceSessionId: 's1' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().task).toMatchObject({
      id: T1,
      projectId: 'p1',
      status: 'open',
      revision: 1,
    });

    const again = await app.inject({
      method: 'PUT',
      url: `/tasks/${T1}`,
      payload: { title: 'Fix badge on iPad', projectId: 'p1' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().task).toMatchObject({ title: 'Fix badge on iPad', revision: 2 });

    await app.inject({ method: 'PUT', url: `/tasks/${T2}`, payload: { title: 'General idea' } });
    const general = await app.inject({ method: 'GET', url: '/tasks?projectId=general' });
    expect(ids(general.json())).toEqual([T2]);
    const project = await app.inject({ method: 'GET', url: '/tasks?projectId=p1&status=open' });
    expect(ids(project.json())).toEqual([T1]);
    expect((await app.inject({ method: 'GET', url: '/tasks' })).json().tasks).toHaveLength(2);
  });

  it("keeps one user from touching another user's task by id", async () => {
    await app.inject({ method: 'PUT', url: `/tasks/${T1}`, payload: { title: 'Mine' } });
    const list = await app.inject({ method: 'GET', url: '/tasks', headers: asMember });
    expect(list.json().tasks).toEqual([]);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/tasks/${T1}`,
      headers: asMember,
      payload: { status: 'done' },
    });
    expect(patch.statusCode).toBe(404);
    const hijack = await app.inject({
      method: 'PUT',
      url: `/tasks/${T1}`,
      headers: asMember,
      payload: { title: 'Hijack' },
    });
    expect(hijack.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/tasks/${T1}`, headers: asMember });
    expect(del.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/tasks' })).json().tasks[0].title).toBe('Mine');
  });

  it('needs project read to file a task there and execute to assign it to a session', async () => {
    const noAccess = await app.inject({
      method: 'PUT',
      url: `/tasks/${T1}`,
      headers: asMember,
      payload: { title: 'T', projectId: 'p1' },
    });
    expect(noAccess.statusCode).toBe(404);

    await grantMember({ read: true, execute: false });
    const filed = await app.inject({
      method: 'PUT',
      url: `/tasks/${T1}`,
      headers: asMember,
      payload: { title: 'T', projectId: 'p1' },
    });
    expect(filed.statusCode).toBe(201);
    const assign = await app.inject({
      method: 'PATCH',
      url: `/tasks/${T1}`,
      headers: asMember,
      payload: { sessionId: 's1' },
    });
    expect(assign.statusCode).toBe(404);

    await ctx.db
      .updateTable('project_memberships')
      .set({ can_execute: true })
      .where('user_id', '=', MEMBER)
      .execute();
    const assigned = await app.inject({
      method: 'PATCH',
      url: `/tasks/${T1}`,
      headers: asMember,
      payload: { sessionId: 's1', status: 'in_progress' },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().task).toMatchObject({ sessionId: 's1', status: 'in_progress' });
  });

  it('refuses a session outside the task project', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/tasks/${T1}`,
      payload: { title: 'T', projectId: 'p1', sessionId: 'loose' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reports a stale revision as a conflict and otherwise bumps it', async () => {
    await app.inject({ method: 'PUT', url: `/tasks/${T1}`, payload: { title: 'T' } });
    const ok = await app.inject({
      method: 'PATCH',
      url: `/tasks/${T1}`,
      payload: { title: 'T2', expectedRevision: 1 },
    });
    expect(ok.json().task.revision).toBe(2);
    const stale = await app.inject({
      method: 'PATCH',
      url: `/tasks/${T1}`,
      payload: { title: 'T3', expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    const empty = await app.inject({
      method: 'PATCH',
      url: `/tasks/${T1}`,
      payload: { expectedRevision: 2 },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('tells the assigned session about every change, including an unassignment', async () => {
    await app.inject({
      method: 'PUT',
      url: `/tasks/${T1}`,
      payload: { title: 'T', projectId: 'p1', sessionId: 's1' },
    });
    await app.inject({ method: 'PATCH', url: `/tasks/${T1}`, payload: { status: 'done' } });
    await app.inject({ method: 'PATCH', url: `/tasks/${T1}`, payload: { sessionId: null } });
    await app.inject({ method: 'PATCH', url: `/tasks/${T1}`, payload: { title: 'quiet' } });
    await app.inject({ method: 'DELETE', url: `/tasks/${T1}` });
    expect(
      published.map((p) => `${p.sessionId}:${(p.event as { change: string }).change}`),
    ).toEqual(['s1:added', 's1:completed', 's1:updated']);
    expect(published.every((p) => p.event.t === 'tasks_updated' && p.event.origin === 'user')).toBe(
      true,
    );
  });
});

describe('executeTasksTool', () => {
  const run = (sessionId: string, request: unknown, projectId: string | null = 'p1') =>
    executeTasksTool({
      eventStore: store,
      publish: async (id, event) => {
        published.push({ sessionId: id, event });
      },
      sessionId,
      projectId,
      request: request as never,
    });

  it('adds tasks to the calling session for the user who assigned work there', async () => {
    await store.tasks.upsert({
      id: T1,
      ownerUserId: MEMBER,
      origin: 'user',
      title: 'Assigned by member',
      projectId: 'p1',
      sessionId: 's1',
    });
    const added = (await run('s1', {
      action: 'add',
      tasks: [{ title: 'Rotate tokens', detail: 'auth.ts' }, { title: 'Rate-limit login' }],
    })) as { added: { id: string }[] };
    expect(added.added).toHaveLength(2);
    const mine = await store.tasks.list({ ownerUserId: MEMBER, sessionId: 's1' });
    expect(mine.map((t) => [t.title, t.origin, t.sort])).toEqual([
      ['Assigned by member', 'user', 0],
      ['Rotate tokens', 'agent', 1],
      ['Rate-limit login', 'agent', 2],
    ]);
    expect(published.at(-1)?.event).toMatchObject({
      t: 'tasks_updated',
      origin: 'agent',
      change: 'added',
    });
  });

  it('falls back to the project creator and refuses to write without any owner', async () => {
    await run('s1', { action: 'add', tasks: [{ title: 'Finding' }] });
    expect(await store.tasks.list({ ownerUserId: ADMIN, sessionId: 's1' })).toHaveLength(1);
    await expect(run('loose', { action: 'add', tasks: [{ title: 'x' }] }, null)).rejects.toThrow(
      /project session/,
    );
  });

  it('lists only assigned tasks unless asked for the project backlog', async () => {
    await store.tasks.upsert({
      id: T1,
      ownerUserId: ADMIN,
      origin: 'user',
      title: 'Assigned',
      projectId: 'p1',
      sessionId: 's1',
    });
    await store.tasks.upsert({
      id: T2,
      ownerUserId: ADMIN,
      origin: 'user',
      title: 'Backlog',
      projectId: 'p1',
    });
    const session = (await run('s1', { action: 'list' })) as { tasks: { id: string }[] };
    expect(session.tasks.map((t) => t.id)).toEqual([T1]);
    const project = (await run('s1', { action: 'list', scope: 'project' })) as {
      tasks: { id: string; assigned?: boolean }[];
    };
    expect(project.tasks.map((t) => [t.id, t.assigned])).toEqual([
      [T1, undefined],
      [T2, false],
    ]);
  });

  it('updates, completes and drops only tasks assigned to the calling session', async () => {
    await store.tasks.upsert({
      id: T1,
      ownerUserId: ADMIN,
      origin: 'user',
      title: 'Assigned',
      projectId: 'p1',
      sessionId: 's1',
    });
    await store.tasks.upsert({
      id: T2,
      ownerUserId: ADMIN,
      origin: 'user',
      title: 'Backlog',
      projectId: 'p1',
    });
    await expect(run('s1', { action: 'complete', id: T2, result: 'nope' })).rejects.toThrow(
      /not found/,
    );

    const updated = (await run('s1', { action: 'update', id: T1, status: 'in_progress' })) as {
      task: { status: string };
    };
    expect(updated.task.status).toBe('in_progress');
    const done = (await run('s1', { action: 'complete', id: T1, result: 'Shipped' })) as {
      task: { status: string };
      remaining: unknown[];
    };
    expect(done.task.status).toBe('done');
    expect(done.remaining).toEqual([]);
    expect((await store.tasks.get(T1, ADMIN))?.result).toBe('Shipped');
    // A completed task is no longer assigned work, so the agent cannot touch it again.
    await expect(run('s1', { action: 'drop', id: T1, result: 'changed my mind' })).rejects.toThrow(
      /not found/,
    );
    expect(published.map((p) => (p.event as { change: string }).change)).toEqual([
      'updated',
      'completed',
    ]);
  });
});
