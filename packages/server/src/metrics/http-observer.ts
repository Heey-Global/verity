import type { FastifyInstance, FastifyRequest } from 'fastify';
import { clientLabel, identifyClient } from './client-identity.js';
import { createCause, runInCause, type ExternalCause } from './external-calls.js';
import type { MonitoringControl } from './monitoring-control.js';
import type { ServerMetrics } from './server-metrics.js';

const REQUEST_ID_HEADER = 'x-request-id';
const UNMATCHED_ROUTE = '(unmatched)';

interface PendingRequest {
  startedAt: bigint;
  bytesOut: number;
  external?: ExternalCause;
}

type Writer = (this: unknown, ...args: unknown[]) => unknown;

function chunkBytes(chunk: unknown, encoding: unknown): number {
  if (typeof chunk === 'string')
    return Buffer.byteLength(
      chunk,
      typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8',
    );
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

function sessionIdOf(request: FastifyRequest, route: string): string | null {
  if (!route.startsWith('/sessions/:id')) return null;
  const id = (request.params as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' && id.length <= 200 ? id : null;
}

/**
 * Counts every HTTP request by route template, client and status class, with
 * the response body bytes as they are written to the socket — after
 * compression, so the count is what actually crosses the network.
 *
 * Each response carries its request ID so one request can be followed from the
 * app to the server log. The WebSocket upgrade is counted by the live
 * connection instead.
 */
export function observeHttp(
  app: FastifyInstance,
  metrics: ServerMetrics,
  control: MonitoringControl,
): void {
  const pending = new WeakMap<FastifyRequest, PendingRequest>();
  app.addHook('onRequest', (request, reply, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    if (!control.measuring || request.headers.upgrade?.toLowerCase() === 'websocket') {
      done();
      return;
    }
    const state: PendingRequest = { startedAt: process.hrtime.bigint(), bytesOut: 0 };
    pending.set(request, state);
    const raw = reply.raw as unknown as { write: Writer; end: Writer };
    const write = raw.write;
    const end = raw.end;
    // Some responses implement `end(chunk)` by calling `write(chunk)`; count the
    // chunk where it enters, once.
    let ending = false;
    raw.write = function (this: unknown, ...args: unknown[]) {
      if (!ending) state.bytesOut += chunkBytes(args[0], args[1]);
      return write.apply(this, args);
    };
    raw.end = function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] !== 'function') state.bytesOut += chunkBytes(args[0], args[1]);
      ending = true;
      try {
        return end.apply(this, args);
      } finally {
        ending = false;
      }
    };
    // Outbound calls made while handling this request name its route as cause.
    const external = createCause(
      `${request.method} ${request.routeOptions.url ?? UNMATCHED_ROUTE}`,
    );
    state.external = external;
    runInCause(external, done);
  });
  app.addHook('onResponse', (request, reply, done) => {
    const state = pending.get(request);
    if (state === undefined || !control.measuring) {
      done();
      return;
    }
    pending.delete(request);
    const route = request.routeOptions.url ?? UNMATCHED_ROUTE;
    const length = Number(request.headers['content-length']);
    metrics.recordHttp(
      {
        method: request.method,
        route,
        // The version is the caller's own text. A rejected request keeps only
        // the client kind, so unauthenticated callers cannot fill the series
        // cap with invented versions and push real traffic into the overflow.
        client:
          reply.statusCode < 400
            ? clientLabel(identifyClient(request.headers))
            : identifyClient(request.headers).kind,
        status: reply.statusCode,
        durationMs: Number(process.hrtime.bigint() - state.startedAt) / 1e6,
        bytesIn: Number.isFinite(length) && length > 0 ? length : 0,
        bytesOut: state.bytesOut,
        // Only a session the server served: a rejected or unknown ID is the
        // caller's text, not a session, and must not fill the session list.
        sessionId: reply.statusCode < 400 ? sessionIdOf(request, route) : null,
        requestId: request.id,
        external: state.external,
      },
      control.detailActive,
    );
    done();
  });
}
