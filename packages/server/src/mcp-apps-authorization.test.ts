import type { FastifyRequest } from 'fastify';
import { expect, it, vi } from 'vitest';
import { createMcpAppAuthorization } from './mcp-apps-authorization.js';
import type { ServerDeps } from './server-deps.js';

const policy = vi.hoisted(() => ({ check: vi.fn(async () => 'allow') }));
vi.mock('./paired-route-policy.js', () => ({ authorizePairedRoute: policy.check }));

it('revalidates captured credentials and original session after request completion', async () => {
  const registry = {
    isEnabled: () => true,
    verify: vi.fn(() => true),
    resolveUserId: vi.fn(() => 'viewer'),
  };
  const deps = { authRegistry: registry, eventStore: {} } as unknown as Pick<
    ServerDeps,
    'authRegistry' | 'eventStore'
  >;
  const authorization = createMcpAppAuthorization(deps);
  const request = {
    headers: { authorization: 'Bearer device-token' },
    localUserId: 'viewer',
    params: { id: 's', appId: 'app' },
    method: 'POST',
    routeOptions: { url: '/sessions/:id/mcp-apps/:appId/document' },
  } as unknown as FastifyRequest;
  expect(await authorization.authorizeRequest(request)).toBe(true);
  const check = authorization.captureDocumentAccess(request);
  request.localUserId = 'other';
  request.headers.authorization = 'Bearer other-device';
  request.params = { id: 'foreign', appId: 'app' };
  expect(await check()).toBe(true);
  expect(registry.verify).toHaveBeenLastCalledWith('device-token');
  expect(policy.check).toHaveBeenLastCalledWith(
    deps.eventStore,
    'viewer',
    'GET',
    '/sessions/:id/mcp-apps/:appId',
    { id: 's', appId: 'app' },
  );
  registry.verify.mockReturnValue(false);
  expect(await check()).toBe(false);
  registry.verify.mockReturnValue(true);
  registry.resolveUserId.mockReturnValue('other');
  expect(await check()).toBe(false);
  registry.resolveUserId.mockReturnValue('viewer');
  policy.check.mockResolvedValueOnce('forbidden');
  expect(await check()).toBe(false);
  expect(await authorization.authorizeRequest(request)).toBe(false);
});
