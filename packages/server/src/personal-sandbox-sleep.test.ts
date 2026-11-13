import { describe, expect, it, vi } from 'vitest';
import { sweepPersonalSandboxes } from './personal-sandbox-sleep.js';

describe('sweepPersonalSandboxes', () => {
  // A member's container should cost memory only while they work, and never be
  // put to sleep under a running server or turn.
  it('sleeps a sandbox only after it stayed idle for the whole period', async () => {
    let now = 0;
    let busy = true;
    const sleep = vi.fn(async () => undefined);
    const deps = {
      listActive: async () => [{ projectId: 'p1', userId: 'lena' }],
      isBusy: async () => busy,
      sleep,
      now: () => now,
      idleMs: 1000,
    };
    const idle = new Map<string, number>();
    await sweepPersonalSandboxes(deps, idle);
    busy = false;
    now = 500;
    await sweepPersonalSandboxes(deps, idle);
    now = 1400;
    await sweepPersonalSandboxes(deps, idle);
    expect(sleep).not.toHaveBeenCalled();
    now = 1600;
    await sweepPersonalSandboxes(deps, idle);
    expect(sleep).toHaveBeenCalledExactlyOnceWith('p1', 'lena');
  });
});
