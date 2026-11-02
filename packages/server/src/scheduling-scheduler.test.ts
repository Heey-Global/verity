import { describe, expect, it, vi } from 'vitest';
import { startSchedulingScheduler } from './scheduling-scheduler.js';

describe('scheduling scheduler shutdown', () => {
  it('drains an active pass before shutdown and never starts queued work afterwards', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runDue = vi.fn(async () => {
      await blocked;
      return undefined;
    });
    const scheduler = startSchedulingScheduler({ runDue, log: { warn: vi.fn() } });
    const pass = scheduler.runOnce();
    await scheduler.runOnce();
    let stopped = false;
    const closing = Promise.resolve(scheduler.stop()).then(() => {
      stopped = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(stopped).toBe(false);
    } finally {
      release();
      await pass;
      await closing;
    }
    expect(stopped).toBe(true);
    scheduler.wake();
    await scheduler.runOnce();
    expect(runDue).toHaveBeenCalledOnce();
  });
});
