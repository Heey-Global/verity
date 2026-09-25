import { expect, it, vi } from 'vitest';
import { authorizePairedRoute, type PairedRoutePolicyStore } from './paired-route-policy.js';

it('resolves project and session reads while keeping undeclared routes administrator-only', async () => {
  const store: PairedRoutePolicyStore = {
    isActiveLocalUser: vi.fn(async (userId) => userId !== 'disabled'),
    isActiveAdministrator: vi.fn(async (userId) => userId === 'admin'),
    hasProjectPermission: vi.fn(
      async (_userId, projectId, permission) => projectId === 'shared' && permission === 'read',
    ),
    getSession: vi.fn(async (id) => (id === 'session' ? { projectId: 'shared' } : undefined)),
  };
  expect(
    await authorizePairedRoute(store, 'member', 'GET', '/projects/:id', { id: 'shared' }),
  ).toBe('allow');
  expect(
    await authorizePairedRoute(store, 'member', 'GET', '/sessions/:id', { id: 'session' }),
  ).toBe('allow');
  expect(
    await authorizePairedRoute(store, 'member', 'GET', '/sessions/:id', { id: 'unknown' }),
  ).toBe('not_found');
  expect(await authorizePairedRoute(store, 'member', 'GET', '/sessions/:id', {})).toBe('not_found');
  expect(await authorizePairedRoute(store, 'member', 'GET', '/settings', {})).toBe('forbidden');
  expect(await authorizePairedRoute(store, 'member', 'GET', '/projects', {})).toBe('allow');
  expect(await authorizePairedRoute(store, 'disabled', 'GET', '/projects', {})).toBe('forbidden');
  expect(await authorizePairedRoute(store, 'admin', 'GET', '/settings', {})).toBe('allow');
});
