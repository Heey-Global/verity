import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({
  current: undefined as { projectId: string; containerGeneration: string } | undefined,
}));
vi.mock('./internal-listener.js', () => ({ internalConnectionIdentity: () => identity.current }));
const { registerProjectDnsRoute } = await import('./project-dns-route.js');

afterEach(() => {
  identity.current = undefined;
});

async function app(resolveDirect?: Parameters<typeof registerProjectDnsRoute>[1]['resolveDirect']) {
  const server = Fastify();
  registerProjectDnsRoute(server, { resolveDirect });
  await server.ready();
  return server;
}

it('answers only over the project-bound socket from the host-admitted family', async () => {
  const resolveDirect = vi.fn(async (_identity: unknown, name: string) =>
    name === 'downloads.example.com'
      ? { addresses: ['8.8.8.8', '2001:4860:4860::8888'], ttlSeconds: 3 }
      : undefined,
  );
  const server = await app(resolveDirect);
  const ask = (payload: Record<string, unknown>) =>
    server.inject({ method: 'POST', url: '/internal/dns', payload });
  expect((await ask({ name: 'downloads.example.com', type: 'A' })).statusCode).toBe(401);
  expect(resolveDirect).not.toHaveBeenCalled();
  identity.current = { projectId: 'p1', containerGeneration: 'g1' };
  expect((await ask({ name: 'downloads.example.com', type: 'A' })).json()).toEqual({
    granted: true,
    addresses: ['8.8.8.8'],
    ttlSeconds: 3,
  });
  expect(resolveDirect).toHaveBeenLastCalledWith(identity.current, 'downloads.example.com');
  expect((await ask({ name: 'downloads.example.com', type: 'AAAA' })).json()).toMatchObject({
    addresses: ['2001:4860:4860::8888'],
  });
  expect((await ask({ name: 'other.example.com', type: 'A' })).json()).toEqual({
    granted: false,
    addresses: [],
    ttlSeconds: 1,
  });
  for (const name of ['intranet', 'Downloads.example.com', 'host.1example'])
    expect((await ask({ name, type: 'A' })).json()).toEqual({
      granted: false,
      addresses: [],
      ttlSeconds: 1,
    });
  for (const payload of [
    { name: 'x'.repeat(254), type: 'A' },
    { name: 'downloads.example.com', type: 'TXT' },
    { name: 'downloads.example.com', type: 'A', projectId: 'p2' },
  ])
    expect((await ask(payload)).statusCode).toBe(400);
  resolveDirect.mockRejectedValueOnce(new Error('host unavailable'));
  expect((await ask({ name: 'downloads.example.com', type: 'A' })).statusCode).toBe(503);
  await server.close();
});

it('registers nothing without the project fence', async () => {
  const server = await app(undefined);
  identity.current = { projectId: 'p1', containerGeneration: 'g1' };
  expect(
    (await server.inject({ method: 'POST', url: '/internal/dns', payload: {} })).statusCode,
  ).toBe(404);
  await server.close();
});
