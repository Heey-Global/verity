import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { join } from 'node:path';
import {
  NON_OPERATOR_ROUTES,
  declaredNonOperatorKeys,
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
 *
 * It also only sees calls on a receiver named in RECEIVERS. Broadening that to
 * any identifier is not an option — `map.get('key')` would read as a route — so
 * the narrowness is enforced instead: `every route module names its Fastify
 * instance` below fails if a module introduces a receiver this cannot see.
 */
const RECEIVERS = ['app', 'instance', 'server'] as const;
const receiver = `(?:${RECEIVERS.join('|')})`;
const ROUTE_PATTERN = new RegExp(
  `\\b${receiver}\\.(get|post|put|patch|delete)\\(\\s*(['"\`])([^'"\`]+)\\2`,
  'g',
);
const COMPUTED_ROUTE_PATTERN = new RegExp(
  `\\b${receiver}\\.(?:get|post|put|patch|delete|head)\\(\\s*([^'"\`\\s)])`,
  'g',
);
const HEAD_ROUTE_PATTERN = new RegExp(`\\b${receiver}\\.head\\(`, 'g');
/** `app.all(...)` / `app.route({ method })` register a path under several verbs
 *  at once, which neither the scan above nor the declaration keys model. */
const MULTI_METHOD_PATTERN = new RegExp(`\\b${receiver}\\.(?:all|route)\\(`, 'g');
/** The binding a route module receives its Fastify instance under. */
const FASTIFY_PARAM_PATTERN = /([A-Za-z_$][\w$]*)\s*:\s*FastifyInstance\b/g;

/**
 * Resolve against the repo root rather than the process cwd, so the scan does
 * not silently match nothing if this suite is ever run from a package
 * directory. `--others` includes files that exist but have not been `git add`ed
 * yet: a brand-new route file must be scanned, not excused for being untracked.
 */
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

function routeSourceFiles(): readonly string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'packages/server/src/*.ts'],
    { encoding: 'utf8', cwd: REPO_ROOT },
  )
    .split('\n')
    .filter((path) => path !== '' && !path.endsWith('.test.ts'))
    .map((path) => join(REPO_ROOT, path));
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

function filesMatching(pattern: RegExp): readonly string[] {
  const hits: string[] = [];
  for (const file of routeSourceFiles()) {
    pattern.lastIndex = 0;
    if (pattern.test(readFileSync(file, 'utf8'))) hits.push(file);
  }
  return hits;
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
    // `declaredNonOperatorKeys` folds HEAD onto its GET declaration, which is
    // right for the HEAD Fastify auto-adds to a GET (same handler) and wrong for
    // a hand-written one. Nothing registers HEAD by hand, and this keeps it so.
    expect(filesMatching(HEAD_ROUTE_PATTERN)).toEqual([]);
  });

  it('registers no route under several methods at once', () => {
    // `app.all` / `app.route({ method: [...] })` would put one pathname under
    // verbs the declaration map names individually. The gate handles that
    // correctly (each method is keyed on its own), but the source scan would
    // report the path under a single verb and the staleness check would go soft.
    expect(filesMatching(MULTI_METHOD_PATTERN)).toEqual([]);
  });

  it('names its Fastify instance consistently in every route module', () => {
    // What makes the receiver allowlist in the patterns safe. A module that calls
    // its instance `fastify` or `api` would be invisible to the scan, and every
    // guarantee above would quietly stop covering it.
    const stray: string[] = [];
    for (const file of routeSourceFiles()) {
      for (const match of readFileSync(file, 'utf8').matchAll(FASTIFY_PARAM_PATTERN)) {
        const name = match[1]!;
        if (!(RECEIVERS as readonly string[]).includes(name)) stray.push(`${file}: ${name}`);
      }
    }
    expect(stray).toEqual([]);
  });
});

describe('declaredNonOperatorKeys', () => {
  it('grants an undeclared route no key, leaving it to the operator gate', () => {
    expect(declaredNonOperatorKeys({ method: 'GET', url: '/sessions/:id' })).toEqual([]);
    expect(declaredNonOperatorKeys({ method: 'POST', url: '/projects' })).toEqual([]);
  });

  it('grants a declared route the key the gate looks up', () => {
    expect(declaredNonOperatorKeys({ method: 'GET', url: '/healthz' })).toEqual(['GET /healthz']);
    expect(declaredNonOperatorKeys({ method: 'POST', url: '/internal/git/sign' })).toEqual([
      'POST /internal/git/sign',
    ]);
  });

  it('does not carry a sibling method in on a declared one', () => {
    // The gap the old pathname-keyed set had: `/secret/status` was pre-auth for
    // whatever method was registered on it, so a POST added next to the GET
    // would have been exposed without anyone deciding that. The keys are what
    // the gate stores, so this only holds if the gate keys by method too —
    // `auth.test.ts` asserts that end to end against a real buildServer.
    expect(declaredNonOperatorKeys({ method: 'GET', url: '/secret/status' })).toEqual([
      'GET /secret/status',
    ]);
    expect(declaredNonOperatorKeys({ method: 'POST', url: '/secret/status' })).toEqual([]);
  });

  it('grants a multi-method registration only the methods that are declared', () => {
    expect(declaredNonOperatorKeys({ method: ['GET', 'POST'], url: '/secret/status' })).toEqual([
      'GET /secret/status',
    ]);
    expect(declaredNonOperatorKeys({ method: ['POST', 'GET'], url: '/internal/mcp' })).toEqual([
      'POST /internal/mcp',
      'GET /internal/mcp',
    ]);
  });

  it("treats a GET's auto-added HEAD as covered by the GET declaration", () => {
    // Keyed as HEAD, because that is the method the request arrives with.
    expect(declaredNonOperatorKeys({ method: 'HEAD', url: '/healthz' })).toEqual(['HEAD /healthz']);
    expect(declaredNonOperatorKeys({ method: ['GET', 'HEAD'], url: '/healthz' })).toEqual([
      'GET /healthz',
      'HEAD /healthz',
    ]);
    expect(declaredNonOperatorKeys({ method: 'HEAD', url: '/projects' })).toEqual([]);
  });

  it('refuses a declared exception whose url carries a parameter', () => {
    const routes = fixture('GET', '/probe/:id');
    expect(() => declaredNonOperatorKeys({ method: 'GET', url: '/probe/:id' }, routes)).toThrow(
      /path parameter/,
    );
    // Undeclared, so the gate covers it and the shape of the url is irrelevant.
    expect(declaredNonOperatorKeys({ method: 'GET', url: '/other/:id' }, routes)).toEqual([]);
  });
});

describe('the onRoute hook in buildServer', () => {
  // The hook body is `declaredNonOperatorKeys`, exercised above. What is left to
  // check is that Fastify calls it the way the hook assumes: once per
  // registration, with the url pattern and the auto-added HEAD, and — the part
  // the gate's correctness rests on — only for routes registered AFTER the hook.
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

  it('does not see routes registered before it, which is why placement matters', async () => {
    // `onRoute` is not retroactive the way `onRequest` is. The hook in
    // buildServer therefore has to sit above the first route registration, and
    // it does — but nothing in the type system says so, and a route hoisted
    // above it would lose its exemption and 401 the on-ramp that mints the
    // operator token. This states the hazard so a reader hits it here first.
    const app = Fastify({ logger: false });
    const seen: string[] = [];
    app.get('/before', async () => ({}));
    app.addHook('onRoute', (route) => void seen.push(route.url));
    app.get('/after', async () => ({}));
    await app.ready();
    await app.close();
    expect(seen).toContain('/after');
    expect(seen).not.toContain('/before');
  });

  it('refuses to register a declared exception under a parameterised url', () => {
    const routes = fixture('GET', '/probe/:id');
    const app = Fastify({ logger: false });
    app.addHook('onRoute', (route) => {
      declaredNonOperatorKeys(route, routes);
    });
    expect(() => app.get('/probe/:id', async () => ({}))).toThrow(/path parameter/);
  });
});
