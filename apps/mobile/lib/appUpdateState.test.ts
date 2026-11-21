import { createAppUpdateState } from './appUpdateState';
import type { SerialUpdateResult } from './automaticUpdates';

it('shares the pending result between automatic and manual callers, including its failure', async () => {
  let finish!: (result: SerialUpdateResult) => void;
  const operation = jest.fn(
    () =>
      new Promise<SerialUpdateResult>((resolve) => {
        finish = resolve;
      }),
  );
  const state = createAppUpdateState(operation);
  const listener = jest.fn();
  const unsubscribe = state.subscribe(listener);
  const automatic = state.check();
  const manual = state.check();
  expect(manual).toBe(automatic);
  expect(state.getSnapshot().phase).toBe('check');
  await Promise.resolve();
  expect(operation).toHaveBeenCalledTimes(1);
  const failure = { status: 'failed', phase: 'check', timedOut: true, message: 'offline' } as const;
  finish(failure);
  await expect(manual).resolves.toEqual(failure);
  expect(state.getSnapshot()).toMatchObject({ phase: 'idle', failure });
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
});

it('retains a failed check during retry, clears it on success and retains a ready download', async () => {
  let phase!: (phase: 'check' | 'download') => void;
  let result: SerialUpdateResult = {
    status: 'failed',
    phase: 'download',
    timedOut: false,
    message: 'offline',
  };
  const state = createAppUpdateState(async (onPhase) => {
    phase = onPhase;
    return result;
  });
  await state.check();
  expect(state.getSnapshot().failure?.phase).toBe('download');
  result = 'downloaded';
  const pending = state.check();
  expect(state.getSnapshot().failure).not.toBeNull();
  await Promise.resolve();
  phase('download');
  expect(state.getSnapshot().phase).toBe('download');
  await pending;
  expect(state.getSnapshot()).toEqual({ phase: 'idle', downloaded: true, failure: null });
  result = 'current';
  await state.check();
  expect(state.getSnapshot().downloaded).toBe(true);
});
