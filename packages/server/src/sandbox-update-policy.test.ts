import { describe, expect, it, vi } from 'vitest';
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

import { SandboxUpdateTracker, type SandboxUpdateState } from './sandbox-update-policy.js';
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
it('terminates a recovery interrupted by server restart and persists its concrete outcome', async () => {
  const saved = {
    since: 10,
    reasons: [],
    reportedAt: 10,
    recovery: { state: 'checking' as const, at: 10, detail: 'Checking' },
  };
  let persisted: unknown;
  const tracker = new SandboxUpdateTracker();
  await tracker.restore({
    list: async () => new Map([['p', saved]]),
    set: async (_id, state) => {
      persisted = state;
    },
    clear: async () => {},
  });
  expect(tracker.states.get('p')?.recovery).toMatchObject({
    state: 'failed',
    detail: expect.stringContaining('server restart'),
  });
  expect(persisted).toEqual(tracker.states.get('p'));
});

it('preserves a manual recovery started before the first reconcile restore', async () => {
  const durable = new Map<string, SandboxUpdateState>();
  const store = {
    list: vi.fn(async () => new Map(durable)),
    set: vi.fn(async (id: string, state: SandboxUpdateState) => {
      durable.set(id, state);
    }),
    clear: async () => {},
  };
  const tracker = new SandboxUpdateTracker();
  await tracker.beginRecovery(store, 'p');
  await tracker.restore(store);
  expect(store.list).toHaveBeenCalledTimes(1);
  expect(store.set).toHaveBeenCalledTimes(1);
  expect(tracker.states.get('p')?.recovery?.state).toBe('checking');
  expect(durable.get('p')?.recovery?.state).toBe('checking');
});

it('serializes concurrent startup restore and manual recovery before any writes', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const saved = {
    since: 10,
    reasons: [],
    reportedAt: 10,
    recovery: { state: 'checking' as const, at: 10, detail: 'Prior process' },
  };
  const durable = new Map<string, SandboxUpdateState>([['p', saved]]);
  const store = {
    list: vi.fn(async () => {
      entered();
      await gate;
      return new Map(durable);
    }),
    set: vi.fn(async (id: string, state: SandboxUpdateState) => {
      durable.set(id, state);
    }),
    clear: async () => {},
  };
  const tracker = new SandboxUpdateTracker();
  const first = tracker.restore(store);
  await started;
  const second = tracker.restore(store);
  const manual = tracker.beginRecovery(store, 'p');
  expect(store.set).not.toHaveBeenCalled();
  release();
  await Promise.all([first, second, manual]);
  expect(store.list).toHaveBeenCalledTimes(1);
  expect(store.set.mock.calls.map(([, state]) => state.recovery?.state)).toEqual([
    'failed',
    'checking',
  ]);
  expect(durable.get('p')?.recovery?.state).toBe('checking');
  expect(tracker.states.get('p')?.recovery?.state).toBe('checking');
});
