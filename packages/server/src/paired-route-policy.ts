import { routeScopeKey } from './route-scopes.js';

type ProjectPermission = 'read' | 'execute' | 'manage';
type ResourceRule = {
  readonly kind: 'project' | 'session';
  readonly parameter: string;
  readonly permission: ProjectPermission;
};
type PairedRoutePolicy =
  ResourceRule | { readonly kind: 'administrator' } | { readonly kind: 'active_user' };

/** Routes become available to members only after their resource and required
 * permission are declared here. Everything else remains administrator-only,
 * including collections and cross-project actions. */
const resourceRules: ReadonlyMap<string, ResourceRule> = new Map([
  [
    routeScopeKey('POST', '/projects/:id/repairs/approval'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/repairs'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('PUT', '/projects/:id/repairs'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/repairs/retry'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/egress/remove-request'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/egress/permanent'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/egress'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/egress/requests'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/egress/decisions'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/egress/reopen'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/egress/revoke'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/vulnerability-scan/ignores'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/vulnerability-scan/ignores'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('DELETE', '/projects/:id/vulnerability-scan/ignores/:ignoreId'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/vulnerability-scan'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/vulnerability-scan'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/live-meetings/online'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/live-meetings/:meetingId/online/stop'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('PATCH', '/sessions/:id/live-meetings/:meetingId/online/speakers'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [routeScopeKey('GET', '/projects/:id'), { kind: 'project', parameter: 'id', permission: 'read' }],
  [
    routeScopeKey('GET', '/projects/:id/github/issues'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/vulnerability-scan'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [routeScopeKey('GET', '/sessions/:id'), { kind: 'session', parameter: 'id', permission: 'read' }],
  [
    routeScopeKey('GET', '/sessions/:id/live-meetings'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('PUT', '/sessions/:id/live-meetings/:meetingId'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/live-meetings/:meetingId/addressed'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/live-meetings/:meetingId/speaker-name'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('PUT', '/sessions/:id/live-meetings/:meetingId/notes/:noteId'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/live-meetings/:meetingId/commands'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/live-meetings/:meetingId/commands'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('PUT', '/sessions/:id/live-meetings/:meetingId/commands/:commandId'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
]);

const activeUserRoutes = new Set([
  // Any active user may open the live connection; every session it subscribes
  // to is authorized individually, like `GET /sessions/:id`. The WebSocket
  // handshake consumes the ticket, not a paired-device bearer.
  routeScopeKey('POST', '/live/ticket'),
  routeScopeKey('GET', '/projects'),
  routeScopeKey('GET', '/auth/session'),
  routeScopeKey('POST', '/auth/logout'),
  // Tasks are owner-scoped inside the handler (docs/TASKS_AND_QUICK_CAPTURE_CONCEPT.md §7.2).
  routeScopeKey('GET', '/tasks'),
  routeScopeKey('GET', '/tasks/:id/attachments/:hash'),
  routeScopeKey('PUT', '/tasks/:id'),
  routeScopeKey('PATCH', '/tasks/:id'),
  routeScopeKey('DELETE', '/tasks/:id'),
]);

function pairedRoutePolicy(method: string, routeUrl: string): PairedRoutePolicy {
  const key = routeScopeKey(method, routeUrl);
  if (activeUserRoutes.has(key)) return { kind: 'active_user' };
  return resourceRules.get(key) ?? { kind: 'administrator' };
}

export interface PairedRoutePolicyStore {
  isActiveLocalUser(userId: string): Promise<boolean>;
  isActiveAdministrator(userId: string): Promise<boolean>;
  hasProjectPermission(
    userId: string,
    projectId: string,
    permission: ProjectPermission,
  ): Promise<boolean>;
  getSession(sessionId: string): Promise<{ projectId: string | null } | undefined>;
}

export async function authorizePairedRoute(
  store: PairedRoutePolicyStore,
  userId: string,
  method: string,
  routeUrl: string,
  params: Record<string, unknown>,
): Promise<'allow' | 'forbidden' | 'not_found'> {
  const policy = pairedRoutePolicy(method, routeUrl);
  if (policy.kind === 'active_user') {
    return (await store.isActiveLocalUser(userId)) ? 'allow' : 'forbidden';
  }
  if (policy.kind === 'administrator') {
    return (await store.isActiveAdministrator(userId)) ? 'allow' : 'forbidden';
  }
  const resourceId = params[policy.parameter];
  if (typeof resourceId !== 'string') return 'not_found';
  const projectId =
    policy.kind === 'project' ? resourceId : (await store.getSession(resourceId))?.projectId;
  if (projectId === undefined) return 'not_found';
  if (projectId === null) {
    return (await store.isActiveAdministrator(userId)) ? 'allow' : 'forbidden';
  }
  return (await store.hasProjectPermission(userId, projectId, policy.permission))
    ? 'allow'
    : 'forbidden';
}
