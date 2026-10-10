import { afterEach, expect, it, vi } from 'vitest';
import type { TaskRecord } from '@verity/store';
import {
  parseTaskTitle,
  taskTitleModel,
  TaskTitleJobs,
  TASK_TITLE_TIMEOUT_MS,
} from './task-titles.js';

afterEach(() => vi.useRealTimers());

it('uses the exact session model, only asking for the default outside sessions', async () => {
  const session = vi.fn(async () => ({ model: 'session-model', projectId: 'p' }));
  const defaultModel = vi.fn(async () => 'default-model');
  expect(await taskTitleModel('s', { session, defaultModel })).toEqual({
    model: 'session-model',
    projectId: 'p',
  });
  expect(defaultModel).not.toHaveBeenCalled();
  expect(await taskTitleModel(null, { session, defaultModel })).toEqual({
    model: 'default-model',
    projectId: null,
  });
  session.mockResolvedValueOnce(undefined as never);
  expect(await taskTitleModel('deleted', { session, defaultModel })).toBeUndefined();
  expect(defaultModel).toHaveBeenCalledTimes(1);
});

it.each([
  undefined,
  '',
  'Title\nMore commentary',
  'x'.repeat(101),
  'one two three four five six seven eight nine ten eleven',
])('rejects unusable title output %j', (raw) => {
  expect(parseTaskTitle(raw)).toBeUndefined();
});

it('accepts a concise title without surrounding quotation marks', () => {
  expect(parseTaskTitle(' “Improve voice task titles” ')).toBe('Improve voice task titles');
});

const task = {
  id: 't',
  detail: 'The complete transcript',
  title: 'Provisional',
  status: 'open',
  sessionId: null,
} as TaskRecord;

it('bounds concurrency, times out requests, and never saves results after abort', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const query = vi.fn(async (_task, _prompt, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<string>((resolve) =>
      signal.addEventListener('abort', () => resolve('Late title'), { once: true }),
    );
  });
  const save = vi.fn();
  const jobs = new TaskTitleJobs({ query, save });
  jobs.enqueue(task);
  jobs.enqueue({ ...task, id: 'two' });
  jobs.enqueue({ ...task, id: 'three' });
  expect(query).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(TASK_TITLE_TIMEOUT_MS);
  expect(signals[0]!.aborted).toBe(true);
  expect(query).toHaveBeenCalledTimes(3);
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls.every(([, title]) => title === undefined)).toBe(true);
  jobs.close();
  await vi.advanceTimersByTimeAsync(1);
  expect(signals[2]!.aborted).toBe(true);
  expect(save).toHaveBeenCalledTimes(2);
});
