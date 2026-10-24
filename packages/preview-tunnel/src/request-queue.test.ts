import { afterEach, expect, it, vi } from 'vitest';
import { RequestQueue, RequestQueueError } from './request-queue.js';

afterEach(() => vi.useRealTimers());

it('admits in FIFO order and releases a slot only once', async () => {
  const queue = new RequestQueue(1, 2, 30_000);
  const signal = new AbortController().signal;
  const first = await queue.acquire(signal);
  const order: number[] = [];
  const second = Promise.resolve(queue.acquire(signal)).then((release) => {
    order.push(2);
    return release;
  });
  const third = Promise.resolve(queue.acquire(signal)).then((release) => {
    order.push(3);
    return release;
  });
  expect(() => queue.acquire(signal)).toThrow(RequestQueueError);
  first();
  first();
  const releaseSecond = await second;
  expect(order).toEqual([2]);
  releaseSecond();
  (await third)();
  expect(order).toEqual([2, 3]);
});

it('removes an aborted waiter without consuming the next slot', async () => {
  const queue = new RequestQueue(1, 1, 30_000);
  const controller = new AbortController();
  const first = await queue.acquire(controller.signal);
  const cancelled = new AbortController();
  const pending = Promise.resolve(queue.acquire(cancelled.signal));
  const rejection = expect(pending).rejects.toThrow('reader left');
  cancelled.abort(new Error('reader left'));
  await rejection;
  const next = queue.acquire(controller.signal);
  first();
  (await next)();
  expect(() => queue.acquire(cancelled.signal)).toThrow('reader left');
});

it('bounds queue wait and clears timers after admission or cancellation', async () => {
  vi.useFakeTimers();
  const queue = new RequestQueue(1, 1, 100);
  const signal = new AbortController().signal;
  const first = await queue.acquire(signal);
  const expired = expect(queue.acquire(signal)).rejects.toThrow('wait expired');
  await vi.advanceTimersByTimeAsync(100);
  await expired;
  const next = queue.acquire(signal);
  first();
  (await next)();
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels all pending admissions without damaging active leases', async () => {
  vi.useFakeTimers();
  const queue = new RequestQueue(1, 2, 100);
  const signal = new AbortController().signal;
  const first = await queue.acquire(signal);
  const second = expect(queue.acquire(signal)).rejects.toThrow('disconnected');
  const third = expect(queue.acquire(signal)).rejects.toThrow('disconnected');
  queue.cancelPending(new Error('disconnected'));
  await Promise.all([second, third]);
  expect(vi.getTimerCount()).toBe(0);
  const next = queue.acquire(signal);
  first();
  (await next)();
});
