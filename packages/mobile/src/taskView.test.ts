import { describe, expect, it, vi } from 'vitest';
import { VerityApiError } from './api.js';
import { TaskQueue, type TaskQueueState } from './taskQueue.js';
import { listTaskView } from './taskView.js';
import type { Task } from './tasks.js';

const base: Task = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Mine',
  detail: null,
  projectId: null,
  sessionId: null,
  sourceSessionId: null,
  origin: 'user',
  attachments: [],
  status: 'open',
  result: null,
  sort: 0,
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  completedAt: null,
};
const mine = base;
const dropped: Task = { ...base, id: '22222222-2222-4222-8222-222222222222', status: 'dropped' };
const step: Task = {
  ...base,
  id: '33333333-3333-4333-8333-333333333333',
  origin: 'agent',
  sessionId: 's1',
};
const otherStep: Task = {
  ...step,
  id: '44444444-4444-4444-8444-444444444444',
  sessionId: 's2',
};

describe('listTaskView', () => {
  it('asks for the own list and the steps of the viewed sessions only', async () => {
    const listTasks = vi.fn(async (query?: string) =>
      query?.includes('origin=agent') ? [step] : [mine],
    );
    expect(await listTaskView({ listTasks }, ['s1'])).toEqual([mine, step]);
    expect(listTasks.mock.calls.map(([query]) => query)).toEqual([
      '?origin=user&status=open,in_progress,done',
      '?origin=agent&status=open,in_progress,done&sessionId=s1',
    ]);
  });

  it('filters the full list itself when the server refuses the filter', async () => {
    const listTasks = vi.fn(async (query?: string) => {
      if (query) throw new VerityApiError(400, 'unrecognized key');
      return [mine, dropped, step, otherStep];
    });
    expect(await listTaskView({ listTasks }, ['s1'])).toEqual([mine, step]);
  });

  it('does not mistake other failures for an older server', async () => {
    const listTasks = vi.fn(async () => {
      throw new VerityApiError(503, 'unavailable');
    });
    await expect(listTaskView({ listTasks }, [])).rejects.toThrow('unavailable');
    expect(listTasks).toHaveBeenCalledTimes(1);
  });
});

function queueWith(options: {
  disk?: string;
  view?: () => Promise<Task[]> | null;
  keep?: (task: Task) => boolean;
}) {
  let disk = options.disk ?? null;
  let snapshot: TaskQueueState = { tasks: [], pending: [], conflicts: [] };
  const api = {
    listTasks: vi.fn(async () => [mine]),
    saveTask: vi.fn(async () => mine),
    updateTask: vi.fn(async () => mine),
    deleteTask: vi.fn(async () => undefined),
  };
  const queue = new TaskQueue({
    api,
    load: async () => disk,
    persist: async (data) => {
      disk = data;
    },
    active: () => true,
    changed: (state) => {
      snapshot = state;
    },
    ...(options.view ? { view: options.view } : {}),
    ...(options.keep ? { keep: options.keep } : {}),
  });
  return { queue, api, snapshot: () => snapshot, disk: () => disk };
}

describe('TaskQueue views', () => {
  it('delivers pending changes without reading the list while no view is open', async () => {
    const { queue, api } = queueWith({ view: () => null });
    await queue.create(mine, { title: mine.title, projectId: 'p1' });
    await queue.sync();
    expect(api.saveTask).toHaveBeenCalledTimes(1);
    // The silent failure: the full list read on every app start and foreground.
    expect(api.listTasks).not.toHaveBeenCalled();
  });

  it('reads the open views instead of the full list', async () => {
    const view = vi.fn(async () => [step]);
    const { queue, api, snapshot } = queueWith({ view });
    await queue.sync();
    expect(view).toHaveBeenCalledTimes(1);
    expect(api.listTasks).not.toHaveBeenCalled();
    expect(snapshot().tasks).toEqual([step]);
  });

  it('drops restored rows no view shows again, but never pending ones', async () => {
    const pendingStep = { ...otherStep, id: '55555555-5555-4555-8555-555555555555' };
    const disk = JSON.stringify({
      tasks: [mine, step, pendingStep],
      pending: [{ kind: 'delete', id: pendingStep.id }],
      conflicts: [],
    });
    const {
      queue,
      snapshot,
      disk: stored,
    } = queueWith({
      disk,
      keep: (task) => task.origin === 'user',
    });
    await queue.restore();
    expect(snapshot().tasks.map((task) => task.id)).toEqual([mine.id, pendingStep.id]);
    expect(JSON.parse(stored()!).tasks).toHaveLength(2);
  });

  it('reads again after a sync that started before a view opened', async () => {
    let open = false;
    let release!: () => void;
    const view = vi.fn(() => (open ? Promise.resolve([mine]) : null));
    const { queue, api } = queueWith({ view });
    api.saveTask.mockImplementationOnce(
      () =>
        new Promise<Task>((resolve) => {
          release = () => resolve(mine);
        }),
    );
    await queue.create(mine, { title: mine.title, projectId: 'p1' });
    const first = queue.sync();
    await vi.waitFor(() => expect(api.saveTask).toHaveBeenCalled());
    open = true;
    const forced = queue.sync(true);
    release();
    await Promise.all([first, forced]);
    expect(view.mock.results.some((result) => result.value !== null)).toBe(true);
  });
});
