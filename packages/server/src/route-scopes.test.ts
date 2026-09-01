import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  NON_OPERATOR_ROUTES,
  isDeclaredNonOperatorRoute,
  nonOperatorDeclarationError,
  routeScopeKey,
  type RouteScopeDeclaration,
} from './route-scopes.js';

/**
 * Read the route registrations out of the source rather than out of a list kept
 * for this test. A hand-written list is exactly what the declaration map already
 * is, so comparing one against the other would only prove they were copied from
 * each other — the same failure mode `scripts/ci-workflow.test.ts` avoids by
 * deriving its expectation from the thing it is checking.
 *
 * The pattern deliberately is not a parser. It matches a route verb followed by
 * a string literal, which is how every registration in this package is written
 * and how Prettier keeps them. A registration built from a computed path would
 * be missed, which is what `no computed route paths` below exists to rule out.
 */
const ROUTE_PATTERN =
  /\b(?:app|instance|server)\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
const COMPUTED_ROUTE_PATTERN =
  /\b(?:app|instance|server)\.(?:get|post|put|patch|delete|head)\(\s*([^'"`\s)])/g;
const HEAD_ROUTE_PATTERN = /\b(?:app|instance|server)\.head\(/g;

function routeSourceFiles(): readonly string[] {
  return execFileSync('git', ['ls-files', 'packages/server/src/*.ts'], { encoding: 'utf8' })
    .split('\n')
    .filter((path) => path !== '' && !path.endsWith('.test.ts'));
}

function registeredRouteKeys(): readonly string[] {
  const keys: string[] = [];
  for (const file of routeSourceFiles()) {
    for (const match of readFileSync(file, 'utf8').matchAll(ROUTE_PATTERN)) {
      keys.push(routeScopeKey(match[1]!, match[3]!));
    }
  }
  return keys;
}

const fixture = (method: string, url: string): ReadonlyMap<string, RouteScopeDeclaration> =>
  new Map([[routeScopeKey(method, url), { scope: 'public' as const, credential: 'test fixture' }]]);

describe('route scope declarations', () => {
  it('finds the route surface it is supposed to be checking', () => {
    // A guard on the extraction itself. If the pattern stopped matching — a
    // Fastify upgrade, a reformat, a move to `route({ method })` — every other
    // assertion in this file would pass vacuously against an empty set.
    const keys = registeredRouteKeys();
    expect(keys.length).toBeGreaterThan(100);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('declares no route that is not registered', () => {
    // The direction the old pre-auth pathname set could not check. A declaration
    // whose route was renamed or deleted grants nothing, but it reads in review
    // as a live exception and outlives the reason it was added.
    const registered = new Set(registeredRouteKeys());
    expect([...NON_OPERATOR_ROUTES.keys()].filter((key) => !registered.has(key))).toEqual([]);
  });

  it('states, for every exception, which credential stands in for the operator token', () => {
    for (const [key, declaration] of NON_OPERATOR_ROUTES) {
      expect(key, `${key} must be keyed "METHOD /path"`).toMatch(
        /^(GET|POST|PUT|PATCH|DELETE) \/[^\s]*$/,
      );
      // The reason an exception is safe is reviewed together with the entry, so
      // it has to say something. `public` routes name their lack of a credential.
      expect(declaration.credential.length, `${key} must state its credential`).toBeGreaterThan(10);
    }
  });

  it('keeps every exception free of path parameters', () => {
    for (const key of NON_OPERATOR_ROUTES.keys()) {
      const [method, url] = key.split(' ', 2) as [string, string];
      expect(nonOperatorDeclarationError(method, url), key).toBeUndefined();
    }
  });

  it('has no computed route paths that the source scan would miss', () => {
    // What makes the scan above trustworthy: every registration passes a literal.
    // A template literal or a variable would register a route this test cannot
    // see. That is only safe because the gate requires the operator token by
    // default — this keeps the default the sole reason an undeclared route is ok.
    const computed: string[] = [];
    for (const file of routeSourceFiles()) {
      for (const match of readFileSync(file, 'utf8').matchAll(COMPUTED_ROUTE_PATTERN)) {
        computed.push(`${file}: ${match[1]!}`);
      }
    }
    expect(computed).toEqual([]);
  });

  it('registers no explicit HEAD route', () => {
    // `isDeclaredNonOperatorRoute` folds HEAD onto its GET declaration, which is
    // right for the HEAD Fastify auto-adds to a GET (same handler) and wrong for
    // a hand-written one. Nothing registers HEAD by hand, and this keeps it so.
    const explicit: string[] = [];
    for (const file of routeSourceFiles()) {
      if (HEAD_ROUTE_PATTERN.test(readFileSync(file, 'utf8'))) explicit.push(file);
      HEAD_ROUTE_PATTERN.lastIndex = 0;
    }
    expect(explicit).toEqual([]);
  });
});

describe('isDeclaredNonOperatorRoute', () => {
  it('reports an undeclared route as covered by the operator gate', () => {
    expect(isDeclaredNonOperatorRoute({ method: 'GET', url: '/sessions/:id' })).toBe(false);
    expect(isDeclaredNonOperatorRoute({ method: 'POST', url: '/projects' })).toBe(false);
  });

  it('reports a declared route as an exception', () => {
    expect(isDeclaredNonOperatorRoute({ method: 'GET', url: '/healthz' })).toBe(true);
    expect(isDeclaredNonOperatorRoute({ method: 'POST', url: '/internal/git/sign' })).toBe(true);
  });

  it('does not carry a sibling method in on a declared one', () => {
    // The gap the old pathname-keyed set had: `/secret/status` was pre-auth for
    // whatever method was registered on it, so a POST added next to the GET
    // would have been exposed without anyone deciding that.
    expect(isDeclaredNonOperatorRoute({ method: 'GET', url: '/secret/status' })).toBe(true);
    expect(isDeclaredNonOperatorRoute({ method: 'POST', url: '/secret/status' })).toBe(false);
  });

  it("treats a GET's auto-added HEAD as covered by the GET declaration", () => {
    expect(isDeclaredNonOperatorRoute({ method: 'HEAD', url: '/healthz' })).toBe(true);
    expect(isDeclaredNonOperatorRoute({ method: ['GET', 'HEAD'], url: '/healthz' })).toBe(true);
    expect(isDeclaredNonOperatorRoute({ method: 'HEAD', url: '/projects' })).toBe(false);
  });

  it('refuses a declared exception whose url carries a parameter', () => {
    const routes = fixture('GET', '/probe/:id');
    expect(() => isDeclaredNonOperatorRoute({ method: 'GET', url: '/probe/:id' }, routes)).toThrow(
      /path parameter/,
    );
    // Undeclared, so the gate covers it and the shape of the url is irrelevant.
    expect(isDeclaredNonOperatorRoute({ method: 'GET', url: '/other/:id' }, routes)).toBe(false);
  });
});

describe('the onRoute hook in buildServer', () => {
  // The hook body is `isDeclaredNonOperatorRoute`, exercised above. What is left
  // to check is that Fastify calls it the way the hook assumes: once per
  // registration, with the url pattern and the auto-added HEAD.
  it('sees every registered route, including the HEAD Fastify adds to a GET', async () => {
    const app = Fastify({ logger: false });
    const seen: string[] = [];
    app.addHook('onRoute', (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        seen.push(routeScopeKey(method, route.url));
      }
    });
    app.get('/healthz', async () => ({}));
    app.post('/sessions/:id/turns', async () => ({}));
    await app.ready();
    await app.close();
    expect(seen).toContain('GET /healthz');
    expect(seen).toContain('HEAD /healthz');
    expect(seen).toContain('POST /sessions/:id/turns');
  });

  it('refuses to register a declared exception under a parameterised url', () => {
    const routes = fixture('GET', '/probe/:id');
    const app = Fastify({ logger: false });
    app.addHook('onRoute', (route) => {
      isDeclaredNonOperatorRoute(route, routes);
    });
    expect(() => app.get('/probe/:id', async () => ({}))).toThrow(/path parameter/);
  });
});
