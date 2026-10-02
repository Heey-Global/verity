import { performance } from 'node:perf_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  createRequestLatencyTrace,
  withRequestLatencyTrace,
  type RequestLatencyTrace,
} from '@verity/store';

const PROBE_INTERVAL_MS = 100;
const SLOW_REQUEST_MS = 3_000;
const TRACKED_ROUTES = new Set([
  '/projects',
  '/sessions',
  '/sessions/:id',
  '/sessions/:id/activity',
  '/sessions/:id/links',
  '/sessions/:id/branches',
  '/sessions/:id/dev-servers',
  '/projects/:id/public-shares',
]);

interface Probe {
  trace: RequestLatencyTrace;
  started: number;
  nextTick: number;
  eventLoopDelayMaxMs: number;
  eventLoopStart: ReturnType<typeof performance.eventLoopUtilization>;
  beforeHandlerMs?: number;
  timer: ReturnType<typeof setInterval>;
}

/** Slow reads log bounded numeric measurements, never IDs, URLs, SQL or parameters. */
export function registerRequestLatencyDiagnostics(app: FastifyInstance): void {
  const probes = new Map<FastifyRequest, Probe>();
  function finish(request: FastifyRequest): Probe | undefined {
    const probe = probes.get(request);
    if (!probe) return;
    clearInterval(probe.timer);
    probes.delete(request);
    // A handler can block through response completion before the timer runs.
    probe.eventLoopDelayMaxMs = Math.max(
      probe.eventLoopDelayMaxMs,
      performance.now() - probe.nextTick,
    );
    return probe;
  }

  app.addHook('onRequest', (request, reply, done) => {
    if (
      request.method !== 'GET' ||
      !TRACKED_ROUTES.has((request.routeOptions.url ?? '').replace(/:[^/]+/g, ':id'))
    ) {
      return done();
    }
    const started = performance.now();
    const trace = createRequestLatencyTrace();
    const probe: Probe = {
      trace,
      started,
      nextTick: started + PROBE_INTERVAL_MS,
      eventLoopDelayMaxMs: 0,
      eventLoopStart: performance.eventLoopUtilization(),
      timer: setInterval(() => {
        const now = performance.now();
        probe.eventLoopDelayMaxMs = Math.max(probe.eventLoopDelayMaxMs, now - probe.nextTick);
        probe.nextTick = now + PROBE_INTERVAL_MS;
      }, PROBE_INTERVAL_MS),
    };
    probe.timer.unref();
    probes.set(request, probe);
    // GET bodies may already be consumed, so onRequestAbort alone misses a
    // disconnected client whose handler is still waiting on an upstream service.
    reply.raw.once('close', () => {
      finish(request);
    });
    withRequestLatencyTrace(trace, done);
  });
  app.addHook('preHandler', (request, _reply, done) => {
    const probe = probes.get(request);
    if (probe) probe.beforeHandlerMs = performance.now() - probe.started;
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    const probe = finish(request);
    if (probe && reply.elapsedTime >= SLOW_REQUEST_MS) {
      request.log.warn(
        {
          route: request.routeOptions.url ?? 'unmatched',
          statusCode: reply.statusCode,
          elapsedMs: reply.elapsedTime,
          beforeHandlerMs: probe.beforeHandlerMs,
          eventLoopDelayMaxMs: probe.eventLoopDelayMaxMs,
          // Process-wide while this request was open; overlapping requests share activity.
          eventLoopUtilization: performance.eventLoopUtilization(probe.eventLoopStart).utilization,
          ...probe.trace,
        },
        'slow backend read diagnostic',
      );
    }
    done();
  });
  app.addHook('onRequestAbort', (request, done) => {
    finish(request);
    done();
  });
  app.addHook('onTimeout', (request, _reply, done) => {
    finish(request);
    done();
  });
  app.addHook('onClose', (_instance, done) => {
    for (const request of probes.keys()) finish(request);
    done();
  });
}
