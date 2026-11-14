import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerLifecycle } from './server-context.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Only intervals are faked: Fastify's own ready/close sequencing runs on
// immediates and microtasks and must stay real.
const fakeIntervals = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

describe('createServerLifecycle', () => {
  it('stops components in the order app.addHook would', async () => {
    // Moving a hook into the registry must not reorder shutdown: a service
    // stopped after the one it sends through would send into a closed sender.
    const app = Fastify();
    const lifecycle = createServerLifecycle(app);
    const order: string[] = [];
    lifecycle.onClose(() => {
      order.push('sender');
    });
    app.addHook('onClose', async () => {
      order.push('direct');
    });
    lifecycle.onClose(async () => {
      await Promise.resolve();
      order.push('producer');
    });
    await app.ready();
    await app.close();
    expect(order).toEqual(['producer', 'direct', 'sender']);
  });

  it('clears intervals before any onClose hook runs', async () => {
    fakeIntervals();
    const app = Fastify();
    const lifecycle = createServerLifecycle(app);
    let ticks = 0;
    let closed = false;
    // Registered first, so this onClose hook runs last; the interval must
    // already be gone by then, not merely when its own registration comes up.
    lifecycle.every(1_000, () => {
      ticks += 1;
      if (closed) throw new Error('ticked into a closed service');
    });
    lifecycle.onClose(() => {
      vi.advanceTimersByTime(5_000);
      closed = true;
      vi.advanceTimersByTime(5_000);
    });
    await app.ready();
    vi.advanceTimersByTime(2_000);
    expect(ticks).toBe(2);
    await app.close();
    expect(ticks).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts a ready-bound interval only once the server is ready', async () => {
    fakeIntervals();
    const app = Fastify();
    const lifecycle = createServerLifecycle(app);
    let ticks = 0;
    lifecycle.every(1_000, () => (ticks += 1), { startWhenReady: true });
    vi.advanceTimersByTime(5_000);
    expect(ticks).toBe(0);
    await app.ready();
    vi.advanceTimersByTime(3_000);
    expect(ticks).toBe(3);
    await app.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never keeps the process alive', () => {
    const app = Fastify();
    const lifecycle = createServerLifecycle(app);
    const spy = vi.spyOn(globalThis, 'setInterval');
    lifecycle.every(1_000, () => undefined);
    const interval = spy.mock.results[0]?.value as ReturnType<typeof setInterval>;
    expect(interval.hasRef()).toBe(false);
    clearInterval(interval);
  });
});
