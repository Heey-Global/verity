import { expect, it, vi } from 'vitest';
import { VerityClient, returnPathStatusSchema } from './api.js';
const status = {
  enabled: false,
  source: 'none',
  installationFingerprint: null,
  expiresAt: null,
  currentUtc: '2026-10-11T18:00:00Z',
  remainingMs: 0,
  matchedConnectors: 0,
};
it('uses authenticated status/start/stop requests and sends only an agreed deadline', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(status), { status: 200 })),
    );
  const client = new VerityClient({
    baseUrl: 'https://core.example',
    fetch,
    getToken: () => 'paired-token',
  });
  await client.getReturnPathStatus();
  await client.startReturnPathDiagnostics('2026-10-11T18:09:00Z');
  await client.stopReturnPathDiagnostics();
  expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual(['GET', 'POST', 'DELETE']);
  const options = fetch.mock.calls[1]?.[1];
  expect(options?.headers).toMatchObject({
    authorization: 'Bearer paired-token',
    'content-type': 'application/json',
  });
  expect(options?.body).toBe(JSON.stringify({ expiresAt: '2026-10-11T18:09:00Z' }));
  expect(fetch.mock.calls[1]?.[0]).toContain('/api/remote-control/diagnostics');
});
it('rejects unsafe unexpected diagnostic response fields', () => {
  for (const field of ['installationId', 'token', 'payload', 'headers'])
    expect(() => returnPathStatusSchema.parse({ ...status, [field]: 'private' })).toThrow();
});
