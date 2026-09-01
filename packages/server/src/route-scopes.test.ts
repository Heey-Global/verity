import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { join } from 'node:path';
import {
  LOCKOUT_CRITICAL_KEYS,
  NON_OPERATOR_ROUTES,
  declaredNonOperatorKeys,
  missingLockoutKeys,
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
/** A template literal opens with a quote character, so COMPUTED_ROUTE_PATTERN
 *  reads it as a literal and ROUTE_PATTERN keys the route under the raw
 *  `${...}` text. Interpolation is what makes a path computed, not the quote. */
const INTERPOLATED_PATH = /\$\{/;
const HEAD_ROUTE_PATTERN = new RegExp(`\\b${receiver}\\.head\\(`, 'g');
/** `app.all(...)` / `app.route({ method })` register a path under several verbs
 *  at once, which neither the scan above nor the declaration keys model. */
const MULTI_METHOD_PATTERN = new RegExp(`\\b${receiver}\\.(?:all|route)\\(`, 'g');
/** The binding a route module receives its Fastify instance under. */
const FASTIFY_PARAM_PATTERN = /([A-Za-z_$][\w$]*)\s*:\s*FastifyInstance\b/g;
/** An inline plugin binds its instance with an INFERRED type, so the annotation
 *  above never sees it. Catch the callback's first parameter directly. */
const INLINE_PLUGIN_PATTERN =
  // Two shapes, because a bare identifier is a plugin reference in one and the
  // bound instance in the other: `register((app) => …)` / `register(function
  // (app) …)` versus the parenless `register(app => …)`. Matching an unqualified
  // identifier would read `register(websocketPlugin)` as a receiver named
  // `websocketPlugin`, so the parenless form is anchored on its arrow.
  /\.register\(\s*(?:async\s+)?(?:function\s*[\w$]*\s*)?\(\s*([A-Za-z_$][\w$]*)|\.register\(\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/g;
/** A `prefix` shifts the url `onRoute` reports away from the literal in the
 *  source, so a declaration would name a path that never arrives. */
const PREFIXED_REGISTER_PATTERN = /\.register\([^)]*\bprefix\s*:/g;

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
    // A directory pathspec, not a glob: whether `*` crosses `/` depends on
    // pathspec magic and on --literal-pathspecs being absent. Filter here instead.
    ['ls-files', '--cached', '--others', '--exclude-standard', 'packages/server/src'],
    { encoding: 'utf8', cwd: REPO_ROOT },
  )
    .split('\n')
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
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
    // assertion in this file would pass vacuously against an empty set. Anchored
    // on routes that are NOT exceptions and that live in more than one module, so
    // a scan that has narrowed to server.ts, or to the declared paths, still
    // fails here. A count would only say "fewer than last time".
    const keys = registeredRouteKeys();
    for (const anchor of [
      'GET /sessions',
      'GET /projects',
      'GET /sessions/:id',
      'GET /projects/:projectId/agent-loops',
      'GET /projects/:projectId/dev-servers',
    ]) {
      expect(
        NON_OPERATOR_ROUTES.has(anchor),
        `${anchor} must not be a declared exception, or it stops proving the scan reaches ordinary operator routes`,
      ).toBe(false);
      expect(keys, `${anchor} is registered in this package; the scan must see it`).toContain(
        anchor,
      );
    }
    // Name the duplicates rather than comparing two counts. Fastify itself
    // refuses a genuinely duplicated registration, so a hit here is more likely a
    // second copy of a route module inside the scan — which the repeated paths
    // identify, and a bare `104 !== 97` would not.
    const seen = new Set<string>();
    expect(keys.filter((key) => (seen.has(key) ? true : (seen.add(key), false)))).toEqual([]);
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

  it('has no computed route paths that the source scan would miss or mis-key', () => {
    // What makes the scan above trustworthy: every registration passes a literal.
    // A variable would register a route this test cannot see at all; a template
    // literal is worse, because it opens with a quote and so reads as a literal —
    // the key would be the raw `${…}` text, which silently satisfies both the
    // staleness and duplicate checks. Both are ruled out here. That is only safe
    // because the gate requires the operator token by default; this keeps the
    // default the sole reason an undeclared route is acceptable.
    const computed: string[] = [];
    for (const file of routeSourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(COMPUTED_ROUTE_PATTERN)) {
        computed.push(`${file}: ${match[1]!}`);
      }
      for (const match of source.matchAll(ROUTE_PATTERN)) {
        if (INTERPOLATED_PATH.test(match[3]!)) computed.push(`${file}: ${match[3]!}`);
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
    // guarantee above would quietly stop covering it. Both forms are checked: the
    // annotated parameter a route module declares, and the inferred one an inline
    // `register` callback binds — the latter has no annotation to find.
    const stray: string[] = [];
    for (const file of routeSourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of [FASTIFY_PARAM_PATTERN, INLINE_PLUGIN_PATTERN] as const) {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern)) {
          // INLINE_PLUGIN_PATTERN has two alternatives, so the name lands in
          // whichever group matched.
          const name = match[1] ?? match[2];
          if (name !== undefined && !(RECEIVERS as readonly string[]).includes(name)) {
            stray.push(`${file}: ${name}`);
          }
        }
      }
    }
    expect(stray).toEqual([]);
  });

  it('registers no plugin under a url prefix', () => {
    // A source-level nudge only: this pattern sees `register(plugin, { prefix })`
    // but not a prefix passed past a long inline plugin body. The guarantee lives
    // at runtime, in the prefix check inside `declaredNonOperatorKeys`, which sees
    // what Fastify actually resolved rather than what the source looks like.
    expect(filesMatching(PREFIXED_REGISTER_PATTERN)).toEqual([]);
  });
});

describe('missingLockoutKeys', () => {
  it('accepts a gate that got every lockout-critical exemption', () => {
    expect(missingLockoutKeys(new Set(LOCKOUT_CRITICAL_KEYS))).toEqual([]);
  });

  it('names the exemptions a gate is missing', () => {
    const keys = new Set(LOCKOUT_CRITICAL_KEYS);
    keys.delete('POST /secret/unlock');
    // buildServer turns this into a refusal to come up. Without it the deployment
    // starts and 401s the only request that can mint the operator's bearer.
    expect(missingLockoutKeys(keys)).toEqual(['POST /secret/unlock']);
    expect(missingLockoutKeys(new Set())).toEqual([...LOCKOUT_CRITICAL_KEYS]);
  });

  it('holds only keys that the declarations actually contain', () => {
    // A typo here would be a check that can never pass — buildServer would refuse
    // to start at all. That failed loudly the moment it was tried, but cheaply
    // enough to pin.
    for (const key of LOCKOUT_CRITICAL_KEYS) expect([...NON_OPERATOR_ROUTES.keys()]).toContain(key);
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

  it('refuses a declared exception that a plugin prefix moved off its own path', () => {
    const routes = fixture('GET', '/healthz');
    expect(() =>
      declaredNonOperatorKeys({ method: 'GET', url: '/api/healthz', prefix: '/api' }, routes),
    ).toThrow(/registered under the prefix/);
    // A prefixed route whose bare path is not declared is an ordinary operator
    // route; the prefix is then nobody's business.
    expect(
      declaredNonOperatorKeys({ method: 'GET', url: '/api/projects', prefix: '/api' }, routes),
    ).toEqual([]);
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
