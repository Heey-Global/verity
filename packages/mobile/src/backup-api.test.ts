import { expect, it, vi } from 'vitest';
import { VerityClient, backupStatusSchema } from './api.js';

const offer = {
  id: '6a5c3a52-36f1-4c39-9c51-2a1e2b0d6b7e',
  recoveryKey: 'verity-recovery-v1.sample',
  expiresAt: 1,
};
const job = {
  format: 1,
  installationId: '1f0e4a0e-2b8f-4a7e-9d3c-5b6a7c8d9e0f',
  id: '0b7d6c5e-4f3a-4b2c-8d1e-9f0a1b2c3d4e',
  status: 'running',
  phase: 'database',
  startedAt: 1,
  finishedAt: null,
  snapshot: null,
  error: null,
};

function client(body: unknown) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })));
  return {
    fetch,
    client: new VerityClient({
      baseUrl: 'https://core.example',
      fetch,
      getToken: () => 'paired-token',
    }),
  };
}

it('confirms setup and key replacement with the offered key and always replaces as lost', async () => {
  const { fetch, client: api } = client(offer);
  expect(await api.beginBackupSetup()).toEqual(offer);
  await api.confirmBackupSetup(offer);
  await api.beginBackupKeyReplacement();
  await api.confirmBackupKeyReplacement(offer);
  const calls = fetch.mock.calls.map(([url, init]) => [
    (url as string).replace('https://core.example', ''),
    init?.method,
    init?.body,
  ]);
  expect(calls).toEqual([
    ['/api/backups/setup', 'POST', '{}'],
    [
      '/api/backups/setup/confirm',
      'POST',
      JSON.stringify({ id: offer.id, recoveryKey: offer.recoveryKey }),
    ],
    ['/api/backups/key-replacement', 'POST', JSON.stringify({ reason: 'lost' })],
    [
      '/api/backups/key-replacement/confirm',
      'POST',
      JSON.stringify({ id: offer.id, recoveryKey: offer.recoveryKey }),
    ],
  ]);
  expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
    authorization: 'Bearer paired-token',
    'content-type': 'application/json',
  });
});

it('sends policy changes and probe requests to their routes', async () => {
  const { fetch, client: api } = client(job);
  await api.setBackupPolicy({ intervalMs: 3600000 });
  expect((await api.startBackupProbe('verity-recovery-v1.sample')).phase).toBe('database');
  await api.getBackupProbe(job.id);
  await api.cancelBackupProbe(job.id);
  expect(
    fetch.mock.calls.map(([url, init]) => [(url as string).split('/api')[1], init?.method]),
  ).toEqual([
    ['/backups/policy', 'PATCH'],
    ['/backups/probes', 'POST'],
    [`/backups/probes/${job.id}`, 'GET'],
    [`/backups/probes/${job.id}/cancel`, 'POST'],
  ]);
  expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ intervalMs: 3600000 }));
});

it('accepts unavailable reasons from older servers and the configured status', () => {
  expect(
    backupStatusSchema.parse({ available: false, reason: 'recovery-validation-pending' }),
  ).toEqual({ available: false, reason: 'recovery-validation-pending' });
  expect(
    backupStatusSchema.parse({
      available: true,
      configured: true,
      paused: false,
      intervalMs: 21600000,
      lastSuccess: null,
      capturing: true,
      lastProbe: null,
      probe: null,
      alerts: [],
    }),
  ).toMatchObject({ available: true, capturing: true });
});
