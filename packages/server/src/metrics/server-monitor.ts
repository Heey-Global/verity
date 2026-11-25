import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { buildDiagnosticReport, type DiagnosticReport } from './diagnostic-report.js';
import { observeHttp } from './http-observer.js';
import { observeLiveSocket } from './live-observer.js';
import {
  DETAIL_MODE_MINUTES,
  MonitoringControl,
  type MonitoringSettingsStore,
  type MonitoringState,
} from './monitoring-control.js';
import { ProcessSampler } from './process-sampler.js';
import { ServerMetrics } from './server-metrics.js';

export interface ServerMonitor {
  readonly metrics: ServerMetrics;
  readonly control: MonitoringControl;
  observeLiveSocket(
    socket: WebSocket,
    headers: Record<string, string | string[] | undefined>,
  ): void;
  report(sessionIds: 'hashed' | 'raw'): DiagnosticReport;
  /** Stops the event-loop sampler; the server is shutting down. */
  close(): void;
}

export function createServerMonitor(options: {
  store: MonitoringSettingsStore | undefined;
  version: string;
  now?: () => Date;
}): ServerMonitor {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const metrics = new ServerMetrics(now);
  const sampler = new ProcessSampler();
  // Switching measurement off drops what was counted: the next report covers
  // only the time measurement was on, and memory returns to the baseline.
  const control = new MonitoringControl(
    options.store,
    () => now().getTime(),
    (enabled) => {
      metrics.reset();
      sampler.setActive(enabled);
    },
    // Each detail period reports only its own slow requests, whoever starts it.
    () => {
      metrics.slowRequests = [];
    },
  );
  sampler.setActive(control.measuring);
  return {
    metrics,
    control,
    observeLiveSocket: (socket, headers) => observeLiveSocket(socket, headers, metrics, control),
    close: () => sampler.setActive(false),
    report: (sessionIds) =>
      buildDiagnosticReport({
        metrics,
        monitoring: control.state(),
        resources: sampler.sample(),
        server: { version: options.version, startedAt },
        now: now(),
        sessionIds,
      }),
  };
}

const monitoringPatch = z.union([
  z.object({ measurementEnabled: z.boolean() }).strict(),
  z
    .object({
      detailMode: z.union([
        z.null(),
        z.object({ minutes: z.literal(DETAIL_MODE_MINUTES) }).strict(),
      ]),
    })
    .strict(),
]);

/**
 * Hooks the counters into every request and registers the administrator
 * routes the app uses: read and change the monitoring settings, and fetch the
 * diagnostic report. None of these routes is in the paired-route allowlist,
 * so the default administrator policy applies.
 */
export function installServerMonitoring(app: FastifyInstance, monitor: ServerMonitor): void {
  observeHttp(app, monitor.metrics, monitor.control);
  app.addHook('onClose', (_instance, done) => {
    monitor.close();
    done();
  });
  app.addHook('onReady', async () => {
    try {
      await monitor.control.load();
    } catch (error) {
      // The defaults (measuring, no detail mode) stay in effect.
      app.log.warn({ err: error }, 'monitoring: settings could not be loaded; using defaults');
    }
  });

  app.get('/diagnostics/monitoring', async (_request, reply): Promise<MonitoringState> => {
    void reply.header('cache-control', 'no-store');
    return monitor.control.state();
  });

  app.patch('/diagnostics/monitoring', async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const parsed = monitoringPatch.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
    const patch = parsed.data;
    if ('measurementEnabled' in patch)
      return monitor.control.setMeasurementEnabled(patch.measurementEnabled);
    if (patch.detailMode === null) return monitor.control.stopDetailMode();
    return monitor.control.startDetailMode(patch.detailMode.minutes, 'app');
  });

  app.get('/diagnostics/report', async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    return monitor.report('hashed');
  });
}
