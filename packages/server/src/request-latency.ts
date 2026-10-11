import {
  switchRequestDiagnostic,
  createSwitchDiagnosticBudget,
} from './switch-request-diagnostic.js';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  createRequestLatencyTrace,
  withRequestLatencyTrace,
  type RequestLatencyTrace,
} from '@verity/store';
import { createLatencyCpuProfiler } from './latency-cpu-profile.js';

const PROBE_INTERVAL_MS = 100;
const SLOW_REQUEST_MS = 3_000;
const TRACKED_ROUTES = new Set([
  '/projects',
  '/sessions',
  '/sessions/:id',
  '/sessions/:id/events',
  '/sessions/:id/activity',
  '/sessions/:id/links',
  '/sessions/:id/branches',
  '/sessions/:id/dev-servers',
  '/projects/:id/public-shares',
  '/projects/:id/dev-servers',
  '/server/updates',
  '/provider-limits',
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

/** Slow reads log bounded measurements and route patterns, never raw URLs or SQL. */
export function registerRequestLatencyDiagnostics(app: FastifyInstance): void {
  const admitSwitchDiagnostic = createSwitchDiagnosticBudget();
  const probes = new Map<FastifyRequest, Probe>();
  const switchRequests = new WeakMap<
    FastifyRequest,
    { started: number; diagnosticRequestId: string; kind: string }
  >();
  const finishSwitch = (request: FastifyRequest, outcome: string, statusCode?: number): void => {
    const trace = switchRequests.get(request);
    if (!trace) return;
    switchRequests.delete(request);
    request.log.info(
      {
        diagnosticRequestId: trace.diagnosticRequestId,
        kind: trace.kind,
        completedAt: Date.now(),
        elapsedMs: performance.now() - trace.started,
        outcome,
        ...(statusCode === undefined ? {} : { statusCode }),
      },
      'session switch handler completed',
    );
  };
  const cpuProfiler = createLatencyCpuProfiler({
    directory: process.env.VERITY_LATENCY_CPU_PROFILE_DIR,
    log: (event) => app.log.warn(event, 'backend latency CPU profile'),
  });
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
    cpuProfiler.trigger(probe.eventLoopDelayMaxMs);
    return probe;
  }

  app.addHook('onRequest', (request, reply, done) => {
    const diagnostic = switchRequestDiagnostic(request.method, request.url, request.headers);
    if (diagnostic && admitSwitchDiagnostic()) {
      switchRequests.set(request, { ...diagnostic, started: performance.now() });
      request.log = request.log.child(diagnostic);
      request.log.info({ receivedAt: Date.now() }, 'session switch handler received');
    }
    const trace = createRequestLatencyTrace();
    trace.owner = `${request.method} ${request.routeOptions.url ?? 'unmatched'} (${request.id})`;
    if (
      request.method !== 'GET' ||
      !TRACKED_ROUTES.has((request.routeOptions.url ?? '').replace(/:[^/]+/g, ':id'))
    ) {
      return withRequestLatencyTrace(trace, done);
    }
    const started = performance.now();
    const probe: Probe = {
      trace,
      started,
      nextTick: started + PROBE_INTERVAL_MS,
      eventLoopDelayMaxMs: 0,
      eventLoopStart: performance.eventLoopUtilization(),
      timer: setInterval(() => {
        const now = performance.now();
        probe.eventLoopDelayMaxMs = Math.max(probe.eventLoopDelayMaxMs, now - probe.nextTick);
        cpuProfiler.trigger(now - probe.nextTick);
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
    finishSwitch(request, 'finished', reply.statusCode);
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
    finishSwitch(request, 'aborted');
    finish(request);
    done();
  });
  app.addHook('onTimeout', (request, _reply, done) => {
    finishSwitch(request, 'timeout');
    finish(request);
    done();
  });
  app.addHook('onClose', async () => {
    for (const request of probes.keys()) finish(request);
    await cpuProfiler.close();
  });
}
