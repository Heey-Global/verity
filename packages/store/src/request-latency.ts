import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { PostgresPool } from 'kysely';

export type LatencyPhase =
  | 'request_authorization'
  | 'pool_generation_verify'
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
  | 'project_release_refresh'
  | 'project_release_persist'
  | 'project_settings'
  | 'project_control'
  | 'project_sandbox_updates';

interface Timing {
  calls: number;
  totalMs: number;
  maxMs: number;
}

export interface RequestLatencyTrace {
  owner?: string;
  phases: Partial<Record<LatencyPhase, Timing>>;
  poolAcquire: Timing & {
    errors: number;
    waitingMax: number;
    totalMax: number;
    holders?: PoolHolder[];
    holderSampleWaitMs?: number;
  };
  queries: Timing & { errors: number };
}

export interface PoolHolder {
  owner: string;
  heldMs: number;
  phase?: LatencyPhase;
  backendPid?: number;
}

// Stack frames contain code locations, never query text or error messages.
function backgroundOwner(): string {
  const previousLimit = Error.stackTraceLimit;
  let frames: string[];
  try {
    // Resolve synchronously, then restore before other work can run. The default
    // ten frames can end inside Kysely before reaching an async job's caller.
    Error.stackTraceLimit = 40;
    frames = new Error().stack?.split('\n').slice(1) ?? [];
  } finally {
    Error.stackTraceLimit = previousLimit;
  }
  const locations = frames
    .filter(
      (line) =>
        !/request-latency\.[cm]?[jt]s:/.test(line) &&
        !line.includes('node:') &&
        !line.includes('node_modules/'),
    )
    .map((line) => line.match(/([^/\\\s()]+\.[cm]?[jt]s:\d+:\d+)/)?.[1])
    .filter((location): location is string => location !== undefined)
    .slice(0, 6);
  return `background:${locations.join(' > ') || 'unknown'}`;
}

const context = new AsyncLocalStorage<RequestLatencyTrace>();
const phaseContext = new AsyncLocalStorage<LatencyPhase>();

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
    return await phaseContext.run(phase, action);
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
  const holders = new Map<
    object,
    { owner: string; started: number; phase?: LatencyPhase; backendPid?: number }
  >();
  return {
    ...(pool.Client === undefined ? {} : { Client: pool.Client }),
    options: pool.options,
    end: () => pool.end(),
    async connect() {
      const trace = context.getStore();
      const started = performance.now();
      const owner = trace?.owner ?? backgroundOwner();
      const phase = phaseContext.getStore();
      const capture = () => {
        if (!trace || trace.poolAcquire.holders) return;
        const now = performance.now();
        trace.poolAcquire.holderSampleWaitMs = now - started;
        trace.poolAcquire.holders = [...holders.values()]
          .sort((a, b) => a.started - b.started)
          .slice(0, 10)
          .map(({ started: heldSince, ...holder }) => ({ ...holder, heldMs: now - heldSince }));
      };
      // Capture while still queued: after checkout the blocking holders may be gone.
      const timer = trace ? setTimeout(capture, 1_000) : undefined;
      timer?.unref();
      try {
        // connect() enqueues synchronously; sampling afterwards captures this waiter.
        const pending = pool.connect();
        if (trace) {
          const counts = snapshot();
          trace.poolAcquire.waitingMax = Math.max(trace.poolAcquire.waitingMax, counts.waiting);
          trace.poolAcquire.totalMax = Math.max(trace.poolAcquire.totalMax, counts.total);
        }
        const client = await pending;
        if (performance.now() - started >= 1_000) capture();
        const backendPid =
          'processID' in client &&
          typeof client.processID === 'number' &&
          Number.isInteger(client.processID)
            ? client.processID
            : undefined;
        const holder = {
          owner,
          started: performance.now(),
          ...(phase === undefined ? {} : { phase }),
          ...(backendPid === undefined ? {} : { backendPid }),
        };
        holders.set(client, holder);
        // pg installs a fresh release function on every checkout. Keep the real
        // client (including cursor support), and forward its exact release arguments.
        // Restore the exact method on release; invoke it with its client below.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const release = client.release;
        client.release = (...args: Parameters<typeof release>) => {
          if (holders.get(client) === holder) {
            holders.delete(client);
            client.release = release;
          }
          return release.apply(client, args);
        };
        return client;
      } catch (error) {
        if (trace) trace.poolAcquire.errors += 1;
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        if (trace) addTiming(trace.poolAcquire, performance.now() - started);
      }
    },
  };
}
