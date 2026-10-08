import { describe, expect, it, vi } from 'vitest';
import { TaskQueue, type TaskQueueState } from './taskQueue.js';
import type { Task } from './tasks.js';
const task: Task = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Keep this',
  detail: null,
  projectId: null,
  sessionId: null,
  sourceSessionId: null,
  origin: 'user',
  attachments: [],
  status: 'open',
  result: null,
  sort: 0,
  revision: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  completedAt: null,
};
function setup(initial?: string) {
  let disk: string | null = initial ?? null;
  let active = true;
  let snapshot: TaskQueueState = { tasks: [], pending: [], conflicts: [] };
  const remote: Task[] = [];
  const api = {
    listTasks: vi.fn(async () => remote),
    saveTask: vi.fn(async () => {
      const existing = remote.find((t) => t.id === task.id);
      if (existing) return existing;
      const saved = { ...task, revision: 1 };
      remote.push(saved);
      return saved;
    }),
    updateTask: vi.fn(async (_id: string, patch: { expectedRevision: number }): Promise<Task> => ({
      ...task,
      ...patch,
      revision: patch.expectedRevision + 1,
    })),
    deleteTask: vi.fn(async () => undefined),
  };
  const persist = vi.fn(async (data: string) => {
    disk = data;
  });
  const queue = new TaskQueue({
    api,
    persist,
    load: async () => disk,
    active: () => active,
    changed: (state) => {
      snapshot = state;
    },
  });
  return {
    queue,
    api,
    persist,
    remote,
    disk: () => disk!,
    snapshot: () => snapshot,
    deactivate: () => {
      active = false;
    },
  };
}
describe('task outbox', () => {
  it('persists before acknowledging and retains captures when offline', async () => {
    const s = setup();
    await s.queue.create(task, { title: task.title, projectId: null });
    s.api.saveTask.mockRejectedValueOnce(new Error('offline'));
    await expect(s.queue.sync()).rejects.toThrow('offline');
    expect(JSON.parse(s.disk()).pending).toHaveLength(1);
    expect(s.snapshot().tasks[0]?.title).toBe(task.title);
  });
  it('retries the same id after a lost response and restart', async () => {
    const s = setup();
    await s.queue.create(task, { title: task.title, projectId: null });
    s.remote.push({ ...task, revision: 1 });
    s.api.saveTask.mockRejectedValueOnce(new Error('lost response'));
    await expect(s.queue.sync()).rejects.toThrow();
    const restored = setup(s.disk());
    restored.remote.push(...s.remote);
    await restored.queue.restore();
    await restored.queue.sync();
    expect(restored.api.saveTask).toHaveBeenCalledWith(task.id, {
      title: task.title,
      projectId: null,
    });
    expect(restored.remote).toHaveLength(1);
    expect(restored.snapshot().pending).toHaveLength(0);
  });
  // The silent failure: a capture handed over twice with its stable id shows
  // up as two rows and two pending creates until the next full sync.
  it('keeps one row when the same capture id is created again', async () => {
    const s = setup();
    await s.queue.create(task, { title: task.title, projectId: null });
    await s.queue.create({ ...task, title: 'Again' }, { title: 'Again', projectId: null });
    expect(s.snapshot().tasks).toHaveLength(1);
    expect(s.snapshot().tasks[0]?.title).toBe(task.title);
    expect(JSON.parse(s.disk()).pending).toHaveLength(1);
  });
  it('does not block local saving behind a hung sync request', async () => {
    const s = setup();
    await s.queue.create(task, { title: task.title, projectId: null });
    let finish!: (value: Task) => void;
    s.api.saveTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const syncing = s.queue.sync();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const other = { ...task, id: '22222222-2222-4222-8222-222222222222' };
    await s.queue.create(other, { title: other.title, projectId: null });
    expect(s.snapshot().pending).toHaveLength(2);
    finish({ ...task, revision: 1 });
    await syncing;
  });
  it('does not publish or mutate after credential scope changes', async () => {
    const s = setup();
    await s.queue.create(task, { title: task.title, projectId: null });
    s.deactivate();
    await s.queue.sync();
    expect(s.api.saveTask).not.toHaveBeenCalled();
    await expect(
      s.queue.patch(task.id, { title: 'wrong account', expectedRevision: 0 }),
    ).rejects.toThrow('Sign in');
  });
  it('keeps edits through sync and advances queued revisions', async () => {
    const s = setup();
    await s.queue.create(task, { title: task.title, projectId: null });
    await s.queue.patch(task.id, { title: 'Edited offline', expectedRevision: 0 });
    await s.queue.sync();
    expect(s.api.updateTask).toHaveBeenCalledWith(task.id, {
      title: 'Edited offline',
      expectedRevision: 1,
    });
  });
  it('retains attachments across a restart', async () => {
    const s = setup();
    await s.queue.create(task, {
      title: task.title,
      projectId: null,
      uploads: [{ kind: 'file', data: 'aGk=', fileName: 'context.txt', mediaType: 'text/plain' }],
    });
    const restored = setup(s.disk());
    await restored.queue.restore();
    await restored.queue.sync();
    expect(restored.api.saveTask.mock.calls[0]).toEqual([
      task.id,
      expect.objectContaining({ uploads: [expect.objectContaining({ data: 'aGk=' })] }),
    ]);
  });
  it('surfaces conflicts without overwriting the remote version', async () => {
    const s = setup(
      JSON.stringify({ tasks: [{ ...task, revision: 2 }], pending: [], conflicts: [] }),
    );
    await s.queue.restore();
    await s.queue.patch(task.id, { title: 'My edit', expectedRevision: 2 });
    s.api.updateTask.mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409 }));
    s.remote.push({ ...task, title: 'Remote edit', revision: 3 });
    await s.queue.sync();
    expect(s.snapshot().conflicts).toEqual([task.id]);
    expect(s.snapshot().tasks[0]?.title).toBe('My edit');
    await s.queue.resolve(task.id, true);
    await s.queue.sync();
    expect(s.api.updateTask).toHaveBeenLastCalledWith(task.id, {
      title: 'My edit',
      expectedRevision: 3,
    });
  });
  it('does not acknowledge a failed disk write', async () => {
    const s = setup();
    s.persist.mockRejectedValueOnce(new Error('disk full'));
    await expect(s.queue.create(task, { title: task.title, projectId: null })).rejects.toThrow(
      'disk full',
    );
    expect(s.snapshot().tasks).toHaveLength(0);
    expect(s.api.saveTask).not.toHaveBeenCalled();
  });
});

it('can delete a task with a retained conflicting edit', async () => {
  const s = setup(
    JSON.stringify({
      tasks: [{ ...task, revision: 2 }],
      pending: [{ kind: 'patch', id: task.id, body: { title: 'My edit', expectedRevision: 1 } }],
      conflicts: [task.id],
    }),
  );
  await s.queue.restore();
  await s.queue.delete(task.id);
  await s.queue.sync();
  expect(s.api.updateTask).not.toHaveBeenCalled();
  expect(s.api.deleteTask).toHaveBeenCalledWith(task.id);
  expect(s.snapshot().pending).toHaveLength(0);
});

it('retains a rejected capture while allowing unrelated captures to sync', async () => {
  const s = setup();
  await s.queue.create(
    { ...task, projectId: 'missing' },
    { title: task.title, projectId: 'missing' },
  );
  const other = { ...task, id: '22222222-2222-4222-8222-222222222222' };
  await s.queue.create(other, { title: 'General capture', projectId: null });
  s.api.saveTask.mockRejectedValueOnce(
    Object.assign(new Error('project not found'), { status: 404 }),
  );
  await s.queue.sync();
  expect(s.api.saveTask).toHaveBeenCalledWith(other.id, {
    title: 'General capture',
    projectId: null,
  });
  expect(s.snapshot().pending).toHaveLength(1);
  expect(s.snapshot().conflicts).toContain(task.id);
  expect(s.snapshot().errors?.[task.id]).toBe('project not found');
});

it('does not rebase a stale editor over an in-flight patch', async () => {
  const s = setup(
    JSON.stringify({ tasks: [{ ...task, revision: 2 }], pending: [], conflicts: [] }),
  );
  await s.queue.restore();
  await s.queue.patch(task.id, { title: 'Current edit', expectedRevision: 2 });
  let finish!: (value: Task) => void;
  s.api.updateTask.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  s.api.updateTask.mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409 }));
  const syncing = s.queue.sync();
  await vi.waitFor(() => expect(finish).toBeDefined());
  await s.queue.patch(task.id, { title: 'Stale edit', expectedRevision: 1 });
  finish({ ...task, title: 'Current edit', revision: 3 });
  await syncing;
  expect(s.api.updateTask).toHaveBeenLastCalledWith(task.id, {
    title: 'Stale edit',
    expectedRevision: 1,
  });
  expect(s.snapshot().conflicts).toContain(task.id);
});

it('can move a rejected capture to General and retry its original id', async () => {
  const s = setup(
    JSON.stringify({
      tasks: [{ ...task, projectId: 'revoked' }],
      pending: [{ kind: 'create', id: task.id, body: { title: task.title, projectId: 'revoked' } }],
      conflicts: [task.id],
    }),
  );
  await s.queue.restore();
  await s.queue.patch(task.id, { projectId: null, sessionId: null, expectedRevision: 0 });
  await s.queue.sync();
  expect(s.api.saveTask).toHaveBeenCalledWith(task.id, { title: task.title, projectId: null });
  expect(s.snapshot().conflicts).toHaveLength(0);
});

it('preserves earlier offline edits when repairing a rejected capture', async () => {
  const s = setup();
  s.api.updateTask.mockImplementation(async (_id, patch) => {
    const saved = { ...task, ...patch, revision: patch.expectedRevision + 1 };
    s.remote[0] = saved;
    return saved;
  });
  await s.queue.create(
    { ...task, projectId: 'missing' },
    { title: task.title, projectId: 'missing' },
  );
  await s.queue.patch(task.id, {
    title: 'Edited offline',
    detail: 'Keep detail',
    expectedRevision: 0,
  });
  s.api.saveTask.mockRejectedValueOnce(
    Object.assign(new Error('project not found'), { status: 404 }),
  );
  await s.queue.sync();
  await s.queue.patch(task.id, { projectId: null, sessionId: null, expectedRevision: 0 });
  await s.queue.sync();
  expect(s.api.saveTask).toHaveBeenLastCalledWith(
    task.id,
    expect.objectContaining({ title: 'Edited offline', detail: 'Keep detail', projectId: null }),
  );
  expect(s.api.updateTask).toHaveBeenLastCalledWith(
    task.id,
    expect.objectContaining({ title: 'Edited offline', detail: 'Keep detail', projectId: null }),
  );
  expect(s.snapshot().tasks[0]?.title).toBe('Edited offline');
});
