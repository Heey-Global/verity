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
  expect(
    await authorizePairedRoute(store, 'member', 'GET', '/tasks/:id/attachments/:hash', {}),
  ).toBe('allow');
  expect(
    await authorizePairedRoute(store, 'disabled', 'GET', '/tasks/:id/attachments/:hash', {}),
  ).toBe('forbidden');
  expect(await authorizePairedRoute(store, 'member', 'GET', '/attachments/:hash', {})).toBe(
    'forbidden',
  );
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
  // A name check spends a model call on the session, like a spoken request check.
  expect(
    await authorizePairedRoute(
      store,
      'viewer',
      'POST',
      '/sessions/:id/live-meetings/:meetingId/speaker-name',
      { id: 'session', meetingId: 'meeting' },
    ),
  ).toBe('forbidden');
});

it('requires session read access for app documents and execute access for app actions', async () => {
  const store: PairedRoutePolicyStore = {
    isActiveLocalUser: async () => true,
    isActiveAdministrator: async () => false,
    hasProjectPermission: async (userId, projectId, permission) =>
      projectId === 'shared' && (permission === 'read' || userId === 'executor'),
    getSession: async (id) => (id === 'session' ? { projectId: 'shared' } : undefined),
  };
  expect(
    await authorizePairedRoute(store, 'viewer', 'GET', '/sessions/:id/mcp-apps/:appId', {
      id: 'session',
    }),
  ).toBe('allow');
  expect(
    await authorizePairedRoute(store, 'viewer', 'POST', '/sessions/:id/mcp-apps/:appId/call', {
      id: 'session',
    }),
  ).toBe('forbidden');
  expect(
    await authorizePairedRoute(store, 'executor', 'POST', '/sessions/:id/mcp-apps/:appId/call', {
      id: 'session',
    }),
  ).toBe('allow');
  expect(
    await authorizePairedRoute(store, 'executor', 'POST', '/sessions/:id/mcp-apps/:appId/call', {
      id: 'foreign',
    }),
  ).toBe('not_found');
});

it('requires project management permission to disconnect GitHub', async () => {
  const store: PairedRoutePolicyStore = {
    isActiveLocalUser: async () => true,
    isActiveAdministrator: async () => false,
    hasProjectPermission: async (user, project, permission) =>
      user === 'manager' && project === 'project' && permission === 'manage',
    getSession: async () => undefined,
  };
  for (const user of ['reader', 'executor']) {
    expect(
      await authorizePairedRoute(store, user, 'POST', '/projects/:id/disconnect-github', {
        id: 'project',
      }),
    ).toBe('forbidden');
  }
  expect(
    await authorizePairedRoute(store, 'manager', 'POST', '/projects/:id/disconnect-github', {
      id: 'project',
    }),
  ).toBe('allow');
});

it('allows active users to read Shared centrally but reserves changes for administrators', async () => {
  const store: PairedRoutePolicyStore = {
    isActiveLocalUser: async (id) => id !== 'disabled',
    isActiveAdministrator: async (id) => id === 'admin',
    hasProjectPermission: async () => false,
    getSession: async () => undefined,
  };
  for (const route of [
    '/knowledge/shared/files',
    '/knowledge/shared/files/content',
    '/knowledge/shared/files/download',
  ]) {
    expect(await authorizePairedRoute(store, 'member', 'GET', route, {})).toBe('allow');
    expect(await authorizePairedRoute(store, 'disabled', 'GET', route, {})).toBe('forbidden');
  }
  expect(
    await authorizePairedRoute(store, 'member', 'PUT', '/knowledge/shared/files/content', {}),
  ).toBe('forbidden');
  expect(
    await authorizePairedRoute(store, 'admin', 'PUT', '/knowledge/shared/files/content', {}),
  ).toBe('allow');
});
