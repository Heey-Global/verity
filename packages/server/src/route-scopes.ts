/**
 * Which credential authenticates a route.
 *
 * The global auth gate in {@link buildServer} is default-deny: a route that is
 * not named in {@link NON_OPERATOR_ROUTES} requires the operator's paired-device
 * bearer token. So this map lists only the EXCEPTIONS — the routes whose caller
 * is not the operator and which therefore carry a credential of their own.
 *
 * It replaces a hand-maintained set of pre-auth pathnames that lived next to the
 * gate and duplicated, in a second place and with a second set of conditions,
 * what the route registrations already say. Three things that set bought us:
 *
 *  - It keyed on the PATHNAME alone. `/secret/status` was pre-auth for every
 *    method registered on it, so adding `POST /secret/status` next to the
 *    existing GET would have exposed the POST silently. The keys here name the
 *    method, and a route is an exception only for the method that is declared.
 *  - Its entries were conditional (`deps.mcpGateway !== undefined ? [...] : []`)
 *    and had to stay in step with the equally conditional route registration.
 *    Nothing here is conditional: the gate learns which exceptions actually
 *    exist from the routes that are actually registered, so a deployment that
 *    does not register a route cannot have a pre-auth pathname for it either.
 *  - A stale entry — a pathname whose route had been renamed or removed — was
 *    invisible. `route-scopes.test.ts` reads the route registrations out of the
 *    source and fails on any declaration that no longer matches one.
 *
 * What this does NOT do is rank operator routes against each other. Verity has
 * one class of operator credential: a paired device is a paired device, and a
 * scope model over 130 routes that all resolve to that one credential would be
 * ceremony rather than a boundary. The boundary that exists is the one drawn
 * here — operator versus not-operator — so that is the one written down.
 */

/** The credential a caller presents. `operator` is the default and is implied. */
export type RouteScope =
  | 'public'
  | 'onboarding'
  | 'device-pairing'
  | 'github-app-manifest'
  | 'github-webhook'
  | 'signing-broker'
  | 'container-capability'
  | 'gateway-turn';

export interface RouteScopeDeclaration {
  readonly scope: RouteScope;
  /** Which credential the route's own handler checks instead of the operator
   *  bearer. Read as the answer to "if not the operator, then who?" — it is the
   *  reason the exception is safe, and it is reviewed with the entry. */
  readonly credential: string;
}

/** `"METHOD /pathname"` — the key shape for {@link NON_OPERATOR_ROUTES}. */
export function routeScopeKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

const declare = (
  method: string,
  url: string,
  scope: RouteScope,
  credential: string,
): readonly [string, RouteScopeDeclaration] => [routeScopeKey(method, url), { scope, credential }];

/**
 * Every route that the operator bearer gate deliberately does not cover.
 *
 * Adding an entry here is the one way to expose a route without the operator
 * token, and it is the reason `buildServer` refuses to start a route whose
 * declaration is malformed. Removing a route without removing its entry fails
 * the stale-declaration test.
 */
export const NON_OPERATOR_ROUTES: ReadonlyMap<string, RouteScopeDeclaration> = new Map([
  declare('GET', '/healthz', 'public', 'none — liveness probe, no operator data in the response'),
  declare(
    'GET',
    '/secret/status',
    'public',
    'none — reports only whether the store is sealed, which the app needs before it can hold a token',
  ),
  declare(
    'GET',
    '/onboarding/status',
    'public',
    'none — the probe that tells a fresh app which on-ramp to show',
  ),
  // The master-password lifecycle is the on-ramp that MINTS the operator token,
  // so it cannot itself require one. Until `/secret/init` runs the store is
  // uninitialized and the gate is open, which is the documented first-run
  // trust-on-first-use residual: the deployment must sit behind a trusted
  // network on first boot. See SECURITY.md.
  declare('POST', '/secret/init', 'onboarding', 'master password (sets the first one)'),
  declare('POST', '/secret/unlock', 'onboarding', 'master password'),
  declare('GET', '/pair/identity', 'device-pairing', 'pairing code issued out of band'),
  declare('POST', '/pair/redeem', 'device-pairing', 'single-use pairing code'),
  // Reached by GitHub's browser redirect, not by the app, so no bearer can be
  // attached; each carries a single-use CSRF `state` instead.
  declare('GET', '/github/app/manifest/start', 'github-app-manifest', 'single-use CSRF state'),
  declare('GET', '/github/app/manifest/callback', 'github-app-manifest', 'single-use CSRF state'),
  declare('GET', '/github/app/manifest/installed', 'github-app-manifest', 'single-use CSRF state'),
  declare(
    'POST',
    '/providers/github/webhook',
    'github-webhook',
    'GitHub HMAC signature over the delivery body',
  ),
  // The `/internal/*` routes are additionally unreachable off the internal
  // listener: the network-origin guard in the gate 404s them on the public/LAN
  // port, so the broker is off the LAN entirely on top of its own credential.
  declare(
    'POST',
    '/internal/git/sign',
    'signing-broker',
    'broker token (SHA-256 of the signing key), presented by the sandbox commit-signing wrapper',
  ),
  declare(
    'POST',
    '/internal/github/token',
    'container-capability',
    'per-container capability, presented by the sandbox git credential helper / gh wrapper',
  ),
  declare(
    'POST',
    '/internal/project/memory',
    'container-capability',
    'per-container capability, presented by the sandbox `verity-memory` wrapper (ADR 0008)',
  ),
  declare(
    'POST',
    '/internal/workflow/result',
    'container-capability',
    'per-container capability, presented by a workflow step reporting its result',
  ),
  // Both methods: the MCP endpoint answers POST for calls and GET for the
  // server-sent event stream, and the same per-turn bearer covers both.
  declare(
    'POST',
    '/internal/mcp',
    'gateway-turn',
    'per-turn gateway bearer the Server minted for that turn',
  ),
  declare(
    'GET',
    '/internal/mcp',
    'gateway-turn',
    'per-turn gateway bearer the Server minted for that turn',
  ),
  declare(
    'POST',
    '/internal/control-plane/mcp',
    'gateway-turn',
    'per-turn gateway bearer, for the one caller that arrives on the shared internal listener rather than a project socket',
  ),
  declare(
    'GET',
    '/internal/control-plane/mcp',
    'gateway-turn',
    'per-turn gateway bearer, for the one caller that arrives on the shared internal listener rather than a project socket',
  ),
]);

/**
 * The gate matches on the concrete request pathname with the query stripped,
 * deliberately not on Fastify's route pattern. That is only sound while no
 * exception carries a path parameter or wildcard — otherwise the declared key
 * would never equal a real pathname and the route would fall back to requiring
 * the operator token, which fails closed but fails confusingly.
 *
 * The assumption used to live in a comment. `buildServer` now refuses to
 * register such a route, so it cannot be introduced by accident.
 *
 * `routes` is a parameter so a test can drive the guard with a fixture instead
 * of mutating the shared map.
 */
export function nonOperatorDeclarationError(
  method: string,
  url: string,
  routes: ReadonlyMap<string, RouteScopeDeclaration> = NON_OPERATOR_ROUTES,
): string | undefined {
  const declaration = routes.get(routeScopeKey(method, url));
  if (declaration === undefined) return undefined;
  if (url.includes(':') || url.includes('*')) {
    return `route ${routeScopeKey(method, url)} is declared as \`${declaration.scope}\` but carries a path parameter or wildcard; the auth gate matches exception routes on the exact pathname, so such a route can never match its declaration`;
  }
  return undefined;
}

/**
 * The whole body of `buildServer`'s `onRoute` hook, so that the hook and its
 * test exercise one implementation rather than two copies that can drift.
 *
 * Throws when a route contradicts its own declaration. Returns true when the
 * route is a declared exception, which is the gate's signal to let its pathname
 * past the operator bearer check.
 *
 * Fastify reports `method` as one verb or several, and — with `exposeHeadRoutes`
 * at its default — auto-adds a HEAD route for every GET. That HEAD shares the
 * GET's handler, so it inherits the GET's declaration rather than needing one of
 * its own; folding it here keeps `HEAD /healthz` reachable exactly as it was
 * before this map existed. Nothing in this package registers HEAD explicitly
 * (`route-scopes.test.ts` holds that), so the fold cannot launder a hand-written
 * HEAD route past a declaration meant for a GET.
 */
export function isDeclaredNonOperatorRoute(
  route: { readonly method: string | readonly string[]; readonly url: string },
  routes: ReadonlyMap<string, RouteScopeDeclaration> = NON_OPERATOR_ROUTES,
): boolean {
  const methods = (
    Array.isArray(route.method) ? route.method : [route.method]
  ) as readonly string[];
  let declared = false;
  for (const raw of methods) {
    const method = raw.toUpperCase() === 'HEAD' ? 'GET' : raw;
    const error = nonOperatorDeclarationError(method, route.url, routes);
    // A programming error in this repository, not a runtime condition: fail at
    // registration, where it is cheap to see, rather than at the first request.
    if (error !== undefined) throw new Error(`verity: ${error}`);
    if (routes.has(routeScopeKey(method, route.url))) declared = true;
  }
  return declared;
}
