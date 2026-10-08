import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSecretCipher, isEncrypted } from './crypto.js';
import {
  TaskInputError,
  TaskNotFoundError,
  TaskRevisionConflictError,
  TaskStore,
} from './tasks.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => ctx.close());

beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.db
    .insertInto('users')
    .values({ id: OTHER, role: 'member', status: 'active' })
    .execute();
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'verity-p1',
    state: 'active',
  });
  await ctx.store.createSession({
    sessionId: 's1',
    worktree: '/wt/s1',
    model: 'm',
    projectId: 'p1',
  });
});

function tasks(): TaskStore {
  return ctx.store.tasks;
}

describe('TaskStore', () => {
  it('serializes concurrent saves without losing revisions', async () => {
    const input = { id: 'race', ownerUserId: ADMIN, origin: 'user' as const, title: 'Capture' };
    const first = await Promise.all([tasks().upsert(input), tasks().upsert(input)]);
    expect(first.map((task) => task.revision).sort()).toEqual([1, 2]);
    const next = await Promise.all([tasks().upsert(input), tasks().upsert(input)]);
    expect(next.map((task) => task.revision).sort()).toEqual([3, 4]);
    await expect(tasks().patch('race', ADMIN, { title: 'Stale' }, 3)).rejects.toBeInstanceOf(
      TaskRevisionConflictError,
    );
  });

  it('saves a capture and lists it by owner, project and General bucket', async () => {
    await tasks().upsert({ id: 't1', ownerUserId: ADMIN, origin: 'user', title: ' Fix badge ' });
    await tasks().upsert({
      id: 't2',
      ownerUserId: ADMIN,
      origin: 'user',
      title: 'Project idea',
      projectId: 'p1',
      sourceSessionId: 's1',
    });
    await tasks().upsert({ id: 't3', ownerUserId: OTHER, origin: 'user', title: 'Not mine' });

    const all = await tasks().list({ ownerUserId: ADMIN });
    expect(all.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(all[0]).toMatchObject({
      title: 'Fix badge',
      projectId: null,
      status: 'open',
      revision: 1,
    });
    expect(all[1]).toMatchObject({ projectId: 'p1', sourceSessionId: 's1', sessionId: null });

    const general = await tasks().list({ ownerUserId: ADMIN, projectId: null });
    expect(general.map((t) => t.id)).toEqual(['t1']);
    const project = await tasks().list({ ownerUserId: ADMIN, projectId: 'p1' });
    expect(project.map((t) => t.id)).toEqual(['t2']);
  });

  it('treats a repeated save of the same id as one task and bumps its revision', async () => {
    const first = await tasks().upsert({
      id: 't1',
      ownerUserId: ADMIN,
      origin: 'user',
      title: 'v1',
    });
    const second = await tasks().upsert({
      id: 't1',
      ownerUserId: ADMIN,
      origin: 'user',
      title: 'v2',
      projectId: 'p1',
    });
    expect(second).toMatchObject({ title: 'v2', projectId: 'p1', revision: first.revision + 1 });
    expect(await tasks().list({ ownerUserId: ADMIN })).toHaveLength(1);
  });

  it('never lets another user read, replace, patch or delete a task by id', async () => {
    await tasks().upsert({ id: 't1', ownerUserId: ADMIN, origin: 'user', title: 'Mine' });
    expect(await tasks().get('t1', OTHER)).toBeUndefined();
    await expect(
      tasks().upsert({ id: 't1', ownerUserId: OTHER, origin: 'user', title: 'Hijack' }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(tasks().patch('t1', OTHER, { status: 'done' })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    expect(await tasks().delete('t1', OTHER)).toBe(false);
    expect((await tasks().get('t1', ADMIN))?.title).toBe('Mine');
  });

  it('patches with optimistic concurrency and tracks completion', async () => {
    const created = await tasks().upsert({
      id: 't1',
      ownerUserId: ADMIN,
      origin: 'user',
      title: 'T',
    });
    const started = await tasks().patch(
      't1',
      ADMIN,
      { status: 'in_progress', projectId: 'p1', sessionId: 's1' },
      1,
    );
    expect(started).toMatchObject({ status: 'in_progress', sessionId: 's1', revision: 2 });
    expect(started.completedAt).toBeNull();

    await expect(
      tasks().patch('t1', ADMIN, { status: 'done' }, created.revision),
    ).rejects.toMatchObject({ name: 'TaskRevisionConflictError', currentRevision: 2 });

    const done = await tasks().patch('t1', ADMIN, { status: 'done', result: 'Shipped in #12' }, 2);
    expect(done).toMatchObject({ status: 'done', result: 'Shipped in #12', revision: 3 });
    expect(done.completedAt).toBeInstanceOf(Date);

    const reopened = await tasks().patch('t1', ADMIN, { status: 'open' });
    expect(reopened.completedAt).toBeNull();
  });

  it("lists what a session's agent should see, across owners, in sort order", async () => {
    await tasks().upsert({
      id: 'a',
      ownerUserId: ADMIN,
      origin: 'user',
      title: 'A',
      projectId: 'p1',
      sessionId: 's1',
      sort: 2,
    });
    await tasks().upsert({
      id: 'b',
      ownerUserId: ADMIN,
      origin: 'agent',
      title: 'B',
      projectId: 'p1',
      sessionId: 's1',
      sort: 1,
    });
    await tasks().upsert({
      id: 'c',
      ownerUserId: ADMIN,
      origin: 'user',
      title: 'C',
      projectId: 'p1',
      sessionId: 's1',
      status: 'done',
    });
    await tasks().upsert({
      id: 'd',
      ownerUserId: ADMIN,
      origin: 'user',
      title: 'D',
      projectId: 'p1',
    });

    expect((await tasks().listAssigned('s1')).map((t) => t.id)).toEqual(['b', 'a']);
    expect(await tasks().assignedOwner('s1')).toBe(ADMIN);
    expect(await tasks().assignedOwner('s-none')).toBeUndefined();
  });

  it('turns a deleted project into General and a deleted session into unassigned', async () => {
    await tasks().upsert({
      id: 't1',
      ownerUserId: ADMIN,
      origin: 'user',
      title: 'T',
      projectId: 'p1',
      sessionId: 's1',
    });
    await ctx.db.deleteFrom('sessions').where('session_id', '=', 's1').execute();
    expect(await tasks().get('t1', ADMIN)).toMatchObject({ projectId: 'p1', sessionId: null });
    await ctx.db.deleteFrom('projects').where('id', '=', 'p1').execute();
    expect(await tasks().get('t1', ADMIN)).toMatchObject({ projectId: null });
  });

  it('lets the owner adopt an agent step into their own list', async () => {
    await tasks().upsert({
      id: 't1',
      ownerUserId: ADMIN,
      origin: 'agent',
      projectId: 'p1',
      title: 'Step',
      sessionId: 's1',
    });
    const adopted = await tasks().patch('t1', ADMIN, { origin: 'user', sessionId: null });
    expect(adopted).toMatchObject({ origin: 'user', sessionId: null, revision: 2 });
  });

  it('drops the agent’s unfinished steps when their session is deleted, and keeps the operator’s', async () => {
    const base = { ownerUserId: ADMIN, projectId: 'p1', sessionId: 's1' };
    await tasks().upsert({ ...base, id: 'step', origin: 'agent', title: 'Step' });
    await tasks().upsert({ ...base, id: 'done', origin: 'agent', title: 'Done', status: 'done' });
    await tasks().upsert({ ...base, id: 'mine', origin: 'user', title: 'Mine' });
    await ctx.store.deleteSession('s1');
    expect(await tasks().get('step', ADMIN)).toMatchObject({ status: 'dropped', sessionId: null });
    expect(await tasks().get('done', ADMIN)).toMatchObject({ status: 'done' });
    expect(await tasks().get('mine', ADMIN)).toMatchObject({ status: 'open', sessionId: null });
  });

  it('rejects empty titles and too many attachments', async () => {
    await expect(
      tasks().upsert({ id: 't1', ownerUserId: ADMIN, origin: 'user', title: '   ' }),
    ).rejects.toBeInstanceOf(TaskInputError);
    const attachments = Array.from({ length: 21 }, (_, i) => ({
      hash: `h${i}`,
      filename: `f${i}.png`,
      mimeType: 'image/png',
    }));
    await expect(
      tasks().upsert({ id: 't1', ownerUserId: ADMIN, origin: 'user', title: 'T', attachments }),
    ).rejects.toBeInstanceOf(TaskInputError);
  });

  it('attributes agent tasks to the assigning user, else to the project creator', async () => {
    expect(await tasks().agentTaskOwner('s1', 'p1')).toBe(ADMIN);
    expect(await tasks().agentTaskOwner('s1', null)).toBeUndefined();
    await tasks().upsert({
      id: 't1',
      ownerUserId: OTHER,
      origin: 'user',
      title: 'T',
      projectId: 'p1',
      sessionId: 's1',
    });
    expect(await tasks().agentTaskOwner('s1', 'p1')).toBe(OTHER);
  });

  it('stores title, detail and result as cipher envelopes, never plaintext', async () => {
    const cipher = createSecretCipher('0'.repeat(64));
    const store = new TaskStore(ctx.db, cipher);
    await store.upsert({
      id: 't1',
      ownerUserId: ADMIN,
      origin: 'agent',
      title: 'Rotate tokens',
      detail: 'auth.ts:12 leaks the refresh token',
    });
    await store.patch('t1', ADMIN, { status: 'done', result: 'fixed' });
    const raw = await ctx.db.selectFrom('tasks').selectAll().executeTakeFirstOrThrow();
    expect(isEncrypted(raw.title)).toBe(true);
    expect(isEncrypted(raw.detail ?? '')).toBe(true);
    expect(isEncrypted(raw.result ?? '')).toBe(true);
    expect(await store.get('t1', ADMIN)).toMatchObject({
      title: 'Rotate tokens',
      detail: 'auth.ts:12 leaks the refresh token',
      result: 'fixed',
    });
    expect(new TaskRevisionConflictError('t1', 3).currentRevision).toBe(3);
  });
});
