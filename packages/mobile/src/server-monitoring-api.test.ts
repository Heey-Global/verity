import { describe, expect, it, vi } from 'vitest';
import { serverMonitoringClient } from './server-monitoring-api.js';

type Request = Parameters<typeof serverMonitoringClient>[0];

const state = {
  measurementEnabled: true,
  detailMode: { active: false, until: null, startedBy: null, remainingSeconds: 0 },
};

function setup(body: unknown) {
  const request = vi.fn<Request>(async () => new Response(JSON.stringify(body)));
  return { request, client: serverMonitoringClient(request) };
}

function sent(request: ReturnType<typeof setup>['request']) {
  const [path, init] = request.mock.calls[0]!;
  return { path, method: init.method, body: JSON.parse(init.body as string) as unknown };
}

describe('server monitoring client', () => {
  // The server accepts exactly one change per PATCH and rejects unknown keys;
  // a body shaped differently fails there with a 400 the screen only shows as
  // "did not accept the change".
  it('sends one change per request in the shape the server accepts', async () => {
    let call = setup(state);
    await call.client.setMeasurementEnabled(false);
    expect(sent(call.request)).toEqual({
      path: '/diagnostics/monitoring',
      method: 'PATCH',
      body: { measurementEnabled: false },
    });
    call = setup(state);
    await call.client.startDetailMode(60);
    expect(sent(call.request).body).toEqual({ detailMode: { minutes: 60 } });
    call = setup(state);
    await call.client.stopDetailMode();
    expect(sent(call.request).body).toEqual({ detailMode: null });
  });

  it('keeps the report text exactly as the server built it for sharing', async () => {
    const report = {
      format: 'verity.diagnostic-report/1',
      generatedAt: '2026-11-25T14:58:00.000Z',
      server: { version: '1.95.4', uptimeSeconds: 10 },
      monitoring: { measurementEnabled: true, coveredSeconds: 10 },
      availability: {
        requests: 1,
        serverErrorRate: 0,
        latencyMs: { p50: 1, p95: 1, p99: 1, max: 1 },
      },
      traffic: { httpBytesOut: 5, liveBytesOut: 0, byClient: [], topRoutes: [] },
      resources: { rssBytes: 1, heapUsedBytes: 1, heapLimitBytes: 2 },
      futureArea: { anything: true },
    };
    const { request, client } = setup(report);
    const loaded = await client.report();
    expect(request.mock.calls[0]![0]).toBe('/diagnostics/report');
    // A field this app does not know yet is still shared.
    expect(JSON.parse(loaded.text)).toEqual(report);
    expect(loaded.report.notYetMeasured).toEqual([]);
  });
});
