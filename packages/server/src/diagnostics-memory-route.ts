import { getHeapStatistics } from 'node:v8';
import type { FastifyInstance } from 'fastify';

/**
 * One sample of the server process's memory, in bytes.
 *
 * The split between `heapUsed` and `external`/`arrayBuffers` is the point of
 * this route rather than an incidental detail: they answer different questions.
 * JS objects — parsed event payloads, projection slices, cached PR summaries —
 * land in `heapUsed`. `Buffer`s do not: a buffered request body or a file read
 * whole into memory shows up in `external`, with its backing store counted again
 * under `arrayBuffers`. A process that is heavy in `heapUsed` and a process that
 * is heavy in `external` have different causes and different fixes, and `rss`
 * alone cannot tell them apart.
 *
 * `heapLimit` is what V8 will let `heapUsed` reach before it aborts. Node sizes
 * it from the cgroup when no `--max-old-space-size` is given, so it is also how
 * you check that the process actually saw the container's limit rather than the
 * host's memory.
 */
export interface MemoryDiagnostics {
  /** Process age in fractional seconds, so two samples can be compared without the
   *  caller clock-watching. Deliberately not rounded: a consumer deriving a rate
   *  from two closely-spaced samples would otherwise divide by a zero delta. */
  uptimeSeconds: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  heapLimitBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

/**
 * Registers the operator-only memory probe.
 *
 * Deliberately NOT a field on `/healthz`. That route is declared `public` in
 * `route-scopes.ts` on the stated grounds that it returns no operator data, and
 * it is reachable from wherever the deployment is reachable — a liveness probe
 * that also reports how close the process is to its heap limit hands an
 * unauthenticated caller the timing signal for a memory-exhaustion attempt. This
 * route is not listed in `NON_OPERATOR_ROUTES`, so the default-deny gate in
 * `buildServer` requires the operator bearer, which is the whole of what keeps
 * the two apart. Absence from that list is the entire mechanism — the gate is an
 * un-encapsulated `app.addHook`, so it covers this route wherever in `buildServer`
 * the registration sits, and moving the call earlier does not open it.
 *
 * It samples on request and keeps no history: distinguishing a leak from a high
 * baseline is a question about the shape of a series, and the series belongs to
 * whatever polls this — a process that accumulated its own would be spending
 * memory to measure memory.
 */
export function registerDiagnosticsMemoryRoute(app: FastifyInstance): void {
  app.get('/diagnostics/memory', (_request, reply): MemoryDiagnostics => {
    // The response is a point-in-time sample and nothing else. An intermediary
    // that cached one would keep serving numbers that look current and are not —
    // wrong in the one way this route has no defence against, since a stale
    // sample is indistinguishable from a process that simply stopped moving.
    void reply.header('cache-control', 'no-store');
    const usage = process.memoryUsage();
    const heap = getHeapStatistics();
    return {
      uptimeSeconds: process.uptime(),
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      heapTotalBytes: usage.heapTotal,
      heapLimitBytes: heap.heap_size_limit,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers,
    };
  });
}
