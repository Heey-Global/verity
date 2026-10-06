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
  // Tasks are scoped by owner inside the handler, so any active user reaches the routes.
  expect(await authorizePairedRoute(store, 'member', 'PUT', '/tasks/:id', { id: 't' })).toBe(
    'allow',
  );
  expect(await authorizePairedRoute(store, 'disabled', 'GET', '/tasks', {})).toBe('forbidden');
  expect(await authorizePairedRoute(store, 'disabled', 'GET', '/projects', {})).toBe('forbidden');
  expect(await authorizePairedRoute(store, 'admin', 'GET', '/settings', {})).toBe('allow');
});

it('allows live meeting viewing with read access and remote controls only with execute access', async () => {
  const store: PairedRoutePolicyStore = {
    isActiveLocalUser: async () => true,
    isActiveAdministrator: async () => false,
    hasProjectPermission: async (_userId, _projectId, permission) => permission === 'read',
    getSession: async () => ({ projectId: 'shared' }),
  };
  expect(
    await authorizePairedRoute(store, 'viewer', 'GET', '/sessions/:id/live-meetings', {
      id: 'session',
    }),
  ).toBe('allow');
  expect(
    await authorizePairedRoute(
      store,
      'viewer',
      'GET',
      '/sessions/:id/live-meetings/:meetingId/commands',
      { id: 'session', meetingId: 'meeting' },
    ),
  ).toBe('allow');
  expect(
    await authorizePairedRoute(
      store,
      'viewer',
      'POST',
      '/sessions/:id/live-meetings/:meetingId/commands',
      { id: 'session', meetingId: 'meeting' },
    ),
  ).toBe('forbidden');
  expect(
    await authorizePairedRoute(
      store,
      'viewer',
      'PUT',
      '/sessions/:id/live-meetings/:meetingId/notes/:noteId',
      { id: 'session', meetingId: 'meeting', noteId: 'note' },
    ),
  ).toBe('forbidden');
  // Checking a spoken request can end in a turn, so it needs the same right as sending one.
  expect(
    await authorizePairedRoute(
      store,
      'viewer',
      'POST',
      '/sessions/:id/live-meetings/:meetingId/addressed',
      { id: 'session', meetingId: 'meeting' },
    ),
  ).toBe('forbidden');
});
