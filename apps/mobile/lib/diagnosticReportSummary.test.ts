import { diagnosticReportSchema } from '@verity/mobile';
import {
  clientName,
  formatBytes,
  formatDuration,
  summarizeReport,
} from './diagnosticReportSummary';

// The shape `GET /diagnostics/report` returns (packages/server/src/metrics/diagnostic-report.ts),
// parsed through the client's own schema so a renamed field fails here, not on a phone.
const report = diagnosticReportSchema.parse({
  format: 'verity.diagnostic-report/1',
  generatedAt: '2026-11-25T14:58:00.000Z',
  server: { version: '1.95.4', uptimeSeconds: 274_800, startedAt: 'x', node: 'v26' },
  monitoring: { measurementEnabled: true, coveredSeconds: 3_600 },
  availability: {
    requests: 12_345,
    serverErrorRate: 0.004,
    latencyMs: { p50: 12, p95: 180, p99: 900, max: 2_000 },
  },
  traffic: {
    httpBytesOut: 3_000_000_000,
    liveBytesOut: 1_600_000_000,
    byClient: [{ client: 'ios/1.95.4', bytesOut: 4_000_000_000 }],
    topRoutes: [
      {
        method: 'GET',
        route: '/sessions/overview',
        client: 'ios/1.95.4',
        bytesOut: 3_100_000_000,
      },
    ],
  },
  resources: { rssBytes: 1_100_000_000, heapUsedBytes: 400_000_000, heapLimitBytes: 2_000_000_000 },
  notYetMeasured: ['external_calls', 'database'],
});

it('summarises outbound calls by their busiest target', () => {
  const withCalls = diagnosticReportSchema.parse({
    ...report,
    externalCalls: {
      calls: 20_000,
      byTarget: [
        {
          target: 'github',
          calls: 18_420,
          failed: 3,
          duplicates: 552,
          rateLimit: { remaining: 4_812, limit: 5_000, at: 'x' },
        },
        { target: 'doppler', calls: 1_580, failed: 0, duplicates: 48, rateLimit: null },
      ],
      topCauses: [],
    },
    notYetMeasured: ['database'],
  });
  expect(summarizeReport(withCalls).find((area) => area.title === 'External calls')).toEqual({
    title: 'External calls',
    summary: '20,000 calls · top: GitHub 18,420 · 3 % duplicates · 4,812 of 5,000 left',
  });
});

it('summarises each measured area and names the ones not measured yet', () => {
  expect(summarizeReport(report)).toEqual([
    { title: 'Availability', summary: '12,345 requests · 0.4 % errors · p95 180 ms' },
    {
      title: 'Traffic',
      summary: '4.6 GB sent · top: GET /sessions/overview on iPhone, 3.1 GB',
    },
    { title: 'Resources', summary: 'Server 1.1 GB RAM · heap 400 MB of 2.0 GB' },
    { title: 'External calls', summary: 'Not measured by this server version' },
    { title: 'Database', summary: 'Not measured by this server version' },
  ]);
});

it('formats sizes, durations and clients for people', () => {
  expect(formatBytes(512)).toBe('512 B');
  expect(formatBytes(14_200)).toBe('14 KB');
  expect(formatDuration(274_800)).toBe('3 d 4 h');
  expect(formatDuration(30)).toBe('under a minute');
  expect(clientName('watch/1.95.4')).toBe('Watch');
  expect(clientName('agent')).toBe('agents');
});
