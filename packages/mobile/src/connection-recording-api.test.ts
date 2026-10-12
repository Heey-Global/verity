import { expect, it, vi } from 'vitest';
import { VerityClient, connectionRecordingStatusSchema } from './api.js';
const runId = '11111111-1111-4111-8111-111111111111';
const status = {
  version: 1,
  runId,
  phase: 'recording',
  startedAt: '2026-10-12T10:00:00.000Z',
  expiresAt: '2026-10-12T10:02:00.000Z',
  installationFingerprint: '0123456789abcdef',
  core: { state: 'recording', records: 0, dropped: 0 },
  uplink: { state: 'recording' },
  error: null,
};
it('uses authenticated bounded run-scoped start/status/stop/export calls', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((url) =>
    Promise.resolve(
      new Response(
        JSON.stringify(
          (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith(
            '/export',
          )
            ? {
                version: 1,
                status,
                core: { records: [], dropped: 0 },
                uplink: { available: false, data: null, error: 'uplink_export_failed' },
              }
            : status,
        ),
      ),
    ),
  );
  const client = new VerityClient({
    baseUrl: 'https://core.example',
    fetch,
    getToken: () => 'paired-token',
  });
  await client.startConnectionRecording(runId, 120_000);
  await client.getConnectionRecording(runId);
  await client.stopConnectionRecording(runId);
  await client.exportConnectionRecording(runId);
  expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual(['POST', 'GET', 'DELETE', 'GET']);
  expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ runId, durationMs: 120_000 }));
  expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer paired-token' });
  expect(fetch.mock.calls[3]?.[0]).toContain(`/recordings/${runId}/export`);
  await expect(client.startConnectionRecording(runId, 120_001)).rejects.toThrow();
  await expect(client.exportConnectionRecording('../secret')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(4);
});
it('rejects unknown readiness and private status fields', () => {
  expect(() =>
    connectionRecordingStatusSchema.parse({ ...status, uplink: { state: 'ready' } }),
  ).toThrow();
  expect(() => connectionRecordingStatusSchema.parse({ ...status, ticket: 'secret' })).toThrow();
});

it('projects Uplink metadata and rejects mismatched export ownership', async () => {
  const { connectionRecordingExportSchema } = await import('./api.js');
  const data = {
    version: 1,
    runId,
    state: 'stopped',
    expiresAt: status.expiresAt,
    retainedUntil: status.expiresAt,
    collectorReady: true,
    recordCount: 1,
    droppedRecords: 0,
    records: [
      {
        event: 'remote.return_path',
        schemaVersion: 1,
        session: '0123456789abcdef',
        generation: '0123456789abcdef',
        party: 'app',
        direction: 'in',
        stage: 'emitted_message',
        outcome: 'observed',
        eventOrder: 0,
        elapsedMs: 0,
        ticket: 'private',
        payload: 'secret',
      },
    ],
  };
  const envelope = {
    version: 1,
    status,
    core: { records: [], dropped: 0 },
    uplink: { available: true, data, error: null },
  };
  const safe = JSON.stringify(connectionRecordingExportSchema.parse(envelope));
  expect(safe).not.toContain('private');
  expect(safe).not.toContain('secret');
  expect(() =>
    connectionRecordingExportSchema.parse({
      ...envelope,
      uplink: {
        ...envelope.uplink,
        data: { ...data, runId: '22222222-2222-4222-8222-222222222222' },
      },
    }),
  ).toThrow();
});
