import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerSessionDeleteRoute } from './session-delete-route.js';

it('bounds even a stalled initial lookup and returns a retryable response', async () => {
  const app = Fastify();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  registerSessionDeleteRoute(app, {
    remove: async () => {
      started();
      return new Promise(() => {});
    },
  });
  await app.ready();
  vi.useFakeTimers();
  try {
    const response = app.inject({ method: 'DELETE', url: '/sessions/stale' }).then((res) => res);
    await entered;
    await vi.advanceTimersByTimeAsync(15_000);
    const res = await response;
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json().error).toContain('pending');
  } finally {
    vi.useRealTimers();
    await app.close();
  }
});
