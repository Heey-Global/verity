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
 * including collections, cross-project actions, and stream-ticket issuance.
 * The WebSocket handshake consumes that ticket, not a paired-device bearer. */
const resourceRules: ReadonlyMap<string, ResourceRule> = new Map([
  [routeScopeKey('GET', '/projects/:id'), { kind: 'project', parameter: 'id', permission: 'read' }],
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
  routeScopeKey('GET', '/projects'),
  routeScopeKey('GET', '/auth/session'),
  routeScopeKey('POST', '/auth/logout'),
  // Tasks are owner-scoped inside the handler (docs/TASKS_AND_QUICK_CAPTURE_CONCEPT.md §7.2).
  routeScopeKey('GET', '/tasks'),
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
