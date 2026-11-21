import { serializeServerRequest } from './request-log.js';
import compressPlugin from '@fastify/compress';
import rateLimitPlugin from '@fastify/rate-limit';
import { measureLatencyPhase, SealedError } from '@verity/store';
import Fastify, {
  type FastifyHttpsOptions,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Server as HttpsServer } from 'node:https';
import { ZodError } from 'zod';
import {
  browserOriginAllowed,
  cookieCredential,
  requestCredential,
  setBrowserSession,
} from './auth.js';
import { authorizePairedRoute } from './paired-route-policy.js';
import { registerRequestLatencyDiagnostics } from './request-latency.js';
import {
  declaredNonOperatorKeys,
  missingLockoutKeys,
  nonOperatorRequestKey,
} from './route-scopes.js';
import {
  createServerLifecycle,
  type ServerContext,
  type ServerLifecycle,
} from './server-context.js';
import type { ServerDeps } from './server-deps.js';
import { BINARY_UPLOAD_ROUTES, DEFAULT_BODY_LIMIT_BYTES, WS_LIVE_PATH } from './server-support.js';
import { isWebAppRequest } from './web-app.js';
import { RepositoryHasNoCommitsError } from './worktree.js';

/**
 * The Fastify instance with what must exist before any route: logging, the body
 * limit, the lifecycle registry, the pre-auth exemption set derived from route
 * registrations, the rate-limit and compression plugins, and the upload body
 * parser. `preAuthKeys` feeds the auth gate that `installHttpGuards` adds.
 */
export function createServerApp(deps: ServerDeps): {
  app: FastifyInstance;
  lifecycle: ServerLifecycle;
  preAuthKeys: ReadonlySet<string>;
} {
  // What a route gets when it declares no `bodyLimit` of its own: enough for the
  // metadata-shaped JSON that is all every route here takes, and nothing like
  // enough for a base64 upload.
  //
  // This used to be sized from the two upload caps, so it was ~71 MB for every
  // route in the server. Bulk is now declared where it is needed — see
  // TURN_BODY_LIMIT_BYTES and MEETING_TRANSCRIPT_BODY_LIMIT_BYTES, alongside the
  // limits the knowledge source routes already declare above this default and
  // the far tighter ones the pairing and secret routes set below it. What that
  // removes is not a leak but a ceiling: a buffered base64 body costs about
  // three times its own size at once (the body, the string `JSON.parse` produces
  // from it, the Buffer the handler decodes back), so a global 71 MB meant any
  // route at all could be made to cost ~237 MB of peak memory.
  //
  // Raising this back to cover some new large-body route is the mistake to avoid:
  // it would restore that ceiling everywhere to serve one endpoint. Give the
  // route its own limit instead. Routes streaming to disk need neither — the
  // `application/octet-stream` parser below hands them the raw stream and no body
  // limit applies.
  const bodyLimit = DEFAULT_BODY_LIMIT_BYTES;
  const loggerOption: NonNullable<FastifyServerOptions['logger']> = deps.logger
    ? {
        serializers: {
          req: serializeServerRequest,
        },
      }
    : false;
  const app: FastifyInstance =
    deps.https === undefined
      ? Fastify({ logger: loggerOption, bodyLimit })
      : Fastify({
          logger: loggerOption,
          bodyLimit,
          https: deps.https,
        } satisfies FastifyHttpsOptions<HttpsServer>);
  if (deps.logger) registerRequestLatencyDiagnostics(app);
  app.decorateRequest('localUserId', null);
  const lifecycle = createServerLifecycle(app);
  // Derives the auth gate's pre-auth exception set from the routes this instance
  // actually registers; the gate that consumes it is far below, next to the rest
  // of the auth logic. It is attached HERE, in the same statement group as the
  // instance itself, because `onRoute` is not retroactive — unlike `onRequest` it
  // sees only routes registered after it. Adjacent to the constructor there is no
  // "before" to get wrong: no route can exist yet. Anywhere else and a future
  // route hoisted above it would silently lose its exemption and 401.
  // `preAuthKeys` holds `"METHOD /pathname"`, so a sibling method on an exempt
  // pathname is not exempt. See route-scopes.ts.
  const preAuthKeys = new Set<string>();
  app.addHook('onRoute', (route) => {
    for (const key of declaredNonOperatorKeys(route)) preAuthKeys.add(key);
  });
  // Defence in depth for the routes whose loss locks the operator out entirely
  // rather than breaking a feature: refuse to come up instead of 401-ing the
  // on-ramp that mints the operator bearer. See LOCKOUT_CRITICAL_KEYS.
  app.addHook('onReady', (done) => {
    const missing = missingLockoutKeys(preAuthKeys);
    done(
      missing.length === 0
        ? undefined
        : new Error(
            `verity: pre-auth exemption missing for ${missing.join(', ')} — the onRoute hook that derives them must precede every route registration`,
          ),
    );
  });
  // Install the limiter's manual API. The auth hook below invokes it only after
  // a protected request has failed bearer-token verification.
  app.register(rateLimitPlugin, { global: false });
  // Opt in only large history reads: global compression would also transform
  // credential responses and opaque brokered HTTP payloads.
  app.register(compressPlugin, {
    global: false,
    globalDecompression: false,
    encodings: ['gzip', 'deflate'],
  });

  // Session file uploads are streamed directly to disk. Returning the raw request
  // stream from this parser intentionally avoids Fastify's buffered body limit.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });
  // …but the mobile app cannot guarantee that header. Its upload body is a
  // file-backed Blob, and expo/fetch overwrites our explicit
  // `application/octet-stream` with the picked file's own MIME type, so a PDF
  // arrives as `application/pdf` and used to die on Fastify's 415 before the
  // route ever ran. Declare the media type these routes actually receive instead
  // of trying to match it: they stream whatever bytes they are given straight to
  // disk and read the real type from the file name or an explicit parameter, so
  // the header carries no information for them.
  //
  // A catch-all `'*'` parser would not be enough. Fastify seeds `application/json`
  // and `text/plain` parsers that win over it by exact match, so a picked .json or
  // .txt file would still be buffered and parsed into an object or string, and the
  // handler's `pipeline(request.body, …)` would fail on a body that is no longer a
  // stream. Rewriting the header sidesteps parser precedence entirely and leaves
  // every other route on Fastify's own 415 for a body it cannot parse.
  //
  // `onRequest` runs after routing and before parsing, so both the matched route
  // and the header are available here. A request with no content-type is left
  // alone so Fastify keeps short-circuiting an empty body to the handler.
  app.addHook('onRequest', (request, _reply, done) => {
    if (
      request.headers['content-type'] !== undefined &&
      BINARY_UPLOAD_ROUTES.has(request.routeOptions.url ?? '')
    ) {
      request.headers['content-type'] = 'application/octet-stream';
    }
    done();
  });
  return { app, lifecycle, preAuthKeys };
}

/**
 * The error boundary, the global auth gate with its invalid-bearer limit, and
 * the per-response device activity and connection diagnostics.
 */
export function installHttpGuards(
  app: FastifyInstance,
  ctx: ServerContext,
  { preAuthKeys }: { preAuthKeys: ReadonlySet<string> },
): void {
  const { deps, lifecycle } = ctx;
  let checkInvalidBearer: ReturnType<FastifyInstance['createRateLimit']> | undefined;

  // Single error boundary: never reflect internal/driver/zod details to the
  // client. Invalid input → 400; everything else → a generic 500 (the real
  // error is logged server-side via Fastify's logger when enabled).
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      request.log.warn(
        {
          issues: error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path,
            message: issue.message,
          })),
          bodyType: typeof request.body,
          bodyConstructor:
            request.body !== null && request.body !== undefined
              ? request.body.constructor?.name
              : null,
        },
        'verity: invalid request',
      );
      reply.code(400);
      return { error: 'invalid request' };
    }
    // A sealed secret store surfaces as a clean 503 (not a 500): the operation
    // touched a secret while no key is loaded. Clients (mobile onboarding) read
    // this to prompt for the master password via /secret/unlock.
    if (error instanceof SealedError) {
      reply.code(503);
      return { error: 'secret store is sealed', status: 'sealed' as const };
    }
    if (error instanceof RepositoryHasNoCommitsError) {
      request.log.warn(error, 'verity: session base repository is empty');
      reply.code(409);
      return { error: error.message };
    }
    // Fastify's own client errors carry a 4xx statusCode (415 unsupported media
    // type, 413 payload too large, malformed-JSON 400, …). Surface the code —
    // it's a client mistake they can fix — but with a generic message so no
    // internal detail leaks. 5xx and uncoded errors fall through to a 500.
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const clientError = error as Error;
      request.log.warn(
        {
          status,
          errorType: clientError.constructor?.name,
          message: clientError.message,
          bodyType: typeof request.body,
          bodyConstructor:
            request.body !== null && request.body !== undefined
              ? request.body.constructor?.name
              : null,
        },
        'verity: invalid client request',
      );
      reply.code(status);
      return { error: 'invalid request' };
    }
    request.log.error(error);
    reply.code(500);
    return { error: 'internal error' };
  });

  // ── Global auth gate (audit finding C1) ───────────────────────────────────
  // Every route requires a valid per-device bearer token EXCEPT the routes
  // declared in `NON_OPERATOR_ROUTES` — the health probe, the master-password
  // lifecycle (the on-ramp that mints the token), the onboarding status probe,
  // the GitHub manifest URLs GitHub's browser must reach, the webhook, and the
  // sandbox-facing `/internal/*` brokers. Registering the check as a global
  // `onRequest` hook — rather than per route — means a newly added route is
  // protected by default; you must consciously declare it to expose it.
  //
  // The gate only enforces once a master password is configured (registry
  // enabled). Env-key/headless deployments have no interactive credential and
  // keep the previous open behaviour, relying on network isolation.
  //
  // The exception set used to be written out here as a second, conditional list
  // that had to stay in step with the equally conditional route registrations.
  // It is now `preAuthKeys`, derived from the routes this instance actually
  // registers by the `onRoute` hook attached next to the Fastify constructor
  // above — see there for why it cannot live at this point in the file.
  app.addHook('onRequest', async (request, reply) => {
    // Match on the concrete pathname (query stripped) plus the request method; no
    // pre-auth route carries a path param, so an exact-set lookup is sufficient
    // and avoids depending on Fastify's route-pattern internals. That is no longer
    // an assumption a reader has to hold: the `onRoute` hook above refuses to
    // register a declared exception whose url has a param or wildcard.
    const pathname = request.url.split('?', 1)[0] ?? request.url;
    // Network-origin gate for `/internal/*` (audit H1 follow-up), enforced BEFORE
    // and independent of the auth gate: when an internal listener is wired, these
    // routes are reachable only on that non-published socket. On the public/LAN
    // port the guard fails, so they 404 as if they don't exist here — the broker
    // is thus off the LAN entirely, on top of its own broker-token check.
    if (
      deps.internalPathGuard !== undefined &&
      pathname.startsWith('/internal/') &&
      !deps.internalPathGuard(request)
    ) {
      // send()+return so the request lifecycle STOPS here — a bare `return payload`
      // from an async onRequest hook does not reliably short-circuit the handler.
      return reply.code(404).send({ error: 'not found' });
    }
    const registry = deps.authRegistry;
    if (deps.webAppDir !== undefined && isWebAppRequest(request)) return;
    if (
      cookieCredential(request) !== undefined &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !browserOriginAllowed(request, deps.browserRequestOrigin?.(request))
    ) {
      return reply.code(403).send({ error: 'invalid origin' });
    }
    if (registry === undefined || !registry.isEnabled()) return;
    if (preAuthKeys.has(nonOperatorRequestKey(request.method, pathname, request.routeOptions.url)))
      return;
    const websocketStream =
      (request.headers.upgrade ?? '').toLowerCase() === 'websocket' && WS_LIVE_PATH.test(pathname);
    const cookieToken = cookieCredential(request);
    if (cookieToken !== undefined && !registry.isBrowserToken(cookieToken)) {
      if (websocketStream) return;
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const token = requestCredential(request);
    if (registry.verify(token)) {
      if (cookieToken !== undefined && token === cookieToken) setBrowserSession(reply, cookieToken);
      const userId = registry.resolveUserId(token);
      if (userId === undefined) return reply.code(401).send({ error: 'unauthorized' });
      request.localUserId = userId;
      const access = await measureLatencyPhase('request_authorization', () =>
        authorizePairedRoute(
          deps.eventStore,
          userId,
          request.method,
          request.routeOptions.url ?? pathname,
          (request.params ?? {}) as Record<string, unknown>,
        ),
      );
      if (access === 'not_found') return reply.code(404).send({ error: 'not found' });
      if (access === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      return;
    }
    // A genuine WebSocket upgrade to the live route cannot take a normal HTTP
    // 401 from here — reply.send() on an in-flight `@fastify/websocket` handshake
    // does not abort it cleanly (it hangs). That ONE route's handler enforces the
    // same token check itself (1008 close; see GET /live), so let it
    // through. Scoped to the actual WS path AND a real upgrade so a spoofed
    // `Upgrade: websocket` header on any other route still gets the 401 below.
    if (websocketStream) {
      return;
    }
    checkInvalidBearer ??= app.createRateLimit({ max: 100, timeWindow: '1 minute' });
    const limit = await checkInvalidBearer(request);
    if (!limit.isAllowed && limit.isExceeded) {
      reply.header('retry-after', String(limit.ttlInSeconds));
      return reply.code(429).send({ error: 'too many unauthorized requests' });
    }
    // send()+return — a bare `return { error }` from an async onRequest hook is
    // DISCARDED by Fastify (the route handler still runs and its body is sent with
    // this 401 status, a full auth bypass). Only reply.send() sets reply.sent and
    // actually short-circuits the lifecycle. See the /internal guard above.
    return reply.code(401).send({ error: 'unauthorized' });
  });

  lifecycle.onClose(() => {
    deps.authRegistry?.dispose?.();
  });

  // Record activity after the response, outside the authorization hook. `touch`
  // resolves the bearer token through the registry and ignores unknown values;
  // its per-device throttle keeps this universal lifecycle hook to at most one
  // database write every five minutes for each paired device.
  app.addHook('onResponse', (request, _reply, done) => {
    deps.authRegistry?.touch(requestCredential(request));
    done();
  });

  // A ticket request can fail before its handler runs; record only the route
  // pattern and status so bearer tokens and single-use tickets never enter logs.
  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url;
    if (route === '/live/ticket' || route === '/api/remote-control/descriptor') {
      request.log.info(
        {
          stage: route === '/live/ticket' ? 'live_ticket' : 'descriptor',
          statusCode: reply.statusCode,
          elapsedMs: reply.elapsedTime,
        },
        'mobile connection diagnostic request completed',
      );
    }
    done();
  });
}
