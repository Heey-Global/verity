import { createHash } from 'node:crypto';
import { LatencyHistogram } from './latency-histogram.js';
import type { MonitoringState } from './monitoring-control.js';
import type { ProcessResources } from './process-sampler.js';
import type { ExternalSeries, LiveSeries, ServerMetrics, SlowRequest } from './server-metrics.js';

const DIAGNOSTIC_REPORT_FORMAT = 'verity.diagnostic-report/1';
const TOP = 20;

/** What a report never contains; shown in the app before it is shared. */
const REPORT_EXCLUSIONS = [
  'messages',
  'transcripts',
  'file contents',
  'secrets and tokens',
  'request bodies',
  'query strings and full URLs',
  'project and session names',
] as const;

/** Areas of the observability plan that later versions add to the report. */
const NOT_YET_MEASURED = ['database', 'error_groups', 'cost', 'sandbox_lifecycle'] as const;

export interface ReportInput {
  metrics: ServerMetrics;
  monitoring: MonitoringState;
  resources: ProcessResources;
  server: { version: string; startedAt: Date };
  now: Date;
  /** `hashed` for anything that leaves the server; `raw` only for Verity Control. */
  sessionIds: 'hashed' | 'raw';
}

/**
 * Outbound calls per target, and the causes that make the most of them. A
 * duplicate is the same read repeated within two seconds.
 */
function externalCalls(metrics: ServerMetrics) {
  const byTarget = new Map<
    string,
    { target: string; calls: number; failed: number; duplicates: number; latency: LatencyHistogram }
  >();
  const byCause = new Map<
    string,
    {
      target: string;
      cause: string;
      method: string;
      calls: number;
      failed: number;
      duplicates: number;
      latency: LatencyHistogram;
    }
  >();
  for (const series of metrics.external.values() as Iterable<ExternalSeries>) {
    const target = byTarget.get(series.target) ?? {
      target: series.target,
      calls: 0,
      failed: 0,
      duplicates: 0,
      latency: new LatencyHistogram(),
    };
    const causeKey = `${series.target} ${series.cause} ${series.method}`;
    const cause = byCause.get(causeKey) ?? {
      target: series.target,
      cause: series.cause,
      method: series.method,
      calls: 0,
      failed: 0,
      duplicates: 0,
      latency: new LatencyHistogram(),
    };
    for (const entry of [target, cause]) {
      entry.calls += series.calls;
      entry.failed += series.failed;
      entry.duplicates += series.duplicates;
      entry.latency.merge(series.latency);
    }
    byTarget.set(series.target, target);
    byCause.set(causeKey, cause);
  }
  const summary = <T extends { latency: LatencyHistogram }>({ latency, ...rest }: T) => ({
    ...rest,
    p95Ms: rounded(latency.quantile(0.95)),
  });
  return {
    calls: [...byTarget.values()].reduce((total, entry) => total + entry.calls, 0),
    byTarget: [...byTarget.values()]
      .map((entry) => {
        const seen = metrics.rateLimits.get(entry.target as never);
        return { ...summary(entry), rateLimit: seen === undefined ? null : { ...seen } };
      })
      .sort((a, b) => b.calls - a.calls),
    topCauses: [...byCause.values()]
      .map(summary)
      .sort((a, b) => b.calls - a.calls)
      .slice(0, TOP),
  };
}

function rounded(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

export function hashIdentifier(id: string): string {
  return `sha256:${createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
}

/**
 * The diagnostic report (ADR 0032): one versioned JSON document built from the
 * in-memory counters. Route templates name endpoints without their parameters;
 * session identifiers are hashed unless the reader is Verity Control.
 */
export function buildDiagnosticReport(input: ReportInput) {
  const { metrics, monitoring, resources, server, now } = input;
  const series = [...metrics.http.values()];
  const overall = new LatencyHistogram();
  for (const entry of series) overall.merge(entry.latency);
  const requests = series.reduce((total, entry) => total + entry.requests, 0);
  const sumBy = (predicate: (statusClass: string) => boolean) =>
    series
      .filter((entry) => predicate(entry.statusClass))
      .reduce((total, entry) => total + entry.requests, 0);
  const serverErrors = sumBy((statusClass) => statusClass === '5xx');
  const clientErrors = sumBy((statusClass) => statusClass === '4xx');

  const byRoute = new Map<
    string,
    { method: string; route: string; requests: number; latency: LatencyHistogram }
  >();
  const byRouteClient = new Map<
    string,
    {
      method: string;
      route: string;
      client: string;
      requests: number;
      bytesOut: number;
      notModified: number;
      compressed: number;
    }
  >();
  const byClient = new Map<
    string,
    { client: string; requests: number; bytesOut: number; bytesIn: number }
  >();
  for (const entry of series) {
    const routeKey = `${entry.method} ${entry.route}`;
    const route = byRoute.get(routeKey) ?? {
      method: entry.method,
      route: entry.route,
      requests: 0,
      latency: new LatencyHistogram(),
    };
    route.requests += entry.requests;
    route.latency.merge(entry.latency);
    byRoute.set(routeKey, route);

    const pairKey = `${routeKey} ${entry.client}`;
    const pair = byRouteClient.get(pairKey) ?? {
      method: entry.method,
      route: entry.route,
      client: entry.client,
      requests: 0,
      bytesOut: 0,
      notModified: 0,
      compressed: 0,
    };
    pair.requests += entry.requests;
    pair.bytesOut += entry.bytesOut;
    // Without these an average size cannot tell a large body sent uncompressed
    // from a small one diluted by bodiless revalidations.
    pair.notModified += entry.notModified;
    pair.compressed += entry.compressed;
    byRouteClient.set(pairKey, pair);

    const client = byClient.get(entry.client) ?? {
      client: entry.client,
      requests: 0,
      bytesOut: 0,
      bytesIn: 0,
    };
    client.requests += entry.requests;
    client.bytesOut += entry.bytesOut;
    client.bytesIn += entry.bytesIn;
    byClient.set(entry.client, client);
  }
  const live = [...metrics.live.values()];
  const liveBytesOut = live.reduce((total, entry) => total + entry.bytesOut, 0);
  const sessionId = (id: string) => (input.sessionIds === 'hashed' ? hashIdentifier(id) : id);

  return {
    format: DIAGNOSTIC_REPORT_FORMAT,
    generatedAt: now.toISOString(),
    server: {
      version: server.version,
      startedAt: server.startedAt.toISOString(),
      uptimeSeconds: Math.round((now.getTime() - server.startedAt.getTime()) / 1000),
      node: process.version,
    },
    monitoring: {
      ...monitoring,
      measuringSince: metrics.since.toISOString(),
      coveredSeconds: Math.round((now.getTime() - metrics.since.getTime()) / 1000),
    },
    availability: {
      requests,
      serverErrors,
      clientErrors,
      serverErrorRate: requests === 0 ? 0 : Math.round((serverErrors / requests) * 10_000) / 10_000,
      latencyMs: {
        p50: rounded(overall.quantile(0.5)),
        p95: rounded(overall.quantile(0.95)),
        p99: rounded(overall.quantile(0.99)),
        max: rounded(overall.count === 0 ? null : overall.maxMs),
      },
      slowestRoutes: [...byRoute.values()]
        .filter((route) => route.requests >= 5)
        .map((route) => ({
          method: route.method,
          route: route.route,
          requests: route.requests,
          p95Ms: rounded(route.latency.quantile(0.95)),
        }))
        .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0))
        .slice(0, TOP),
    },
    traffic: {
      httpBytesOut: series.reduce((total, entry) => total + entry.bytesOut, 0),
      httpBytesIn: series.reduce((total, entry) => total + entry.bytesIn, 0),
      liveBytesOut,
      byClient: [...byClient.values()].sort((a, b) => b.bytesOut - a.bytesOut),
      topRoutes: [...byRouteClient.values()]
        .map((pair) => ({
          ...pair,
          averageBytes: Math.round(pair.bytesOut / Math.max(1, pair.requests)),
        }))
        .sort((a, b) => b.bytesOut - a.bytesOut)
        .slice(0, TOP),
      topSessions: [...metrics.sessions.entries()]
        .map(([id, traffic]) => ({ session: sessionId(id), ...traffic }))
        .sort((a, b) => b.bytesOut - a.bytesOut)
        .slice(0, TOP),
      untrackedSessions: metrics.droppedSessions,
      live: live.map((entry: LiveSeries) => ({ ...entry })).sort((a, b) => b.bytesOut - a.bytesOut),
    },
    resources,
    externalCalls: externalCalls(metrics),
    // The last detail period stays in reports until the next one starts, so a
    // report taken after detail mode ended still carries what it recorded.
    detail:
      monitoring.detailMode.active || metrics.slowRequests.length > 0
        ? {
            active: monitoring.detailMode.active,
            slowRequests: metrics.slowRequests.map((request: SlowRequest) => ({ ...request })),
          }
        : null,
    notYetMeasured: [...NOT_YET_MEASURED],
    excluded: [...REPORT_EXCLUSIONS],
  };
}

export type DiagnosticReport = ReturnType<typeof buildDiagnosticReport>;
