import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import {
  authorizePairedRoute,
  pairedRoutePolicy,
  type PairedRoutePolicyStore,
} from './paired-route-policy.js';

it('requires execute access to mark or end a session mockup review', async () => {
  const store: PairedRoutePolicyStore = {
    isActiveLocalUser: async () => true,
    isActiveAdministrator: async () => false,
    hasProjectPermission: async (userId, projectId, permission) =>
      projectId === 'shared' && (permission === 'read' || userId === 'executor'),
    getSession: async (id) =>
      id === 'session'
        ? { projectId: 'shared' }
        : id === 'foreign'
          ? { projectId: 'other' }
          : undefined,
  };
  const preview = '/sessions/:id/mockup-attachments/:hash';
  expect(await authorizePairedRoute(store, 'reader', 'GET', preview, { id: 'session' })).toBe(
    'allow',
  );
  expect(await authorizePairedRoute(store, 'reader', 'GET', preview, { id: 'foreign' })).toBe(
    'forbidden',
  );
  expect(
    await authorizePairedRoute(store, 'reader', 'POST', '/sessions/:id/mockups', { id: 'session' }),
  ).toBe('forbidden');
  expect(
    await authorizePairedRoute(store, 'executor', 'POST', '/sessions/:id/mockups', {
      id: 'session',
    }),
  ).toBe('allow');
  expect(
    await authorizePairedRoute(store, 'executor', 'POST', '/sessions/:id/mockups', {
      id: 'foreign',
    }),
  ).toBe('forbidden');
  expect(
    await authorizePairedRoute(store, 'executor', 'POST', '/sessions/:id/mockups', {
      id: 'missing',
    }),
  ).toBe('not_found');
});

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

// Shared knowledge is the administrator's across all their projects; members of
// a shared project never read it (ADR 0023 §1).
it('keeps Shared knowledge to administrators', async () => {
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
    '/knowledge/shared/recent',
  ]) {
    expect(await authorizePairedRoute(store, 'member', 'GET', route, {})).toBe('forbidden');
    expect(await authorizePairedRoute(store, 'admin', 'GET', route, {})).toBe('allow');
  }
  expect(
    await authorizePairedRoute(store, 'member', 'PUT', '/knowledge/shared/files/content', {}),
  ).toBe('forbidden');
  expect(
    await authorizePairedRoute(store, 'admin', 'PUT', '/knowledge/shared/files/content', {}),
  ).toBe('allow');
});

it('scopes direct project knowledge reads and edits to project permissions', async () => {
  const store: PairedRoutePolicyStore = {
    isActiveLocalUser: async () => true,
    isActiveAdministrator: async () => false,
    hasProjectPermission: async (user, project, permission) =>
      project === 'p' && (permission === 'read' || user === 'manager'),
    getSession: async () => undefined,
  };
  for (const route of [
    '/projects/:id/knowledge/files',
    '/projects/:id/knowledge/files/content',
    '/projects/:id/knowledge/files/download',
    '/projects/:id/knowledge/wiki',
  ]) {
    expect(await authorizePairedRoute(store, 'reader', 'GET', route, { id: 'p' })).toBe('allow');
    expect(await authorizePairedRoute(store, 'reader', 'GET', route, { id: 'other' })).toBe(
      'forbidden',
    );
  }
  expect(
    await authorizePairedRoute(store, 'reader', 'PUT', '/projects/:id/knowledge/files/content', {
      id: 'p',
    }),
  ).toBe('forbidden');
  expect(
    await authorizePairedRoute(store, 'manager', 'PUT', '/projects/:id/knowledge/files/content', {
      id: 'p',
    }),
  ).toBe('allow');
});

it('requires project management permission to delete Wiki entries', async () => {
  const store: PairedRoutePolicyStore = {
    isActiveLocalUser: async () => true,
    isActiveAdministrator: async () => false,
    hasProjectPermission: async (user, project, permission) =>
      project === 'p' && user === 'manager' && permission === 'manage',
    getSession: async () => undefined,
  };
  expect(
    await authorizePairedRoute(store, 'reader', 'DELETE', '/projects/:id/knowledge/files', {
      id: 'p',
    }),
  ).toBe('forbidden');
  expect(
    await authorizePairedRoute(store, 'manager', 'DELETE', '/projects/:id/knowledge/files', {
      id: 'p',
    }),
  ).toBe('allow');
  // Renaming a source changes the library like deleting it does.
  expect(
    await authorizePairedRoute(store, 'reader', 'POST', '/projects/:id/knowledge/files/rename', {
      id: 'p',
    }),
  ).toBe('forbidden');
  expect(
    await authorizePairedRoute(store, 'manager', 'POST', '/projects/:id/knowledge/files/rename', {
      id: 'p',
    }),
  ).toBe('allow');
});

// Read from the route module rather than listed: a knowledge route added there
// later must land in the same split, or managers lose it silently (nothing
// declared means administrator-only) or a member gains write access to Shared.
it('lets project members read and managers change project knowledge, Shared only administrators', () => {
  const source = readFileSync(new URL('./knowledge-file-routes.ts', import.meta.url), 'utf8');
  const routes = [...source.matchAll(/\bapp\.(get|post|put|delete)\(\s*'([^']+)'/g)].map(
    ([, method, url]) => [method!.toUpperCase(), url!] as const,
  );
  const shared = routes.filter(([, url]) => url.startsWith('/knowledge/shared/'));
  const project = routes.filter(([, url]) => url.startsWith('/projects/:id/knowledge/'));
  expect(shared.length).toBeGreaterThan(8);
  expect(project.length).toBe(shared.length);
  for (const [method, url] of shared)
    expect(pairedRoutePolicy(method, url), `${method} ${url}`).toEqual({ kind: 'administrator' });
  for (const [method, url] of project)
    expect(pairedRoutePolicy(method, url), `${method} ${url}`).toEqual({
      kind: 'project',
      parameter: 'id',
      permission: method === 'GET' ? 'read' : 'manage',
    });
});

it('lets a reader keep their own view state but hides resources they cannot read', async () => {
  const store: PairedRoutePolicyStore = {
    isActiveLocalUser: async () => true,
    isActiveAdministrator: async () => false,
    hasProjectPermission: async (_userId, projectId, permission) =>
      projectId === 'shared' && permission === 'read',
    getSession: async (id) =>
      id === 'mine'
        ? { projectId: 'shared' }
        : id === 'theirs'
          ? { projectId: 'other' }
          : undefined,
  };
  for (const route of ['/projects/:id/collapsed', '/projects/:id/inbox-dismissed']) {
    // Without these rules a member could not fold, read or dismiss anything at all.
    expect(await authorizePairedRoute(store, 'reader', 'PATCH', route, { id: 'shared' })).toBe(
      'allow',
    );
    // Refused like a read of the same project, whether it exists or not.
    for (const id of ['other', 'missing'])
      expect(await authorizePairedRoute(store, 'reader', 'PATCH', route, { id })).toBe('forbidden');
  }
  for (const route of ['/sessions/:id/seen', '/sessions/:id/inbox-dismissed']) {
    expect(await authorizePairedRoute(store, 'reader', 'PATCH', route, { id: 'mine' })).toBe(
      'allow',
    );
    // The same answers as `GET /sessions/:id` for that session.
    expect(await authorizePairedRoute(store, 'reader', 'PATCH', route, { id: 'theirs' })).toBe(
      'forbidden',
    );
    expect(await authorizePairedRoute(store, 'reader', 'PATCH', route, { id: 'gone' })).toBe(
      'not_found',
    );
  }
});

it('lets a manager rename a project without opening the rest of its settings', async () => {
  const store: PairedRoutePolicyStore = {
    isActiveLocalUser: async () => true,
    isActiveAdministrator: async () => false,
    hasProjectPermission: async (userId, projectId, permission) =>
      projectId === 'shared' && (permission === 'read' || userId === 'manager'),
    getSession: async () => undefined,
  };
  const profile = '/projects/:id/profile';
  expect(await authorizePairedRoute(store, 'manager', 'PATCH', profile, { id: 'shared' })).toBe(
    'allow',
  );
  // Reading a project is not enough to rename it.
  expect(await authorizePairedRoute(store, 'reader', 'PATCH', profile, { id: 'shared' })).toBe(
    'forbidden',
  );
  // The settings route keeps every other project setting with administrators.
  expect(
    await authorizePairedRoute(store, 'manager', 'PATCH', '/projects/:id/settings', {
      id: 'shared',
    }),
  ).toBe('forbidden');
});

// Deleting a project, or tearing down its sandboxes, ends everyone's work in it.
// Only its creator, while still in the project, or an administrator may do that;
// managing members does not include it.
it.each([
  ['DELETE', '/projects/:id'],
  ['POST', '/projects/:id/deprovision'],
] as const)('lets only the creator or an administrator %s %s', async (method, route) => {
  const store: PairedRoutePolicyStore = {
    isActiveLocalUser: async (userId) => userId !== 'disabled-creator',
    isActiveAdministrator: async (userId) => userId === 'admin',
    hasProjectPermission: async (userId) =>
      userId === 'creator' || userId === 'manager' || userId === 'disabled-creator',
    getSession: async () => undefined,
    isProjectCreator: async (userId) =>
      ['creator', 'removed-creator', 'disabled-creator'].includes(userId),
  };
  const decide = (userId: string) =>
    authorizePairedRoute(store, userId, method, route, { id: 'p1' });
  expect(await decide('admin')).toBe('allow');
  expect(await decide('creator')).toBe('allow');
  expect(await decide('manager')).toBe('forbidden');
  // Removed from the project, or deactivated: creating it no longer counts.
  expect(await decide('removed-creator')).toBe('forbidden');
  expect(await decide('disabled-creator')).toBe('forbidden');
});

// Edit lets a member work with the agent; adding the session's changes to the
// project's code needs Code (ADR 0023 §1). A route left on execute would let an
// Edit-only member merge while the team settings say they cannot.
it('requires Code, not only execute, to add changes to the project code', async () => {
  const integrating = [
    ['POST', '/sessions/:id/merge'],
    ['POST', '/sessions/:id/pull-request/merge'],
    ['POST', '/sessions/:id/save-to-project'],
    ['POST', '/sessions/:id/branch'],
    ['POST', '/sessions/:id/code-workspace/restore'],
    ['POST', '/sessions/:id/repositories/:repositoryId/open'],
    ['POST', '/projects/:id/pull-requests/:repositoryId/:number/merge'],
    ['POST', '/projects/:id/pull-requests/:repositoryId/:number/fix'],
    ['POST', '/projects/:id/qa/issues/:issueId/decision'],
    ['POST', '/projects/:id/repairs/approval'],
    ['POST', '/projects/:id/repairs/retry'],
    ['POST', '/projects/:id/vulnerability-fix'],
    ['POST', '/projects/:id/vulnerability-scan'],
  ] as const;
  const store = (permissions: string[]): PairedRoutePolicyStore => ({
    isActiveLocalUser: async () => true,
    isActiveAdministrator: async () => false,
    hasProjectPermission: async (_user, projectId, permission) =>
      projectId === 'p' && permissions.includes(permission),
    getSession: async (id) => (id === 's' ? { projectId: 'p' } : undefined),
  });
  const editor = store(['read', 'execute']);
  const developer = store(['read', 'execute', 'code']);
  for (const [method, url] of integrating) {
    const params = url.startsWith('/sessions/') ? { id: 's' } : { id: 'p' };
    expect(pairedRoutePolicy(method, url)).toMatchObject({ permission: 'code' });
    expect(await authorizePairedRoute(editor, 'mara', method, url, params)).toBe('forbidden');
    expect(await authorizePairedRoute(developer, 'alex', method, url, params)).toBe('allow');
  }
  // Working with the agent and the preview stays with execute.
  expect(
    await authorizePairedRoute(editor, 'mara', 'POST', '/sessions/:id/turns', { id: 's' }),
  ).toBe('allow');
  expect(
    await authorizePairedRoute(
      editor,
      'mara',
      'POST',
      '/sessions/:sessionId/managed-dev-servers/:serverId/start',
      { sessionId: 's', serverId: 'web' },
    ),
  ).toBe('allow');
});
