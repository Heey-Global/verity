import { describe, expect, it } from 'vitest';
import { nightlySandboxUpdate } from './sandbox-update-policy.js';
describe('fixed sandbox update window', () => {
  it.each([
    [2, 59, false],
    [3, 0, true],
    [4, 59, true],
    [5, 0, false],
  ])('local %i:%i => %s', (hour, minute, expected) => {
    expect(
      nightlySandboxUpdate(new Date(2026, 10, 16, hour, minute).getTime(), [
        'dev_server',
        'preview',
      ]),
    ).toBe(expected);
  });
  it.each([['turn'], ['unknown'], ['preview', 'turn'], ['dev_server', 'unknown'], []])(
    'never overrides %j',
    (...reasons) => {
      expect(nightlySandboxUpdate(new Date(2026, 10, 16, 3).getTime(), reasons as never)).toBe(
        false,
      );
    },
  );
});

import { SandboxUpdateTracker } from './sandbox-update-policy.js';
it('restores original waiting time and throttles repeated reports', async () => {
  const durable = new Map();
  const store = {
    list: async () => durable,
    set: async (id: string, value: unknown) => {
      durable.set(id, value);
    },
    clear: async (id: string) => {
      durable.delete(id);
    },
  };
  const before = new SandboxUpdateTracker();
  expect(await before.defer(store, 'p', ['preview'], 100)).toBe(true);
  const after = new SandboxUpdateTracker();
  await after.restore(store);
  expect(await after.defer(store, 'p', ['preview'], 1000)).toBe(false);
  expect(after.states.get('p')?.since).toBe(100);
  expect(await after.defer(store, 'p', ['dev_server'], 1001)).toBe(true);
  expect(await after.defer(store, 'p', ['dev_server'], 1001 + 30 * 60_000)).toBe(true);
  await after.clearWait(store, 'p');
  expect(after.states.has('p')).toBe(false);
});
it('starts a fresh wait after recovery and never lets telemetry fail a healthy update', async () => {
  const tracker = new SandboxUpdateTracker();
  await expect(
    tracker.checkRecovery(
      undefined,
      'p',
      async () => ({ state: 'ready', detail: 'restored' }),
      () => 10,
      () => {
        throw new Error('logger unavailable');
      },
    ),
  ).resolves.toBeUndefined();
  expect(tracker.states.get('p')?.recovery?.state).toBe('ready');
  await tracker.defer(undefined, 'p', ['preview'], 10000);
  expect(tracker.states.get('p')?.since).toBe(10000);
  expect(tracker.states.get('p')?.recovery).toBeUndefined();
});
