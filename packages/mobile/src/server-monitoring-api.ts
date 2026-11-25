import { z } from 'zod';

import type { TransportRequestInit } from './api.js';

// Server monitoring and the diagnostic report (docs/adr/0032-server-metrics-and-diagnostics.md).
// `VerityClient` carries these calls as `monitoring`
// (docs/adr/0029-module-boundaries-and-file-size.md). Administrators only.

/** The detail-mode durations the server accepts, in minutes. */
export const DETAIL_MODE_MINUTES = [15, 60, 240] as const;
export type DetailModeMinutes = (typeof DETAIL_MODE_MINUTES)[number];

export const monitoringStateSchema = z.object({
  measurementEnabled: z.boolean(),
  detailMode: z.object({
    active: z.boolean(),
    until: z.string().nullable(),
    // A plain string: a newer server may name starters this app does not know.
    startedBy: z.string().nullable(),
    remainingSeconds: z.number().nonnegative(),
  }),
});
export type MonitoringState = z.infer<typeof monitoringStateSchema>;

const latencySchema = z.object({
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  p99: z.number().nullable(),
  max: z.number().nullable(),
});

/**
 * The fields of `verity.diagnostic-report/1` the app summarises. The report is
 * shared verbatim, so everything else passes through untouched.
 */
export const diagnosticReportSchema = z
  .object({
    format: z.string(),
    generatedAt: z.string(),
    server: z.object({ version: z.string(), uptimeSeconds: z.number() }).passthrough(),
    monitoring: z
      .object({ measurementEnabled: z.boolean(), coveredSeconds: z.number() })
      .passthrough(),
    availability: z
      .object({
        requests: z.number(),
        serverErrorRate: z.number(),
        latencyMs: latencySchema,
      })
      .passthrough(),
    traffic: z
      .object({
        httpBytesOut: z.number(),
        liveBytesOut: z.number(),
        byClient: z.array(z.object({ client: z.string(), bytesOut: z.number() }).passthrough()),
        topRoutes: z.array(
          z
            .object({
              method: z.string(),
              route: z.string(),
              client: z.string(),
              bytesOut: z.number(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
    resources: z
      .object({ rssBytes: z.number(), heapUsedBytes: z.number(), heapLimitBytes: z.number() })
      .passthrough(),
    notYetMeasured: z.array(z.string()).default([]),
  })
  .passthrough();
export type DiagnosticReport = z.infer<typeof diagnosticReportSchema>;

type Request = (path: string, init: TransportRequestInit) => Promise<Response>;
const patch = (body: unknown): TransportRequestInit => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** The monitoring calls, bound to the client's `request`. */
export function serverMonitoringClient(request: Request) {
  const state = async (res: Response) => monitoringStateSchema.parse(await res.json());
  return {
    state: async () => state(await request('/diagnostics/monitoring', { method: 'GET' })),
    setMeasurementEnabled: async (measurementEnabled: boolean) =>
      state(await request('/diagnostics/monitoring', patch({ measurementEnabled }))),
    startDetailMode: async (minutes: DetailModeMinutes) =>
      state(await request('/diagnostics/monitoring', patch({ detailMode: { minutes } }))),
    stopDetailMode: async () =>
      state(await request('/diagnostics/monitoring', patch({ detailMode: null }))),
    /** The report as parsed for the summary, and its exact text for sharing. */
    report: async (): Promise<{ report: DiagnosticReport; text: string }> => {
      const res = await request('/diagnostics/report', { method: 'GET' });
      const raw: unknown = await res.json();
      return { report: diagnosticReportSchema.parse(raw), text: JSON.stringify(raw, null, 2) };
    },
  };
}
