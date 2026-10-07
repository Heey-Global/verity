import type { AgentEvent } from '@verity/events';
import { EventStore } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  it('blocks member assignment to an administrator-only projectless session', async () => {
    const create = await app.inject({
      method: 'PUT',
      url: `/tasks/${T1}`,
      headers: asMember,
      payload: { title: 'Injected', sessionId: 'loose' },
    });
    expect(create.statusCode).toBe(404);
    await app.inject({
      method: 'PUT',
      url: `/tasks/${T1}`,
      headers: asMember,
      payload: { title: 'Personal' },
    });
    const assign = await app.inject({
      method: 'PATCH',
      url: `/tasks/${T1}`,
      headers: asMember,
      payload: { sessionId: 'loose' },
    });
    expect(assign.statusCode).toBe(404);
    expect(await store.tasks.listAssigned('loose')).toEqual([]);
  });

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
    expect(again.json().task).toMatchObject({ title: 'Fix badge', revision: 1 });

    await app.inject({ method: 'PUT', url: `/tasks/${T2}`, payload: { title: 'General idea' } });
    const general = await app.inject({ method: 'GET', url: '/tasks?projectId=general' });
    expect(ids(general.json())).toEqual([T2]);
    const project = await app.inject({ method: 'GET', url: '/tasks?projectId=p1&status=open' });
    expect(ids(project.json())).toEqual([T1]);
    expect((await app.inject({ method: 'GET', url: '/tasks' })).json().tasks).toHaveLength(2);
  });

  it('blocks edits to assigned tasks after project access is revoked', async () => {
    await grantMember({ read: true, execute: true });
    await store.tasks.upsert({
      id: T1,
      ownerUserId: MEMBER,
      projectId: 'p1',
      sessionId: 's1',
      origin: 'user',
      title: 'Assigned',
    });
    await ctx.db.deleteFrom('project_memberships').where('user_id', '=', MEMBER).execute();
    for (const payload of [{ title: 'Injected' }, { detail: 'Injected' }, { status: 'done' }]) {
      expect(
        (await app.inject({ method: 'PATCH', url: `/tasks/${T1}`, headers: asMember, payload }))
          .statusCode,
      ).toBe(404);
    }
  });

  it('blocks replacement and deletion after assigned-project access is revoked', async () => {
    await grantMember({ read: true, execute: true });
    await store.tasks.upsert({
      id: T1,
      ownerUserId: MEMBER,
      projectId: 'p1',
      sessionId: 's1',
      origin: 'user',
      title: 'Assigned',
    });
    await ctx.db.deleteFrom('project_memberships').where('user_id', '=', MEMBER).execute();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/tasks/${T1}`,
          headers: asMember,
          payload: { title: 'General replacement' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: `/tasks/${T1}`, headers: asMember })).statusCode,
    ).toBe(404);
    expect((await store.tasks.get(T1, MEMBER))?.sessionId).toBe('s1');
    expect(published).toEqual([]);
  });

  it('hides project tasks from all listing variants after access is revoked', async () => {
    await grantMember({ read: true, execute: true });
    await store.tasks.upsert({
      id: T1,
      ownerUserId: MEMBER,
      projectId: 'p1',
      sessionId: 's1',
      origin: 'user',
      title: 'Private project',
    });
    await store.tasks.upsert({ id: T2, ownerUserId: MEMBER, origin: 'user', title: 'Personal' });
    await ctx.db.deleteFrom('project_memberships').where('user_id', '=', MEMBER).execute();
    for (const url of ['/tasks?projectId=p1', '/tasks?sessionId=s1']) {
      expect((await app.inject({ method: 'GET', url, headers: asMember })).json().tasks).toEqual(
        [],
      );
    }
    expect(
      ids((await app.inject({ method: 'GET', url: '/tasks', headers: asMember })).json()),
    ).toEqual([T2]);
  });

  it('rejects stale deletion authorization after a concurrent move', async () => {
    await store.tasks.upsert({ id: T1, ownerUserId: MEMBER, origin: 'user', title: 'Personal' });
    const original = store.tasks.delete.bind(store.tasks);
    const spy = vi.spyOn(store.tasks, 'delete').mockImplementationOnce(async (...args) => {
      await store.tasks.patch(T1, MEMBER, { projectId: 'p1', sessionId: 's1' });
      return original(...args);
    });
    try {
      expect(
        (await app.inject({ method: 'DELETE', url: `/tasks/${T1}`, headers: asMember })).statusCode,
      ).toBe(409);
      expect((await store.tasks.get(T1, MEMBER))?.sessionId).toBe('s1');
      expect(published).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('capture retries preserve agent completion and edits without writing', async () => {
    const payload = { title: 'Original capture', projectId: 'p1', sessionId: 's1' };
    expect((await app.inject({ method: 'PUT', url: `/tasks/${T1}`, payload })).statusCode).toBe(
      201,
    );
    const blob = await store.putAttachment('text/plain', Buffer.from('context').toString('base64'));
    await store.tasks.patch(T1, ADMIN, {
      status: 'done',
      detail: 'Updated',
      result: 'Verified',
      attachments: [{ hash: blob, filename: 'context.txt', mimeType: 'text/plain' }],
    });
    const saved = await store.tasks.get(T1, ADMIN);
    const writes = vi.spyOn(store.tasks, 'upsert');
    try {
      const response = await app.inject({ method: 'PUT', url: `/tasks/${T1}`, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json().task).toMatchObject({
        status: 'done',
        detail: 'Updated',
        result: 'Verified',
        revision: saved?.revision,
        attachments: saved?.attachments,
      });
      expect(writes).not.toHaveBeenCalled();
      expect(await store.tasks.get(T1, ADMIN)).toEqual(saved);
    } finally {
      writes.mockRestore();
    }
  });

  it('serves task attachments only to their owner with current project access', async () => {
    await grantMember({ read: true, execute: true });
    const hash = await store.putAttachment('text/plain', Buffer.from('context').toString('base64'));
    await store.tasks.upsert({
      id: T1,
      ownerUserId: MEMBER,
      projectId: 'p1',
      origin: 'user',
      title: 'With file',
      attachments: [{ hash, filename: 'a.txt', mimeType: 'text/plain' }],
    });
    const url = `/tasks/${T1}/attachments/${hash}`;
    const response = await app.inject({ method: 'GET', url, headers: asMember });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('context');
    expect(response.headers['content-type']).toBe('text/plain');
    expect(response.headers['cache-control']).toContain('private');
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/tasks/${T1}/attachments/${'0'.repeat(64)}`,
          headers: asMember,
        })
      ).statusCode,
    ).toBe(404);
    await ctx.db.deleteFrom('project_memberships').where('user_id', '=', MEMBER).execute();
    expect((await app.inject({ method: 'GET', url, headers: asMember })).statusCode).toBe(404);
    await store.tasks.patch(T1, MEMBER, { projectId: null });
    expect((await app.inject({ method: 'GET', url, headers: asMember })).statusCode).toBe(200);
  });

  it('cannot substitute a future revision for the authorized HTTP snapshot', async () => {
    await store.tasks.upsert({ id: T1, ownerUserId: MEMBER, origin: 'user', title: 'Personal' });
    const patch = vi.spyOn(store.tasks, 'patch');
    try {
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/tasks/${T1}`,
            headers: asMember,
            payload: { title: 'Replacement', expectedRevision: 2 },
          })
        ).statusCode,
      ).toBe(409);
      expect(patch).not.toHaveBeenCalled();
    } finally {
      patch.mockRestore();
    }
  });

  it('rejects HTTP assignment when the task moves after validation', async () => {
    await store.tasks.upsert({
      id: T1,
      ownerUserId: ADMIN,
      projectId: 'p1',
      origin: 'user',
      title: 'Backlog',
    });
    const patch = store.tasks.patch.bind(store.tasks);
    const spy = vi.spyOn(store.tasks, 'patch').mockImplementationOnce(async (...args) => {
      await patch(T1, ADMIN, { projectId: null });
      return patch(...args);
    });
    try {
      expect(
        (await app.inject({ method: 'PATCH', url: `/tasks/${T1}`, payload: { sessionId: 's1' } }))
          .statusCode,
      ).toBe(409);
      expect((await store.tasks.get(T1, ADMIN))?.sessionId).toBeNull();
    } finally {
      spy.mockRestore();
    }
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

  it('rejects assignments when the session moves after the route check', async () => {
    await store.tasks.upsert({
      id: T1,
      ownerUserId: ADMIN,
      projectId: 'p1',
      origin: 'user',
      title: 'Backlog',
    });
    const patch = store.tasks.patch.bind(store.tasks);
    const spy = vi.spyOn(store.tasks, 'patch').mockImplementationOnce(async (...args) => {
      await ctx.db
        .updateTable('sessions')
        .set({ project_id: null })
        .where('session_id', '=', 's1')
        .execute();
      return patch(...args);
    });
    try {
      expect(
        (await app.inject({ method: 'PATCH', url: `/tasks/${T1}`, payload: { sessionId: 's1' } }))
          .statusCode,
      ).toBe(400);
      expect((await store.tasks.get(T1, ADMIN))?.sessionId).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects agent status writes when the session moves after assigned-task lookup', async () => {
    await store.tasks.upsert({
      id: T1,
      ownerUserId: ADMIN,
      projectId: 'p1',
      sessionId: 's1',
      origin: 'user',
      title: 'Work',
    });
    const patch = store.tasks.patch.bind(store.tasks);
    const spy = vi.spyOn(store.tasks, 'patch').mockImplementationOnce(async (...args) => {
      await ctx.db
        .updateTable('sessions')
        .set({ project_id: null })
        .where('session_id', '=', 's1')
        .execute();
      return patch(...args);
    });
    try {
      await expect(run('s1', { action: 'complete', id: T1, result: 'Verified' })).rejects.toThrow(
        /session is not/,
      );
      expect((await store.tasks.get(T1, ADMIN))?.status).toBe('open');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not expose or update source-project tasks after a session move', async () => {
    await store.tasks.upsert({
      id: T1,
      ownerUserId: MEMBER,
      projectId: 'p1',
      sessionId: 's1',
      origin: 'user',
      title: 'Source task',
    });
    await ctx.db
      .updateTable('sessions')
      .set({ project_id: null })
      .where('session_id', '=', 's1')
      .execute();
    expect(await store.tasks.listAssigned('s1')).toEqual([]);
    expect(await store.tasks.assignedOwner('s1')).toBeUndefined();
    expect(await run('s1', { action: 'list' })).toEqual({ tasks: [] });
    await expect(run('s1', { action: 'complete', id: T1, result: 'No' })).rejects.toThrow();
    expect((await store.tasks.get(T1, MEMBER))?.status).toBe('open');
  });

  it('does not expose the project creator backlog to an unassigned session', async () => {
    await store.tasks.upsert({
      id: T1,
      ownerUserId: ADMIN,
      projectId: 'p1',
      origin: 'user',
      title: 'Private backlog',
    });
    expect(await run('s1', { action: 'list', scope: 'project' })).toEqual({ tasks: [] });
  });

  it('rejects agent completion if assignment changes after the authorization read', async () => {
    await store.tasks.upsert({
      id: T1,
      ownerUserId: ADMIN,
      projectId: 'p1',
      sessionId: 's1',
      origin: 'user',
      title: 'Assigned',
    });
    const patch = store.tasks.patch.bind(store.tasks);
    const spy = vi.spyOn(store.tasks, 'patch').mockImplementationOnce(async (...args) => {
      await patch(T1, ADMIN, { sessionId: null });
      return patch(...args);
    });
    try {
      await expect(run('s1', { action: 'complete', id: T1, result: 'Verified' })).rejects.toThrow(
        /at revision/,
      );
      expect((await store.tasks.get(T1, ADMIN))?.status).toBe('open');
    } finally {
      spy.mockRestore();
    }
  });

  it('updates assigned tasks belonging to different users', async () => {
    for (const [id, ownerUserId] of [
      [T1, ADMIN],
      [T2, MEMBER],
    ]) {
      await store.tasks.upsert({
        id: id!,
        ownerUserId: ownerUserId!,
        origin: 'user',
        title: 'Assigned',
        projectId: 'p1',
        sessionId: 's1',
      });
    }
    await run('s1', { action: 'update', id: T2, status: 'in_progress' });
    await run('s1', { action: 'complete', id: T2, result: 'Verified' });
    await run('s1', { action: 'drop', id: T1, result: 'Superseded' });
    expect((await store.tasks.get(T2, MEMBER))?.status).toBe('done');
    expect((await store.tasks.get(T1, ADMIN))?.status).toBe('dropped');
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

describe('task capture uploads', () => {
  it('stores uploaded bytes and lets the owner read the referenced attachment', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/tasks/${T1}`,
      payload: {
        title: 'Read context',
        uploads: [{ kind: 'file', mediaType: 'text/plain', fileName: 'context.txt', data: 'aGk=' }],
      },
    });
    expect(response.statusCode).toBe(201);
    const saved = await store.tasks.get(T1, ADMIN);
    expect(saved?.attachments[0]).toMatchObject({
      filename: 'context.txt',
      mimeType: 'text/plain',
    });
    const read = await app.inject({
      method: 'GET',
      url: `/tasks/${T1}/attachments/${saved!.attachments[0]!.hash}`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.body).toBe('hi');
  });
  it('does not upload replacement bytes on a capture retry', async () => {
    await app.inject({ method: 'PUT', url: `/tasks/${T1}`, payload: { title: 'Original' } });
    const put = vi.spyOn(store, 'putAttachment');
    const response = await app.inject({
      method: 'PUT',
      url: `/tasks/${T1}`,
      payload: {
        title: 'Replacement',
        uploads: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(put).not.toHaveBeenCalled();
    expect((await store.tasks.get(T1, ADMIN))?.title).toBe('Original');
  });
  it('authorizes the project before ingesting bytes', async () => {
    const put = vi.spyOn(store, 'putAttachment');
    const response = await app.inject({
      method: 'PUT',
      url: `/tasks/${T1}`,
      headers: asMember,
      payload: {
        title: 'Private',
        projectId: 'p1',
        uploads: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
      },
    });
    expect(response.statusCode).toBe(404);
    expect(put).not.toHaveBeenCalled();
  });
  it('rejects invalid base64 before persisting a task', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/tasks/${T1}`,
      payload: {
        title: 'Invalid',
        uploads: [{ kind: 'image', mediaType: 'image/png', data: 'not base64!' }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(await store.tasks.get(T1, ADMIN)).toBeUndefined();
  });
});
