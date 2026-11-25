import websocketPlugin, { type WebSocket } from '@fastify/websocket';
import { LIVE_TICKET_PROTOCOL_PREFIX } from '@verity/events';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import {
  browserOriginAllowed,
  cookieCredential,
  requestCredential,
  wsOriginAllowed,
} from './auth.js';
import { LiveHub } from './live/live-hub.js';
import { ResourceObserver } from './live/resource-observer.js';
import { subscribeAgentProcessLogging } from './agent-process-logging.js';
import { authorizePairedRoute } from './paired-route-policy.js';
import type { ServerContext, ServerLifecycle } from './server-context.js';
import type { ServerDeps } from './server-deps.js';
import type { TrafficLedger } from './traffic-ledger.js';

/**
 * One-time tickets that authorize opening the live WebSocket. A ticket is
 * minted over an authenticated request and consumed by the upgrade, which
 * cannot carry the device credential itself.
 */
export function createLiveTickets(deps: Pick<ServerDeps, 'authRegistry'>) {
  const liveTickets = new Map<
    string,
    { expiresAt: number; deviceId: string; userId: string; credential: string | undefined }
  >();
  const liveTicketTtlMs = 30_000;
  const mintLiveTicket = (
    deviceId: string,
    userId: string,
    credential?: string,
  ): { ticket: string; expiresAt: string } => {
    const now = Date.now();
    for (const [ticket, record] of liveTickets) {
      if (record.expiresAt <= now) liveTickets.delete(ticket);
    }
    while (liveTickets.size >= 1024) liveTickets.delete(liveTickets.keys().next().value!);
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = now + liveTicketTtlMs;
    liveTickets.set(ticket, { expiresAt, deviceId, userId, credential });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  };
  const consumeLiveTicket = (
    protocolHeader: string | undefined,
  ): { deviceId: string; userId: string; credential: string | undefined } | undefined => {
    const offered = (protocolHeader ?? '')
      .split(',')
      .map((value) => value.trim())
      .find((value) => value.startsWith(LIVE_TICKET_PROTOCOL_PREFIX));
    if (offered === undefined) return undefined;
    const ticket = offered.slice(LIVE_TICKET_PROTOCOL_PREFIX.length);
    const record = liveTickets.get(ticket);
    if (record === undefined) return undefined;
    liveTickets.delete(ticket);
    if (record.expiresAt <= Date.now() || !deps.authRegistry?.isKnownId?.(record.deviceId))
      return undefined;
    return { deviceId: record.deviceId, userId: record.userId, credential: record.credential };
  };
  const revokeDevice = (deviceId: string): void => {
    for (const [ticket, record] of liveTickets) {
      if (record.deviceId === deviceId) liveTickets.delete(ticket);
    }
  };
  return { mint: mintLiveTicket, consume: consumeLiveTicket, revokeDevice };
}

/**
 * The live hub that multiplexes session streams, overview hints and resource
 * watches over the app-wide WebSocket. Closed with the server.
 */
export function createServerLiveHub(
  app: FastifyInstance,
  deps: ServerDeps,
  {
    resources,
    lifecycle,
    trafficLedger,
  }: {
    resources: ResourceObserver;
    lifecycle: ServerLifecycle;
    trafficLedger?: TrafficLedger | undefined;
  },
): LiveHub {
  const liveHub = new LiveHub({
    ...(trafficLedger
      ? {
          onFrameSent: (kind: string, bytes: number) =>
            trafficLedger.record(`WS live ${kind}`, { bodyBytes: bytes }),
        }
      : {}),
    watchResource: (identity, resource, changed) =>
      resources.watch(
        identity.userId ?? '',
        resource,
        async (target) => {
          if (
            deps.authRegistry?.isEnabled() === true &&
            (!identity.credential || !deps.authRegistry.verify(identity.credential))
          )
            return { statusCode: 401, body: '' };
          const response = await app.inject({
            method: 'GET',
            url: target.path,
            headers: {
              ...(identity.credential ? { authorization: `Bearer ${identity.credential}` } : {}),
              ...(target.ownerToken ? { 'x-meeting-owner-token': target.ownerToken } : {}),
            },
          });
          return { statusCode: response.statusCode, body: response.body };
        },
        changed,
      ),
    bus: deps.bus,
    store: {
      getSession: async (sessionId) => {
        const session = await deps.eventStore.getSession(sessionId);
        return session === undefined
          ? undefined
          : { sessionId: session.sessionId, projectId: session.projectId };
      },
      getEventsAfter: (sessionId, afterSeq, limit) =>
        deps.eventStore.getEventsAfter(sessionId, afterSeq, limit),
    },
    access: {
      // Without the auth gate there is one operator and no identity to scope by.
      canReadSession: async (userId, session) =>
        userId === undefined ||
        (await authorizePairedRoute(deps.eventStore, userId, 'GET', '/sessions/:id', {
          id: session.sessionId,
        })) === 'allow',
      overviewScope: async (userId) => {
        if (userId === undefined) return { all: true };
        const [projectIds, administrator] = await Promise.all([
          deps.eventStore.listReadableProjectIds(userId),
          deps.eventStore.isActiveAdministrator(userId),
        ]);
        return { all: false, projectIds: new Set(projectIds), unassigned: administrator };
      },
      isActiveUser: (userId) => deps.eventStore.isActiveLocalUser(userId),
    },
    logger: app.log,
  });
  const unsubscribeSessionChanges = deps.sessionChanges?.subscribe((sessionId, change) => {
    liveHub.notify({
      sessionId,
      topics: change === 'name' ? ['session'] : ['activity', 'status'],
    });
  });
  lifecycle.onClose(() => {
    unsubscribeSessionChanges?.();
    liveHub.close();
  });
  return liveHub;
}

/** The app-wide live connection: the ticket route and the WebSocket upgrade. */
export function installLive(
  app: FastifyInstance,
  ctx: ServerContext,
  { tickets }: { tickets: ReturnType<typeof createLiveTickets> },
): void {
  const { deps, liveHub } = ctx;
  const { mint: mintLiveTicket, consume: consumeLiveTicket } = tickets;
  // The app-wide live connection: one WebSocket per paired device carrying the
  // multiplexed session streams, overview hints, foreground presence and
  // in-app alerts (`packages/server/src/live/live-hub.ts`).
  app.register(websocketPlugin);
  app.register((instance, _opts, done) => {
    instance.post('/live/ticket', async (request, reply) => {
      const registry = deps.authRegistry;
      if (registry === undefined || !registry.isEnabled()) {
        // Without the auth gate the socket needs no ticket; answer one anyway so
        // the client has a single connect path.
        return {
          ticket: randomBytes(32).toString('base64url'),
          expiresAt: new Date().toISOString(),
        };
      }
      const deviceId = registry.resolveId(requestCredential(request));
      if (deviceId === undefined || !request.localUserId) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      return mintLiveTicket(deviceId, request.localUserId, requestCredential(request));
    });

    instance.get('/live', { websocket: true }, (socket: WebSocket, request) => {
      if (
        cookieCredential(request) !== undefined &&
        !browserOriginAllowed(request, deps.browserRequestOrigin?.(request))
      ) {
        socket.close(1008, 'origin not allowed');
        return;
      }
      const browserCookie = cookieCredential(request);
      if (
        browserCookie !== undefined &&
        deps.authRegistry?.isBrowserToken(browserCookie) !== true
      ) {
        socket.close(1008, 'unauthorized');
        return;
      }
      // Defence-in-depth against cross-site WebSocket hijacking: when an Origin
      // allowlist is configured, a browser-supplied Origin must match it. A
      // native client sends no Origin and passes.
      if (!wsOriginAllowed(deps.wsAllowedOrigins, request.headers.origin)) {
        socket.close(1008, 'origin not allowed');
        return;
      }
      const registry = deps.authRegistry;
      if (registry?.isEnabled() !== true) {
        liveHub.attach(socket, {});
        return;
      }
      const identity = consumeLiveTicket(request.headers['sec-websocket-protocol']);
      if (identity === undefined) {
        socket.close(1008, 'unauthorized');
        return;
      }
      liveHub.attach(socket, identity);
    });
    done();
  });
}

/** Invalidate resource watches after accepted HTTP mutations. */
function registerLiveResourceHints(app: FastifyInstance, resources: ResourceObserver): void {
  app.addHook('onResponse', (request, reply, done) => {
    if (
      reply.statusCode < 400 &&
      request.routeOptions.url !== '/sessions/:id/debug/scroll' &&
      (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) ||
        request.url.startsWith('/github/app/manifest/callback') ||
        request.url.startsWith('/github/app/manifest/installed'))
    )
      resources.invalidate(
        request.method === 'PATCH' && request.routeOptions.url === '/sessions/:id'
          ? `${request.url.split('?')[0]}/activity`
          : request.url,
      );
    done();
  });
}

/** Publish overview hints for session mutations that have no bus event. */
export function registerLiveSessionHints(app: FastifyInstance, ctx: ServerContext): void {
  const { deps, liveHub } = ctx;
  const deletedSessionProjects = new WeakMap<object, string | null>();
  app.addHook('preHandler', async (request) => {
    if (request.method !== 'DELETE' || request.routeOptions.url !== '/sessions/:id') return;
    const { id } = request.params as { id: string };
    const session = await deps.eventStore.getSession(id);
    if (session !== undefined) deletedSessionProjects.set(request, session.projectId);
  });
  // Session changes that are not events — a rename, a read marker, a queued or
  // retracted turn, a permission decision, a deletion — reach overview
  // subscribers as content-free hints. Every such change is an accepted mutation
  // on a `/sessions/:id…` route, so one hook covers them all, including routes
  // added later; session events themselves are hinted from the bus.
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
      return payload;
    }
    const route = request.routeOptions.url ?? '';
    if (route === '/sessions' && request.method === 'POST' && typeof payload === 'string') {
      try {
        const created = JSON.parse(payload) as { sessionId?: unknown };
        if (typeof created.sessionId === 'string') {
          liveHub.notify({ sessionId: created.sessionId, topics: ['session', 'status'] });
        }
      } catch {
        // Not JSON: nothing to announce.
      }
      return payload;
    }
    if (!route.startsWith('/sessions/:id')) return payload;
    const sessionId = (request.params as { id?: unknown } | undefined)?.id;
    if (typeof sessionId !== 'string') return payload;
    const deleted = route === '/sessions/:id' && request.method === 'DELETE';
    // A session can change project (a move); forget its cached owner. A deleted
    // one keeps it, so its members still hear that it is gone.
    if (!deleted) liveHub.forgetSession(sessionId);
    if (route === '/sessions/:id/project') await liveHub.recheckSession(sessionId);
    liveHub.notify({
      sessionId,
      topics: ['session', 'status', 'activity'],
      ...(deleted ? { deleted: true, projectId: deletedSessionProjects.get(request) } : {}),
    });
    return payload;
  });
}

export function createLiveResources(
  app: FastifyInstance,
  deps: ServerDeps,
  lifecycle: ServerLifecycle,
): ResourceObserver {
  const resources = new ResourceObserver();
  lifecycle.onClose(() => resources.close());
  const unsubscribeAgentProcessLogging = subscribeAgentProcessLogging(
    deps.bus,
    deps.eventStore,
    app.log,
  );
  lifecycle.onClose(() => unsubscribeAgentProcessLogging());
  registerLiveResourceHints(app, resources);
  return resources;
}

export function registerLiveRevocation(
  ctx: ServerContext,
  liveTickets: ReturnType<typeof createLiveTickets>,
): void {
  const { deps, liveHub, lifecycle } = ctx;
  const detachStreamRevocation = deps.authRegistry?.onRevoke((deviceId) => {
    liveTickets.revokeDevice(deviceId);
    liveHub.revokeDevice(deviceId);
  });
  lifecycle.onClose(() => {
    detachStreamRevocation?.();
  });
}
