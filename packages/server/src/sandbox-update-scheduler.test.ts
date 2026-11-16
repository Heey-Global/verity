import type { FastifyBaseLogger } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import type { ServerDeps } from './server-deps.js';
import { startProjectRelayMigrationScheduler } from './server-support.js';

afterEach(() => vi.useRealTimers());

it('preserves unknown discovery through the scheduler and distinguishes confirmed no updates', async () => {
  vi.useFakeTimers();
  const statusAll = vi
    .fn()
    .mockRejectedValueOnce(new Error('Discovery unavailable'))
    .mockResolvedValue(new Map());
  const reconcileRelays = vi.fn(async () => undefined);
  const stop = startProjectRelayMigrationScheduler(
    {
      listProjects: async () => [],
      sandboxUpdates: { statusAll },
      provisioner: { reconcileRelays },
    } as unknown as ServerDeps,
    { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger,
    async () => false,
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileRelays).toHaveBeenCalledTimes(1);
    const first = reconcileRelays.mock.calls[0] as unknown as [
      unknown,
      { updateAvailable?: ReadonlySet<string> },
    ];
    expect(first[1].updateAvailable).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(reconcileRelays).toHaveBeenCalledTimes(2);
    const next = reconcileRelays.mock.calls[1] as unknown as [
      unknown,
      { updateAvailable?: ReadonlySet<string> },
    ];
    expect(next[1].updateAvailable).toEqual(new Set());
  } finally {
    stop();
  }
});
