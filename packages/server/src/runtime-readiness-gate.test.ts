import { describe, expect, it, vi } from 'vitest';

import {
  createRuntimeReadinessGate,
  validateRuntimeReadinessTtl,
} from './runtime-readiness-gate.js';

describe('runtime readiness gate', () => {
  it('rejects invalid cache windows', () => {
    expect(() => validateRuntimeReadinessTtl(-1)).toThrow(/ttl/);
    expect(() => validateRuntimeReadinessTtl(Number.NaN)).toThrow(/ttl/);
  });
  it('coalesces concurrent checks and caches success only for the bounded ttl', async () => {
    let resolveProbe!: () => void;
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    let now = 1_000;
    const check = createRuntimeReadinessGate(probe, { ttlMs: 5_000, now: () => now });

    const first = check();
    const concurrent = check();
    expect(probe).toHaveBeenCalledOnce();
    resolveProbe();
    await Promise.all([first, concurrent]);
    await check();
    expect(probe).toHaveBeenCalledOnce();

    now += 5_000;
    const refreshed = check();
    resolveProbe();
    await refreshed;
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('caches failure without leaking its detail and recovers after ttl', async () => {
    const probe = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('/opt/private/docker detail'))
      .mockResolvedValue(undefined);
    let now = 0;
    const check = createRuntimeReadinessGate(probe, { ttlMs: 10, now: () => now });

    await expect(check()).rejects.toThrow('runtime is not ready');
    await expect(check()).rejects.not.toThrow('/opt/private');
    expect(probe).toHaveBeenCalledOnce();
    now = 10;
    await expect(check()).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
