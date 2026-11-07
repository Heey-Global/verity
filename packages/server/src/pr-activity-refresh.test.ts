import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrActivityRefresh } from './pr-activity-refresh.js';

describe('PR discovery during a turn', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces a burst and runs a trailing read without another event', async () => {
    const refresh = vi.fn(async () => {});
    const activity = createPrActivityRefresh({ refresh, onError: vi.fn() });
    activity.notify('s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    activity.notify('s1');
    await vi.advanceTimersByTimeAsync(1_000);
    activity.notify('s1');
    await vi.advanceTimersByTimeAsync(27_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await activity.close();
  });

  it('shares a slow read and checks again for changes made while it ran', async () => {
    let finish!: () => void;
    const refresh = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const activity = createPrActivityRefresh({ refresh, onError: vi.fn() });
    activity.notify('s1');
    await vi.advanceTimersByTimeAsync(0);
    activity.notify('s1');
    await vi.advanceTimersByTimeAsync(35_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await activity.close();
  });

  it('refreshes independent sessions and flushes immediately at turn completion', async () => {
    const refresh = vi.fn(async () => {});
    const activity = createPrActivityRefresh({ refresh, onError: vi.fn() });
    activity.notify('s1');
    activity.notify('s2');
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh.mock.calls).toEqual([['s1'], ['s2']]);
    activity.notify('s1');
    activity.notify('s1', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(3);
    await activity.close();
  });

  it('reports failures and cancels pending work on close', async () => {
    const error = new Error('offline');
    const refresh = vi.fn(async () => {
      throw error;
    });
    const onError = vi.fn();
    const activity = createPrActivityRefresh({ refresh, onError });
    activity.notify('s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(error, 's1');
    activity.notify('s1');
    await activity.close();
    activity.notify('s2');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
