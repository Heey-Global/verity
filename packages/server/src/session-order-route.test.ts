import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerSessionOrderRoute } from './session-order-route.js';

it('validates the project-scoped request and returns canonical membership', async () => {
  const app = Fastify();
  const reorderSessions = vi.fn().mockResolvedValue(['new', 'a']);
  registerSessionOrderRoute(app, { store: { reorderSessions } });
  const response = await app.inject({
    method: 'PATCH',
    url: '/sessions/order',
    payload: { projectId: null, ids: ['a'] },
  });
  expect(response.json()).toEqual({ ids: ['new', 'a'] });
  expect(reorderSessions).toHaveBeenCalledWith(null, ['a']);
  for (const payload of [
    { ids: ['a'] },
    { projectId: null, ids: ['a', 'a'] },
    { projectId: '', ids: [] },
  ]) {
    expect(
      (await app.inject({ method: 'PATCH', url: '/sessions/order', payload })).statusCode,
    ).toBe(400);
  }
  expect(reorderSessions).toHaveBeenCalledTimes(1);
  await app.close();
});
it('returns membership conflicts and absent project errors without hiding database failures', async () => {
  const app = Fastify();
  const reorderSessions = vi.fn();
  registerSessionOrderRoute(app, { store: { reorderSessions } });
  for (const [message, status] of [
    ['Session belongs to another project', 409],
    ['Project not found', 404],
    ['database unavailable', 500],
  ] as const) {
    reorderSessions.mockRejectedValueOnce(new Error(message));
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/sessions/order',
          payload: { projectId: 'p', ids: ['a'] },
        })
      ).statusCode,
    ).toBe(status);
  }
  await app.close();
});
