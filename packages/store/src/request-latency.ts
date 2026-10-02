import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { PostgresPool } from 'kysely';

export type LatencyPhase =
  | 'session_list'
  | 'session_projection'
  | 'session_links'
  | 'session_summaries'
  | 'session_attention'
  | 'project_list'
  | 'project_permissions'
  | 'project_overview'
  | 'project_toolkit'
  | 'project_releases'
  | 'project_sandbox_updates';

interface Timing {
  calls: number;
  totalMs: number;
  maxMs: number;
}

export interface RequestLatencyTrace {
  phases: Partial<Record<LatencyPhase, Timing>>;
  poolAcquire: Timing & { errors: number; waitingMax: number; totalMax: number };
  queries: Timing & { errors: number };
}

const context = new AsyncLocalStorage<RequestLatencyTrace>();

export function createRequestLatencyTrace(): RequestLatencyTrace {
  return {
    phases: {},
    poolAcquire: { calls: 0, totalMs: 0, maxMs: 0, errors: 0, waitingMax: 0, totalMax: 0 },
    queries: { calls: 0, totalMs: 0, maxMs: 0, errors: 0 },
  };
}

export function withRequestLatencyTrace<T>(trace: RequestLatencyTrace, action: () => T): T {
  return context.run(trace, action);
}

function addTiming(timing: Timing, elapsedMs: number): void {
  timing.calls += 1;
  timing.totalMs += elapsedMs;
  timing.maxMs = Math.max(timing.maxMs, elapsedMs);
}

/** Timings overlap during fan-out; their totals are not a request's wall time. */
export async function measureLatencyPhase<T>(
  phase: LatencyPhase,
  action: () => Promise<T>,
): Promise<T> {
  const trace = context.getStore();
  if (!trace) return action();
  const started = performance.now();
  try {
    return await action();
  } finally {
    const timing = (trace.phases[phase] ??= { calls: 0, totalMs: 0, maxMs: 0 });
    addTiming(timing, performance.now() - started);
  }
}

/** Kysely measures execution after checkout, so this excludes pool acquisition. */
export function recordRequestQuery(durationMs: number, failed: boolean): void {
  const trace = context.getStore();
  if (!trace) return;
  addTiming(trace.queries, durationMs);
  if (failed) trace.queries.errors += 1;
}

/** Preserve the actual clients and pool lifecycle; only time checkout. */
export function instrumentPostgresPool(
  pool: PostgresPool,
  snapshot: () => { waiting: number; total: number },
): PostgresPool {
  return {
    ...(pool.Client === undefined ? {} : { Client: pool.Client }),
    options: pool.options,
    end: () => pool.end(),
    async connect() {
      const trace = context.getStore();
      if (!trace) return pool.connect();
      const started = performance.now();
      // connect() enqueues synchronously; sampling afterwards captures this waiter.
      const pending = pool.connect();
      const counts = snapshot();
      trace.poolAcquire.waitingMax = Math.max(trace.poolAcquire.waitingMax, counts.waiting);
      trace.poolAcquire.totalMax = Math.max(trace.poolAcquire.totalMax, counts.total);
      try {
        return await pending;
      } catch (error) {
        trace.poolAcquire.errors += 1;
        throw error;
      } finally {
        addTiming(trace.poolAcquire, performance.now() - started);
      }
    },
  };
}
