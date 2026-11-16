import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerSessionDeleteRoute } from './session-delete-route.js';

it('bounds even a stalled initial lookup and returns a retryable response', async () => {
  const app = Fastify();
  let started!: () => void;
  let finish: ((value: unknown) => void) | undefined;
  const settled = vi.fn();
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  registerSessionDeleteRoute(app, {
    remove: async () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await app.ready();
  vi.useFakeTimers();
  try {
    const response = app.inject({ method: 'DELETE', url: '/sessions/stale' }).then((res) => {
      settled();
      return res;
    });
    await entered;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toHaveBeenCalledOnce();
    const res = await response;
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json().error).toContain('pending');
  } finally {
    finish?.({});
    vi.useRealTimers();
    await app.close();
  }
});

// Keeping a deleted session for the Wiki needs the user's choice; a client that
// never offered it (an older app) must keep nothing.
it('keeps a session for the Wiki only when the request asks for it', async () => {
  const app = Fastify();
  const seen: unknown[] = [];
  registerSessionDeleteRoute(app, {
    remove: async (_request, _reply, _id, _force, options) => {
      seen.push(options?.keepForWiki);
      return { sessionId: 's', cleanup: 'pending' };
    },
  });
  await app.ready();
  try {
    await app.inject({ method: 'DELETE', url: '/sessions/s?wiki=true' });
    await app.inject({ method: 'DELETE', url: '/sessions/s?wiki=false' });
    await app.inject({ method: 'DELETE', url: '/sessions/s' });
    expect(seen).toEqual([true, false, false]);
  } finally {
    await app.close();
  }
});
