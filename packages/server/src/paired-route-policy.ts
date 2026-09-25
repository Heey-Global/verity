import { routeScopeKey } from './route-scopes.js';

type ProjectPermission = 'read' | 'execute' | 'manage';
type ResourceRule = {
  readonly kind: 'project' | 'session';
  readonly parameter: string;
  readonly permission: ProjectPermission;
};
type PairedRoutePolicy = ResourceRule | { readonly kind: 'administrator' };

/** Routes become available to members only after their resource and required
 * permission are declared here. Everything else remains administrator-only,
 * including collections, cross-project actions, and stream-ticket issuance.
 * The WebSocket handshake consumes that ticket, not a paired-device bearer. */
const resourceRules: ReadonlyMap<string, ResourceRule> = new Map([
  [routeScopeKey('GET', '/projects/:id'), { kind: 'project', parameter: 'id', permission: 'read' }],
  [routeScopeKey('GET', '/sessions/:id'), { kind: 'session', parameter: 'id', permission: 'read' }],
]);

function pairedRoutePolicy(method: string, routeUrl: string): PairedRoutePolicy {
  return resourceRules.get(routeScopeKey(method, routeUrl)) ?? { kind: 'administrator' };
}

export interface PairedRoutePolicyStore {
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
