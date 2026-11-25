import { LatencyHistogram } from './latency-histogram.js';

/**
 * The server's in-memory counters (ADR 0032). Nothing here is persisted or
 * sent anywhere; the diagnostic report reads it on demand.
 *
 * Labels are bounded by construction: routes are Fastify route templates (or
 * `(unmatched)`), clients come from `identifyClient`, statuses are classes.
 * Every map additionally has a hard cap, past which new keys fold into one
 * overflow entry, so a misbehaving client cannot grow memory without bound.
 */
export const MAX_HTTP_SERIES = 2_000;
export const MAX_SESSIONS = 1_000;
export const MAX_SLOW_REQUESTS = 50;
export const OVERFLOW_ROUTE = '(other)';

export interface HttpObservation {
  method: string;
  route: string;
  client: string;
  status: number;
  durationMs: number;
  bytesIn: number;
  bytesOut: number;
  sessionId: string | null;
  requestId: string;
}

export interface HttpSeries {
  method: string;
  route: string;
  client: string;
  statusClass: string;
  requests: number;
  bytesIn: number;
  bytesOut: number;
  latency: LatencyHistogram;
}

export interface SessionTraffic {
  requests: number;
  bytesOut: number;
}

export interface LiveSeries {
  client: string;
  opened: number;
  active: number;
  framesOut: number;
  bytesOut: number;
  framesIn: number;
  bytesIn: number;
  closedDurationMs: number;
  longestMs: number;
}

export interface SlowRequest {
  at: string;
  requestId: string;
  method: string;
  route: string;
  client: string;
  status: number;
  durationMs: number;
  bytesOut: number;
}

export class ServerMetrics {
  readonly http = new Map<string, HttpSeries>();
  readonly sessions = new Map<string, SessionTraffic>();
  readonly live = new Map<string, LiveSeries>();
  /** Detail mode only: the slowest requests, slowest first. */
  slowRequests: SlowRequest[] = [];
  droppedSessions = 0;
  since: Date;

  constructor(private readonly now: () => Date = () => new Date()) {
    this.since = now();
  }

  reset(): void {
    this.http.clear();
    this.sessions.clear();
    this.live.clear();
    this.slowRequests = [];
    this.droppedSessions = 0;
    this.since = this.now();
  }

  recordHttp(observation: HttpObservation, detail: boolean): void {
    const statusClass = `${Math.floor(observation.status / 100)}xx`;
    let route = observation.route;
    let key = `${observation.method} ${route} ${observation.client} ${statusClass}`;
    if (!this.http.has(key) && this.http.size >= MAX_HTTP_SERIES) {
      route = OVERFLOW_ROUTE;
      key = `${observation.method} ${route} ${observation.client} ${statusClass}`;
    }
    let series = this.http.get(key);
    if (series === undefined) {
      series = {
        method: observation.method,
        route,
        client: observation.client,
        statusClass,
        requests: 0,
        bytesIn: 0,
        bytesOut: 0,
        latency: new LatencyHistogram(),
      };
      this.http.set(key, series);
    }
    series.requests += 1;
    series.bytesIn += observation.bytesIn;
    series.bytesOut += observation.bytesOut;
    series.latency.observe(observation.durationMs);

    if (observation.sessionId !== null)
      this.recordSession(observation.sessionId, observation.bytesOut);
    if (detail) this.recordSlow(observation);
  }

  private recordSession(sessionId: string, bytesOut: number): void {
    let traffic = this.sessions.get(sessionId);
    if (traffic === undefined) {
      if (this.sessions.size >= MAX_SESSIONS) {
        this.droppedSessions += 1;
        return;
      }
      traffic = { requests: 0, bytesOut: 0 };
      this.sessions.set(sessionId, traffic);
    }
    traffic.requests += 1;
    traffic.bytesOut += bytesOut;
  }

  private recordSlow(observation: HttpObservation): void {
    const slowest = this.slowRequests;
    if (
      slowest.length >= MAX_SLOW_REQUESTS &&
      observation.durationMs <= slowest[slowest.length - 1]!.durationMs
    )
      return;
    slowest.push({
      at: this.now().toISOString(),
      requestId: observation.requestId,
      method: observation.method,
      route: observation.route,
      client: observation.client,
      status: observation.status,
      durationMs: Math.round(observation.durationMs),
      bytesOut: observation.bytesOut,
    });
    slowest.sort((a, b) => b.durationMs - a.durationMs);
    if (slowest.length > MAX_SLOW_REQUESTS) slowest.length = MAX_SLOW_REQUESTS;
  }

  private liveSeries(client: string): LiveSeries {
    let series = this.live.get(client);
    if (series === undefined) {
      series = {
        client,
        opened: 0,
        active: 0,
        framesOut: 0,
        bytesOut: 0,
        framesIn: 0,
        bytesIn: 0,
        closedDurationMs: 0,
        longestMs: 0,
      };
      this.live.set(client, series);
    }
    return series;
  }

  liveOpened(client: string): void {
    const series = this.liveSeries(client);
    series.opened += 1;
    series.active += 1;
  }

  liveFrame(client: string, direction: 'in' | 'out', bytes: number): void {
    const series = this.liveSeries(client);
    if (direction === 'out') {
      series.framesOut += 1;
      series.bytesOut += bytes;
    } else {
      series.framesIn += 1;
      series.bytesIn += bytes;
    }
  }

  liveClosed(client: string, durationMs: number): void {
    const series = this.liveSeries(client);
    series.active = Math.max(0, series.active - 1);
    series.closedDurationMs += durationMs;
    series.longestMs = Math.max(series.longestMs, durationMs);
  }
}
